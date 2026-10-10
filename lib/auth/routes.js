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
    isLocalhostRequest,
    readSession,
    revokeSession,
    sessionCookieOptions
} from './session.js';
import { issueLoginToken, loginLinkTtlMinutes, pruneLoginTokens, redeemLoginToken } from './tokens.js';
import { send as sendMail } from '../mail/index.js';

export const router = express.Router();

/** A conservative address check. Deliberately not a full RFC 5322 parser. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The public base URL for links in mail.
 *
 * Must be configured: a link built from a request header would be attacker-
 * controlled (a forged Host would mail a link to the attacker's domain), and a
 * relative link is useless in a mail client.
 */
function publicBaseUrl() {
    const configured = process.env.PUBLIC_BASE_URL;
    if (configured && configured.trim() !== '') {
        return configured.trim().replace(/\/+$/, '');
    }

    const port = Number(process.env.PORT) || 3000;
    console.warn(
        '[auth] PUBLIC_BASE_URL is unset; falling back to http://localhost:' + port +
        ' for sign-in links. Set it in .env for anything but local development.'
    );
    return `http://localhost:${port}`;
}

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

/** Redirects to the login page when there is no valid session. */
export function requireSession(req, res, next) {
    const session = currentSession(req);
    if (session) {
        req.session = session;
        return next();
    }
    return res.redirect('/admin/login');
}

router.get('/login', (req, res) => {
    res.render('admin-login', {
        error: req.query.error || null,
        sent: req.query.sent === '1',
        ttlMinutes: loginLinkTtlMinutes()
    });
});

router.post('/login', async (req, res) => {
    const email = String(req.body?.email || '').trim();
    const localhost = isLocalhostRequest(req);

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
    const link = `${publicBaseUrl()}/admin/login/verify?token=${encodeURIComponent(token)}`;

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
    console.info(`[auth] sign-in link sent (${localhost ? 'localhost' : 'secure'} cookie mode)`);
    return res.render('admin-login', { error: null, sent: true, ttlMinutes: loginLinkTtlMinutes() });
});

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

    const { cookieValue } = createSession(result.email);
    res.cookie(SESSION_COOKIE, cookieValue, sessionCookieOptions(isLocalhostRequest(req)));
    return res.redirect('/admin');
});

router.post('/logout', (req, res) => {
    const session = currentSession(req);
    if (session) revokeSession(session.sessionId);

    // Cleared with the same path so the browser overwrites the cookie it holds.
    res.clearCookie(SESSION_COOKIE, { path: '/admin' });
    return res.redirect('/admin/login');
});

router.get('/', requireSession, (req, res) => {
    res.render('admin-console', {
        email: req.session.email,
        expiresAt: req.session.expiresAt
    });
});
