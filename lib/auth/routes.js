/**
 * Admin routes: login, logout, and the console.
 *
 * Mounted by server.js as a router, so the auth surface lives in one file rather
 * than being scattered through the app. Everything under /admin is behind the
 * session guard except the login routes themselves.
 *
 * The login response is deliberately identical whether or not an address is
 * known to the system. This installation has no account list to check against in
 * this step: an admin link is issued for any well-formed address, and the
 * console that decides who may actually use it is step 3. The property that
 * matters now is that the response cannot be used to enumerate who has signed in
 * before.
 */
import express from 'express';
import { checkLoginRate } from './rate-limit.js';
import {
    SESSION_COOKIE,
    createSession,
    isSecureRequest,
    readSession,
    revokeSession,
    sessionCookieOptions,
    sessionCookiePath
} from './session.js';
import { withBasePath } from '../base-path.js';
import { publicBaseUrl, assertPublicBaseUrlUsable } from './public-base-url.js';
import { issueLoginToken, loginLinkTtlMinutes, pruneLoginTokens, redeemLoginToken } from './tokens.js';
import { send as sendMail } from '../mail/index.js';
import { ROLES } from '../users.js';
import { resolveSignIn } from '../provision.js';
import { requireConsole, router as consoleRouter } from './console.js';

export { assertPublicBaseUrlUsable, publicBaseUrl };

/**
 * Admin routes: login, logout, and the console.
 *
 * The HTTPS requirement is NOT mounted here. It applies to the whole
 * application and is mounted in server.js before every route, so there is one
 * check rather than one per router. See lib/auth/require-secure.js.
 */
export const router = express.Router();

/** A conservative address check. Deliberately not a full RFC 5322 parser. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Defaults every render of the login page needs.
 *
 * Set on res.locals so a render call that omits a flag does not throw: EJS fails
 * on an undefined variable, and eight call sites each having to remember one is
 * how a page breaks on a path nobody re-tested.
 */
router.use((req, res, next) => {
    res.locals.noConsole = false;
    res.locals.error = null;
    res.locals.sent = false;
    next();
});

/** The session for a request, or null. Attached by the guard and by /admin. */
function currentSession(req) {
    return readSession(req.cookies?.[SESSION_COOKIE]);
}

/**
 * Reads cookies into req.cookies.
 *
 * Hand-rolled rather than adding cookie-parser: the only cookie this application
 * sets is its own session cookie. A malformed pair is skipped, and the session
 * reader then refuses the request, which is the correct outcome for a corrupt
 * cookie.
 */
export function cookieReader(req, _res, next) {
    const header = req.headers.cookie;
    const jar = {};
    if (header) {
        for (const pair of header.split(';')) {
            const eq = pair.indexOf('=');
            if (eq === -1) continue;
            const name = pair.slice(0, eq).trim();
            if (!name) continue;
            try {
                jar[name] = decodeURIComponent(pair.slice(eq + 1).trim());
            } catch {
                // A percent-encoding error in one cookie is not fatal: skip that
                // pair and let the session reader refuse if it was the session.
                console.warn(`[auth] ignoring a cookie with undecodable value: ${name}`);
            }
        }
    }
    req.cookies = jar;
    return next();
}

/** Redirects to the sign-in form when there is no valid session. */
export function requireSession(req, res, next) {
    const session = currentSession(req);
    if (session) {
        req.session = session;
        return next();
    }
    return res.redirect(withBasePath('/admin'));
}

/**
 * `/admin` serves the sign-in form OR the console, chosen by the session.
 *
 * THERE IS NO SEPARATE REGISTER OR SIGN-IN PATH. The two are the same action: an
 * unknown address creates an organisation, a known one signs in to the existing
 * one (see resolveSignIn). So an admin can bookmark /admin and it always does the
 * right thing, and a first-time visitor is not asked to decide which they are.
 */
router.get('/', (req, res, next) => {
    const session = currentSession(req);
    if (!session) {
        // Not signed in: the email form. Rendered through the same helper the
        // login path uses, so the two cannot drift apart.
        return res.render('admin-login', {
            error: req.query.error || null,
            sent: false,
            noConsole: false,
            ttlMinutes: loginLinkTtlMinutes()
        });
    }

    req.session = session;
    return next();
});

/**
 * The explicit login path, kept because sign-in links already mailed to admins
 * point at it. It behaves exactly as /admin does when signed out, and forwards to
 * the console when signed in, so an old bookmarked link does not become a dead
 * end.
 */
router.get('/login', (req, res) => {
    res.render('admin-login', {
        error: req.query.error || null,
        sent: req.query.sent === '1',
        // A signed-in user whose role is `user` is sent here rather than to a
        // console that would refuse them. The page says so plainly instead of
        // showing a login form that would appear to do nothing.
        noConsole: req.query.role === 'user',
        ttlMinutes: loginLinkTtlMinutes()
    });
});
/**
 * Handles the sign-in form.
 *
 * MOUNTED AT BOTH `/admin` AND `/admin/login`, from one definition, because
 * they are the same action: an unknown address creates an organisation and a
 * known one signs in to it. Having two handlers would be two places for the
 * enumeration-resistant response to drift out of step.
 */
async function handleSignIn(req, res) {
    const email = String(req.body?.email || '').trim();

    const rate = checkLoginRate(req, email || req.socket?.remoteAddress || 'unknown');
    if (!rate.allowed) {
        console.warn(`[auth] login request rate-limited by ${rate.reason}`);
        res.set('Retry-After', String(rate.retryAfterSeconds));
        // The same page as a success, so the limit cannot be used to probe
        // whether an address exists, and the browser is told to wait.
        return res.status(429).render('admin-login', {
            error: 'too_many_requests',
            sent: false,
            ttlMinutes: loginLinkTtlMinutes()
        });
    }

    if (!EMAIL_PATTERN.test(email)) {
        return res.status(400).render('admin-login', {
            error: 'invalid_email',
            sent: false,
            ttlMinutes: loginLinkTtlMinutes()
        });
    }

    // Issued before the send is attempted, so the mail body has a real link. If
    // the send fails the token stays unused and expires on its own.
    const { token } = issueLoginToken(email);

    // The base URL is validated at startup, so this cannot normally throw. If it
    // does (the environment changed under a running process), fail THIS request
    // with a 500 instead of letting the throw take down the server: a bad
    // configuration must not turn into an outage on an admin's login attempt.
    let link;
    try {
        link = `${publicBaseUrl()}/admin/login/verify?token=${encodeURIComponent(token)}`;
    } catch (err) {
        console.error(`[auth] cannot build a sign-in link: ${err.message}`);
        return res.status(500).render('admin-login', {
            error: 'send_failed',
            sent: false,
            ttlMinutes: loginLinkTtlMinutes()
        });
    }

    try {
        await sendMail({
            to: email,
            subject: 'Your forgeright sign-in link',
            body: [
                'Open this link to sign in to the forgeright admin console:',
                '',
                link,
                '',
                `The link works once and expires in ${loginLinkTtlMinutes()} minutes.`,
                'If you did not request it, ignore this message.'
            ].join('\n')
        });
    } catch (err) {
        // Never silent. An expired Proton session is the expected failure mode,
        // and the symptom on the admin's side is "the mail never arrived", so the
        // reason has to be in the log.
        console.error(`[auth] could not send the sign-in link: ${err.message}`);
        return res.status(502).render('admin-login', {
            error: 'send_failed',
            sent: false,
            ttlMinutes: loginLinkTtlMinutes()
        });
    }

    // The same response whether or not the address has signed in before. There
    // is no account list in this step, but the response must already be
    // indistinguishable so that adding one does not change observable behaviour.
    pruneLoginTokens();
    // The cookie mode is logged from the connection, not the hostname, so the
    // log says what the browser and the cookie will actually do. A "plain"
    // session over a non-TLS request is expected on a Tailscale or LAN address
    // and is the reason sign-in works there at all.
    const secure = isSecureRequest(req);
    console.info(`[auth] sign-in link sent (${secure ? 'secure' : 'plain'} cookie mode)`);
    return res.render('admin-login', { error: null, sent: true, ttlMinutes: loginLinkTtlMinutes() });
}

// The single sign-in action, at both addresses. `/admin` is what the landing
// page and the docs point at; `/admin/login` is kept because links already
// mailed to admins use it.
router.post('/', handleSignIn);
router.post('/login', handleSignIn);

router.get('/login/verify', (req, res) => {
    const result = redeemLoginToken(req.query.token);

    if (!result.ok) {
        // One page for every refusal reason, so the outcome does not say which.
        console.warn(`[auth] sign-in link refused (${result.reason})`);
        return res.status(400).render('admin-login', {
            error: 'link_invalid',
            sent: false,
            ttlMinutes: loginLinkTtlMinutes()
        });
    }

    // PROVISIONING HAPPENS HERE, not at the request to send a link. Creating an
    // organisation when a link is merely REQUESTED would let anyone fill the
    // installation with empty organisations from an address they do not control.
    // Redeeming proves control of the address, so this is the first honest moment
    // to decide who the person is.
    let scope;
    try {
        scope = resolveSignIn(result.email);
    } catch (err) {
        console.error(`[auth] could not provision a user for ${result.email}: ${err.message}`);
        return res.status(500).render('admin-login', {
            error: 'signin_failed',
            sent: false,
            ttlMinutes: loginLinkTtlMinutes()
        });
    }

    const { cookieValue } = createSession(result.email);
    res.cookie(SESSION_COOKIE, cookieValue, sessionCookieOptions(isSecureRequest(req)));

    // A `user` role signs in successfully but has no console. They are sent to a
    // page that says so, rather than to a console that would refuse them.
    if (scope.user.role === ROLES.ADMIN) {
        return res.redirect(withBasePath('/admin'));
    }
    return res.redirect(withBasePath('/admin/login?role=user'));
});

router.post('/logout', (req, res) => {
    const session = currentSession(req);
    if (session) revokeSession(session.sessionId);

    // Cleared with the same path it was set with, so the browser overwrites the
    // cookie it holds. sessionCookiePath() is the one source of that value.
    res.clearCookie(SESSION_COOKIE, { path: sessionCookiePath() });
    return res.redirect(withBasePath('/admin/login'));
});

// The console, mounted INSIDE the admin router, so it shares the session guard
// and the public path. Every console route is behind requireSession (proves who
// is asking) and requireConsole (resolves their organisation from that session,
// and refuses a plain user). The GET / above has already rendered the sign-in
// form for a request with no session, so this chain only sees signed-in ones, and
// a console route added later cannot be reached without both guards.


// A signed-in session falls through to the console guard and the console itself.
router.use('/', requireSession, requireConsole, consoleRouter);