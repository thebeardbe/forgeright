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
 * Reports whether the configured transport can actually send, at startup.
 *
 * THE SECOND HALF OF assertMailSenderUsable, and it covers the failures that are
 * otherwise silent. A valid transport name proves the CONFIGURATION is understood; it
 * proves nothing about whether mail will leave this machine. The proton transport
 * needs a binary and a signed-in session, and when either is missing the only symptom
 * is that nobody receives anything - which looks exactly like working software until
 * someone complains.
 *
 * IT WARNS RATHER THAN THROWING. A mail problem must not stop the console from
 * starting: mail is not needed to serve it, and the operator most likely to read this
 * warning is signing in precisely to diagnose it. Compare assertMailSenderUsable,
 * which does throw - an unknown transport name is a typo that nothing can fix at
 * runtime, while a missing session is fixed by signing in.
 *
 * The console transport has nothing to check: it needs no binary and no credential,
 * which is why it remains the default and the right choice for development.
 *
 * @returns {string[]} Problems found. Empty when the transport can send.
 */
export function mailReadinessProblems() {
    const name = mailSenderName();
    if (name !== 'proton') return [];

    return protonSender.readinessProblems();
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
