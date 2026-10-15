/**
 * Admin sessions, as a signed cookie: a server-side row plus a cookie carrying its id, where the row is
 * what makes logout real and the HMAC is what rejects a forged id before lookup.
 *
 * SESSION_SECRET must come from the environment, because a secret generated per process would invalidate
 * every session on restart and look like a broken login.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { adminConnection } from '../store/registry.js';
import { withBasePath } from '../base-path.js';
import { hostnameFromHeader } from '../trust-proxy.js';

/** Cookie name. Prefixed to avoid colliding with anything else on the origin. */
export const SESSION_COOKIE = 'fr_admin';

/** Hours a session lasts, unless SESSION_TTL_HOURS says otherwise. */
const DEFAULT_TTL_HOURS = 12;

/** Length of the hex HMAC tag appended to the cookie value. */
const TAG_HEX_LENGTH = 64;

/** Domain separator, so this HMAC cannot be reused for another purpose. */
const HMAC_CONTEXT = 'forgeright/admin-session/v1';

function nowIso() {
    return new Date().toISOString();
}

/**
 * Hours an admin session lasts: twelve covers a working day and ends before the next morning. Empty or
 * whitespace counts as unset, matching the other readers.
 *
 * @returns {number}
 */
export function sessionTtlHours() {
    const raw = process.env.SESSION_TTL_HOURS;

    if (raw === undefined || raw.trim() === '') {
        return DEFAULT_TTL_HOURS;
    }

    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        console.warn(
            `[session] SESSION_TTL_HOURS=${JSON.stringify(raw)} is not a positive number; ` +
            `using ${DEFAULT_TTL_HOURS} hours.`
        );
        return DEFAULT_TTL_HOURS;
    }
    return parsed;
}

/**
 * The signing secret, or a thrown error naming the problem. Called at startup, so a missing secret stops
 * the server rather than every login. A short secret is warned about rather than refused.
 *
 * @returns {string}
 * @throws {Error} When SESSION_SECRET is unset or empty.
 */
export function assertSessionSecretConfigured() {
    const secret = process.env.SESSION_SECRET;

    if (secret === undefined || secret.trim() === '') {
        throw new Error(
            'SESSION_SECRET is unset. The admin session cookie is signed with it, and a secret generated ' +
            'per process would invalidate every session on restart and look like a broken login. ' +
            'Set it in .env, for example with: openssl rand -hex 32'
        );
    }

    if (secret.trim().length < 32) {
        console.warn(
            `[session] SESSION_SECRET is only ${secret.trim().length} characters. ` +
            'It still works, but 32 bytes of hex (64 characters) is the intended strength; ' +
            'generate one with: openssl rand -hex 32'
        );
    }
    return secret;
}

/** Fails loudly when the secret is missing. A programming error. */
function secret() {
    const value = process.env.SESSION_SECRET;
    if (!value || value.trim() === '') {
        throw new Error('SESSION_SECRET is unset; refusing to sign or verify a session cookie.');
    }
    return value;
}

/**
 * Signs a value with HMAC-SHA256 and the session secret. The context string is part of the message, so a
 * tag from this scheme is never valid for another.
 *
 * @param {string} value
 * @returns {string} 64 lowercase hex characters.
 */
function sign(value) {
    return createHmac('sha256', secret()).update(`${HMAC_CONTEXT}:${value}`).digest('hex');
}

/**
 * True when a tag matches the value, compared in constant time. The length and hex checks are what let
 * `timingSafeEqual` see only fixed-length input, so a malformed tag is a mismatch rather than a crash.
 *
 * @param {string} value
 * @param {string} tag
 * @returns {boolean}
 */
function tagMatches(value, tag) {
    if (typeof tag !== 'string' || tag.length !== TAG_HEX_LENGTH) return false;
    if (!/^[0-9a-f]+$/.test(tag)) return false;

    return timingSafeEqual(Buffer.from(sign(value), 'hex'), Buffer.from(tag, 'hex'));
}

/**
 * Creates a session for an address and returns the cookie value.
 *
 * @param {string} email
 * @returns {{ cookieValue: string, expiresAt: string, sessionId: string }}
 */
export function createSession(email) {
    if (typeof email !== 'string' || email.trim() === '') {
        throw new Error('createSession requires a non-empty email address.');
    }

    const sessionId = randomUUID();
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + sessionTtlHours() * 3_600_000).toISOString();

    const db = adminConnection();
    db.prepare(
        `INSERT INTO admin_session (id, email, created_at, expires_at, revoked_at)
         VALUES (?, ?, ?, ?, NULL)`
    ).run(sessionId, email.trim(), createdAt, expiresAt);

    // Carrying the expiry in the cookie lets a stale one be rejected without a lookup; the row remains
    // the authority.
    const payload = `${sessionId}.${expiresAt}`;
    console.info(`[session] created an admin session, valid until ${expiresAt}`);

    return { cookieValue: `${payload}.${sign(payload)}`, expiresAt, sessionId };
}

/**
 * Verifies a cookie value and returns the session it names, or null. Every kind of failure returns null,
 * because the caller shows one outcome for all of them, and the reasons are logged so an operator can tell
 * forged from expired from revoked.
 *
 * @param {string} cookieValue
 * @returns {{ email: string, sessionId: string, expiresAt: string }|null}
 */
export function readSession(cookieValue) {
    if (typeof cookieValue !== 'string' || cookieValue === '') return null;

    // From the right: the payload is two dot-separated fields plus the tag, and neither an ISO timestamp
    // nor a UUID contains a dot.
    const lastDot = cookieValue.lastIndexOf('.');
    if (lastDot === -1) {
        console.warn('[session] a session cookie had no signature; refusing.');
        return null;
    }

    const payload = cookieValue.slice(0, lastDot);
    const tag = cookieValue.slice(lastDot + 1);

    if (!tagMatches(payload, tag)) {
        console.warn('[session] a session cookie failed signature verification; refusing.');
        return null;
    }

    const [sessionId, cookieExpiry] = payload.split('.');
    if (!sessionId || !cookieExpiry) {
        console.warn('[session] a signed session cookie had an unreadable payload; refusing.');
        return null;
    }

    // A stale cookie is refused without touching the database.
    if (Date.parse(cookieExpiry) <= Date.now()) {
        console.warn('[session] a session cookie has expired; refusing.');
        return null;
    }

    const db = adminConnection();
    const row = db.prepare(
        'SELECT id, email, expires_at, revoked_at FROM admin_session WHERE id = ?'
    ).get(sessionId);

    if (!row) {
        console.warn('[session] a signed session cookie names a session that does not exist; refusing.');
        return null;
    }
    if (row.revoked_at !== null) {
        console.warn('[session] a session was revoked; refusing its cookie.');
        return null;
    }
    if (Date.parse(row.expires_at) <= Date.now()) {
        console.warn('[session] a session row has expired; refusing.');
        return null;
    }

    return { email: row.email, sessionId: row.id, expiresAt: row.expires_at };
}

/**
 * Revokes a session server-side, which is what stops a copied cookie from working after logout; the route
 * also clears the cookie.
 *
 * @param {string} sessionId
 * @returns {boolean} True when a session was revoked.
 */
export function revokeSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return false;

    const db = adminConnection();
    const result = db.prepare(
        'UPDATE admin_session SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL'
    ).run(nowIso(), sessionId);

    return result.changes > 0;
}

/**
 * The cookie attributes for setting the session. `secure` comes from the connection rather than the
 * hostname: see isSecureRequest.
 *
 * Failing to set Secure over plain HTTP is deliberate, so sign-in works on plain HTTP rather than the
 * cookie being withheld; the deployment must terminate TLS at the proxy.
 *
 * The path includes the base path, because a cookie scoped to /admin under a prefixed deployment is never
 * sent back, and the failure is invisible until every signed-in request looks unauthenticated.
 *
 * @param {boolean} secure Whether the request arrived over a secure connection.
 * @returns {object} Options for res.cookie.
 */
export function sessionCookieOptions(secure) {
    return {
        httpOnly: true,
        sameSite: 'lax',
        secure: Boolean(secure),
        path: sessionCookiePath(),
        maxAge: sessionTtlHours() * 3_600_000
    };
}

/**
 * The cookie's Path attribute: the admin prefix including the base path, exported so the logout route
 * clears the cookie with the identical path.
 *
 * @returns {string}
 */
export function sessionCookiePath() {
    return withBasePath('/admin');
}

/**
 * Whether a request is being served over a secure connection: the decision is about the connection rather
 * than the hostname.
 *
 * `req.secure` is Express's answer, and it reflects X-Forwarded-Proto only when `trust proxy` is
 * configured, which is what makes the trust boundary explicit.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
export function isSecureRequest(req) {
    return Boolean(req.secure);
}

/** Addresses that mean "this machine", in the forms Node reports. */
const LOOPBACK_ADDRESSES = new Set([
    '127.0.0.1',
    '::1',
    // Node reports a v4 loopback connection on a dual-stack listener in its
    // IPv4-mapped form. Omitting this would exempt nothing on this machine's
    // actual listener, which binds ::.
    '::ffff:127.0.0.1'
]);

/**
 * The hostname from a Host header, handling brackets correctly.
 *
 * Imported rather than reimplemented: the host allow-list in server.js and the
 * loopback check here must agree on what a Host header means, and two copies of
 * this rule is how "[::1]" matched in one place and not the other.
 */

/**
 * Whether a request is coming from, and addressed to, this machine's loopback. Both halves are required:
 * a loopback socket can carry any Host header, so keying on the socket alone would let a local process
 * speak for a public hostname, and the Host must name loopback too.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
export function isLoopbackRequest(req) {
    const remote = req.socket?.remoteAddress;
    if (typeof remote !== 'string' || !LOOPBACK_ADDRESSES.has(remote)) return false;

    // Only "[::1]" can match a Host header: a bare "::1" parses to "".
    const host = hostnameFromHeader(req.headers.host);
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}
