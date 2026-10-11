/**
 * Audit conversation core.
 *
 * Runs one turn of the intake interview. The model is asked to reply with a JSON
 * object of the shape:
 *
 *   { status: "asking",   content: "<next question>", have: [...], missing: [...] }
 *   { status: "complete", content: "<closing line>", have: [], missing: [],
 *     processes: [...], audit: { workflows: [...] } }
 *
 * `have` and `missing` are the completeness matrix: what the model can state and
 * what it still needs. THEY DECIDE WHETHER THE INTERVIEW CONTINUES, not `status`,
 * because a model that believes it is finished while a field is absent would
 * close early and drop it silently. The server computes the two lists from the
 * processes and compares them with the model's claim.
 *
 * Keeping the model on this contract is what lets the scoring layer be pure
 * logic: it receives structured data, never prose to be parsed.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateText } from './provider.js';
import { sanitizeInput, checkPromptInjection } from './security.js';
import { extractJsonObject } from './json-extract.js';
import { withFormatCommitment } from './format-commitment.js';
import { ALL_PROCESS_FIELD_NAMES, reconcileMatrix } from './matrix.js';

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
        messages: withFormatCommitment(safeMessages),
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
 * The workflows a completion reply carries, from either shape.
 *
 * THE ONE PLACE THAT KNOWS BOTH SHAPES. The interview shape carries `processes`,
 * which is what the workflow-1 prompt asks a model to emit; the older single-shot
 * shape carries `audit.workflows`. Everything downstream reads the payload through
 * this function, so a consumer cannot be updated for one shape and missed for the
 * other, which is how this defect happened: the completion check and the client
 * both read `audit` alone while the prompt had moved to `processes`.
 *
 * Both are returned as a plain array, so a caller does not branch either.
 *
 * @param {object} parsed A parsed model response.
 * @returns {Array<object>|undefined} The workflows, or undefined when neither is present.
 */
export function workflowsFrom(parsed) {
    if (!parsed || typeof parsed !== 'object') return undefined;
    if (Array.isArray(parsed.processes) && parsed.processes.length > 0) return parsed.processes;
    if (Array.isArray(parsed.audit?.workflows)) return parsed.audit.workflows;
    return undefined;
}

/**
 * Whether a reply carries a payload at all, in either shape.
 *
 * `processes` present but EMPTY is not a payload: an interview that produced no
 * process has produced nothing to score, and treating an empty array as success
 * is how a blank analysis reaches the reader.
 *
 * @param {object} parsed
 * @returns {boolean}
 */
function hasPayload(parsed) {
    const workflows = workflowsFrom(parsed);
    return Array.isArray(workflows);
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
 *
 * THE MATRIX DECIDES COMPLETION. `status` is read for the payload, but whether
 * the interview is over is computed from `processes`: `missing` empty is the
 * only thing that finishes it. A model claiming `complete` with a field absent is
 * downgraded to `asking`, which is the safe direction (one more question rather
 * than a dropped field).
 */
export function parseModelResponse(raw) {
    // PARSED OUT OF PROSE, not handed to JSON.parse.
    //
    // DeepSeek's JSON mode returns whitespace as a conversation grows, so that
    // provider is asked in plain mode and its replies arrive with the object
    // somewhere inside them, often in a ```json fence. The prompt still demands
    // JSON and nothing outside it; the extractor is what makes a fence or a stray
    // sentence survivable rather than fatal. See ai/json-extract.js and
    // NOTES-deepseek-json-mode.md.
    //
    // A reply with NO object is reported as unreadable rather than parsed into a
    // fragment, so a silently empty model response surfaces as a clear error
    // instead of a downstream field access that fails for no visible reason.
    const parsed = extractJsonObject(raw);
    if (parsed === null) {
        // WHAT CAME BACK IS LOGGED, not just that it was unreadable. The message
        // alone ("returned an unreadable response") sent an earlier investigation
        // back to the live API to find out what the model had actually said, when
        // the answer was a bare prose question. Truncated at 120 characters: enough
        // to see the shape, short enough not to dump a whole reply into the log.
        console.error(
            `[audit] no JSON object in the model reply (${String(raw).length} chars): ` +
            (String(raw).trim() === '' ? '(blank reply)' : JSON.stringify(String(raw).slice(0, 120)))
        );
        return {
            status: 'error',
            content: 'The analysis service returned an unreadable response. Please try again.'
        };
    }

    if (!parsed.status) {
        console.error('[audit] model response had no status field');
        return { status: 'error', content: 'The analysis service returned an unexpected response. Please try again.' };
    }

    // The model's claim and the computed truth, side by side. While the interview
    // is running the claim is believed for anything the payload does not yet
    // carry (the payload is a stub early on); on completion only the payload
    // counts, so a claimed field cannot let a real gap vanish. See
    // reconcileMatrix for the full rule.
    const processes = Array.isArray(parsed.processes) ? parsed.processes : [];
    const claimedHave = Array.isArray(parsed.have) ? parsed.have : null;
    const claimedMissing = Array.isArray(parsed.missing) ? parsed.missing : null;

    const computed = reconcileMatrix({
        processes,
        claimedHave,
        claimedMissing,
        closing: parsed.status === 'complete'
    });
    // The matrix decides completion ONLY when the model is playing the matrix
    // game. A reply carrying `processes` is an interview turn and its field list
    // is authoritative; a reply with a valid `audit` and no `processes` is the
    // older single-shot shape, which has already supplied everything the
    // downstream payload needs. Judging that shape by the matrix would refuse a
    // complete audit for having no `frustration` field, which is not this
    // function's business.
    const playingTheMatrix = processes.length > 0 || claimedMissing !== null;
    const matrixComplete = computed.missing.length === 0 && processes.length > 0;

    if (parsed.status === 'complete' && playingTheMatrix && !matrixComplete) {
        // The model thinks it is done and the matrix disagrees. Continue rather
        // than closing: one more question is cheap, a missing field is not.
        console.warn(
            `[audit] model claimed complete with ${computed.missing.length} field(s) still missing ` +
            `(${computed.missing.join(', ')}); continuing`
        );
        return {
            status: 'asking',
            content: parsed.content,
            have: computed.have,
            missing: computed.missing,
            processes
        };
    }

    if (parsed.status === 'complete' && !hasPayload(parsed)) {
        console.error('[audit] model declared completion with neither processes nor audit data');
        return { status: 'error', content: 'The analysis completed without usable data. Please try again.' };
    }

    // Validate the payload here, at the boundary, rather than letting a malformed
    // one reach the client. Without this the browser posts it to /api/score, gets
    // a 400, and shows a generic network error for what is actually a model
    // contract violation.
    //
    // BOTH SHAPES ARE VALIDATED, not just the older one. The interview shape
    // carries `processes` (the prompt asks for exactly that); the single-shot
    // shape carries `audit.workflows`. Checking only `audit` was the defect this
    // fix closes: a genuinely complete interview errored instead of completing,
    // and the mock hid it by emitting both keys.
    if (parsed.status === 'complete') {
        const check = validateWorkflows(workflowsFrom(parsed));
        if (!check.ok) {
            console.error(`[audit] model returned an unusable payload: ${check.reason}`);
            return { status: 'error', content: 'The analysis could not read the questionnaire answers. Please try again.' };
        }
    }

    // The reported lists are the model's; the computed ones are the server's. A
    // discrepancy is logged, because it means the prompt is not being followed,
    // and the computed pair is what callers read.
    if (claimedMissing && claimedMissing.length !== computed.missing.length) {
        console.warn(
            `[audit] the model reported ${claimedMissing.length} missing field(s) and the matrix ` +
            `computes ${computed.missing.length}; using the computed list`
        );
    }

    // THE PAYLOAD IS NORMALISED FROM THE BEST AVAILABLE SOURCE.
    //
    // Not `parsed.audit ?? normalise(processes)`. That kept `parsed.audit`
    // whenever it was merely NON-NULL, so a stale or wrong-typed one won over a
    // good `processes`: `audit: { workflows: [] }` passed `??` and reached the
    // client as an empty list, which /api/score then rejected with a 400 and the
    // participant saw the scoring-failed panel after a successful interview. The
    // same shape as the defect this replaced, one field deeper.
    //
    // So the decision is made on CONTENT, not on nullness: if a usable workflows
    // array exists anywhere, it wins and is wrapped.
    //
    // `workflowsFrom` IS THE ONLY RESOLVER, and that is why there is no fallback
    // arm here. There used to be one, `: parsed.audit`, which read as a safety net;
    // it was unreachable. `workflowsFrom` already returns `parsed.audit.workflows`
    // when that is the only source, so `best` is an array in every case that
    // reaches this line: a `complete` reply without a payload returned earlier, and
    // an `asking` reply's `audit` field is meaningless. An arm that cannot run
    // while looking like protection is worse than no arm, because it suggests a
    // case is handled that nothing has ever exercised.
    const best = workflowsFrom(parsed);

    return {
        ...parsed,
        // ABSENT WHEN THERE IS NOTHING TO NORMALISE, rather than `{}`. With no
        // workflows, `normaliseProcessesPayload` builds `{ workflows: undefined }`,
        // which serialises to an empty object, and AN EMPTY OBJECT IS TRUTHY: a
        // caller using the `data.audit || ...` idiom the client already uses would
        // take `{}` and find `.workflows === undefined`. That is the same subtle
        // class of defect this file has been fixed for twice. On an `asking` turn
        // there is no payload and no `audit` key at all.
        audit: Array.isArray(best) ? normaliseProcessesPayload(parsed, best) : undefined,
        have: computed.have,
        missing: computed.missing,
        processes
    };
}

/**
 * Wraps a workflows array in the payload shape the client reads.
 *
 * The interview shape carries a bare array under `processes`; the client wants an
 * object with `workflows`, and optionally `illustrative` and `note`, which the
 * prompt does not ask a model to produce but which this system uses to label
 * generated data. An unknown model therefore yields a payload with neither flag,
 * which reads as "not illustrative", the correct default for a real interview.
 *
 * The flags are read from EITHER place a model might put them: the top level, or
 * inside an `audit` envelope it also sent. The envelope is not preferred for the
 * workflows themselves, because those came from the best source, but its labels
 * are still worth taking rather than dropping.
 *
 * @param {object} parsed The parsed reply, which may carry the flags.
 * @param {Array<object>} workflows A non-empty array, already resolved.
 * @returns {object}
 */
function normaliseProcessesPayload(parsed, workflows) {
    const payload = { workflows };

    const envelope = parsed && typeof parsed.audit === 'object' && parsed.audit !== null ? parsed.audit : {};

    if (parsed && parsed.illustrative === true) payload.illustrative = true;
    else if (envelope.illustrative === true) payload.illustrative = true;

    const note = typeof parsed?.note === 'string' && parsed.note.trim() !== ''
        ? parsed.note
        : (typeof envelope.note === 'string' && envelope.note.trim() !== '' ? envelope.note : null);
    if (note !== null) payload.note = note;

    return payload;
}
