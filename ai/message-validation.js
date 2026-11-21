/**
 * Validating the conversation the client sends to `/api/chat`.
 *
 * THE CLIENT CHOSE THE ROLE OF ITS OWN MESSAGE, including `system`. `runAuditTurn` sanitised only
 * `role === 'user'` and copied everything else through untouched, so a single request with
 * `{role: 'system', content: '...'}` reached the provider as a system message, past the prompt
 * injection filter entirely. The Gemini adapter then folded system-role content into
 * `systemInstruction`, which is the highest-authority text the model receives.
 *
 * TWO ROLES ARE REAL. A conversation has a participant and an interviewer, so `user` and `assistant`
 * are the only ones accepted and anything else is refused. The refusal happens HERE, before any
 * provider call, so a malformed or hostile body costs nothing.
 *
 * THE BOUNDS ARE MEASURED, not guessed. In `data/demo/orgs/example-ltd-demo.db` (copied, never opened
 * for writing), across every stored round: the longest single turn is 204 characters and the longest
 * round is 28 turns. The limits below are that with generous headroom, and they are stated as numbers
 * so a future reader can tell whether a real interview is near them.
 *
 * The rate limit is the other, independent bound: `CHAT_LIMITS.max` is 60 turns per hour per token. It
 * limits CALLS, not the size of one, which is what these limits cover.
 */

import { MAX_TURN_CHARS } from '../limits.js';

/** The only roles a conversation has. Anything else is refused, never mapped. */
export const ALLOWED_ROLES = Object.freeze(['user', 'assistant']);

/**
 * The longest conversation accepted in one request.
 *
 * MEASURED: the longest real round is 28 turns. 200 allows more than seven times that, so a resumed
 * interview with every previous round replayed stays well inside it, while a body padded to exhaust
 * the provider's context is refused.
 */
export const MAX_MESSAGES = 200;

/**
 * The longest single turn accepted, in characters.
 *
 * MEASURED: the longest real turn is 204 characters. 8000 is nearly forty times that, which leaves
 * room for a participant pasting a long description of a process, and still bounds one turn to a few
 * thousand tokens rather than a whole context window.
 */
/**
 * The longest one conversation turn may be.
 *
 * Re-exported from limits.js rather than written here as a literal, because /api/response bounds the
 * same quantity for a stored transcript turn and the two must not drift. This name is kept because the
 * chat endpoint's own wording and tests use it.
 */
export const MAX_CONTENT_CHARS = MAX_TURN_CHARS;

/**
 * The total characters accepted across all turns in one request.
 *
 * MEASURED: the longest real round, 28 turns at the measured turn size, is a few thousand characters.
 * 60000 allows a long resumed interview with every round replayed, and refuses a body built to be
 * expensive. At roughly four characters per token this is about 15000 tokens of conversation, well
 * inside the 4096-token reply budget's input side.
 */
export const MAX_TOTAL_CHARS = 60000;

/**
 * Check a `messages` array from a request body.
 *
 * Returns a reason rather than throwing, because the caller answers with a 400 and logs the refusal;
 * a thrown error from a validation path is indistinguishable in a log from a model fault, which is
 * exactly the confusion this is meant to prevent.
 *
 * @param {unknown} messages the value from `req.body.messages`
 * @returns {{ ok: true, messages: Array<{role: string, content: string}> } | { ok: false, reason: string }}
 */
export function validateMessages(messages) {
    if (!Array.isArray(messages)) {
        return { ok: false, reason: 'messages is not an array' };
    }
    if (messages.length === 0) {
        return { ok: false, reason: 'messages is empty' };
    }
    if (messages.length > MAX_MESSAGES) {
        return { ok: false, reason: `messages has ${messages.length} entries, limit ${MAX_MESSAGES}` };
    }

    const clean = [];
    let totalChars = 0;

    for (let i = 0; i < messages.length; i += 1) {
        const entry = messages[i];

        // A null or a bare string where an object is expected. Checked before any property read.
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
            return { ok: false, reason: `messages[${i}] is not an object` };
        }

        const role = entry.role;
        if (typeof role !== 'string' || !ALLOWED_ROLES.includes(role)) {
            // THE C1 OF THIS FUNCTION. A `system` role from a client would reach the model as an
            // instruction, so it is named in the log to make the attempt visible.
            return { ok: false, reason: `messages[${i}].role is ${JSON.stringify(role)}, not user or assistant` };
        }

        const content = entry.content;
        if (typeof content !== 'string') {
            return { ok: false, reason: `messages[${i}].content is not a string` };
        }
        if (content === '') {
            return { ok: false, reason: `messages[${i}].content is empty` };
        }
        if (content.length > MAX_CONTENT_CHARS) {
            return { ok: false, reason: `messages[${i}].content is ${content.length} characters, limit ${MAX_CONTENT_CHARS}` };
        }

        totalChars += content.length;
        if (totalChars > MAX_TOTAL_CHARS) {
            return { ok: false, reason: `messages total ${totalChars} characters, limit ${MAX_TOTAL_CHARS}` };
        }

        // Role and content only. Every other property a client sends is dropped here rather than
        // carried into the conversation: `missing`, `evidenced` and `substituted` are replayed by the
        // legitimate client, and they feed the stall guards, so they are READ where those guards need
        // them and never forwarded to the provider.
        clean.push({ role, content });
    }

    return { ok: true, messages: clean };
}
