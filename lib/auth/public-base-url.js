/**
 * The public base URL, and the sign-in links built from it.
 *
 * Extracted from the routes so the HTTPS refusal can use it without importing
 * the routes (which import the refusal). It is the ONE place that decides what
 * URL this installation is reached at, so a redirect and a mailed link cannot
 * disagree.
 */
import { PUBLIC_PATH, publicPathFromBaseUrl } from '../base-path.js';

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
 * It is the AUTHORITY for the public path, and the path it carries is what
 * lib/base-path.js derives PUBLIC_PATH from, so the URL, the emitted links and
 * the session cookie Path cannot disagree.
 *
 * @returns {string}
 * @throws {Error} When PUBLIC_BASE_URL's path is not the public path.
 */
export function publicBaseUrl() {
    const configured = process.env.PUBLIC_BASE_URL;
    if (configured && configured.trim() !== '') {
        // The path already in the URL is what the public path is derived from, so
        // it is the value to check against when the URL has one.
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
 * Completes PUBLIC_BASE_URL so it ends with the public path, exactly once.
 *
 * PUBLIC_BASE_URL IS THE AUTHORITY for the public path: it is the URL the site is
 * reached at, so its pathname IS the emitted prefix (see lib/base-path.js, which
 * derives PUBLIC_PATH from it). This function therefore does not invent a prefix;
 * it makes the two agree and refuses when they cannot:
 *
 *   - the URL already ends with the public path   -> used as given
 *   - the URL has no path, and the public path is
 *     configured from somewhere else             -> the path is appended, once
 *   - the URL's path is something else            -> refused, because links and
 *     redirects would point where the app is not served
 *
 * COMPARES THE PATHNAME, NOT THE WHOLE STRING. An earlier version searched the
 * entire URL, which matched the HOSTNAME: with the product named forgeright,
 * `PUBLIC_BASE_URL=https://forgeright.bunkens.be` contains "/forgeright" nowhere
 * near the path, so the real production configuration was refused at startup.
 * That also silently accepted `https://host/other/forgeright`.
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
        // Not a parseable absolute URL. assertPublicBaseUrlUsable reports that
        // separately; here the path cannot be examined, so the origin is returned
        // as given rather than guessing at a prefix.
        return origin;
    }

    const path = parsed.pathname.replace(/\/+$/, '');

    // The URL already carries the public path: nothing to add. This is the case
    // the deployment is in, where PUBLIC_BASE_URL=https://host/forgeright and the
    // public path is derived from it, so the two agree by construction.
    if (publicPath !== '' && path === publicPath) return origin;

    // No path in the URL, and none configured: the site is at an origin root.
    if (publicPath === '' && (path === '' || path === '/')) return origin;

    // No path in the URL, but one is configured elsewhere (an explicit
    // PUBLIC_PATH). Apply it so the mailed link points inside the mount.
    if (path === '' || path === '/') return `${origin}${publicPath}`;

    // A path that is not the public path. Appending would double it and ignoring
    // it would drop it, so neither guess is safe: refuse instead.
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
