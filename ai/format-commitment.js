/**
 * Framing the request so the model answers in JSON.
 *
 * Split from audit-core.js so that file stays readable, and because the reasoning
 * here is a measurement rather than a design preference.
 */

/**
 * The turn appended before a request, so the model continues in JSON.
 *
 * A PREFILL, IN EFFECT. At conversation length the model answers as PROSE: measured
 * through this path, DeepSeek returned bare questions such as "What starts one of
 * these off?" (29 to 65 characters, no JSON at all), so the extraction found
 * nothing and the turn failed. The prompt's instruction to reply with JSON and
 * nothing else is simply not honoured at length, however it is worded or wherever
 * in the prompt it sits.
 *
 * Ending the conversation with the ASSISTANT'S OWN COMMITMENT to the format makes
 * the model continue in that form. Measured on a 7-message conversation, four runs
 * each:
 *
 *   without:  4 turns 0/4   6 turns 0/4
 *   with:     3 turns 4/4   4 turns 4/4   6 turns 4/4   10 turns 4/4   15 turns 4/4
 *
 * THE REQUIREMENT HAS TO COME AFTER THE PARTICIPANT'S LAST ANSWER, which is the
 * finding that took the experimenting: strengthening the instruction and moving it
 * to the top of the prompt both failed (0/4 each), while appending it to the final
 * user turn worked, and a synthetic assistant turn works equally well. The extra
 * turn is the cleaner of the two, and it needs no change to the prompt.
 *
 * ADDED FOR EVERY PROVIDER, not just DeepSeek, and that is measured rather than a
 * shortcut. Gemini was expected NOT to need it, since its JSON mode works, but on
 * this conversation it also returned bare prose ("What starts one of these off?")
 * 0/5 without the turn and 5/5 with it. So this is not a DeepSeek workaround: it
 * is how a long conversation is framed for either provider, and adding it
 * unconditionally is both correct and simpler than branching on provider.
 *
 * NOT STORED. This is not the participant's answer and must not appear in the
 * transcript, which records what was actually said. It exists only in the outgoing
 * request.
 */
const FORMAT_ACKNOWLEDGEMENT = 'Understood. I will reply with one raw JSON object only.';

/**
 * Appends the format commitment when the conversation ends on a participant turn.
 *
 * ONLY WHEN THE LAST MESSAGE IS FROM THE USER. A conversation already ending on an
 * assistant turn has its own closing commitment, and adding another would put two
 * in a row, which reads as a stutter rather than a pref ill. A caller that sends
 * its own acknowledgement therefore gets no duplicate.
 *
 * The messages are copied rather than the caller's array being pushed to: the
 * conversation is stored and re-sent later, and a synthetic turn leaking into it
 * would appear in the transcript as something the participant never saw.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @returns {Array<{role: string, content: string}>}
 */
export function withFormatCommitment(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return messages;
    if (messages[messages.length - 1].role !== 'user') return messages;

    return [...messages, { role: 'assistant', content: FORMAT_ACKNOWLEDGEMENT }];
}
