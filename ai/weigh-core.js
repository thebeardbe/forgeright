/**
 * Weighing core: workflow 3 - one process and its steps, producing one number with the terms
 * behind it and a paragraph explaining it.
 *
 * THE MODEL COMPOSES THE TERMS INTO THE NUMBER; THE CODE CHECKS AND STORES THEM. The composition
 * is provisional and tunable by editing the prompt, while `validateWeighing` in
 * lib/store/weighing.js enforces the shape so a model cannot return a number with no breakdown.
 * THE COST, which is real: two runs can weight the same terms differently, so the number is
 * comparable within one set of processes and not necessarily between runs.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateText } from './provider.js';
import { sanitizeInput, checkPromptInjection } from './security.js';
import { proseSaidIn, declinedIn } from './field-shapes.js';
import { extractJsonObject } from './json-extract.js';
import { withFormatCommitment } from './format-commitment.js';
import { mergeProcessSteps } from './merge-steps.js';
import { responseWorkflow } from './response-shape.js';

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
 * A field the participant was asked about and did not answer, labelled for the weighing model.
 *
 * "NOT MEASURED" IS NOT "NOTHING HERE", and the note says so because the two pull apart: a term
 * that could not be measured is unknown, while a genuinely zero term is a fact. A model reading a
 * raw `{"declined":"I have no idea"}` beside numbers could read the refusal as a figure or ignore
 * the field without knowing why it was empty, and both are silent.
 *
 * NO NUMBER IS OFFERED AND NONE SHOULD BE INVENTED FROM THE WORDS. The refusal may be quoted.
 *
 * @param {string|null} words What the participant said when declining, if anything.
 * @returns {{declinedToAnswer: true, theySaid: string|null, note: string}}
 */
function declinedForWeighing(words) {
    return {
        declinedToAnswer: true,
        theySaid: words,
        note: 'The participant was asked about this field and did not answer it. This is NOT a '
            + 'value and NOT a zero: there is no measurement here. Score this term from what else '
            + 'you have, and treat it as not measured rather than as nothing. Do not infer a '
            + 'figure from any words quoted.'
    };
}

/**
 * The participant's words, labelled so the weighing model knows they are words.
 *
 * THE LABEL IS THE POINT. Every other value in this payload is a number, a list or a short phrase,
 * so a bare string in a numeric field reads as a figure - `peopleAffected: "just me"` invites the
 * model to score a count from it without being told it was prose. A SHAPE RATHER THAN A REWRITE,
 * so the wording is untouched and the explanation sits beside it; collapsing it to a bare string
 * would lose the distinction between a quoted answer and a typed one.
 *
 * @param {string} said The participant's words, already validated as non-empty.
 * @returns {{saidInTheirWords: string, note: string}}
 */
function proseForWeighing(said) {
    return {
        saidInTheirWords: said,
        note: 'This field is the participant\'s own words, not a figure. Use it if it tells you '
            + 'what you need; if it does not, treat the field as not measured rather than '
            + 'inventing a number from it.'
    };
}

/**
 * The participant-supplied fields, folded into one view of the process.
 *
 * WHERE PARTICIPANTS DISAGREE, BOTH VALUES ARE KEPT as a list rather than averaged: averaging
 * would invent a number nobody gave, and the disagreement is itself information - two people who
 * differ about the frequency may be describing two different steps of the same work.
 *
 * `data` IS IN EITHER STORED SHAPE and is resolved through `responseWorkflow` before any field is
 * read, so a reader that assumed the flat shape would find no fields and weigh the work as
 * unmeasured - and carried an EMPTY `## What the participants said` section into the prompt, the
 * same defect as the step merge.
 *
 * A PROSE ANSWER IS LABELLED BEFORE IT REACHES THE MODEL, which is the whole point of
 * `proseForWeighing`: `{ said: "just me" }` is the participant's words for a field that would not
 * take a number, and passing the raw object gives an unexplained `{"said":"..."}` where every
 * other field is a number or a list. The model decides whether prose is usable, not this code -
 * its job is to make sure the model knows "they said this" from "the figure is this".
 *
 * NOT FILTERED OUT. Excluding prose here would decide on the model's behalf that it is unusable,
 * and the weighing is exactly the place that can judge whether "just me" is a participant count.
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
            // Shape resolved, not reached into; prose labelled, not filtered. See the header.
            .map((response) => responseWorkflow(response.data)?.[field])
            .map((value) => {
                const said = proseSaidIn(value);
                if (said !== null) return proseForWeighing(said);
                const declined = declinedIn(value);
                if (declined !== null) return declinedForWeighing(declined.words);
                return value;
            })
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
 * CONCATENATING THESE CHANGED SCORES, which is why it does not. Every participant lists the same
 * steps, so concatenation sent each one per participant - MEASURED on the fixture's two accounts:
 * nine entries for five distinct steps. `reasoningSteps` is a COST, so a model shown nine where
 * five exist scores the process lower than its own description supports, and the inflation grew
 * with the number of people who described it - more agreement made the work look worse.
 *
 * THE SAME MERGE THE ROADMAP DISPLAYS, from `ai/merge-steps.js`, so the list the model weighs and
 * the list a reader sees are one list. NOTHING IS DROPPED: a step only one participant mentioned
 * survives, because merging by name collapses duplicates rather than intersecting.
 *
 * @param {Array<object>} responses Responses with `data` parsed, in either stored shape.
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
        // REPRODUCED: at 2048 three runs returned 162, 1348 and 163 characters and only the long one
        // parsed; at 8192, 1139, 1101 and 1243 all parsed. A FAILED REPLY IS SHORTER than a good
        // one, so this is not a budget being exhausted - only that the failure rate falls as the
        // cap rises. If it recurs at 8192, diagnose it rather than raising the number again.
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
