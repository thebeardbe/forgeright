/**
 * The public base URL, and the sign-in links built from it. The one place that decides what URL this
 * installation is reached at, so a redirect and a mailed link cannot disagree, and extracted so the HTTPS
 * refusal can use it without importing the routes.
 */
import { PUBLIC_PATH, publicPathFromBaseUrl } from '../base-path.js';

/** Set once the fallback warning has been emitted, so it is said once. */
let warnedAboutMissingPublicBaseUrl = false;

/**
 * The sentence an operator must not be able to misread.
 *
 * MEASURED: with PUBLIC_BASE_URL unset, a real browser POST from the console was answered 403 by the
 * CSRF guard, which compared `Origin: http://127.0.0.1:3147` against the assumed
 * `http://localhost:3147` and found them different. So the effect is not a broken link or a wrong
 * redirect: THE CONSOLE REFUSES EVERY WRITE, and every admin sees a read-only console.
 *
 * The old wording said only that the assumption "only works if the browser is on this machine", which
 * reads as a link problem. This says what happens to a write, because that is what an operator will
 * report as a bug and will not connect to a missing environment variable.
 *
 * @returns {string}
 */
export function publicBaseUrlUnsetWarning() {
    const port = Number(process.env.PORT) || 3000;
    return '[auth] PUBLIC_BASE_URL is unset, so this instance assumes '
        + `http://localhost:${port}${PUBLIC_PATH}. `
        + 'CONSOLE WRITES WILL BE REFUSED until PUBLIC_BASE_URL names this instance\'s public origin: '
        + 'the CSRF guard compares the browser\'s Origin with that assumption, and a visitor who did '
        + 'not arrive at localhost is refused with "This request did not come from this site". '
        + `Set PUBLIC_BASE_URL in .env, for example PUBLIC_BASE_URL=https://<this-host>${PUBLIC_PATH} `
        + '(use https:// when TLS terminates at a proxy). '
        + `Reaching the app at http://localhost:${port}${PUBLIC_PATH} keeps the assumption true for a `
        + 'browser on this machine only.';
}

/**
 * Say the warning at STARTUP, where the other [server] lines are.
 *
 * It used to be emitted lazily, on the first call to publicBaseUrl(), so an operator who started the
 * server and read a clean log saw nothing: the warning appeared on the first page that built a link,
 * which may be the moment a user reports that the console does not save. This is called from the
 * startup block in server.js, and the lazy call site is left in place because a render can reach
 * publicBaseUrl() before any request that would have triggered startup logging in a test.
 */
export function warnIfPublicBaseUrlUnset() {
    if (publicBaseUrlConfigured()) return false;
    if (warnedAboutMissingPublicBaseUrl) return false;
    warnedAboutMissingPublicBaseUrl = true;
    console.warn(publicBaseUrlUnsetWarning());
    return true;
}

/** Whether PUBLIC_BASE_URL names something, without the fallback's side effects. */
function publicBaseUrlConfigured() {
    const configured = process.env.PUBLIC_BASE_URL;
    return Boolean(configured && configured.trim() !== '');
}

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

    // The same sentence the startup call emits, so the two can never say different things.
    warnIfPublicBaseUrlUnset();

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
