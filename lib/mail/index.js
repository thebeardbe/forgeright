/**
 * Mail sending behind one interface: `send({ to, subject, body })`, with MAIL_SENDER choosing `console`
 * (default) or `proton`.
 *
 * An unknown value throws rather than falling back, because falling back to console would print a real
 * login link into a production log and look like success.
 */
import * as consoleSender from './console.js';
import * as protonSender from './proton.js';

/** Transport name to module, one entry per MAIL_SENDER value. */
const SENDERS = {
    console: consoleSender,
    proton: protonSender
};

const DEFAULT_SENDER = 'console';

/**
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
 * Fails at startup rather than at the first login attempt, when the admin is already waiting for a link
 * that cannot come.
 *
 * @throws {Error} When MAIL_SENDER names an unknown transport.
 */
export function assertMailSenderUsable() {
    mailSenderName();
}

/**
 * Whether the configured transport can actually send. A valid name proves the configuration is understood
 * and nothing about whether mail will leave the machine: proton needs a binary and a signed-in session, and
 * when either is missing the only symptom is that nobody receives anything.
 *
 * It warns rather than throwing, because a mail problem must not stop the console starting and the operator
 * who reads it is likely signing in to diagnose it.
 *
 * @returns {string[]} Problems found. Empty when the transport can send.
 */
export function mailReadinessProblems() {
    const name = mailSenderName();
    if (name !== 'proton') return [];

    return protonSender.readinessProblems();
}

/**
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
