/**
 * The public base URL, and the sign-in links built from it. The one place that decides what URL this
 * installation is reached at, so a redirect and a mailed link cannot disagree, and extracted so the HTTPS
 * refusal can use it without importing the routes.
 */
import { PUBLIC_PATH, publicPathFromBaseUrl } from '../base-path.js';

/** Set once the fallback warning has been emitted, so it is said once. */
let warnedAboutMissingPublicBaseUrl = false;

/**
 * The public base URL for this installation, absolute and without a trailing slash.
 *
 * It must be configured: a link built from a request header would be attacker-controlled, and a relative link
 * is useless in a mail client. It is the authority for the public path, which lib/base-path.js derives
 * PUBLIC_PATH from, so the URL, the emitted links and the session cookie Path cannot disagree.
 *
 * @returns {string}
 * @throws {Error} When PUBLIC_BASE_URL's path is not the public path.
 */
export function publicBaseUrl() {
    const configured = process.env.PUBLIC_BASE_URL;
    if (configured && configured.trim() !== '') {
        // The path already in the URL is what the public path is derived from.
        const derived = publicPathFromBaseUrl();
        return completePublicBaseUrl(
            configured.trim().replace(/\/+$/, ''),
            derived === null ? PUBLIC_PATH : derived
        );
    }

    const port = Number(process.env.PORT) || 3000;

    if (!warnedAboutMissingPublicBaseUrl) {
        warnedAboutMissingPublicBaseUrl = true;
        console.warn(
            '[auth] PUBLIC_BASE_URL is unset, so this instance assumes ' +
            `http://localhost:${port}${PUBLIC_PATH}. That only works if the browser is on this machine. ` +
            'To fix it, either:\n' +
            `  - set PUBLIC_BASE_URL in .env to this instance's public URL, for example ` +
            `PUBLIC_BASE_URL=https://<this-host>${PUBLIC_PATH} (use https:// when TLS terminates at a proxy); or\n` +
            `  - reach the app at http://localhost:${port}${PUBLIC_PATH}, so the localhost assumption holds.`
        );
    }

    return `http://localhost:${port}${PUBLIC_PATH}`;
}

/**
 * Validates the configuration at startup, so a bad value stops the process where an operator is looking.
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
 * Completes PUBLIC_BASE_URL so it ends with the public path, exactly once: a URL already ending with the
 * public path is used as given, one with no path gets the path appended, and one whose path is anything else
 * is refused, because links and redirects would point where the app is not served.
 *
 * It compares the pathname, never the whole string, because the hostname may contain the product name and a
 * whole-string search would refuse the real production URL while accepting a wrong path.
 *
 * @param {string} origin An absolute URL with no trailing slash.
 * @param {string} publicPath The public path to apply, from the environment.
 * @returns {string}
 * @throws {Error} When the origin's path is neither empty nor the public path.
 */
export function completePublicBaseUrl(origin, publicPath) {
    let parsed;
    try {
        parsed = new URL(origin);
    } catch (err) {
        // Not parseable, so the path cannot be examined and the origin is returned as given;
        // assertPublicBaseUrlUsable reports it separately.
        return origin;
    }

    const path = parsed.pathname.replace(/\/+$/, '');

    // Already carries the public path, which is the case when it is derived from this URL.
    if (publicPath !== '' && path === publicPath) return origin;

    // No path in the URL and none configured: the site is at an origin root.
    if (publicPath === '' && (path === '' || path === '/')) return origin;

    // No path in the URL but one configured elsewhere: apply it so the mailed link points inside the
    // mount.
    if (path === '' || path === '/') return `${origin}${publicPath}`;

    // Appending would double the path and ignoring it would drop it, so neither guess is safe.
    throw new Error(
        `PUBLIC_BASE_URL=${JSON.stringify(origin)} has the path ${JSON.stringify(path)}, which is not ` +
        `the public path ${JSON.stringify(publicPath)}. Set it to the public origin plus the public ` +
        `path, for example https://host${publicPath}, so links and redirects point where the app is ` +
        'served.'
    );
}

/** Test helper: allow the fallback warning to be emitted again. */
export function resetPublicBaseUrlWarning() {
    warnedAboutMissingPublicBaseUrl = false;
}
