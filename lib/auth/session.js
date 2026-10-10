/**
 * Admin sessions, as a signed cookie.
 *
 * A session is a server-side row (id, email, expiry) plus a cookie carrying that
 * id. The cookie is signed with an HMAC so a forged id is rejected before it is
 * ever looked up, and the row is what makes logout real: the cookie alone cannot
 * be the only state, or a holder could keep using it until it expired.
 *
 * SESSION_SECRET MUST come from the environment. If it is unset the server
 * refuses to start; see assertSessionSecretConfigured. A secret generated per
 * process would invalidate every session on restart, and the symptom is "login
 * is broken", which is the worst kind of misconfiguration: invisible in the code
 * and diagnosed by guesswork.
 *
 * No dependency. Node's crypto has HMAC-SHA256, and the cookie is a two-field
 * value with a tag, which does not need a parser library.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { adminConnection } from '../store/registry.js';

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
 * Hours an admin session lasts.
 *
 * Twelve hours covers a working day, so an admin is not signed out mid-task, and
 * ends before the next morning so an unattended browser does not stay signed in
 * overnight. Empty or whitespace counts as unset, matching the other readers.
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
 * The signing secret, or a thrown error naming the problem.
 *
 * Called at startup, so a missing secret stops the server rather than every
 * login. A short secret is accepted with a warning rather than refused: it is
 * weak, but refusing to start is the operator's call to make, and the warning
 * says exactly what to run.
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
 * Signs a value with HMAC-SHA256 and the session secret.
 *
 * The context string is included in the message so a tag from this scheme can
 * never be valid for another one, even if the secret were reused.
 *
 * @param {string} value
 * @returns {string} 64 lowercase hex characters.
 */
function sign(value) {
    return createHmac('sha256', secret()).update(`${HMAC_CONTEXT}:${value}`).digest('hex');
}

/**
 * True when a tag matches the value, compared in constant time.
 *
 * timingSafeEqual is safe here because both sides are HMAC-SHA256 hex digests of
 * a fixed length: the comparison never sees a variable-length input, so it
 * cannot throw on a length mismatch and cannot leak length through timing. The
 * length and hex checks below are what guarantee that, and a malformed tag is a
 * mismatch rather than a crash.
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

    // The cookie value is the id and the expiry, signed. Carrying the expiry in
    // the cookie lets a clearly stale cookie be rejected without a lookup, while
    // the row remains the authority.
    const payload = `${sessionId}.${expiresAt}`;
    console.info(`[session] created an admin session, valid until ${expiresAt}`);

    return { cookieValue: `${payload}.${sign(payload)}`, expiresAt, sessionId };
}

/**
 * Verifies a cookie value and returns the session it names, or null.
 *
 * Returns null for every kind of failure, because the caller shows one outcome
 * for all of them: redirect to the login page. The reasons are logged, so an
 * operator can tell "forged" from "expired" from "revoked" without the browser
 * being told anything.
 *
 * @param {string} cookieValue
 * @returns {{ email: string, sessionId: string, expiresAt: string }|null}
 */
export function readSession(cookieValue) {
    if (typeof cookieValue !== 'string' || cookieValue === '') return null;

    // Split from the right: the payload is exactly two dot-separated fields plus
    // the tag, and neither an ISO timestamp nor a UUID contains a dot.
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

    // The signed expiry is checked first: a stale cookie is refused without
    // touching the database.
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
 * Revokes a session server-side, so logout is real.
 *
 * The cookie is also cleared by the route; revoking here is what stops a copied
 * cookie from working after logout.
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
 * The cookie attributes for setting the session.
 *
 * `secure` is decided by the caller from the request, not read from NODE_ENV:
 * the flag must be set for every request that is not on localhost, because a
 * cookie without it is sent over plain HTTP.
 *
 * @param {boolean} isLocalhost
 * @returns {object} Options for res.cookie.
 */
export function sessionCookieOptions(isLocalhost) {
    return {
        httpOnly: true,
        sameSite: 'lax',
        secure: !isLocalhost,
        path: '/admin',
        maxAge: sessionTtlHours() * 3_600_000
    };
}

/** True when a request is being served on localhost, where Secure would break the cookie. */
export function isLocalhostRequest(req) {
    const host = (req.headers.host || '').split(':')[0].trim().toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}
