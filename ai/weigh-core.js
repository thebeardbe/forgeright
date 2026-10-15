/**
 * Weighing core: workflow 3, one process and its steps, producing one number with the terms behind it
 * and a paragraph explaining it.
 *
 * The model composes the terms into the number and the code checks and stores them: the composition is
 * provisional and tunable by editing the prompt, while `validateWeighing` in lib/store/weighing.js
 * enforces the shape so a model cannot return a number with no breakdown. The cost is real: two runs can
 * weight the same terms differently, so the number is comparable within one set of processes and not
 * necessarily between runs.
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
 * Loads the weighing prompt, falling back to English then Dutch. It returns null rather than throwing
 * so the caller reports a clean error instead of a stack trace, matching the other two prompts.
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
 * The user turn carrying the process to weigh. Only what the weighing needs, and nothing that
 * identifies a person: the participant count is a number, the departments are names, and no response id
 * travels. The steps are included in full, with `needsReasoning` and `decidedHow`, because every step is
 * considered and the flag is where the automation stops. A caller's own totals are not sent, because
 * handing the model a pre-computed total would invite it to copy that.
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

    // The participant fields, merged across everyone who described it: a merged process has several
    // responses and the numbers belong to the process.
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
 * A field the participant was asked about and did not answer, labelled for the weighing model. "Not
 * measured" is not "nothing here": a term that could not be measured is unknown, while a genuinely zero
 * term is a fact, and a model reading a raw `{"declined":"I have no idea"}` beside numbers could read
 * the refusal as a figure or ignore the field without knowing why it was empty.
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
 * The participant's words, labelled so the weighing model knows they are words. Every other value in
 * this payload is a number, a list or a short phrase, so a bare string in a numeric field reads as a
 * figure: `peopleAffected: "just me"` invites the model to score a count from it. It is a shape rather
 * than a rewrite, so the wording is untouched and the explanation sits beside it.
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
 * The participant-supplied fields, folded into one view of the process. Where participants disagree,
 * both values are kept as a list rather than averaged, because averaging would invent a number nobody
 * gave and the disagreement is itself information.
 *
 * `data` is in either stored shape and is resolved through `responseWorkflow` before any field is read,
 * so a reader that assumed the flat shape would find no fields and weigh the work as unmeasured. A prose
 * answer is labelled before it reaches the model, because the model decides whether prose is usable
 * rather than this code, and it is not filtered out, because excluding it here would decide on the
 * model's behalf.
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

        // Several: distinct values as a list, so a disagreement is visible and no number is invented
        // by combining them.
        const distinct = dedupe(values);
        merged[field] = distinct.length === 1 ? distinct[0] : distinct;
    }

    return merged;
}

/**
 * The steps across every response, merged by name into one sequence. Concatenating them would send each
 * step once per participant, and because `reasoningSteps` is a cost, a model shown the inflated list
 * scores the process lower than its own description supports. It is the same merge the roadmap displays,
 * so the list the model weighs and the list a reader sees are one list, and nothing is dropped because
 * merging by name collapses duplicates rather than intersecting.
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

    // The same guardrail as the other two: participant text is about to be placed in a prompt, and the
    // admin's reasoning is screened like everything else so a compromised admin account is not also an
    // instruction.
    const cleaned = sanitizeInput(message);
    if (await checkPromptInjection(cleaned)) {
        console.warn('[weigh] blocked an input that matched an injection pattern');
        return {
            status: 'rejected',
            content: 'That text looks like an instruction to the system rather than a description of the work.'
        };
    }

    const raw = await generateText({
        messages: withFormatCommitment([{ role: 'user', content: cleaned }]),
        systemInstruction: systemPrompt,
        temperature: 0.2,
        // Do not lower this to the other workflows' cap. A weighing prompt is much longer than an
        // interview turn, and below this the reply is cut off mid-object, which the extractor correctly
        // refuses, so the failure looks like a bad model until the truncation point is read.
        maxTokens: 8192,
        responseMimeType: 'application/json',
        lang: safeLang
    });

    return parseWeighingResponse(raw);
}

/**
 * Parses a weighing reply out of the model's text. Shape only: the terms and the score are checked by
 * `validateWeighing` in lib/store/weighing.js, so the rules about a missing term and a non-numeric score
 * live in one place. A reply with no JSON is reported as an error with what came back, so an unreadable
 * reply is diagnosable from the log.
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
