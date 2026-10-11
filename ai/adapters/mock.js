/**
 * Mock adapter.
 *
 * A first-class provider, not a test double bolted on. It lets the whole flow
 * (interview -> structured processes -> scoring -> roadmap) run with no key and
 * no network, which is what makes the UI and the scoring layer developable
 * before any provider credential exists.
 *
 * Behaviour: it asks a SCRIPTED sequence of questions, using the user-turn count
 * to decide where it is, and reports a `have`/`missing` pair that narrows as the
 * conversation goes on. The final payload is shaped exactly like a real
 * provider's output, including the completeness matrix, so nothing downstream
 * knows or cares that it is canned.
 *
 * THE SCRIPTED PART IS HONEST ABOUT BEING SCRIPTED. A real provider decides
 * which field to ask for next by reading the answer; this one cannot, so it fixes
 * the field order and moves through it. What it does model faithfully is the
 * PROTOCOL: the two lists, the process payload, and the close, which is what the
 * server and the tests read.
 */
import { buildMockAudit } from '../fixtures/mock-audit.js';
import { ALL_PROCESS_FIELD_NAMES, reconcileMatrix } from '../matrix.js';

/**
 * The scripted questions, in the order they are asked, each naming the fields its
 * answer is expected to supply.
 *
 * `fields` is what moves a field from `missing` to `have` once that turn has been
 * answered, so the mock's reported matrix tracks the conversation the way a real
 * model's would. The judgement question asks for the BASIS, never whether the
 * step needs judgement: that distinction is the whole point of workflow 1, and
 * the mock would mislead every test built on it if it asked the old way.
 */
const SCRIPT = {
    nl: [
        { q: 'Welke taak kost je het meest, en wat start er één keer zo\'n taak?', fields: ['task', 'trigger'] },
        { q: 'Welke stappen doorloop je daarbij, van begin tot eind?', fields: ['steps'] },
        { q: 'Hoe vaak komt dit voor, of is het meer doorlopend werk?', fields: ['frequencyPerWeek'] },
        { q: 'Hoeveel mensen in het bedrijf zijn hierbij betrokken?', fields: ['peopleAffected'] },
        { q: 'Waarop baseer je je beslissing als je hier een knoop doorhakt?', fields: [] },
        { q: 'Naar wie gaat het werk daarna, en waar wacht het op?', fields: ['handoffTo', 'waitsFor'] },
        { q: 'Wat moet er eerst gebeurd zijn, en welke systemen gebruik je?', fields: ['dependsOn', 'systems'] },
        { q: 'Welke afdelingen raakt het, gaat het wel eens mis, en hoe doet het team dit vandaag?', fields: ['touchedDepartments', 'mistakesPerPeriod', 'mistakeConsequence', 'currentState', 'frustration'] }
    ],
    en: [
        { q: 'What is the task that takes up the most time, and what starts one instance of it?', fields: ['task', 'trigger'] },
        { q: 'What is the first step, and which steps come after it?', fields: ['steps'] },
        { q: 'How often does this happen, or is it more continuous work?', fields: ['frequencyPerWeek'] },
        { q: 'How many people in the company are involved in this?', fields: ['peopleAffected'] },
        { q: 'On what basis do you decide when you have to make a call here?', fields: [] },
        { q: 'Who does the work go to next, and what does it wait on?', fields: ['handoffTo', 'waitsFor'] },
        { q: 'What has to happen first, and which systems do you use?', fields: ['dependsOn', 'systems'] },
        { q: 'Which departments does it cross, does it ever go wrong, and how does the team do this today?', fields: ['touchedDepartments', 'mistakesPerPeriod', 'mistakeConsequence', 'currentState', 'frustration'] }
    ],
    fr: [
        { q: 'Quelle tâche vous prend le plus de temps, et qu\'est-ce qui déclenche une occurrence ?', fields: ['task', 'trigger'] },
        { q: 'Quelles étapes suivez-vous, du début à la fin ?', fields: ['steps'] },
        { q: 'À quelle fréquence cela arrive-t-il, ou est-ce un travail continu ?', fields: ['frequencyPerWeek'] },
        { q: 'Combien de personnes dans l\'entreprise y participent ?', fields: ['peopleAffected'] },
        { q: 'Sur quelle base décidez-vous quand il faut trancher ici ?', fields: [] },
        { q: 'À qui le travail passe-t-il ensuite, et qu\'attend-il ?', fields: ['handoffTo', 'waitsFor'] },
        { q: 'Que doit-il se produire avant, et quels systèmes utilisez-vous ?', fields: ['dependsOn', 'systems'] },
        { q: 'Quels services cela traverse-t-il, est-ce que cela tourne mal, et comment l\'équipe fait-elle cela aujourd\'hui ?', fields: ['touchedDepartments', 'mistakesPerPeriod', 'mistakeConsequence', 'currentState', 'frustration'] }
    ]
};

const DONE_MESSAGE = {
    nl: 'Bedankt. Is er nog een proces dat je zou willen verbeteren?',
    en: 'Thank you. Is there another process you would like to improve?',
    fr: 'Merci. Y a-t-il un autre processus que vous aimeriez améliorer ?'
};

/**
 * Fields the script cannot supply, because they belong to a step rather than to
 * the process, or because the scripted answer does not carry them.
 *
 * `steps` is the important one: the questions ask for the sequence, and the
 * per-step basis is supplied by the fixture on completion rather than by an
 * answer. Until then it stays in `missing`, so the mock's own matrix reflects
 * what it has actually been told.
 *
 * `timePerPeriod` is never supplied: every workflow in the fixture happens in
 * instances, so `frequencyPerWeek` is the right half of the either/or pair.
 */
const SCRIPT_ONLY_FIELDS = new Set(['steps', 'timePerPeriod']);

/**
 * @param {object} args
 * @param {Array<{role: string, content: string}>} args.messages Conversation so far.
 * @returns {Promise<string>} A JSON string, matching the real providers' contract.
 */
export async function generate({ messages, providerConfig }) {
    const lang = providerConfig?.lang && SCRIPT[providerConfig.lang] ? providerConfig.lang : 'en';
    const script = SCRIPT[lang];

    // Count user turns: each one is an answer to the previous question.
    const userTurns = messages.filter((m) => m.role === 'user').length;

    // What the answers so far supply: every field whose question has been
    // answered. This is what makes the two lists CHANGE turn by turn rather than
    // being a fixed pair, which is the behaviour the server's loop relies on.
    const answered = new Set();
    for (let i = 0; i < Math.min(userTurns, script.length); i += 1) {
        for (const field of script[i].fields) answered.add(field);
    }

    const have = ALL_PROCESS_FIELD_NAMES.filter(
        (field) => answered.has(field) && !SCRIPT_ONLY_FIELDS.has(field)
    );
    const missing = ALL_PROCESS_FIELD_NAMES.filter(
        (field) => !have.includes(field)
    );

    if (userTurns < script.length) {
        return JSON.stringify({
            status: 'asking',
            content: script[Math.min(userTurns, script.length - 1)].q,
            have,
            missing,
            // A partial process, so a real parser sees the same shape throughout
            // rather than only at the end.
            processes: [{ task: '<being described>', steps: [] }]
        });
    }

    // Every scripted question has been answered. The fixture supplies the steps
    // and their decidedHow/needsReasoning, which is what a real model would have
    // read out of the answers rather than asked for.
    const audit = buildMockAudit(lang);

    // The pair is computed by the matrix's own rule, not by a copy of it: a
    // second implementation of "is the effort supplied" is how the either/or case
    // gets missed in one place and not the other, which is exactly what happened
    // here first time round.
    const finalMatrix = reconcileMatrix({ processes: audit.workflows, closing: true });

    // THE SHAPE THE PROMPT ASKS FOR, and nothing else.
    //
    // This used to emit BOTH `processes` and `audit`, which made the mock pass a
    // completion check that a real model could not: the check read `audit` alone,
    // and the mock was carrying the key that satisfied it. A fixture that emits a
    // second shape to satisfy the parser hides exactly the defect the parser has,
    // so there is now one shape here, and it is the one the prompt documents.
    //
    // `illustrative` and `note` sit at the top level rather than inside an `audit`
    // envelope, because the interview shape has no envelope to put them in. The
    // parser lifts them into the payload it normalises, so the banner still shows.
    return JSON.stringify({
        status: 'complete',
        content: DONE_MESSAGE[lang],
        have: finalMatrix.have,
        missing: finalMatrix.missing,
        processes: audit.workflows,
        illustrative: true,
        note: audit.note
    });
}
