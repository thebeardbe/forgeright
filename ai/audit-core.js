/**
 * Audit conversation core.
 *
 * Runs one turn of the intake questionnaire. The model is asked to reply with a
 * JSON object of the shape:
 *
 *   { status: "asking",   content: "<next question>" }
 *   { status: "complete", content: "<closing line>", audit: { ... } }
 *
 * Keeping the model on that contract is what lets the scoring layer be pure
 * logic: it receives structured data, never prose to be parsed.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateText } from './provider.js';
import { sanitizeInput, checkPromptInjection } from './security.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.join(__dirname, '..', 'data', 'prompts');

const SUPPORTED_LANGS = ['nl', 'en', 'fr'];

/**
 * Loads a prompt, falling back to English then Dutch when a translation is
 * missing. Returns null rather than throwing so the caller can report a clean
 * error to the user instead of a stack trace.
 */
async function loadPrompt(toolId, lang) {
    for (const candidate of [lang, 'en', 'nl']) {
        const file = path.join(PROMPTS_DIR, toolId, `prompt_${candidate}.md`);
        try {
            return await fs.readFile(file, 'utf8');
        } catch (err) {
            if (err.code !== 'ENOENT') throw err;
        }
    }
    return null;
}

/**
 * @param {object} args
 * @param {Array<{role: string, content: string}>} args.messages Conversation so far.
 * @param {string} args.lang UI language.
 * @param {string} args.toolId Which prompt set to use.
 * @returns {Promise<object>} The parsed model response.
 */
export async function runAuditTurn({ messages, lang = 'en', toolId = 'cartiere_audit' }) {
    const safeLang = SUPPORTED_LANGS.includes(lang) ? lang : 'en';

    const systemPrompt = await loadPrompt(toolId, safeLang);
    if (!systemPrompt) {
        throw new Error(`No prompt found for tool "${toolId}" in ${PROMPTS_DIR}`);
    }

    // Guardrail: the model must never see unsanitised participant text.
    const safeMessages = [];
    for (const msg of messages) {
        if (msg.role !== 'user') {
            safeMessages.push(msg);
            continue;
        }

        const cleaned = sanitizeInput(msg.content);
        if (await checkPromptInjection(cleaned)) {
            // Refuse rather than pass it through. The prompt sets the same rule,
            // but this holds even if the model is persuaded to ignore it.
            console.warn('[audit] blocked an input that matched an injection pattern');
            return {
                status: 'rejected',
                content: 'That message looks like an instruction to the system rather than an answer. Could you rephrase it as a description of your workflow?'
            };
        }
        safeMessages.push({ role: msg.role, content: cleaned });
    }

    const raw = await generateText({
        messages: safeMessages,
        systemInstruction: systemPrompt,
        temperature: 0.3,
        maxTokens: 4096,
        responseMimeType: 'application/json',
        lang: safeLang
    });

    return parseModelResponse(raw);
}

/** Pluralises a count for an error message the operator reads. */
function countReason(count, singular, plural) {
    return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * Validates an audit payload's workflows.
 *
 * Exported so BOTH entry points apply the same rule: the model path
 * (`parseModelResponse`) and the HTTP path (`POST /api/score`, which takes the
 * payload straight from the client). Validating only the model path left the
 * direct route able to serve a blank heading, and duplicating the checks in two
 * places is how they drift apart.
 *
 * @param {*} workflows
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function validateWorkflows(workflows) {
    if (!Array.isArray(workflows) || workflows.length === 0) {
        return { ok: false, reason: 'workflows is missing, not an array, or empty' };
    }

    const malformed = workflows.filter((w) => !w || typeof w !== 'object' || Array.isArray(w));
    if (malformed.length > 0) {
        return { ok: false, reason: countReason(malformed.length, 'entry is not an object', 'entries are not objects') };
    }

    const missingId = workflows.filter((w) => typeof w.id !== 'string' || w.id.trim() === '');
    if (missingId.length > 0) {
        return { ok: false, reason: countReason(missingId.length, 'entry has no id', 'entries have no id') };
    }

    // `title` is the heading the client reads. Requiring it (rather than
    // falling back) keeps a blank heading out of the document; scoring has its
    // own fallback so a direct caller cannot crash, but the route should not
    // accept the payload in the first place.
    const missingTitle = workflows.filter((w) => typeof w.title !== 'string' || w.title.trim() === '');
    if (missingTitle.length > 0) {
        return { ok: false, reason: countReason(missingTitle.length, 'entry has no title', 'entries have no title') };
    }

    return { ok: true };
}

/**
 * Parses and validates the model's JSON reply.
 *
 * Split out and exported so it can be unit tested without a provider. A model
 * that returns malformed JSON is a normal, expected failure, so it becomes a
 * structured error the UI can show, not an exception.
 */
export function parseModelResponse(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        console.error('[audit] model returned invalid JSON:', String(raw).slice(0, 200));
        return { status: 'error', content: 'The analysis service returned an unreadable response. Please try again.' };
    }

    if (!parsed || typeof parsed !== 'object' || !parsed.status) {
        console.error('[audit] model response had no status field');
        return { status: 'error', content: 'The analysis service returned an unexpected response. Please try again.' };
    }

    if (parsed.status === 'complete' && !parsed.audit) {
        console.error('[audit] model declared completion without audit data');
        return { status: 'error', content: 'The analysis completed without usable data. Please try again.' };
    }

    // Validate the audit shape here, at the boundary, rather than letting a
    // malformed payload reach the client. Without this the browser posts it to
    // /api/score, gets a 400, and shows a generic network error for what is
    // actually a model contract violation.
    if (parsed.status === 'complete') {
        const check = validateWorkflows(parsed.audit?.workflows);
        if (!check.ok) {
            console.error(`[audit] model returned an unusable audit: ${check.reason}`);
            return { status: 'error', content: 'The analysis could not read the questionnaire answers. Please try again.' };
        }
    }

    return parsed;
}
