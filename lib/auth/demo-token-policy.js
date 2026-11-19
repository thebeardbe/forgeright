/**
 * The demo token policy: the placeholder token this repository ships with is acceptable only where the
 * installation is reachable from this machine alone.
 */

/**
 * Committed on purpose: it grants read-only access to one organisation whose name says it is not a real
 * client, and every write is refused. It is nonetheless a known credential, so it is safe on one machine and
 * unsafe on anything reachable.
 */
const COMMITTED_PLACEHOLDER_TOKEN = 'local-demo-read-only-token-change-me';

/**
 * Whether a hostname is this machine: localhost, 127.0.0.0/8 and ::1.
 *
 * @returns {boolean}
 */
function isLoopbackHostname(hostname) {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host === '::1') return true;
    return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Refuses to enable the demo route when the committed placeholder token would be reachable from somewhere
 * else. A refusal rather than a warning, because the placeholder is in the repository.
 *
 * It fires only when the token is the placeholder and the public URL is not localhost. An unparseable
 * PUBLIC_BASE_URL counts as not local: the safe reading of an unknown host is that it is reachable.
 *
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
