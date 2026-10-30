/** The assistant turn appended before a request, so the model continues in JSON instead of prose. */
const FORMAT_ACKNOWLEDGEMENT = 'Understood. I will reply with one raw JSON object only.';

/** The commitment is appended only when the conversation ends on a participant turn; the array is copied, not mutated. */
export function withFormatCommitment(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return messages;
    if (messages[messages.length - 1].role !== 'user') return messages;

    return [...messages, { role: 'assistant', content: FORMAT_ACKNOWLEDGEMENT }];
}
