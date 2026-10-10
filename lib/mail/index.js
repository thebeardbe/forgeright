/**
 * Mail sending, behind one interface.
 *
 * The rest of the application calls `send({ to, subject, body })` and never
 * knows which transport is in use. Adding a transport means an entry here and a
 * module beside this one, not a change at the call site.
 *
 * MAIL_SENDER selects it:
 *   console  (default) print the message to stdout; no credentials needed
 *   proton   send through proton-cli on this machine
 *
 * An unknown value throws rather than falling back. Falling back to console
 * would print a real participant's login link into a production log, which is
 * the one failure a mail sender must not have: it looks like success.
 */
import * as consoleSender from './console.js';
import * as protonSender from './proton.js';

/** Transport name to module. One entry per MAIL_SENDER value. */
const SENDERS = {
    console: consoleSender,
    proton: protonSender
};

/** The transport used when MAIL_SENDER is unset or empty. */
const DEFAULT_SENDER = 'console';

/**
 * The configured transport name, validated.
 *
 * @returns {'console'|'proton'}
 * @throws {Error} When MAIL_SENDER names a transport that does not exist.
 */
export function mailSenderName() {
    const configured = process.env.MAIL_SENDER;
    const name = configured && configured.trim() !== '' ? configured.trim().toLowerCase() : DEFAULT_SENDER;

    if (!SENDERS[name]) {
        throw new Error(
            `MAIL_SENDER "${name}" is not a known mail transport. Known: ${Object.keys(SENDERS).join(', ')}.`
        );
    }
    return name;
}

/**
 * Fails loudly at startup when MAIL_SENDER is invalid, rather than at the first
 * login attempt, when the admin is already waiting for a link that cannot come.
 *
 * @throws {Error} When MAIL_SENDER names an unknown transport.
 */
export function assertMailSenderUsable() {
    mailSenderName();
}

/**
 * Sends one message through the configured transport.
 *
 * @param {object} message
 * @param {string} message.to Recipient address.
 * @param {string} message.subject
 * @param {string} message.body Plain text.
 * @returns {Promise<{ id: string, transport: string }>}
 * @throws {Error} When the transport fails, carrying the transport's own detail.
 */
export async function send(message) {
    if (!message || typeof message.to !== 'string' || message.to.trim() === '') {
        throw new Error('send requires a recipient address.');
    }
    if (typeof message.subject !== 'string' || message.subject.trim() === '') {
        throw new Error('send requires a subject.');
    }
    if (typeof message.body !== 'string' || message.body.trim() === '') {
        throw new Error('send requires a body.');
    }

    const name = mailSenderName();
    return SENDERS[name].send(message);
}
