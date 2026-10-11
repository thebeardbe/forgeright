/**
 * Checks the LIVE model ranks a dominating process above the one it dominates.
 *
 * A LIVE CHECK, NOT A TEST. It calls a real provider, so it cannot live in the
 * suite, which has to pass offline and without keys. Run with
 * `node scripts/check-weighing-order.js`.
 *
 * WHY THIS EXISTS. The prompt says a frequently repeating, simple process should
 * score above a rare, complicated one, and the composition is the model's own. That
 * property is stated in the prompt as dominance: if A's reward terms are all at
 * least B's and none of A's costs is worse, A must score higher. Measured once in a
 * live conversation, at 84 against 18. **This script is that measurement, made
 * repeatable**: a model that stopped composing monotonically is the failure the
 * whole ranking rests on, and nothing else here would catch it.
 *
 * THE TWO PROCESSES ARE CONSTRUCTED TO DOMINATE, so the expected order does not
 * depend on taste: the quick one is better on every reward term and no worse on any
 * cost term, which makes the order the prompt's own requirement rather than this
 * script's opinion.
 *
 * EXIT CODE IS THE RESULT: 0 when the order is right, 1 when it is not or the
 * weighing failed. A check that prints a warning and passes is a check nobody runs.
 *
 * RUN IT WITH A REAL PROVIDER: `AI_PROVIDER=deepseek node scripts/check-weighing-order.js`.
 * `.env` sets `AI_PROVIDER=mock`, and the mock answers every call with the next
 * interview question rather than a weighing, so the default run reports a failed
 * weighing that names nothing useful. That is a property of the mock, not of the
 * prompt. The script says so when it sees a non-completion reply rather than letting
 * it read as a composition failure.
 */
import 'dotenv/config';
import { runWeighing } from '../ai/weigh-core.js';

/**
 * The ten terms, with the reward and cost directions, so the construction below can
 * be verified rather than asserted in a comment.
 */
const REWARD = ['frequency', 'time', 'people', 'results', 'consequences', 'automatableShare'];
const COST = ['departments', 'complexity', 'reasoningSteps', 'buildEffort'];

/** One step, in the shape the prompt asks for. */
const step = (name, needsReasoning) => ({
    name,
    whatHappens: `The work of ${name}.`,
    decidedHow: needsReasoning ? 'depends on the case in front of me' : 'the checklist decides it',
    needsReasoning,
    reasoningBasis: needsReasoning ? 'depends on the case' : 'the checklist decides it'
});

/**
 * The process that must score higher: frequent, fast, rule-following, low stakes.
 *
 * Six to eight steps, almost all rules, a low build effort and few departments, so
 * every reward term can be set high and every cost term low without inventing
 * anything a real questionnaire would not say.
 */
const QUICK = {
    name: 'Checking a delivery note against the order',
    task: 'Checking a delivery note against the order',
    trigger: 'a delivery arriving',
    frequencyPerWeek: 120,
    minutesPerInstance: 2,
    // PEOPLE AND CONSEQUENCES ARE REWARDS TOO, which is easy to forget when
    // constructing a case like this: a first attempt of mine set these LOWER than
    // the slow process, so it did not dominate and the check correctly refused to
    // run. High-volume work genuinely affects more people than one bespoke contract
    // a quarter, and a mis-booked delivery that repeats 120 times a week costs real
    // money, so raising these is honest rather than convenient.
    peopleAffected: 12,
    handoffTo: ['Warehouse'],
    waitsFor: ['the lorry'],
    dependsOn: ['the goods arriving'],
    systems: ['the stock system'],
    touchedDepartments: ['Warehouse'],
    mistakesPerPeriod: 30,
    mistakeConsequence: 'Repeated stock errors across the whole catalogue, corrected by hand, and the same mistake in 120 deliveries a week',
    currentState: 'Checked by hand at the door.',
    frustration: 'The repetition.',
    steps: [step('Read the note', false), step('Find the order', false), step('Compare the lines', false)]
};

/**
 * The process that must score lower: rare, slow, judgement-heavy, high stakes.
 *
 * THREE judgement steps and three departments, so it is worse on every cost term
 * and no better on any reward term. The dominance is deliberate and total, which is
 * what makes the expected order the prompt's requirement rather than a preference.
 */
const SLOW = {
    name: 'Deciding whether to take on a bespoke contract',
    task: 'Deciding whether to take on a bespoke contract',
    trigger: 'a client asking for terms outside the standard paper',
    frequencyPerWeek: 0.25,
    minutesPerInstance: 240,
    peopleAffected: 9,
    handoffTo: ['Legal', 'Finance', 'Security'],
    waitsFor: ['each team replying'],
    dependsOn: ['the deal being qualified'],
    systems: ['Word', 'Email', 'the CRM'],
    touchedDepartments: ['Legal', 'Finance', 'Security'],
    mistakesPerPeriod: 1,
    mistakeConsequence: 'An unfavourable clause binds us for years',
    currentState: 'Two lawyers read every deviation.',
    frustration: 'The waiting.',
    steps: [
        step('Read the deviation', true),
        step('Weigh the risk', true),
        step('Consult each team', true),
        step('Draft the counter-terms', true)
    ]
};

/** The grouping shape `runWeighing` reads: responses, each with `data`. */
const groupingOf = (process) => ({ revision: 1, responses: [{ id: 'synthetic', department: 'Finance', data: process }] });

/** Confirms the construction dominates, so a wrong order cannot be blamed on the data. */
function dominanceIsReal(faster, slower) {
    const problems = [];
    for (const term of REWARD) {
        if (!(faster[term] >= slower[term])) problems.push(`${term}: ${faster[term]} < ${slower[term]} (reward, must be at least)`);
    }
    for (const term of COST) {
        if (!(faster[term] <= slower[term])) problems.push(`${term}: ${faster[term]} > ${slower[term]} (cost, must be no worse)`);
    }
    return problems;
}

/** What the model reported, per term, so a failure says which term broke the order. */
const tableOf = (terms) => Object.entries(terms ?? {}).map(([k, v]) => `${k}=${v}`).join(' ');

async function weigh(process) {
    const reply = await runWeighing({ process: { id: process.name, name: process.name }, grouping: groupingOf(process), lang: 'en' });
    if (reply.status === 'error' || reply.status === 'rejected') {
        throw new Error(`the weighing failed for ${JSON.stringify(process.name)}: ${reply.reason ?? reply.status}`);
    }
    // A NON-COMPLETION REPLY IS USUALLY THE MOCK, which answers every call with the
    // next interview question. Named here so a default-configured run does not read
    // as a composition failure when it is a provider choice.
    if (typeof reply.score !== 'number') {
        throw new Error(
            `no score came back for ${JSON.stringify(process.name)} (reply keys: ` +
            `${Object.keys(reply).join(', ')}). If AI_PROVIDER is "mock" it answers ` +
            'every call with an interview question: run this with a real provider.'
        );
    }
    return reply;
}

/**
 * The expected per-term reading of a process, ON THE PROMPT'S OWN 0-100 SCALE.
 *
 * DERIVED FROM THE RAW FIELDS, NOT HAND-WRITTEN, and that is deliberate: this used
 * to be two literal objects on the old 1-5 scale, so when the scale moved to 0-100
 * they silently became values the prompt would never produce. A dominance check
 * reading stale numbers passes for the wrong reason, which is worse than failing.
 * Deriving them from the same fields the model is given means a scale change moves
 * this with it.
 *
 * These are this script's reading of the ten terms in the direction the prompt
 * defines, normalised to 0-100, and they exist only to confirm the CONSTRUCTION
 * dominates before a model is called. They are not a claim about what the model will
 * return, and nothing here is compared against the reply.
 */
function expectedTerms(process) {
    const weeklyHours = (process.frequencyPerWeek ?? 0) * (process.minutesPerInstance ?? 0) / 60;
    // A rule-following step scores high here, because automatableShare is the share
    // of steps that follow rules rather than need a person.
    const steps = process.steps ?? [];
    const rules = steps.filter((s) => needsReasoningIsFalse(s)).length;
    const judgement = steps.filter((s) => needsReasoningIsFalse(s) === false).length;

    return {
        // Rewards: higher is better, so these read as a position on 0-100.
        frequency: clamp100(process.frequencyPerWeek ?? 0, 0, 120),
        time: clamp100(weeklyHours, 0, 8),
        people: clamp100(process.peopleAffected ?? 0, 1, 12),
        results: 60,
        consequences: clamp100(process.mistakesPerPeriod ?? 0, 0, 30),
        automatableShare: clamp100(rules, 0, Math.max(steps.length, 1)),
        // Costs: higher is worse, so a small number is a GOOD process.
        departments: clamp100((process.touchedDepartments ?? []).length, 1, 4),
        complexity: clamp100(steps.length, 1, 5),
        reasoningSteps: clamp100(judgement, 0, Math.max(steps.length, 1)),
        buildEffort: clamp100(steps.length, 1, 5)
    };
}

/** True when a step follows a rule rather than needing a person. */
function needsReasoningIsFalse(step) {
    return step.needsReasoning === false;
}

/** A value mapped onto 0-100 between two bounds, clamped, for the check above. */
function clamp100(value, low, high) {
    if (high === low) return 0;
    const share = (value - low) / (high - low);
    return Math.round(Math.min(1, Math.max(0, share)) * 100);
}

async function main() {
    // STATED AS DATA, NOT ASSUMED: if the construction were not dominant, a failed
    // check would say nothing about the model.
    const faster = expectedTerms(QUICK);
    const slower = expectedTerms(SLOW);
    const problems = dominanceIsReal(faster, slower);
    if (problems.length > 0) {
        console.error('[check] the fixture does NOT dominate, so this check proves nothing:');
        for (const problem of problems) console.error('  ' + problem);
        process.exit(1);
    }
    console.log('[check] the construction dominates: every reward term at least, every cost term no worse');

    const quick = await weigh(QUICK);
    const slow = await weigh(SLOW);

    console.log(`[check] ${QUICK.name}\n        score ${quick.score}  ${tableOf(quick.terms)}`);
    console.log(`[check] ${SLOW.name}\n        score ${slow.score}  ${tableOf(slow.terms)}`);

    if (!(quick.score > slow.score)) {
        console.error(
            `[check] FAILED: the dominating process scored ${quick.score} against ${slow.score}. ` +
            'The composition is not monotonic, which the prompt requires and the roadmap relies on.'
        );
        process.exit(1);
    }

    console.log(`[check] OK: ${quick.score} > ${slow.score}, so the order the prompt requires holds.`);
}

await main();
