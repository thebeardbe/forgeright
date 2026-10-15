/**
 * The HTTPS requirement, applied to the whole application: a per-route list is how a route gets forgotten,
 * while one check mounted before every route covers one added later.
 */
import { isLoopbackRequest, isSecureRequest } from './session.js';
import { publicBaseUrl } from './public-base-url.js';
import { BASE_PATH } from '../base-path.js';

/**
 * Paths exempt from the HTTPS requirement: /healthz only, because it is the one thing that serves no data
 * and accepts no credential, and a health check that answers 308 makes an orchestrator restart a healthy
 * container. If the endpoint ever reports anything about the system's state, it loses this exemption.
 */
const HTTPS_EXEMPT_PATHS = new Set(['/healthz']);

/**
 * Whether a request path is exempt, compared against the raw path exactly: Express normalises `req.path`,
 * so "/./healthz" and "/%2e%2e/healthz" both arrive there as "/healthz" and would otherwise reach the
 * endpoint over plain HTTP.
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
 * The path exactly as the client sent it, without the query string: `req.originalUrl` is the only place the
 * un-normalised form survives, and the query carries tokens that must never take part in a routing
 * decision.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
function rawPath(req) {
    return String(req.originalUrl || '/').split('?')[0];
}

/**
 * Refuses a request that did not arrive over a secure connection. What decides is `req.secure`, which
 * reflects the connection and honours X-Forwarded-Proto only for hops TRUST_PROXY allows; it is not the
 * hostname.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function requireSecureConnection(req, res, next) {
    if (isExemptPath(rawPath(req))) return next();

    // A CORS preflight, not every OPTIONS: a plain OPTIONS to a normal route is a probe, answered by the
    // framework with the allow-list, and a preflight carries no application data or credential.
    if (req.method === 'OPTIONS' && isCorsPreflight(req)) return next();

    if (isSecureRequest(req)) return next();

    // Both halves must be loopback, so nothing off-host is exempt; see isLoopbackRequest.
    if (isLoopbackRequest(req)) return next();

    const httpsUrl = httpsUrlFor(req);
    console.warn(
        `[auth] refusing an insecure request to ${req.method} ${redactTarget(req)} ` +
        `(host ${req.headers.host || 'unset'}, peer ${req.socket?.remoteAddress || 'unknown'})`
    );

    if (httpsUrl) {
        // 308 keeps the method and body, so a POST is retried as a POST rather than becoming a GET and
        // dropping the submitted payload.
        return res.redirect(308, httpsUrl);
    }

    return res.status(403).type('text/plain').send(refusalBody());
}

/**
 * Whether a request is an actual CORS preflight, which carries both headers; that is what distinguishes the
 * protocol message from a plain OPTIONS probe.
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
 * What a refusal logs: the path only, with any token query string removed, so the refusal does not write a
 * credential into the log.
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
 * The absolute HTTPS URL for the requested path, or null when PUBLIC_BASE_URL is itself plain HTTP.
 *
 * Only BASE_PATH is removed, not `req.baseUrl`: the app is mounted at the root while the public URL ends
 * with the public path, and `req.baseUrl` is the full mount path for whatever router handled the request,
 * so slicing it off drops route segments.
 *
 * @param {import('express').Request} req
 * @returns {string|null}
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
