/**
 * The Proton mail sender: `proton-cli --profile <p> mail messages send --to <a> --subject <s> --body -`.
 *
 * `execFile` and never a shell, so a recipient or subject containing `;`, `$()` or a backtick cannot
 * become a command. The body goes on stdin, not argv, because it is the largest field and the likeliest
 * to hold arbitrary text.
 *
 * The failure that matters is an expired Proton session, where `proton-cli` exits non-zero; the throw
 * carries the exit code and stderr, because the symptom is "the link never arrived".
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
 * The product default, not this machine's account. `default` is the binary's own default, stated by
 * `proton-cli --help` in 5.0.1 as `(env: PROTON_PROFILE; default: default)`, so an unconfigured instance
 * signs in once and mail works. An operator's own value goes in `.env`.
 */
const DEFAULT_PROFILE = 'default';

/**
 * The configured profile name, or the default. Read per call, so a test or a running container can change it.
 *
 * @returns {string}
 */
function profile() {
    const configured = process.env.MAIL_PROTON_PROFILE;
    return configured && configured.trim() !== '' ? configured.trim() : DEFAULT_PROFILE;
}

/**
 * The profile label for a log line, naming whether it was configured: the two lead to different fixes.
 *
 * @returns {string}
 */
function profileLabel() {
    const chosen = profile();
    const fromEnv = (process.env.MAIL_PROTON_PROFILE || '').trim() !== '';
    return fromEnv ? `profile "${chosen}" (from MAIL_PROTON_PROFILE)` : `profile "${chosen}" (the default)`;
}

/**
 * @param {object} message
 * @param {string} message.to
 * @param {string} message.subject
 * @param {string} message.body
 * @returns {Promise<{ id: string, transport: string }>}
 * @throws {Error} When proton-cli exits non-zero, naming the exit code and stderr.
 */
export async function send({ to, subject, body }) {
    // Always explicit, so the binary is never left to choose and a failure names the profile tried.
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

            // proton-cli's confirmation text is not part of its interface, so it is logged, not parsed.
            const confirmation = String(stdout).trim().split('\n').pop() || '';
            console.info(`[mail:proton] sent to ${to} via ${profileLabel()}: ${confirmation}`);
            resolve({ id: 'proton', transport: 'proton' });
        });

        // No empty catch: a truncated body is worse than a loud failure.
        child.stdin.on('error', (err) => {
            console.error(`[mail:proton] could not write the body to proton-cli stdin: ${err.message}`);
            reject(new Error(`Sending mail failed: could not write the message body to proton-cli (${err.message}).`));
        });

        child.stdin.end(String(body), 'utf8');
    });
}

/**
 * The error for a failed send. The exit code and stderr are the point: "not signed in", "session expired"
 * and "network unreachable" have the same symptom on the participant's side and only these fields tell
 * them apart.
 *
 * @param {Error} err The execFile error.
 * @param {string} stderr
 * @param {string} usedProfile
 * @returns {Error}
 */
function describeFailure(err, stderr, usedProfile) {
    const code = err.code === undefined ? 'unknown' : err.code;
    const detail = String(stderr || '').trim() || err.message;

    // A timeout looks like a hang, not a rejection, so it is called out by name.
    const timeoutNote = err.killed ? ` Timed out after ${SEND_TIMEOUT_MS}ms.` : '';

    console.error(
        `[mail:proton] send failed (exit ${code}, ${usedProfile}): ${detail}${timeoutNote}`
    );

    // The advice names the same profile the send used, so the remedy cannot disagree with the failure.
    const loginAdvice = `"proton-cli account login --profile ${profile()}"`;

    return new Error(
        `Sending mail through proton-cli failed via ${usedProfile}: ` +
        `exit code ${code}: ${detail}.${timeoutNote} ` +
        'Check the session with "proton-cli account profiles list"; an expired session needs ' +
        `${loginAdvice}.`
    );
}

/**
 * The directory holding the session and settings. `XDG_CONFIG_HOME`, not `PROTON_CONFIG`, because the
 * latter names only the settings FILE: pointing it at a mounted file leaves `sessions/` wherever HOME put
 * it and the credential ends up outside the volume.
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
 * PATH is searched rather than assuming a location: the image installs to /usr/local/bin while a
 * developer's copy is symlinked from ~/.local/bin.
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
            // Not here, or not executable. An unreadable PATH entry is normal.
        }
    }
    return null;
}

/**
 * Whether mail can actually be sent. A binary missing or a session absent produce the same symptom - a
 * participant waiting for mail that never arrives - and neither is visible from outside the process.
 *
 * It reports rather than throws: a missing session is fixable without a rebuild, and refusing to start
 * would take the console down over a mail problem.
 *
 * @returns {string[]} Problems found, in the order they must be fixed. Empty when a session is unlocked.
 */
export function readinessProblems() {
    const problems = [];

    const binary = cliPath();
    if (!binary) {
        problems.push(
            `${CLI_NAME} is not on PATH. The image installs it at /usr/local/bin/${CLI_NAME}; ` +
            'if this is a development machine, install it or add its directory to PATH.'
        );
        // Without the binary there is nothing to ask about sessions.
        return problems;
    }

    // stderr is where the answer is and the exit code is 0, which is why this is spawnSync rather than
    // execFileSync: "no profiles" is reported on stderr with status 0, so both streams are read.
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

    // A session that exists but is not unlocked cannot send unattended either. The third column is
    // required to be one of the binary's state words, because the table's own header contains
    // "UNLOCKED" and its divider is box characters - a looser filter reported the divider as a profile.
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
