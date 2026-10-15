/**
 * Admin routes: login, logout, and the console, mounted by server.js as a router. Everything under
 * /admin is behind the session guard except the login routes themselves.
 *
 * The login response is deliberately identical whether or not an address is known, so it cannot be used to
 * enumerate who has signed in before.
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
import { registerDemoRoute } from './demo-login.js';
import { isDemoSession, refuseWritesForDemoSessions } from './demo-readonly.js';
import { getOrganisation } from '../store/index.js';

export { assertPublicBaseUrlUsable, publicBaseUrl };

/**
 * The HTTPS requirement is not mounted here: it applies to the whole application and is mounted in
 * server.js before every route, so there is one check rather than one per router.
 */
export const router = express.Router();

// First, immediately after the router is created, so it precedes every route registered below it,
// including the sign-in action. `currentSession` is hoisted.
router.use(refuseWritesForDemoSessions(currentSession, isDemoSession));

/** A conservative address check. Deliberately not a full RFC 5322 parser. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Defaults every render of the login page needs, on res.locals so a render call that omits a flag does
 * not throw: EJS fails on an undefined variable.
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
 * Reads cookies into req.cookies. Hand-rolled rather than adding cookie-parser, because the only cookie
 * this application sets is its own session cookie; a malformed pair is skipped and the session reader then
 * refuses the request.
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
                // Not fatal: skip the pair and let the session reader refuse if it was the session.
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
 * `/admin` serves the sign-in form or the console, chosen by the session. There is no separate register or
 * sign-in path: an unknown address creates an organisation and a known one signs in to the existing one, so
 * /admin always does the right thing as a bookmark.
 */
router.get('/', (req, res, next) => {
    const session = currentSession(req);
    if (!session) {
        // The email form, through the same helper the login path uses.
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
 * The explicit login path, kept because sign-in links already mailed to admins point at it, so an old
 * bookmarked link does not become a dead end.
 */
router.get('/login', (req, res) => {
    res.render('admin-login', {
        error: req.query.error || null,
        sent: req.query.sent === '1',
        // A `user` role is sent here rather than to a console that would refuse them, and the page says so.
        noConsole: req.query.role === 'user',
        ttlMinutes: loginLinkTtlMinutes()
    });
});
/**
 * Handles the sign-in form, mounted at both `/admin` and `/admin/login` from one definition, so the
 * enumeration-resistant response cannot drift between two handlers.
 */
async function handleSignIn(req, res) {
    const email = String(req.body?.email || '').trim();

    const rate = checkLoginRate(req, email || req.socket?.remoteAddress || 'unknown');
    if (!rate.allowed) {
        console.warn(`[auth] login request rate-limited by ${rate.reason}`);
        res.set('Retry-After', String(rate.retryAfterSeconds));
        // The same page as a success, so the limit cannot probe whether an address exists.
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

    // Issued before the send, so the mail body has a real link; a failed send leaves the token unused and
    // it expires on its own.
    const { token } = issueLoginToken(email);

    // Validated at startup, so this cannot normally throw; if the environment changed under a running
    // process, fail this request rather than the server.
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
        // The symptom on the admin's side is "the mail never arrived", so the reason is logged.
        console.error(`[auth] could not send the sign-in link: ${err.message}`);
        return res.status(502).render('admin-login', {
            error: 'send_failed',
            sent: false,
            ttlMinutes: loginLinkTtlMinutes()
        });
    }

    // The response is the same whether or not the address has signed in before.
    pruneLoginTokens();
    // Logged from the connection rather than the hostname, so the log says what the browser and the
    // cookie will actually do.
    const secure = isSecureRequest(req);
    console.info(`[auth] sign-in link sent (${secure ? 'secure' : 'plain'} cookie mode)`);
    return res.render('admin-login', { error: null, sent: true, ttlMinutes: loginLinkTtlMinutes() });
}

// The single sign-in action, at both addresses.
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

    // Here rather than at the request to send a link: redeeming proves control of the address, while
    // creating an organisation on request would let anyone fill the installation from an address they do
    // not control.
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

    // A `user` signs in successfully but has no console.
    if (scope.user.role === ROLES.ADMIN) {
        return res.redirect(withBasePath('/admin'));
    }
    return res.redirect(withBasePath('/admin/login?role=user'));
});

router.post('/logout', (req, res) => {
    const session = currentSession(req);
    if (session) revokeSession(session.sessionId);

    // Cleared with the same path it was set with, so the browser overwrites the cookie it holds.
    res.clearCookie(SESSION_COOKIE, { path: sessionCookiePath() });
    return res.redirect(withBasePath('/admin/login'));
});

// The console, mounted inside the admin router so it shares the session guard and the public path. Every
// console route is behind requireSession and requireConsole, and the GET / above has already rendered the
// sign-in form for a request with no session, so this chain only sees signed-in ones.

// Registered here, before the session guard, because a demo link is opened by somebody who is not signed in.
//
// NOT IN `DEMO_SESSION_ALLOWED`, correctly rather than by omission: establishing a demo session is the one
// write a demo link performs, so there is no session yet to exempt.
registerDemoRoute(router, {
    createSession, currentSession, isDemoSession, sessionCookieOptions,
    isSecureRequest, withBasePath, SESSION_COOKIE, getOrganisation
});

// A signed-in session falls through to the console guard and the console itself.
//
// The read-only guard is not here: an Express router runs middleware in registration order, so a guard on
// this chain cannot cover a route registered above it. It is mounted at the top of this file, before every
// route, so it covers all of them; only `POST /logout` is exempt, and that list is in ./demo-readonly.js.
router.use('/', requireSession, requireConsole, consoleRouter);