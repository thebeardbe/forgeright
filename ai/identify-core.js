/**
 * Identification core: workflow 2.
 *
 * Takes ONE completed response and decides which process it belongs to. A second
 * session, separate from the interview, whose only job is sameness.
 *
 * THE MODEL REASONS, THE CODE DECIDES. The model reports `matches`, a confidence
 * and its reasoning; `validateIdentification` in lib/store/processes.js checks the
 * shape and refuses anything unusable, and the caller stores what survives. Nothing
 * here scores, ranks or advises -- that is workflow 3, deliberately not built.
 *
 * SAME DISCIPLINE AS THE INTERVIEW, and the same two helpers, because a second
 * extraction path would be a second thing to keep right: `extractJsonObject` for a
 * reply that arrives as prose (DeepSeek is asked in plain mode) and
 * `withFormatCommitment` for the trailing turn that keeps a long conversation in
 * JSON. Neither is reimplemented here.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateText } from './provider.js';
import { sanitizeInput, checkPromptInjection } from './security.js';
import { extractJsonObject } from './json-extract.js';
import { withFormatCommitment } from './format-commitment.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.join(__dirname, '..', 'data', 'prompts');

const SUPPORTED_LANGS = ['nl', 'en', 'fr'];

/**
 * Loads the identification prompt, falling back to English then Dutch.
 *
 * Returns null rather than throwing so the caller reports a clean error instead of
 * a stack trace, matching how the interview prompt is loaded.
 */
async function loadIdentifyPrompt(toolId, lang) {
    for (const candidate of [lang, 'en', 'nl']) {
        const file = path.join(PROMPTS_DIR, toolId, `identify_${candidate}.md`);
        try {
            return await fs.readFile(file, 'utf8');
        } catch (err) {
            if (err.code !== 'ENOENT') throw err;
        }
    }
    return null;
}

/**
 * The user turn carrying the comparison: the new response and the known processes.
 *
 * SENT AS THE USER TURN rather than folded into the system prompt, because it is
 * the data under comparison and it changes per call. The system prompt states the
 * rules, which do not change.
 *
 * Only the fields a decision needs are sent. The full transcripts are NOT sent:
 * they are stored so a person can read them, and shipping several conversations
 * into every comparison would be a large cost for text the decision does not use.
 *
 * @param {object} response The response row, with `data` parsed.
 * @param {Array<object>} knownProcesses Existing processes with their reasoning.
 * @param {string} [adminReasoning] An admin's argument, when this is a rejudge.
 * @returns {string}
 */
export function buildComparisonMessage(response, knownProcesses, adminReasoning = null) {
    const parts = [];

    // THE RAW STORED SHAPE GOES TO THE MODEL, and it is the one remaining place where
    // the two shapes are read differently - a live round sends `{ workflows: [...] }`,
    // an imported one sends the workflow directly. Identical results were measured live
    // against the provider on both shapes, because a language model reads through the
    // wrapper where a field lookup cannot. That is what makes it safe HERE and not
    // elsewhere: anything that reads a NAMED field must resolve the shape first, or it
    // finds nothing and reports the work as unmeasured.
    parts.push('## The new response to identify');
    parts.push('');
    parts.push(JSON.stringify(response.data ?? {}, null, 2));

    parts.push('');
    parts.push('## Processes already identified for this organisation');
    parts.push('');
    if (knownProcesses.length === 0) {
        parts.push('(none yet, so this is a new process)');
    } else {
        for (const process of knownProcesses) {
            parts.push(`### ${process.id}`);
            parts.push(`name: ${process.name}`);
            if (process.reasoning) parts.push(`why it exists: ${process.reasoning}`);
            parts.push('');
        }
    }

    // A rejudge carries the admin's argument, which is the whole reason the prompt
    // allows a name change and a re-merge: the model is being given a reason to
    // reconsider, not a category to apply.
    if (adminReasoning) {
        parts.push('## An admin disagrees with the current grouping, and says why');
        parts.push('');
        parts.push(adminReasoning);
        parts.push('');
        parts.push(
            'Weigh that reasoning. If it is right, say so and re-group accordingly; if it is '
            + 'wrong, explain why. Either way, give your reasoning for the result.'
        );
    }

    return parts.join('\n');
}

/**
 * Runs identification for one response.
 *
 * @param {object} args
 * @param {object} args.response The response row being identified (with data parsed).
 * @param {Array<object>} args.knownProcesses Existing processes, each with id, name
 *   and the current revision's reasoning.
 * @param {string} [args.lang]
 * @param {string} [args.toolId]
 * @param {string} [args.adminReasoning] The admin's argument, for a rejudge.
 * @returns {Promise<object>} The parsed model reply, or {status:'error', ...}.
 */
export async function runIdentification({
    response,
    knownProcesses = [],
    lang = 'en',
    toolId = 'cartiere_audit',
    adminReasoning = null
}) {
    const safeLang = SUPPORTED_LANGS.includes(lang) ? lang : 'en';

    const systemPrompt = await loadIdentifyPrompt(toolId, safeLang);
    if (!systemPrompt) {
        throw new Error(`No identification prompt found for tool "${toolId}" in ${PROMPTS_DIR}`);
    }

    const message = buildComparisonMessage(response, knownProcesses, adminReasoning);

    // The same guardrail as the interview, for the same reason: this text came from
    // a participant and is about to be placed in a prompt. The admin's reasoning is
    // included deliberately, because it is an authorised instruction rather than
    // participant input, and it is screened like everything else so a compromise of
    // the admin account is not also an instruction to the model.
    const cleaned = sanitizeInput(message);
    if (await checkPromptInjection(cleaned)) {
        console.warn('[identify] blocked an input that matched an injection pattern');
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
        maxTokens: 1024,
        responseMimeType: 'application/json',
        lang: safeLang
    });

    return parseIdentificationResponse(raw);
}

/**
 * Parses and shape-checks an identification reply.
 *
 * WITHOUT THIS, A GROUPING IS STORED AS THE MODEL WORDED IT. The check is
 * `validateIdentification` in lib/store/processes.js, which is where the rules
 * about a real `matches` id and a required `reasoning` live, so there is one
 * definition rather than one per caller.
 *
 * A reply with no JSON is reported as an error with what came back, matching the
 * interview's behaviour: an unreadable reply has to be diagnosable from the log,
 * not from a live investigation.
 *
 * @param {string} raw
 * @returns {object} The parsed reply, or {status:'error', content, reason}.
 */
export function parseIdentificationResponse(raw) {
    const parsed = extractJsonObject(raw);
    if (parsed === null) {
        console.error(
            `[identify] no JSON object in the model reply (${String(raw).length} chars): ` +
            (String(raw).trim() === '' ? '(blank reply)' : JSON.stringify(String(raw).slice(0, 120)))
        );
        return {
            status: 'error',
            reason: 'no JSON object in the model reply',
            content: 'The identification service returned an unreadable response.'
        };
    }

    return parsed;
}
