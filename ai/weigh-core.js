/**
 * Weighing core: workflow 3.
 *
 * Takes ONE process with its steps and produces **one number**, with the terms
 * behind it and a paragraph explaining it. A third session, separate from the
 * interview and from identification, whose only job is the number.
 *
 * THE MODEL REASONS, THE CODE DECIDES. The model reports a score, ten term scores
 * and a paragraph; `validateWeighing` in lib/store/weighing.js checks the shape and
 * refuses anything unusable, and the caller stores what survives.
 *
 * THE FORMULA IS PROVISIONAL, AND THE SPLIT IS DELIBERATE: THE MODEL COMPOSES THE
 * TERMS INTO THE NUMBER, THE CODE CHECKS AND STORES THEM. The spec marks the
 * composition provisional and says it is fine-tuned once there are real responses.
 * Putting it in the model means it can be tuned by editing the prompt, with no
 * deploy and no version of the arithmetic to reconcile; putting the TERMS in code
 * means the shape is still enforced, so a model cannot return a number with no
 * breakdown behind it. The cost of that choice is real and worth stating: two
 * models could weight the same terms differently, so the number is comparable
 * within one set of processes and not necessarily between runs.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateText } from './provider.js';
import { sanitizeInput, checkPromptInjection } from './security.js';
import { extractJsonObject } from './json-extract.js';
import { withFormatCommitment } from './format-commitment.js';
import { mergeProcessSteps } from './merge-steps.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.join(__dirname, '..', 'data', 'prompts');

const SUPPORTED_LANGS = ['nl', 'en', 'fr'];

/**
 * Loads the weighing prompt, falling back to English then Dutch.
 *
 * Returns null rather than throwing so the caller reports a clean error instead of
 * a stack trace, matching how the other two prompts are loaded.
 */
async function loadWeighPrompt(toolId, lang) {
    for (const candidate of [lang, 'en', 'nl']) {
        const file = path.join(PROMPTS_DIR, toolId, `weigh_${candidate}.md`);
        try {
            return await fs.readFile(file, 'utf8');
        } catch (err) {
            if (err.code !== 'ENOENT') throw err;
        }
    }
    return null;
}

/**
 * The user turn carrying the process to weigh.
 *
 * ONLY WHAT THE WEIGHING NEEDS, and nothing that identifies a person: the
 * participant count is a number, the departments are names, and no response id
 * travels. The process's identity is irrelevant to the number, so sending it would
 * only widen what a model sees.
 *
 * The steps are included IN FULL, with `needsReasoning` and `decidedHow`, because
 * the spec says every step is considered and the flag is where the automation
 * stops. A caller's own totals are NOT sent: the prompt tells the model to weigh
 * the steps, and handing it a pre-computed total would invite it to copy that.
 *
 * @param {object} args
 * @param {object} args.process The process row.
 * @param {object} args.grouping The current revision and the responses behind it.
 * @param {string} [args.adminReasoning] An admin's argument, when this follows a rejudge.
 * @returns {string}
 */
export function buildWeighingMessage({ process, grouping, adminReasoning = null }) {
    const parts = [];

    parts.push('## The process to weigh');
    parts.push('');
    parts.push(`name: ${process.name}`);
    parts.push('');

    // The participant fields, merged across everyone who described it. Read from
    // the responses rather than from a single one, because a merged process has
    // several and the numbers belong to the process.
    const merged = mergeParticipants(grouping?.responses ?? []);
    parts.push('## What the participants said');
    parts.push('');
    parts.push(JSON.stringify(merged, null, 2));
    parts.push('');

    parts.push('## The steps, in order');
    parts.push('');
    parts.push(
        'Each step carries `decidedHow` (the basis the participant gave) and '
        + '`needsReasoning` (whether that basis is a rule or a judgement).'
    );
    parts.push('');
    parts.push(JSON.stringify(collectSteps(grouping?.responses ?? []), null, 2));
    parts.push('');

    parts.push(`Described by ${grouping?.responses?.length ?? 0} participant(s).`);
    parts.push('');

    if (adminReasoning) {
        parts.push('## An admin disputes the current result, and says why');
        parts.push('');
        parts.push(adminReasoning);
        parts.push('');
        parts.push(
            'This process has been regrouped on that argument, so weigh the grouping you are '
            + 'given here. If the admin reasoning changes how the terms should be read, say so '
            + 'in your paragraph.'
        );
    }

    return parts.join('\n');
}

/**
 * The participant-supplied fields, folded into one view of the process.
 *
 * WHERE SEVERAL PARTICIPANTS DISAGREE, BOTH VALUES ARE KEPT as a list rather than
 * averaged. Averaging would invent a number nobody gave, and the disagreement is
 * itself information the weighing should see: two people who disagree about the
 * frequency may be describing two different steps of the same work.
 *
 * @param {Array<object>} responses Responses with `data` parsed.
 * @returns {object}
 */
function mergeParticipants(responses) {
    const fields = ['task', 'trigger', 'frequencyPerWeek', 'timePerPeriod', 'peopleAffected',
        'handoffTo', 'waitsFor', 'dependsOn', 'systems', 'touchedDepartments',
        'mistakesPerPeriod', 'mistakeConsequence', 'currentState', 'frustration'];

    const merged = {};

    for (const field of fields) {
        const values = responses
            .map((response) => response.data?.[field])
            .filter((value) => value !== undefined && value !== null);

        if (values.length === 0) continue;

        // One participant: the value as given, so the common case reads plainly.
        if (values.length === 1) {
            merged[field] = values[0];
            continue;
        }

        // Several: distinct values as a list, so a disagreement is visible and no
        // number is invented by combining them.
        const distinct = dedupe(values);
        merged[field] = distinct.length === 1 ? distinct[0] : distinct;
    }

    return merged;
}

/**
 * The steps across every response, MERGED BY NAME into one sequence.
 *
 * THIS USED TO CONCATENATE, AND THAT CHANGED SCORES. Every participant describing
 * the same work lists the same steps, so concatenating sent the model each step
 * once per participant: on the fixture's two accounts of invoice processing, NINE
 * step entries for FIVE distinct steps. The prompt asks the model to return
 * `reasoningSteps` - how many steps need a person - and that term is a COST, so a
 * model shown nine steps where five exist counts nine, and the process scores
 * lower than its own description supports. The inflation grew with the number of
 * people who described the process, which is backwards: more agreement made the
 * work look worse.
 *
 * THE SAME MERGE THE ROADMAP DISPLAYS, from `ai/merge-steps.js`, so the list the
 * model weighs and the list a reader sees are one list rather than two
 * derivations of it. It also settles the flags the same way, taking `true` when
 * two accounts disagree, because the automation boundary is where a person is
 * still needed.
 *
 * NOTHING IS DROPPED. A step only one participant mentioned survives: the fixture
 * carries the case deliberately ("Query a mismatch" exists in one account only),
 * and it is a real step somebody does. Merging by name collapses duplicates, it
 * does not intersect.
 *
 * @param {Array<object>} responses
 * @returns {Array<object>} Steps in first-seen order, one entry per distinct name.
 */
function collectSteps(responses) {
    return mergeProcessSteps(responses).steps;
}

/** Distinct values, compared by their JSON form so objects and arrays work. */
function dedupe(values) {
    const seen = new Map();
    for (const value of values) seen.set(JSON.stringify(value), value);
    return [...seen.values()];
}

/**
 * Runs weighing for one process.
 *
 * @param {object} args
 * @param {object} args.process The process row.
 * @param {object} args.grouping The current revision, with the responses behind it.
 * @param {string} [args.lang]
 * @param {string} [args.toolId]
 * @param {string} [args.adminReasoning] The admin's argument, when this follows a rejudge.
 * @returns {Promise<object>} The parsed model reply, or {status:'error', ...}.
 */
export async function runWeighing({
    process,
    grouping,
    lang = 'en',
    toolId = 'cartiere_audit',
    adminReasoning = null
}) {
    const safeLang = SUPPORTED_LANGS.includes(lang) ? lang : 'en';

    const systemPrompt = await loadWeighPrompt(toolId, safeLang);
    if (!systemPrompt) {
        throw new Error(`No weighing prompt found for tool "${toolId}" in ${PROMPTS_DIR}`);
    }

    const message = buildWeighingMessage({ process, grouping, adminReasoning });

    // The same guardrail as the other two, for the same reason: participant text is
    // about to be placed in a prompt. The admin's reasoning is screened like
    // everything else, so a compromised admin account is not also an instruction.
    const cleaned = sanitizeInput(message);
    if (await checkPromptInjection(cleaned)) {
        console.warn('[weigh] blocked an input that matched an injection pattern');
        return {
            status: 'rejected',
            content: 'That text looks like an instruction to the system rather than a description of the work.'
        };
    }

    const raw = await generateText({
        // The trailing commitment, from the shared helper: without it a model
        // answers as prose at length. Measured, not assumed.
        messages: withFormatCommitment([{ role: 'user', content: cleaned }]),
        systemInstruction: systemPrompt,
        temperature: 0.2,
        // MEASURED, NOT COPIED FROM THE OTHER TWO WORKFLOWS.
        //
        // A weighing prompt is much longer than an interview turn: the whole
        // process, every step, and a demand for a paragraph. At 2048 the reply is
        // cut off mid-object and the extractor correctly refuses the fragment, so
        // the failure looks like a bad model until the truncation point is read.
        //
        // A LARGER CAP FIXES IT, AND THE MECHANISM IS NOT UNDERSTOOD.
        //
        // The measurement, reproduced: at 2048, three runs returned 162, 1348 and
        // 163 characters, and only the long one parsed. At 4096: 505, 1320, 481,
        // one parsed. At 8192: 1139, 1101, 1243, all parsed.
        //
        // **A failed reply is SHORTER than a good one**, so it is not the output
        // budget being exhausted - a consumed budget would cut a long reply short,
        // not produce a 162-character stub. What is measured is that the failure
        // rate falls as the cap rises, which is all this comment should claim.
        //
        // The earlier explanation here - that Gemini counts the request against the
        // cap - was a guess that the same numbers contradict, so it is removed
        // rather than left as a plausible story. If this recurs at 8192, diagnose
        // it properly rather than raising the number again.
        //
        // The cost is latency on a longer allowance; the alternative is a
        // weighing that fails intermittently, which is worse for a step whose
        // output is the deliverable.
        maxTokens: 8192,
        responseMimeType: 'application/json',
        lang: safeLang
    });

    return parseWeighingResponse(raw);
}

/**
 * Parses a weighing reply out of the model's text.
 *
 * SHAPE ONLY: the terms and the score are checked by `validateWeighing` in
 * lib/store/weighing.js, so the rules about a missing term and a non-numeric score
 * live in one place rather than one per caller.
 *
 * A reply with no JSON is reported as an error with what came back, matching the
 * other two workflows: an unreadable reply has to be diagnosable from the log.
 *
 * @param {string} raw
 * @returns {object} The parsed reply, or {status:'error', content, reason}.
 */
export function parseWeighingResponse(raw) {
    const parsed = extractJsonObject(raw);
    if (parsed === null) {
        console.error(
            `[weigh] no JSON object in the model reply (${String(raw).length} chars): ` +
            (String(raw).trim() === '' ? '(blank reply)' : JSON.stringify(String(raw).slice(0, 120)))
        );
        return {
            status: 'error',
            reason: 'no JSON object in the model reply',
            content: 'The weighing service returned an unreadable response.'
        };
    }

    return parsed;
}
