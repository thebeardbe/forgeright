/**
 * The HTTPS requirement, applied to the WHOLE application.
 *
 * WHY REFUSE RATHER THAN ADAPT. Everything this app serves over plain HTTP
 * either carries a credential or describes how a business runs:
 *
 *   - The admin session cookie is a bearer credential: a holder of the value is
 *     the admin. Over HTTP it crosses the wire in cleartext, where anything able
 *     to observe the traffic can replay it and become the admin.
 *   - The participant link token is a bearer credential too. It is single-use
 *     with a short expiry, but a token sent in cleartext can be used by anyone
 *     observing it BEFORE the participant does, which submits answers in
 *     someone else's name and corrupts the roadmap the client then acts on.
 *   - The answers themselves are employees describing internal processes, which
 *     is the sensitive material this product exists to collect. The request body
 *     of /api/chat and /api/score carries those answers.
 *
 *     This used to add that the body also carried a shared AUDIT_ACCESS_CODE. That
 *     variable is gone, so the sentence was removed with it rather than left as a
 *     stale justification: a reason for a rule should describe the system that
 *     exists. The rule itself got no weaker - every credential on the wire is a
 *     bearer credential, and there is no longer a shared secret among them.
 *
 * So it is ONE RULE FOR EVERYTHING, not a per-route decision. A per-route list
 * is how a route gets forgotten; this is a single check mounted before every
 * route, so a route added later is covered without anyone remembering.
 *
 * Kept in its own module because it is a policy about the CONNECTION, not about
 * any one feature.
 */
import { isLoopbackRequest, isSecureRequest } from './session.js';
import { publicBaseUrl } from './public-base-url.js';
import { BASE_PATH } from '../base-path.js';

/**
 * Paths exempt from the HTTPS requirement.
 *
 * /healthz ONLY, and the reason is that it is the one thing that serves no data
 * and accepts no credential: it answers { ok: true } and nothing else, so there
 * is nothing on the wire for an observer to use, and no state to corrupt.
 *
 * It is exempt because refusing it would break deployments rather than protect
 * them. A container health check or a plain-HTTP liveness probe is normally
 * pointed at a local address with no TLS in front of it, and a health check that
 * answers 308 or 403 makes the orchestrator restart a healthy container. The
 * failure that produces (an outage caused by a security control) is worse than
 * the exposure it prevents (a boolean, over a network the probe already
 * controls).
 *
 * This is a deliberate exception with a stated reason, not an oversight. If the
 * endpoint ever reports anything about the system's state, it loses the
 * exemption.
 */
const HTTPS_EXEMPT_PATHS = new Set(['/healthz']);

/**
 * Whether a request path is exempt from the HTTPS requirement.
 *
 * COMPARED AGAINST THE RAW PATH, exactly, which is the fix for a real hole. The
 * first version compared req.path. Express NORMALISES req.path before any
 * middleware runs (measured: for a request to "/./healthz", "/foo/../healthz"
 * and "/%2e%2e/healthz", req.path is "/healthz" while req.originalUrl keeps the
 * form the client sent). So all three reached the exempt endpoint over plain
 * HTTP. Harmless while the endpoint returns only {"ok":true}, but the exemption
 * is supposed to cover ONE path and it did not.
 *
 * The caller passes the un-normalised path (see rawPath), so only the literal
 * "/healthz" is exempt. A path that normalises to it but is written differently
 * is refused, which is the safe direction and makes the exemption mean what it
 * says.
 *
 * @param {string} requestPath The raw path, without a query string.
 * @returns {boolean}
 */
function isExemptPath(requestPath) {
    const withoutBase = BASE_PATH !== '' && requestPath.startsWith(BASE_PATH)
        ? requestPath.slice(BASE_PATH.length)
        : requestPath;
    return HTTPS_EXEMPT_PATHS.has(withoutBase === '' ? '/' : withoutBase);
}

/**
 * The path exactly as the client sent it, without the query string.
 *
 * req.originalUrl is the only place the un-normalised form survives: req.path and
 * req.url are both already normalised and stripped by the time middleware runs.
 * The query is removed because it carries the sign-in and participant tokens,
 * which must never take part in a routing decision.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
function rawPath(req) {
    return String(req.originalUrl || '/').split('?')[0];
}

/**
 * Refuses a request that did not arrive over a secure connection.
 *
 * WHAT DECIDES: req.secure, which reflects the connection and honours
 * X-Forwarded-Proto only for hops TRUST_PROXY allows. It is NOT the hostname:
 * keying on the name was an earlier defect in the opposite direction, and it
 * would let a plain-HTTP request on a trusted-looking name through. The trust
 * boundary is unchanged.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function requireSecureConnection(req, res, next) {
    // Compared against the RAW path so the exemption is exactly one literal path;
    // see isExemptPath for why a normalised comparison was too broad. req.path is
    // used (not originalUrl) so the query string, which carries the sign-in and
    // participant tokens, is never part of the decision.
    if (isExemptPath(rawPath(req))) return next();

    // A CORS PREFLIGHT is exempt. Not every OPTIONS request: an OPTIONS to a
    // normal route is a probe, and it is answered by the framework with the
    // allow-list, which reveals the method surface over cleartext for no reason.
    // A preflight is a protocol message that carries no application data and no
    // credential, and refusing it would make a legitimate cross-origin request
    // fail with a redirect the browser will not follow.
    if (req.method === 'OPTIONS' && isCorsPreflight(req)) return next();

    if (isSecureRequest(req)) return next();

    // THE LOOPBACK EXEMPTION. A request whose peer AND Host are both loopback
    // never crossed a network: the bytes stayed inside this machine, so there is
    // no wire for an observer to read a session cookie from. Requiring both
    // halves (see isLoopbackRequest) makes this a narrow exemption rather than a
    // hole: a local process cannot claim a public hostname, and a remote client
    // cannot claim loopback.
    //
    // It is not a weakening of the HTTPS rule for deployments: nothing off-host
    // is exempt, and the exemption is what makes `npm start` usable at all.
    if (isLoopbackRequest(req)) return next();

    const httpsUrl = httpsUrlFor(req);
    console.warn(
        `[auth] refusing an insecure request to ${req.method} ${redactTarget(req)} ` +
        `(host ${req.headers.host || 'unset'}, peer ${req.socket?.remoteAddress || 'unknown'})`
    );

    if (httpsUrl) {
        // 308 keeps the method and body, so a POST that arrived over HTTP is
        // retried as a POST at the HTTPS address rather than silently becoming a
        // GET, which would drop the submitted form or API payload.
        return res.redirect(308, httpsUrl);
    }

    // No HTTPS origin is configured, so there is nowhere to send them. Say what
    // is wrong and what to set, rather than redirecting into a loop or a bare 403.
    return res.status(403).type('text/plain').send(refusalBody());
}

/**
 * Whether a request is an actual CORS preflight.
 *
 * A preflight carries both `Origin` and `Access-Control-Request-Method`; that is
 * what distinguishes the protocol message from a plain OPTIONS probe, which any
 * client can send to read a route's allow-list.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isCorsPreflight(req) {
    return typeof req.headers.origin === 'string'
        && typeof req.headers['access-control-request-method'] === 'string';
}

/**
 * The refusal text, naming the problem and both ways forward.
 *
 * @returns {string}
 */
function refusalBody() {
    return [
        'This site is served over HTTPS only.',
        '',
        'This request arrived over a plain HTTP connection. Both the sign-in link and the',
        'participant link are credentials, and the questionnaire answers describe how the',
        'business runs, so none of it may cross the network in cleartext.',
        '',
        'Use the https:// address of this site instead.',
        '',
        'If this instance has no HTTPS address yet, set PUBLIC_BASE_URL to one in .env. Until then',
        'the site is reachable only from this machine, over http://localhost.',
        ''
    ].join('\n');
}

/**
 * What a refusal logs: the path, with any token query parameter removed.
 *
 * A REFUSAL IS THE LAST PLACE A CREDENTIAL SHOULD BE WRITTEN DOWN. The sign-in
 * token and the participant token both travel in the query string, and a request
 * refused for being insecure is exactly the one most likely to already be sitting
 * in a proxy's access log or a packet capture, so copying it into this log
 * repeats the exposure the refusal is meant to prevent. The path is enough to
 * tell an operator what was refused.
 *
 * @param {import('express').Request} req
 * @returns {string} The path only, with a redaction marker when a token was present.
 */
function redactTarget(req) {
    const path = req.originalUrl.split('?')[0];
    const hadQuery = req.originalUrl.length !== path.length;
    return hadQuery ? `${path}?[query redacted]` : path;
}

/**
 * The absolute HTTPS URL for the requested path, or null.
 *
 * Returns null when the configured PUBLIC_BASE_URL is itself plain HTTP: there
 * is no secure origin to redirect to, and redirecting to another http:// URL
 * would be theatre.
 *
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function httpsUrlFor(req) {
    let base;
    try {
        base = publicBaseUrl();
    } catch (err) {
        // A bad PUBLIC_BASE_URL is caught at startup; if the environment changed
        // under a running process, log it and fall through to the plain refusal
        // rather than turning a refusal into a crash.
        console.error(`[auth] cannot compute the HTTPS URL: ${err.message}`);
        return null;
    }

    if (!base.startsWith('https://')) return null;

    // The caller's path, with only the MOUNTED prefix removed, because
    // publicBaseUrl() already ends with the PUBLIC path. The two differ when a
    // proxy strips its prefix: the app is mounted at the root (so the incoming
    // path carries nothing to strip) while the public URL ends with /forgeright.
    //
    // Not req.baseUrl: that is the FULL mount path for whatever router handled the
    // request (measured: "/forgeright/admin" inside the admin router), so slicing
    // it off drops route segments and the redirect lands on a 404. Not slicing at
    // all would double the public path. So the only thing removed is BASE_PATH,
    // from the front of the original URL.
    let remainder = req.originalUrl;
    if (BASE_PATH !== '' && remainder.startsWith(BASE_PATH)) {
        remainder = remainder.slice(BASE_PATH.length);
    }
    if (remainder === '') remainder = '/';

    return `${base}${remainder}`;
}
