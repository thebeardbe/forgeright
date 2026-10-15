/**
 * The turn appended before a request, so the model continues in JSON.
 *
 * A PREFILL, IN EFFECT. At conversation length the model answers as PROSE, so the extraction finds
 * nothing and the turn fails. MEASURED on a 7-message conversation, four runs each: WITHOUT it the
 * model answered in prose 0/8 times; WITH it, 20/20.
 *
 * POSITION MATTERS, which is the counter-intuitive part that took the experimenting: strengthening
 * the instruction and moving it to the top of the prompt both failed 0/4, while appending it after
 * the participant's last answer worked.
 *
 * ADDED FOR EVERY PROVIDER: Gemini, whose JSON mode works, also returned bare prose without it.
 * NOT STORED, because it is not the participant's answer and must not reach the transcript.
 */
const FORMAT_ACKNOWLEDGEMENT = 'Understood. I will reply with one raw JSON object only.';

/**
 * Appends the format commitment when the conversation ends on a participant turn.
 *
 * ONLY WHEN THE LAST MESSAGE IS FROM THE USER: a conversation already ending on an assistant turn
 * has its own closing commitment, and a second would read as a stutter rather than a prefill.
 *
 * THE ARRAY IS COPIED RATHER THAN PUSHED TO, because the conversation is stored and re-sent later -
 * a synthetic turn leaking into it would appear in the transcript as something never said.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @returns {Array<{role: string, content: string}>}
 */
export function withFormatCommitment(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return messages;
    if (messages[messages.length - 1].role !== 'user') return messages;

    return [...messages, { role: 'assistant', content: FORMAT_ACKNOWLEDGEMENT }];
}
