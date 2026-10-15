/**
 * The demo token policy: what makes the demo link safe to publish, and when it is not, with no server,
 * store or route involved.
 *
 * The rule: the placeholder token this repository ships with is acceptable only where the installation is
 * reachable from this machine alone.
 */

/**
 * The token this repository ships with, in `docker-compose.yml`. Committed on purpose, because it grants
 * read-only access to one organisation whose name says it is not a real client, every write is refused, and
 * making an operator invent a value would break the "clone it and run docker compose up" property.
 *
 * It is nonetheless a known credential: safe on one machine, unsafe on anything reachable.
 */
const COMMITTED_PLACEHOLDER_TOKEN = 'local-demo-read-only-token-change-me';

/**
 * Whether a hostname is this machine: localhost, 127.0.0.0/8 and ::1.
 *
 * @param {string} hostname A URL hostname, without a port.
 * @returns {boolean}
 */
function isLoopbackHostname(hostname) {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host === '::1') return true;
    return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Refuses to enable the demo route when the committed placeholder token would be reachable from somewhere
 * other than this machine. A refusal rather than a warning, because the placeholder is in the repository
 * and so anybody who reads it has the credential.
 *
 * The condition is deliberately narrow, so it costs nothing where the risk is not real: it fires only when
 * the token is the placeholder and the public URL is not localhost. An unparseable PUBLIC_BASE_URL counts
 * as not local, because the safe reading of an unknown host is that it is reachable.
 *
 * @param {string} token The configured DEMO_LOGIN_TOKEN.
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function assertDemoTokenNotPlaceholderInPublic(token) {
    if (token !== COMMITTED_PLACEHOLDER_TOKEN) return { ok: true };

    const configured = (process.env.PUBLIC_BASE_URL || '').trim();
    if (configured === '') {
        // Unset means the app assumes http://localhost:PORT, per public-base-url.js.
        return { ok: true };
    }

    let hostname;
    try {
        hostname = new URL(configured).hostname;
    } catch (err) {
        return {
            ok: false,
            reason: `PUBLIC_BASE_URL=${JSON.stringify(configured)} is not a parseable URL, so this ` +
                'cannot be shown to be a localhost deployment'
        };
    }

    if (isLoopbackHostname(hostname)) return { ok: true };

    return {
        ok: false,
        reason: `PUBLIC_BASE_URL names ${hostname}, which is not this machine`
    };
}

export { COMMITTED_PLACEHOLDER_TOKEN };
