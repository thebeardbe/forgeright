/** The assistant turn appended before a request, so the model continues in JSON instead of prose. */
const FORMAT_ACKNOWLEDGEMENT = 'Understood. I will reply with one raw JSON object only.';

/**
 * Appends the format commitment when the conversation ends on a participant turn, leaving the
 * caller's array untouched.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @returns {Array<{role: string, content: string}>}
 */
export function withFormatCommitment(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return messages;
    if (messages[messages.length - 1].role !== 'user') return messages;

    return [...messages, { role: 'assistant', content: FORMAT_ACKNOWLEDGEMENT }];
}
