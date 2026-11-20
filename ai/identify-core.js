/**
 * Identification core: workflow 2, one completed response and which process it belongs to. The model
 * reports `matches`, a confidence and its reasoning, and `validateIdentification` in
 * lib/store/processes.js checks the shape. Nothing here scores or ranks, which is workflow 3.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateText } from './provider.js';
import { sanitizeInput, checkPromptInjection, stripControlCharsDeep } from './security.js';
import { capParticipantString } from './prompt-budget.js';
import { extractJsonObject } from './json-extract.js';
import { withFormatCommitment } from './format-commitment.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.join(__dirname, '..', 'data', 'prompts');

const SUPPORTED_LANGS = ['nl', 'en', 'fr'];

/** Loads the identification prompt, falling back to English then Dutch, or null. */
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
 * The user turn carrying the comparison: the new response and the known processes. Sent as the user turn
 * rather than folded into the system prompt, because it is the data under comparison and changes per call.
 * The full transcripts are not sent: they are a large cost for text the decision does not use.
 *
 * @param {object} response The response row, with `data` parsed.
 * @param {Array<object>} knownProcesses Existing processes with their reasoning. Each may carry
 *   `isCurrentHome: true` for the process this response is already in.
 * @param {string} [adminReasoning] An admin's argument, when this is a rejudge.
 * @returns {string}
 */
export function buildComparisonMessage(response, knownProcesses, adminReasoning = null) {
    const parts = [];

    // THE ADMIN'S ARGUMENT GOES FIRST. It used to be last, after the known-processes list, so once an
    // organisation had grown the list alone exceeded the document bound and the argument was removed
    // entirely. FIRST, not merely marked: what is at the end is what a truncation loses.
    if (adminReasoning) {
        parts.push('## An admin disagrees with the current grouping, and says why');
        parts.push('');
        parts.push(adminReasoning);
        parts.push('');
        parts.push(
            'THIS IS A REJUDGE, NOT A RE-GROUPING. The admin is disputing how this process was '
            + 'READ, not which responses belong to it.'
        );
        parts.push('');
        parts.push(
            'UNLESS THE ARGUMENT IS EXPLICITLY ABOUT WHICH WORK THIS IS, keep the response where '
            + 'it already is: answer `matches` with the id of the process marked as its current '
            + 'home. A new process is only right when the admin says this answer describes '
            + 'DIFFERENT work.'
        );
        parts.push('');
        parts.push(
            'If the argument is right, say so and explain how the reading should change - the '
            + 'weighing receives the same argument and applies it to the terms. If it is wrong, '
            + 'explain why. Either way, give your reasoning for the result.'
        );
        parts.push('');
    }

    // THE PROCESS LIST COMES NEXT, before the response being identified, for the same reason: it is
    // what the model compares against, and losing its tail is what makes the model invent a
    // duplicate of a process that already exists.
    parts.push('## Processes already identified for this organisation');
    parts.push('');
    if (knownProcesses.length === 0) {
        parts.push('(none yet, so this is a new process)');
    } else {
        for (const process of knownProcesses) {
            parts.push(`### ${process.id}`);
            parts.push(`name: ${process.name}`);
            // Naming the current home stops a rejudge spawning a sibling.
            if (process.isCurrentHome === true) {
                parts.push('THIS IS WHERE THE RESPONSE IS NOW. It is already in this process, so '
                    + 'matching it here means the grouping does not change.');
            }
            if (process.reasoning) parts.push(`why it exists: ${process.reasoning}`);
            parts.push('');
        }
    }

    // The response being identified goes LAST: it is one response, bounded per field, so it is the
    // smallest and safest thing to lose if this document ever meets its budget.
    parts.push('## The new response to identify');
    parts.push('');
    parts.push(JSON.stringify(capResponseData(response.data ?? {})));

    return parts.join('\n');
}

/**
 * One response's payload with each string capped at the per-string bound, and no indentation.
 *
 * Compact because indentation is 23% of a payload measured on the demo data, and it buys the model
 * nothing. Per string because 3000 characters is a bound on one participant's words, which is what
 * each of these values is.
 *
 * @param {object} data the response's data, either stored shape
 * @returns {object}
 */
function capResponseData(data) {
    const stripped = stripControlCharsDeep(data);
    const bounded = (value) => {
        if (typeof value === 'string') return capParticipantString(value, 'identify response field');
        if (Array.isArray(value)) return value.map(bounded);
        if (value && typeof value === 'object') {
            const out = {};
            for (const [key, inner] of Object.entries(value)) out[key] = bounded(inner);
            return out;
        }
        return value;
    };
    return bounded(stripped);
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

    // Participant text is about to be placed in a prompt. The admin's reasoning is deliberately included,
    // because it is an authorised instruction, and screened like everything else so a compromised admin
    // account is not also an instruction to the model.
    const cleaned = sanitizeInput(message);
    if (await checkPromptInjection(cleaned)) {
        console.warn('[identify] blocked an input that matched an injection pattern');
        return {
            status: 'rejected',
            content: 'That text looks like an instruction to the system rather than a description of the work.'
        };
    }

    const raw = await generateText({
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
 * Parses and shape-checks an identification reply. The check is `validateIdentification` in
 * lib/store/processes.js, where the rules about a real `matches` id and a required `reasoning` live. A
 * reply with no JSON is reported with what came back, so it is diagnosable from the log.
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
