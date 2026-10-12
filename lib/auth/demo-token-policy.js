/**
 * The demo token policy: what makes the demo link safe to publish, and when it is not.
 *
 * Extracted from `demo-login.js` so the rule is in one place and can be tested on its own,
 * with no server, no store and no route. The route module decides WHETHER the demo exists;
 * this module decides whether the credential guarding it is fit for where this installation
 * is reachable from.
 *
 * THE RULE, in one sentence: the placeholder token this repository ships with is acceptable
 * only where the installation is reachable from this machine alone.
 */
/**
 * The token this repository ships with, in `docker-compose.yml`.
 *
 * IT IS COMMITTED ON PURPOSE, and the reasoning is worth stating because the value looks
 * like a mistake. It grants read-only access to ONE organisation whose name says it is not
 * a real client, every write is refused, and the escalation paths out of a demo session are
 * closed and tested. Requiring an operator to invent a value instead would break the
 * "clone it and run `docker compose up`" property that the container exists to provide.
 *
 * IT IS NONETHELESS A KNOWN CREDENTIAL, so it is safe on one machine and unsafe on
 * anything reachable. That is the line `assertDemoTokenNotPlaceholderInPublic` below draws,
 * rather than a warning in a document that a hurried operator will not read.
 */
const COMMITTED_PLACEHOLDER_TOKEN = 'local-demo-read-only-token-change-me';

/**
 * Whether a hostname is this machine.
 *
 * LOCALHOST, 127.0.0.0/8 AND ::1, because a deployment reached over loopback is the
 * intended home for a committed credential: the only way to use the link is to already be
 * on the machine, and anyone who is already there does not need the link. Written out
 * rather than imported so this module keeps its single dependency on the store registry.
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
 * Refuses to enable the demo route when the committed placeholder token would be reachable
 * from somewhere other than this machine.
 *
 * WHY A REFUSAL RATHER THAN A WARNING. The placeholder is a known credential: it is in the
 * repository, so anybody who reads the repository has it. On one machine that costs
 * nothing. On a public hostname it means anyone who has seen the repository can read the
 * demo organisation's data.
 *
 * THE CONDITION IS DELIBERATELY NARROW, so it costs nothing where the risk is not real: it
 * fires only when the token IS the placeholder AND the public URL is NOT localhost. A
 * localhost deployment keeps working with no configuration at all, which is the property
 * that makes the container useful. A real deployment must set its own token, and the
 * message says exactly how.
 *
 * AN UNPARSEABLE PUBLIC_BASE_URL IS TREATED AS NOT LOCAL, because the safe reading of an
 * unknown host is that it is reachable. `assertPublicBaseUrlUsable` refuses such a value
 * later anyway; this check must not be the one that waves it through.
 *
 * @param {string} token The configured DEMO_LOGIN_TOKEN.
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function assertDemoTokenNotPlaceholderInPublic(token) {
    if (token !== COMMITTED_PLACEHOLDER_TOKEN) return { ok: true };

    const configured = (process.env.PUBLIC_BASE_URL || '').trim();
    if (configured === '') {
        // Unset means the app assumes http://localhost:PORT, per public-base-url.js, so a
        // deployment that never set it is on this machine by the app's own rule.
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
