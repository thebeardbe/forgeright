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
import { execFile, spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

/** Milliseconds before a send is treated as hung. Proton CLI can block on the network. */
const SEND_TIMEOUT_MS = 30_000;

/** The command name, resolved through PATH. */
const CLI_NAME = 'proton-cli';

/** Milliseconds before the session probe at startup gives up. */
const PROBE_TIMEOUT_MS = 15_000;

/**
 * The profile to send from when `MAIL_PROTON_PROFILE` does not name one.
 *
 * THIS IS THE PRODUCT DEFAULT, NOT THIS MACHINE'S ACCOUNT. It used to be the string
 * 'jobsearch' - the signed-in mailbox on the machine this was written on - which meant a
 * fresh clone and a deployment both looked for a profile named after somebody's personal
 * account and found nothing. Where an operator's own value goes is `.env`; this constant is
 * what an instance nobody has configured should do, so it must be the thing that works
 * WITHOUT any configuration at all.
 *
 * AND THAT IS `default`, WHICH IS THE BINARY'S OWN DEFAULT - not a name invented here.
 * Verified against proton-cli 5.0.1 by running `proton-cli --help` inside the built image:
 *
 *   -p, --profile string   Profile to act as (env: PROTON_PROFILE; default: default)
 *
 * So the sequence is: `.env`'s MAIL_PROTON_PROFILE if it names one, otherwise this - and
 * this agrees with what the binary would have chosen on its own, so an unconfigured
 * deployment signs in once (`proton-cli account login`, no flag) and mail works.
 *
 * KEEPING THE CONSTANT RATHER THAN PASSING NO FLAG is the owner's decision: the value is
 * visible in one place and `--profile` is always explicit in the arguments, which makes a
 * failure to authenticate name the profile it actually tried.
 */
const DEFAULT_PROFILE = 'default';

/**
 * The profile to send from: the configured name, or the product default above.
 *
 * Read per call, so a test or a running container can change it, and so an unset value
 * takes `DEFAULT_PROFILE` rather than depending on the operator having set anything.
 *
 * @returns {string}
 */
function profile() {
    const configured = process.env.MAIL_PROTON_PROFILE;
    return configured && configured.trim() !== '' ? configured.trim() : DEFAULT_PROFILE;
}

/**
 * The profile label for a log line or an error, naming whether it was configured.
 *
 * A reader seeing `jobsearch` in a failure has no way to tell whether that came from `.env`
 * or from a default buried in the code, and the two lead to different fixes. Naming which
 * one it was removes that guess.
 *
 * @returns {string}
 */
function profileLabel() {
    const chosen = profile();
    const fromEnv = (process.env.MAIL_PROTON_PROFILE || '').trim() !== '';
    return fromEnv ? `profile "${chosen}" (from MAIL_PROTON_PROFILE)` : `profile "${chosen}" (the default)`;
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
    // ALWAYS EXPLICIT. `profile()` returns a name in every case - the configured one or
    // DEFAULT_PROFILE - so the binary is never left to choose, and a failure names the
    // profile that was actually tried.
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
                reject(describeFailure(err, stderr, profileLabel()));
                return;
            }

            // proton-cli prints a confirmation line on success. Its exact text is
            // not part of its interface, so it is logged rather than parsed.
            const confirmation = String(stdout).trim().split('\n').pop() || '';
            console.info(`[mail:proton] sent to ${to} via ${profileLabel()}: ${confirmation}`);
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
        `[mail:proton] send failed (exit ${code}, ${usedProfile}): ${detail}${timeoutNote}`
    );

    // THE LOGIN ADVICE NAMES THE SAME PROFILE THE SEND USED, which is the whole reason to
    // sign in as an explicit profile rather than relying on the binary's choice: the two
    // cannot disagree, so the remedy is a command that works.
    const loginAdvice = `"proton-cli account login --profile ${profile()}"`;

    return new Error(
        `Sending mail through proton-cli failed via ${usedProfile}: ` +
        `exit code ${code}: ${detail}.${timeoutNote} ` +
        'Check the session with "proton-cli account profiles list"; an expired session needs ' +
        `${loginAdvice}.`
    );
}

/**
 * Where the session and settings live, when XDG_CONFIG_HOME says so.
 *
 * XDG_CONFIG_HOME IS THE MECHANISM THAT MAKES THE SESSION A VOLUME, and it was
 * chosen over PROTON_CONFIG after testing both against the installed binary:
 *
 *   - `PROTON_CONFIG` names the SETTINGS FILE only. Pointing it at a mounted file
 *     leaves `sessions/` wherever HOME already put it, so the credential would end
 *     up outside the volume - the opposite of the requirement.
 *   - `XDG_CONFIG_HOME` moves the whole CONFIG DIRECTORY. Measured: with it set to
 *     an empty directory, `proton account profiles list` answered "No profiles",
 *     and `proton-cli/` was created under the new directory; without it the real
 *     `jobsearch` session appeared. So it isolates the credential completely, which
 *     is what a container needs.
 *
 * Returned only for the message: the binary reads the variable itself, so this is
 * never passed anywhere. It exists so a failure can name the directory to look in.
 *
 * @returns {string} The config directory in use, or a description of the default.
 */
export function configDirectory() {
    const xdg = (process.env.XDG_CONFIG_HOME || '').trim();
    if (xdg !== '') return join(xdg, 'proton-cli');

    const home = (process.env.HOME || '').trim();
    if (home !== '') return join(home, '.config', 'proton-cli');

    return '<neither XDG_CONFIG_HOME nor HOME is set>';
}

/**
 * The absolute path to proton-cli, or null when it is not on PATH.
 *
 * PATH IS SEARCHED HERE RATHER THAN ASSUMING A LOCATION, because the image installs
 * it to /usr/local/bin while a developer's copy is symlinked from ~/.local/bin. Both
 * are on PATH, and a hardcoded path would refuse one of them.
 *
 * @returns {string|null}
 */
function cliPath() {
    const dirs = (process.env.PATH || '').split(delimiter).filter(Boolean);
    for (const dir of dirs) {
        const candidate = join(dir, CLI_NAME);
        try {
            accessSync(candidate, constants.X_OK);
            return candidate;
        } catch (err) {
            // Not here, or not executable. Try the next directory: an unreadable
            // entry on PATH is normal, not an error worth reporting per candidate.
        }
    }
    return null;
}

/**
 * Checks whether mail can actually be sent, and returns the problems it finds.
 *
 * WHY THIS EXISTS. The transport refuses an unknown MAIL_SENDER at startup, and this
 * extends that treatment to the two failures that are otherwise SILENT: the binary
 * missing, and the session expired or absent. Both produce the same symptom - a
 * participant waits for a mail that never arrives - and neither is visible from
 * outside the process. An expired session is the real unattended fault this module
 * already documents, so it is worth finding at boot rather than at the first send.
 *
 * IT REPORTS RATHER THAN THROWS. A missing session is fixable without a rebuild, and
 * refusing to start would take the console down over a mail problem - the admin
 * console does not need mail to work, and an operator may well be signing in to
 * diagnose exactly this. So the server starts and says clearly what is wrong.
 *
 * @returns {string[]} Problems found, in the order they must be fixed. Empty when
 *   proton-cli is present and a session is unlocked.
 */
export function readinessProblems() {
    const problems = [];

    const binary = cliPath();
    if (!binary) {
        problems.push(
            `${CLI_NAME} is not on PATH. The image installs it at /usr/local/bin/${CLI_NAME}; ` +
            'if this is a development machine, install it or add its directory to PATH.'
        );
        // Without the binary there is nothing to ask about sessions, so stop here
        // rather than reporting a session problem that cannot be checked.
        return problems;
    }

    // STDERR IS WHERE THE ANSWER IS, AND THE EXIT CODE IS 0, which is why this uses
    // spawnSync rather than execFileSync. MEASURED against version 5.0.1 with an
    // empty XDG_CONFIG_HOME:
    //
    //   stdout: ""            stderr: "No profiles.\n"            status: 0
    //
    // The first version of this check read stdout only, so it saw an empty string,
    // matched nothing, and reported no problems while mail could not work at all -
    // the exact silent failure it was written to catch. A non-zero exit cannot be
    // relied on either, so both streams are read and both are inspected.
    const probe = spawnSync(binary, ['account', 'profiles', 'list'], {
        timeout: PROBE_TIMEOUT_MS,
        encoding: 'utf8'
    });
    if (probe.error) {
        problems.push(
            `${CLI_NAME} could not list its profiles (${probe.error.message}). ` +
            `Its configuration directory is ${configDirectory()}.`
        );
        return problems;
    }

    const text = `${probe.stdout || ''}\n${probe.stderr || ''}`;

    // "No profiles." is the binary's own wording for an empty config dir.
    if (/no profiles/i.test(text)) {
        // THE COMMAND NAMES THE SAME PROFILE THE SEND WILL USE, so signing in with it is
        // guaranteed to fix the send. The profile is always known - the configured name or
        // DEFAULT_PROFILE - so the flag is always correct to include.
        //
        // `forgeright` is the container_name in the deploy file. This used to say
        // `forgeright-app`, a service that no longer exists - advice that could not be
        // pasted.
        const loginCommand = `${CLI_NAME} account login --profile ${profile()}`;
        problems.push(
            `no Proton session is present in ${configDirectory()}. Sign in once, inside the ` +
            'container, with:\n' +
            `      docker compose exec -it forgeright ${loginCommand}\n` +
            '    The session is written to the mounted volume, so it survives a restart and is ' +
            'never stored in the image or on the host.'
        );
        return problems;
    }

    // A session that exists but is not UNLOCKED still needs a password, so it cannot
    // send unattended either.
    //
    // MATCHED ON THE COLUMN VALUE, NOT ON THE WORD, which is a fix for a false
    // positive this check had: the table's own HEADER contains "UNLOCKED", so a
    // substring search for "locked" reported a problem for every healthy session -
    // including the one on this machine, which is unlocked and working. A warning
    // that fires when everything is fine is worth less than no warning at all,
    // because it teaches the reader to skip the line.
    //
    // The row is "PROFILE  EMAIL  UNLOCKED  SAVED  ACTIVE" with the value in the
    // third column. Anything that is not an explicit "yes" is reported, so a new
    // state the binary introduces is surfaced rather than assumed healthy.
    // THE TABLE IS "header, divider, rows", and the divider is drawn with box
    // characters rather than dashes - so it is neither the header nor a data row, and
    // a filter that only dropped line one matched it and reported the DIVIDER as a
    // profile called "--------". Both the header and the divider are dropped here by
    // shape: a row is a profile only if its third column is one of the words the
    // binary uses for the state.
    //
    // Measured layout, so this is not guesswork:
    //   header   ["PROFILE","EMAIL","UNLOCKED"]
    //   divider  ["---------","----------------","--------"]
    //   data     ["jobsearch","beard_jobagent@proton.me","yes"]
    const rows = text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !/^\d+ profiles?/.test(line));

    const dataRows = rows
        .map((line) => line.split(/\s{2,}/))
        .filter((columns) => columns.length >= 3 && /^(yes|no|locked|unreadable)$/i.test(columns[2]));

    for (const columns of dataRows) {
        const unlocked = columns[2];
        if (unlocked.toLowerCase() !== 'yes') {
            problems.push(
                `the Proton profile "${columns[0]}" in ${configDirectory()} is not unlocked ` +
                `(it reports "${unlocked}"), so an unattended send may fail. Sign in again with: ` +
                `${CLI_NAME} account login --profile ${columns[0]}`
            );
        }
    }

    return problems;
}
