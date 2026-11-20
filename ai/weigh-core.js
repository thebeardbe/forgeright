/**
 * Weighing core: workflow 3, one process and its steps, producing one number with the terms behind it and a
 * paragraph explaining it.
 *
 * The model composes the terms into the number and the code checks and stores them, so a model cannot
 * return a number with no breakdown. The composition is provisional and tunable by editing the prompt,
 * which means two runs can weight the same terms differently.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateText } from './provider.js';
import { checkPromptInjection, stripControlCharsDeep } from './security.js';
import { capMessage, capAdminReasoning, capParticipantString } from './prompt-budget.js';
import { proseSaidIn, declinedIn } from './field-shapes.js';
import { extractJsonObject } from './json-extract.js';
import { withFormatCommitment } from './format-commitment.js';
import { mergeProcessSteps } from './merge-steps.js';
import { responseWorkflow } from './response-shape.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.join(__dirname, '..', 'data', 'prompts');

const SUPPORTED_LANGS = ['nl', 'en', 'fr'];

/** Loads the weighing prompt, falling back to English then Dutch, or null. */
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
 * The user turn carrying the process to weigh. Nothing that identifies a person travels: the participant
 * count is a number, the departments are names, and no response id. A caller's own totals are not sent,
 * because handing the model a pre-computed total would invite it to copy that.
 *
 * @param {object} args
 * @param {object} args.process The process row.
 * @param {object} args.grouping The current revision and the responses behind it.
 * @param {string} [args.adminReasoning] An admin's argument, when this follows a rejudge.
 * @returns {string}
 */
export function buildWeighingMessage({ process, grouping, adminReasoning = null }) {
    const parts = [];

    // THE ADMIN'S ARGUMENT GOES FIRST, and the reason is measured. This message used to end with it,
    // and a document bound cuts at the END: on the demo data a weighing message carrying a rejudge
    // argument is 3145 characters, so at the old 3000-character cut the argument was removed
    // ENTIRELY and the model weighed without it. That is precisely the case a rejudge exists for.
    //
    // FIRST, not merely "marked": whatever is at the end is what a truncation loses, and no marker
    // protects text that is no longer there.
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
        parts.push('');
    }

    parts.push('## The process to weigh');
    parts.push('');
    parts.push(`name: ${process.name}`);
    parts.push('');

    // Merged across everyone who described it: the numbers belong to the process, not one response.
    // COMPACT, not pretty-printed: indentation is 23% of a payload and buys the model nothing.
    const merged = mergeParticipants(grouping?.responses ?? []);
    parts.push('## What the participants said');
    parts.push('');
    parts.push(JSON.stringify(merged));
    parts.push('');

    parts.push('## The steps, in order');
    parts.push('');
    parts.push(
        'Each step carries `decidedHow` (the basis the participant gave) and '
        + '`needsReasoning` (whether that basis is a rule or a judgement).'
    );
    parts.push('');
    parts.push(JSON.stringify(collectSteps(grouping?.responses ?? [])));
    parts.push('');

    parts.push(`Described by ${grouping?.responses?.length ?? 0} participant(s).`);

    return parts.join('\n');
}

/**
 * A field the participant was asked about and did not answer, labelled for the weighing model. "Not
 * measured" is not "nothing here": a model reading a raw `{"declined":"I have no idea"}` beside numbers
 * could read the refusal as a figure, or ignore the field without knowing why it was empty.
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
 * The participant's words, labelled so the weighing model knows they are words: every other value in this
 * payload is a number, a list or a short phrase, so a bare string in a numeric field reads as a figure.
 * The wording is untouched and the explanation sits beside it.
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
 * The participant-supplied fields, folded into one view of the process. Where participants disagree, both
 * values are kept rather than averaged, because averaging would invent a number nobody gave.
 *
 * `data` must be resolved through `responseWorkflow` before any field is read, or a flat-shape payload
 * weighs as unmeasured. Prose is labelled rather than filtered out, because the model decides whether it
 * is usable.
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
                // THE PER-STRING BOUND BELONGS HERE, on one participant's words for one field.
                if (said !== null) return proseForWeighing(capParticipantString(said, `weigh ${field}`));
                const declined = declinedIn(value);
                if (declined !== null) {
                    return declinedForWeighing(
                        declined.words === null
                            ? null
                            : capParticipantString(declined.words, `weigh ${field} (declined)`)
                    );
                }
                // Anything else is a number, a list or a short phrase; strip control characters from
                // its strings without capping, because the document budget covers the whole message.
                return stripControlCharsDeep(value);
            })
            .filter((value) => value !== undefined && value !== null);

        if (values.length === 0) continue;

        // One participant: the value as given.
        if (values.length === 1) {
            merged[field] = values[0];
            continue;
        }

        // Several: distinct values as a list, so a disagreement is visible.
        const distinct = dedupe(values);
        merged[field] = distinct.length === 1 ? distinct[0] : distinct;
    }

    return merged;
}

/**
 * The steps across every response, merged by name into one sequence. Concatenating them would send each
 * step once per participant, and because `reasoningSteps` is a cost, the inflated list scores lower than
 * the description supports. It is the same merge the roadmap displays, and nothing is dropped, because
 * merging by name collapses duplicates rather than intersecting.
 *
 * @param {Array<object>} responses Responses with `data` parsed, in either stored shape.
 * @returns {Array<object>} Steps in first-seen order, one entry per distinct name.
 */
function collectSteps(responses) {
    // A step is participant text too, so each of its strings meets the per-string bound here rather
    // than the whole list meeting a document bound later.
    return stripControlCharsDeep(mergeProcessSteps(responses).steps).map((step) => {
        if (!step || typeof step !== 'object') return step;
        const capped = { ...step };
        for (const key of ['name', 'whatHappens', 'decidedHow', 'needsReasoningNote']) {
            if (typeof capped[key] === 'string') {
                capped[key] = capParticipantString(capped[key], `weigh step.${key}`);
            }
        }
        return capped;
    });
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

    // The admin's argument is capped as a string here, so one paragraph cannot spend the whole
    // document budget, and the message is then capped as a document.
    const message = capMessage(
        buildWeighingMessage({ process, grouping, adminReasoning: capAdminReasoning(adminReasoning, 'weigh') }),
        'weigh'
    );

    // THE SCREENING IS UNCHANGED AND STILL COVERS THE WHOLE MESSAGE. Truncation and injection
    // detection are different concerns: the admin's reasoning is screened deliberately, so a
    // compromised admin account is not also an instruction. It is screened AFTER the cap, so what is
    // screened is exactly what the model receives.
    const cleaned = message;
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
 * Parses a weighing reply out of the model's text, shape only: the terms and the score are checked by
 * `validateWeighing` in lib/store/weighing.js. A reply with no JSON is reported with what came back, so it
 * is diagnosable from the log.
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
