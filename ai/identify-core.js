/**
 * Identification core: workflow 2, one completed response and which process it belongs to. The model
 * reports `matches`, a confidence and its reasoning, and `validateIdentification` in
 * lib/store/processes.js checks the shape. Nothing here scores or ranks, which is workflow 3.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateText } from './provider.js';
import { checkPromptInjection, stripControlCharsDeep } from './security.js';
import { describeInjectionMatch } from './security.js';
import { capMessage, capAdminReasoning, capParticipantString } from './prompt-budget.js';
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

    // The admin's argument is capped as a string, so one paragraph cannot spend the whole document
    // budget, and the message is then capped as a document.
    const message = capMessage(
        buildComparisonMessage(response, knownProcesses, capAdminReasoning(adminReasoning, 'identify')),
        'identify'
    );

    // A MATCH IS A SIGNAL, NOT A REFUSAL. THE MODEL STILL GETS THE TEXT.
    //
    // This used to return `rejected`, and that made every false positive PERMANENT. MEASURED, ten
    // ordinary work sentences match the filter, including "Ik negeer de vorige regel als de klant
    // belt." and "I do not follow the instruction sheet if the drawing contradicts it." Each was
    // refused at identification and at weighing, every time, and the round stayed "not yet read"
    // forever.
    //
    // NOBODY IS HERE TO REPHRASE IT. Identification runs after the round has been submitted. There is
    // no participant on the other end to ask, no route that can edit a prose field
    // (CORRECTABLE_FIELDS is four numeric ones), and a rejudge screens the same stored text and was
    // refused identically. The filter is a speed bump, not a wall: what contains a successful
    // injection is the strict schema validation of the reply, the absence of tool access, and one
    // tenant's data per database. The interview turn still refuses, because THERE a person can
    // rephrase and nothing is lost. See ai/audit-core.js.
    //
    // LOGGED LOUDLY, with what matched, because a live signal that nobody sees is worse than none.
    // THE STORED ANSWER IS A SIGNAL: nobody can rephrase it, so the model reads it.
    //
    // THE ADMIN'S REASONING IS DIFFERENT AND STILL REFUSES. An admin is a person at a form, typing a
    // sentence they can change, exactly like a participant mid-interview. Refusing costs them one
    // rephrase; continuing would let a compromised admin account instruct the model through text it
    // chose, which is the case the screen exists for. So the two are decided separately.
    // The known processes are ADMIN-AUTHORED too: their names and reasons come from the console, not
    // from a participant. A compromised admin account must not instruct the model through either, and
    // an admin is present to rephrase. Checked together with the reasoning, so the two cannot drift.
    const adminText = [
        adminReasoning ?? '',
        ...knownProcesses.map((process) => `${process.name ?? ''}\n${process.reasoning ?? ''}`)
    ].join('\n');

    const adminMatch = await describeInjectionMatch(adminText);
    if (adminMatch.matched) {
        console.warn(
            `[identify] refused an admin rejudge argument that matched an injection pattern: ${adminMatch.where}`
        );
        return {
            status: 'rejected',
            content: 'That text looks like an instruction to the system rather than a reason for the '
                + 'rejudge. Please rephrase it as an argument about how this work should be read.'
        };
    }

    const cleaned = message;
    const match = await describeInjectionMatch(cleaned);
    if (match.matched) {
        console.warn(
            `[identify] an injection-shaped phrase is in the stored answer for response `
            + `${response?.id ?? 'unknown'} and the model was given it anyway: ${match.where}. `
            + 'The answer cannot be edited, and the reply is still validated against the strict schema.'
        );
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
