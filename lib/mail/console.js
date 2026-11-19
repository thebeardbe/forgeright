/**
 * The console mail sender, and the default MAIL_SENDER: the message is printed to stdout rather than sent,
 * so the whole sign-in flow works without a mail account.
 */

/** Width of the rule drawn above and below a logged message. */
const RULE_WIDTH = 72;

/**
 * Logs a message to stdout in a block that is easy to pick out of server logs.
 *
 * @returns {Promise<{ id: string, transport: string }>}
 */
export async function send({ to, subject, body }) {
    const rule = '='.repeat(RULE_WIDTH);

    // console.log rather than a logger, so the block survives a terminal, a pipe and a log file
    // unchanged. Multi-line on purpose: a login link wrapped over three lines would be pasted wrongly.
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
