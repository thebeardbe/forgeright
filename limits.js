/**
 * THE ONE TURN SIZE, SHARED BY THE TWO PLACES THAT MEASURE A CONVERSATION TURN.
 *
 * A conversation turn arrives at this app on two paths, and both must bound it by the same number
 * because they bound the same quantity: one thing a person said.
 *
 *   /api/chat        refuses a single message over MAX_CONTENT_CHARS before calling the provider.
 *   /api/response    refuses a transcript turn over MAX_TRANSCRIPT_CHARS before storing it.
 *
 * These were two literals, `8000` in ai/message-validation.js and `8000` in
 * lib/store/field-limits.js, that happened to be equal. A test asserted the equality, which meant the
 * day someone changed one of them the failure would arrive as a number mismatch in a test - and the
 * test could not say WHY the two had to agree, because nothing in the code said it either. A limit
 * that must agree with another belongs in one place, so this module holds the number and both import
 * it.
 *
 * THIS MODULE LIVES AT THE TOP LEVEL OF THE PROJECT, not inside ai/ or lib/store/, because putting it
 * in either would invert a layer boundary: lib/store/ does not otherwise import from ai/, and
 * ai/message-validation.js does not otherwise import from lib/store/. A shared constant has no
 * business picking a side. It imports nothing, so it cannot create a cycle.
 *
 * The name states the quantity rather than the endpoint, because it is the quantity that is shared.
 */

/**
 * The longest one conversation turn may be, in characters.
 *
 * MEASURED against a real interview: the longest turn in the demo store is 204 characters. 8000 is
 * nearly forty times that, so a participant pasting a long description of a process is well inside it,
 * and one turn is bounded to a few thousand tokens rather than a whole context window.
 */
export const MAX_TURN_CHARS = 8000;
