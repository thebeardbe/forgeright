/**
 * The public base URL, and the sign-in links built from it.
 *
 * Extracted from the routes so the HTTPS refusal can use it without importing
 * the routes (which import the refusal). It is the ONE place that decides what
 * URL this installation is reached at, so a redirect and a mailed link cannot
 * disagree.
 */
import { BASE_PATH } from '../base-path.js';

/** Set once the fallback warning has been emitted, so it is said once. */
let warnedAboutMissingPublicBaseUrl = false;

/**
 * The public base URL for this installation, absolute and without a trailing
 * slash.
 *
 * Must be configured: a link built from a request header would be attacker-
 * controlled (a forged Host would mail a link to the attacker's domain), and a
 * relative link is useless in a mail client.
 *
 * It SHOULD already include the base path when the app is served under one
 * (https://host/forgeright). The base path is appended only when absent, so the
 * two cannot produce "/forgeright/forgeright/admin". A URL containing the base
 * path somewhere other than at the end is refused, because that cannot be
 * prefixed correctly and guessing would mail or redirect to a broken URL.
 *
 * @returns {string}
 * @throws {Error} When PUBLIC_BASE_URL contains the base path in the wrong place.
 */
export function publicBaseUrl() {
    const configured = process.env.PUBLIC_BASE_URL;
    if (configured && configured.trim() !== '') {
        return appendBasePath(configured.trim().replace(/\/+$/, ''));
    }

    const port = Number(process.env.PORT) || 3000;

    if (!warnedAboutMissingPublicBaseUrl) {
        warnedAboutMissingPublicBaseUrl = true;
        console.warn(
            '[auth] PUBLIC_BASE_URL is unset, so this instance assumes ' +
            `http://localhost:${port}${BASE_PATH}. That only works if the browser is on this machine. ` +
            'To fix it, either:\n' +
            `  - set PUBLIC_BASE_URL in .env to this instance's public URL, for example ` +
            `PUBLIC_BASE_URL=https://<this-host>${BASE_PATH} (use https:// when TLS terminates at a proxy); or\n` +
            `  - reach the app at http://localhost:${port}${BASE_PATH}, so the localhost assumption holds.`
        );
    }

    return `http://localhost:${port}${BASE_PATH}`;
}

/**
 * Validates the configuration at startup, so a bad value stops the process where
 * an operator is looking rather than on a request.
 *
 * @throws {Error} When the configuration cannot produce a usable URL.
 */
export function assertPublicBaseUrlUsable() {
    const base = publicBaseUrl();
    if (!/^https?:\/\//.test(base)) {
        throw new Error(
            `PUBLIC_BASE_URL produced ${JSON.stringify(base)}, which is not an absolute http(s) URL. ` +
            'Sign-in links are opened from a mail client, so a relative URL cannot work.'
        );
    }
}

/**
 * Appends the base path to an origin, exactly once.
 *
 * @param {string} origin An absolute URL with no trailing slash.
 * @returns {string}
 * @throws {Error} When the origin contains the base path other than as its suffix.
 */
function appendBasePath(origin) {
    if (BASE_PATH === '') return origin;

    if (origin.endsWith(BASE_PATH)) return origin;

    if (origin.includes(BASE_PATH)) {
        throw new Error(
            `PUBLIC_BASE_URL=${JSON.stringify(origin)} contains the base path ${JSON.stringify(BASE_PATH)} ` +
            'somewhere other than at the end. Set it to the public origin plus the base path, for example ' +
            `https://host${BASE_PATH}, with no path after it.`
        );
    }

    return `${origin}${BASE_PATH}`;
}

/** Test helper: allow the fallback warning to be emitted again. */
export function resetPublicBaseUrlWarning() {
    warnedAboutMissingPublicBaseUrl = false;
}
