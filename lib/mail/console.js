/**
 * The console mail sender.
 *
 * The default MAIL_SENDER, and the reason local development needs no
 * credentials: the message is printed to stdout in a readable block instead of
 * being sent. A login link appears in the terminal, so the whole sign-in flow is
 * exercisable without a mail account.
 *
 * This is a sender, not a stub: it reports success honestly for what it did.
 * What it did is log the message, which is exactly what MAIL_SENDER=console
 * means.
 */

/** Width of the rule drawn above and below a logged message. */
const RULE_WIDTH = 72;

/**
 * Logs a message to stdout in a block that is easy to pick out of server logs.
 *
 * @param {object} message
 * @param {string} message.to
 * @param {string} message.subject
 * @param {string} message.body
 * @returns {Promise<{ id: string, transport: string }>}
 */
export async function send({ to, subject, body }) {
    const rule = '='.repeat(RULE_WIDTH);

    // Written with console.log rather than a logger so the block survives a
    // terminal, a pipe and a log file unchanged. It is multi-line on purpose:
    // a login link wrapped over three lines would be pasted wrongly.
    console.log(rule);
    console.log(`[mail:console] to:      ${to}`);
    console.log(`[mail:console] subject: ${subject}`);
    console.log(`[mail:console] body:`);
    for (const line of String(body).split('\n')) {
        console.log(`    ${line}`);
    }
    console.log(rule);

    return { id: 'console', transport: 'console' };
}
