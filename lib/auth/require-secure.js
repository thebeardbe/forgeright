/**
 * The HTTPS requirement, applied to the whole application: a per-route list is how a route gets forgotten,
 * while one check mounted before every route covers one added later.
 */
import { isLoopbackRequest, isSecureRequest } from './session.js';
import { publicBaseUrl } from './public-base-url.js';
import { BASE_PATH } from '../base-path.js';

/**
 * /healthz only: it serves no data and accepts no credential, and a health check that answers 308 makes an
 * orchestrator restart a healthy container. It loses this exemption if it ever reports system state.
 */
const HTTPS_EXEMPT_PATHS = new Set(['/healthz']);

/**
 * Compared against the raw path exactly: Express normalises `req.path`, so "/./healthz" would otherwise reach
 * the endpoint over plain HTTP.
 *
 * @returns {boolean}
 */
function isExemptPath(requestPath) {
    const withoutBase = BASE_PATH !== '' && requestPath.startsWith(BASE_PATH)
        ? requestPath.slice(BASE_PATH.length)
        : requestPath;
    return HTTPS_EXEMPT_PATHS.has(withoutBase === '' ? '/' : withoutBase);
}

/**
 * `req.originalUrl` is the only place the un-normalised form survives, and the query carries tokens that must
 * never take part in a routing decision.
 *
 * @returns {string}
 */
function rawPath(req) {
    return String(req.originalUrl || '/').split('?')[0];
}

/**
 * What decides is `req.secure`, which honours X-Forwarded-Proto only for hops TRUST_PROXY allows; it is not
 * the hostname.
 */
export function requireSecureConnection(req, res, next) {
    if (isExemptPath(rawPath(req))) return next();

    // A preflight, not every OPTIONS: a plain OPTIONS is a probe, answered with the allow-list.
    if (req.method === 'OPTIONS' && isCorsPreflight(req)) return next();

    if (isSecureRequest(req)) return next();

    // Both halves must be loopback, so nothing off-host is exempt.
    if (isLoopbackRequest(req)) return next();

    const httpsUrl = httpsUrlFor(req);
    console.warn(
        `[auth] refusing an insecure request to ${req.method} ${redactTarget(req)} ` +
        `(host ${req.headers.host || 'unset'}, peer ${req.socket?.remoteAddress || 'unknown'})`
    );

    if (httpsUrl) {
        // 308 keeps the method and body, so a POST is not downgraded to a GET and does not drop its payload.
        return res.redirect(308, httpsUrl);
    }

    return res.status(403).type('text/plain').send(refusalBody());
}

/** A preflight carries both headers; that is what distinguishes it from a plain OPTIONS probe. */
function isCorsPreflight(req) {
    return typeof req.headers.origin === 'string'
        && typeof req.headers['access-control-request-method'] === 'string';
}

/** Names the problem and both ways forward. */
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

/** The path only, so the refusal does not write a token into the log. */
function redactTarget(req) {
    const path = req.originalUrl.split('?')[0];
    const hadQuery = req.originalUrl.length !== path.length;
    return hadQuery ? `${path}?[query redacted]` : path;
}

/**
 * Only BASE_PATH is removed, not `req.baseUrl`, which is the full mount path for whatever router handled the
 * request; slicing that off drops route segments. Null when PUBLIC_BASE_URL is itself plain HTTP.
 */
function httpsUrlFor(req) {
    let base;
    try {
        base = publicBaseUrl();
    } catch (err) {
        // A bad PUBLIC_BASE_URL is caught at startup; if the environment changed under a running process,
        // fall through to the plain refusal rather than turning a refusal into a crash.
        console.error(`[auth] cannot compute the HTTPS URL: ${err.message}`);
        return null;
    }

    if (!base.startsWith('https://')) return null;

    let remainder = req.originalUrl;
    if (BASE_PATH !== '' && remainder.startsWith(BASE_PATH)) {
        remainder = remainder.slice(BASE_PATH.length);
    }
    if (remainder === '') remainder = '/';

    return `${base}${remainder}`;
}
