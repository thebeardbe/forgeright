/**
 * REFUSING A STATE-CHANGING REQUEST THAT CAME FROM ANOTHER SITE.
 *
 * The console's only defence was `SameSite=Lax` on the session cookie, and that is not enough for this
 * deployment. **SameSite is scoped to the REGISTRABLE DOMAIN, not the host**, so every `*.bunkens.be` site
 * is the SAME SITE to the browser. MEASURED against this app: a POST to `/admin/organisation/name` carrying
 * a valid `fr_admin` cookie and `Origin: https://evil.bunkens.be` was accepted, and the organisation was
 * renamed. A sibling subdomain, a future test site, or a subdomain takeover is enough to drive it.
 *
 * THE RULE, and why it is these two headers together:
 *
 *   `Sec-Fetch-Site` is the browser's own statement about where the request came from, and the page cannot
 *   forge it. `same-origin` is the only value accepted. It is the strongest signal available and it needs
 *   no token, which matters because this app has no form infrastructure to thread one through.
 *
 *   `Origin` is the same information in a header browsers have sent for far longer. It equals the app's
 *   own public origin when the request came from its own pages.
 *
 * ACCEPTED: a request whose `Sec-Fetch-Site` is `same-origin`; or, when that header is absent, one whose
 * `Origin` equals this app's own origin.
 *
 * REFUSED: a request that carries either header saying something else. `Origin` mismatching is a refusal
 * even if `Sec-Fetch-Site` says same-origin, because a browser will not send both untruthfully and a
 * mismatch means something in the chain rewrote one of them.
 *
 * WHAT IF NEITHER HEADER IS PRESENT? IT IS ACCEPTED, deliberately, and this is the one place the rule
 * gives something up. Old browsers, some corporate proxies, and non-browser clients do not send either.
 * Refusing them would lock people out of their own console, and the console is reached by e-mail link on
 * whatever device the reader has. WHAT AN ATTACKER GAINS: nothing, in the case that matters. A page on a
 * sibling subdomain is a CURRENT BROWSER, and current browsers send Sec-Fetch-Site on every request, so
 * the browser that could run the attack is exactly the browser that cannot strip the headers. To reach the
 * no-header path an attacker would need to make the victim's browser stop sending them, which it will not.
 * The residual risk is a future or unusual client, which is why the cookie is also being renamed with a
 * `__Host-` prefix: that defends the same attack from the other end. See lib/auth/session.js.
 *
 * WHY NOT A CSRF TOKEN. A token is the textbook answer and it is strictly stronger. It also needs every
 * form to carry it, every route to verify it, and a story for the GET pages that redirect back. There is
 * one console, a handful of forms, and a guard that holds today; the token can be layered on later without
 * removing this check.
 */
import { publicBaseUrl } from './public-base-url.js';

/** Methods that cannot change state, and are therefore not checked. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The origin a browser sends for this deployment, or null when it cannot be determined.
 *
 * `publicBaseUrl()` is the value the app already uses to build links in e-mail, so it is the address the
 * participant and the admin actually reach. A trailing slash is stripped because `Origin` never has one.
 *
 * @returns {string|null}
 */
function ownOrigin() {
    try {
        return new URL(publicBaseUrl()).origin;
    } catch (err) {
        // An unusable PUBLIC_BASE_URL already stops startup elsewhere; here it means this check cannot
        // compare against anything, so it falls back to Sec-Fetch-Site alone rather than refusing
        // everything.
        console.error(`[csrf] cannot determine this app's origin: ${err.message}`);
        return null;
    }
}

/**
 * Whether a request's provenance headers say it came from this app.
 *
 * Returns the reason rather than a boolean so a refusal can be logged with what was seen, which is what
 * an operator needs when somebody reports being locked out.
 *
 * @param {{ method?: string, headers: Record<string, string|string[]|undefined> }} req
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function checkRequestOrigin(req, expectedOrigin = ownOrigin()) {
    const method = String(req.method || 'GET').toUpperCase();
    if (SAFE_METHODS.has(method)) return { ok: true };

    const headers = req.headers || {};
    const site = headerValue(headers['sec-fetch-site']);
    const origin = headerValue(headers.origin);

    // `Origin: null` MEANS "THIS BROWSER DID NOT SAY", not "a foreign site".
    //
    // MEASURED: Chromium 154 sends `Origin: null` with NO Sec-Fetch-Site for an ordinary same-origin
    // form POST from a page served over plain HTTP. Treating `null` as a foreign origin refused a real
    // admin rename, which would have broken the console for every legitimate user. So `null` is treated
    // exactly like an absent header and falls through to the checks below.
    //
    // That is not a hole: an attacking page on a sibling subdomain is a browser too, and a browser that
    // sends no usable Origin also sends no Sec-Fetch-Site on this build, so it lands in the same
    // "cannot tell" case. The defence that does not depend on either header is the `__Host-` cookie.
    const usableOrigin = origin !== null && origin !== 'null';

    // An Origin that contradicts us is a refusal on its own.
    if (usableOrigin && expectedOrigin !== null && origin !== expectedOrigin) {
        return { ok: false, reason: `Origin ${JSON.stringify(origin)} is not this app (${expectedOrigin})` };
    }

    if (site !== null) {
        if (site === 'same-origin') return { ok: true };
        return { ok: false, reason: `Sec-Fetch-Site ${JSON.stringify(site)} is not same-origin` };
    }

    // No Sec-Fetch-Site: fall back to Origin, which is the older way to say the same thing.
    if (usableOrigin) return { ok: true };

    // Neither header. Accepted on purpose; see the header of this file for what that gives up.
    return { ok: true };
}

/** A header value as a string, or null when absent. Arrays (a repeated header) count as present. */
function headerValue(value) {
    if (value === undefined || value === null) return null;
    if (Array.isArray(value)) return value.length > 0 ? String(value[0]) : null;
    const text = String(value);
    return text === '' ? null : text;
}

/**
 * Express middleware refusing a cross-site request that could change state.
 *
 * Mounted before every console route, so a route added later is covered without being told about it.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function refuseCrossSiteWrites(req, res, next) {
    const verdict = checkRequestOrigin(req);
    if (verdict.ok) return next();

    console.warn(
        `[csrf] refused ${req.method} ${req.originalUrl || req.url} from ${req.ip || 'unknown'}: ${verdict.reason}`
    );
    // 403 rather than a redirect: this is not "sign in again", it is "this request did not come from
    // here", and a redirect would hide a real attack behind a login page.
    return res.status(403).type('text/plain').send(
        'This request did not come from this site, so it was not carried out. '
        + 'Open the console directly and try again.'
    );
}
