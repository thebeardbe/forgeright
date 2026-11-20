/**
 * THE BOUND ON ONE ASSEMBLED MESSAGE.
 *
 * `sanitizeInput` caps ONE participant-provided string at 3000 characters. It was being applied to
 * whole assembled messages, which are documents, and the effect was a silent deletion of the most
 * important part of each one.
 *
 * MEASURED against the demo store, and then against what the product asks a participant to write:
 *
 *   a weighing message, one participant            2341
 *   a weighing message, one participant + rejudge  3145   <- over the old 3000 cut
 *   a weighing message, all 8 demo responses      12050
 *   an identification message, 60 known processes 22228   <- 13% of it reached the model
 *
 * So 3000 was cutting real traffic, and every case above the cut lost whatever was at the end: the
 * admin's argument in weighing, and the end of the known-processes list in identification.
 *
 * WHY 32000 FOR A MESSAGE. It is roughly ten times the largest real message measured (22228) and
 * about eight times the largest the demo store can produce, so ordinary traffic never meets it. The
 * bound is not about the model's context, which is far larger; it is about surprises: a bug that
 * concatenates a list into itself, an organisation that grows without limit, or a caller that builds
 * a document out of everything it can reach. At roughly four characters per token, 32000 is about
 * 8000 tokens, which is a document and not a runaway.
 *
 * WHY 8000 FOR AN ADMIN'S ARGUMENT. A rejudge argument is one sentence to a paragraph of reasoning
 * typed by a staff member who is explaining a disagreement. MEASURED, the arguments used in these
 * tests run 500 to 700 characters; 8000 is more than ten times that, so nobody writing in good faith
 * meets it, and an argument padded to be a denial of service does not survive.
 *
 * INDENTATION IS NOT BUDGET. `JSON.stringify(x, null, 2)` is for a human reading a log. MEASURED, 23%
 * of a pretty-printed payload is whitespace, which buys the model nothing and spends the budget that
 * the admin's argument needs. Every payload in these messages is compact.
 */
import { sanitizeInput } from './security.js';

/**
 * The most characters one assembled message may contain.
 *
 * See the header for the measurement. A message over this is cut AT THE END, which is why the
 * callers that assemble a message put the admin's reasoning FIRST: what is last is what is lost.
 */
export const MAX_MESSAGE_CHARS = 32000;

/**
 * The most characters an admin's rejudge argument may contain, on its own.
 *
 * Applied before assembly, so the argument is bounded as a string and the document budget is spent
 * on the participant data instead of on one paragraph.
 */
export const MAX_ADMIN_REASONING_CHARS = 8000;

/**
 * Cap an admin's rejudge argument, loudly.
 *
 * @param {string|null} reasoning
 * @param {string} where the workflow, so the log says which one
 * @returns {string|null}
 */
export function capAdminReasoning(reasoning, where) {
    if (!reasoning) return null;
    const text = String(reasoning);
    if (text.length <= MAX_ADMIN_REASONING_CHARS) return text;

    console.warn(
        `[${where}] admin reasoning truncated: ${text.length} characters, cap ` +
        `${MAX_ADMIN_REASONING_CHARS}, cut ${text.length - MAX_ADMIN_REASONING_CHARS}`
    );
    return text.slice(0, MAX_ADMIN_REASONING_CHARS) + '\n...[TRUNCATED]';
}

/**
 * Cap an assembled message, saying what was cut and how much.
 *
 * The old code said only "exceeded 3000 characters", which named neither the message nor the loss.
 * This names the workflow, the size, the budget and the number of characters removed, so an operator
 * reading the log knows whether a rejudge lost its argument or an organisation simply grew.
 *
 * @param {string} message the assembled message
 * @param {string} where the workflow, for the log line
 * @returns {string}
 */
export function capMessage(message, where) {
    const text = String(message ?? '');
    if (text.length <= MAX_MESSAGE_CHARS) return text;

    const cut = text.length - MAX_MESSAGE_CHARS;
    console.warn(
        `[${where}] assembled message truncated: ${text.length} characters, budget ` +
        `${MAX_MESSAGE_CHARS}, cut ${cut} from the END. If a rejudge argument is missing from the ` +
        'reply, this is why.'
    );
    return text.slice(0, MAX_MESSAGE_CHARS) + '\n...[TRUNCATED]';
}

/**
 * Cap one participant-provided string for a message, naming it in the log.
 *
 * A thin wrapper so a caller cannot pass a whole message here by mistake without the label showing
 * in the log line.
 *
 * @param {string} value
 * @param {string} label the field or step the string came from
 * @returns {string}
 */
export function capParticipantString(value, label) {
    return sanitizeInput(value, label);
}
