/**
 * The Proton mail sender.
 *
 * Sends through `proton-cli` on this machine. The invocation, verified against
 * the installed binary:
 *
 *   proton-cli --profile <profile> mail messages send --to <addr> --subject <subj> --body -
 *
 * `--body -` reads the message body from stdin. Two deliberate choices follow
 * from that:
 *
 *   1. execFile, never a shell string. There is no shell, so a recipient address
 *      or a subject containing `;`, `$()`, a backtick or a newline cannot become
 *      a command. Those characters can only be part of an address or a subject,
 *      which is all the arguments are for.
 *   2. The body goes on stdin, not in argv. It is the largest field and the one
 *      most likely to contain arbitrary text, so it never touches the argument
 *      list in the first place.
 *
 * Failure mode that matters: an unattended sender's real fault is an expired
 * Proton session, and `proton-cli` then exits non-zero. That must not be silent,
 * because the symptom is "the login link never arrived", which is impossible to
 * diagnose without the exit code and stderr. So the throw carries both.
 */
import { execFile } from 'node:child_process';

/** Milliseconds before a send is treated as hung. Proton CLI can block on the network. */
const SEND_TIMEOUT_MS = 30_000;

/** The default profile, matching this machine's signed-in jobsearch account. */
const DEFAULT_PROFILE = 'jobsearch';

/**
 * The profile to send from. Read per call, so a test or a deployment can change
 * it, and so an unset value takes the documented default.
 *
 * @returns {string}
 */
function profile() {
    const configured = process.env.MAIL_PROTON_PROFILE;
    return configured && configured.trim() !== '' ? configured.trim() : DEFAULT_PROFILE;
}

/**
 * Sends one message through proton-cli.
 *
 * @param {object} message
 * @param {string} message.to
 * @param {string} message.subject
 * @param {string} message.body
 * @returns {Promise<{ id: string, transport: string }>}
 * @throws {Error} When proton-cli exits non-zero, naming the exit code and
 *   stderr so an expired session is diagnosable from the log alone.
 */
export async function send({ to, subject, body }) {
    const args = [
        '--profile', profile(),
        'mail', 'messages', 'send',
        '--to', to,
        '--subject', subject,
        '--body', '-'
    ];

    return new Promise((resolve, reject) => {
        const child = execFile('proton-cli', args, { timeout: SEND_TIMEOUT_MS }, (err, stdout, stderr) => {
            if (err) {
                reject(describeFailure(err, stderr, profile()));
                return;
            }

            // proton-cli prints a confirmation line on success. Its exact text is
            // not part of its interface, so it is logged rather than parsed.
            const confirmation = String(stdout).trim().split('\n').pop() || '';
            console.info(`[mail:proton] sent to ${to} via profile ${profile()}: ${confirmation}`);
            resolve({ id: 'proton', transport: 'proton' });
        });

        // No empty catch: a failure to write the body is reported, because a
        // message with a truncated link is worse than one that fails loudly.
        child.stdin.on('error', (err) => {
            console.error(`[mail:proton] could not write the body to proton-cli stdin: ${err.message}`);
            reject(new Error(`Sending mail failed: could not write the message body to proton-cli (${err.message}).`));
        });

        child.stdin.end(String(body), 'utf8');
    });
}

/**
 * Builds the error for a failed send, carrying everything an operator needs.
 *
 * The exit code and stderr are the whole point. "Profile is not signed in",
 * "session expired" and "network unreachable" are different problems with the
 * same symptom on the participant's side, and only these fields tell them apart.
 *
 * @param {Error} err The execFile error.
 * @param {string} stderr
 * @param {string} usedProfile
 * @returns {Error}
 */
function describeFailure(err, stderr, usedProfile) {
    const code = err.code === undefined ? 'unknown' : err.code;
    const detail = String(stderr || '').trim() || err.message;

    // A timeout is called out by name: it looks like a hang, not a rejection, and
    // the operator should not have to infer it from a bare code.
    const timeoutNote = err.killed ? ` Timed out after ${SEND_TIMEOUT_MS}ms.` : '';

    console.error(
        `[mail:proton] send failed (exit ${code}, profile ${usedProfile}): ${detail}${timeoutNote}`
    );

    return new Error(
        `Sending mail through proton-cli failed for profile "${usedProfile}": ` +
        `exit code ${code}: ${detail}.${timeoutNote} ` +
        `Check the session with "proton-cli account profiles list"; an expired session needs ` +
        `"proton-cli account login --profile ${usedProfile}".`
    );
}
