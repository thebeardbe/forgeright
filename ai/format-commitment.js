/**
 * Framing the request so the model answers in JSON.
 *
 * Split from audit-core.js so that file stays readable, and because the reasoning
 * here is a measurement rather than a design preference.
 */

/**
 * The turn appended before a request, so the model continues in JSON.
 *
 * A PREFILL, IN EFFECT. At conversation length the model answers as PROSE, so the extraction finds
 * nothing and the turn fails: the prompt's instruction to reply with JSON is not honoured at
 * length, however it is worded. MEASURED on a 7-message conversation, four runs each - WITHOUT it
 * the model answered in prose 0/8 times; WITH it, 20/20.
 *
 * POSITION MATTERS, which is the counter-intuitive part that took the experimenting: strengthening
 * the instruction and moving it to the top of the prompt both failed 0/4, while appending it after
 * the participant's last answer worked.
 *
 * ADDED FOR EVERY PROVIDER. Gemini was expected not to need it, since its JSON mode works, but it
 * also returned bare prose without the turn. Adding it unconditionally is simpler than branching.
 *
 * NOT STORED: this is not the participant's answer and must not appear in the transcript. It exists
 * only in the outgoing request.
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
