/**
 * Sign-in links for the admin console: 32 CSPRNG bytes in base64url, and only the SHA-256 hash is stored,
 * so a database read does not hand over a usable link.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { adminConnection } from '../store/registry.js';

/** 32 bytes of entropy becomes 43 characters of base64url. */
const TOKEN_BYTES = 32;

/** Length of a SHA-256 hex digest, the stored form of a token. */
const TOKEN_HASH_HEX_LENGTH = 64;

/** Lowercase hex only: the sole form hashToken writes and a lookup can find. */
const HEX_PATTERN = /^[0-9a-f]+$/;

/** Minutes a sign-in link stays valid, unless LOGIN_LINK_TTL_MINUTES says otherwise. */
const DEFAULT_TTL_MINUTES = 15;

/** ISO 8601 UTC, matching the store's timestamp convention so text sorts chronologically. */
function nowIso() {
    return new Date().toISOString();
}

/**
 * How long a sign-in link stays valid, in minutes: fifteen covers reading the mail and opening the link on
 * a phone. Empty or whitespace counts as unset, because an empty variable is how one is disabled and a TTL
 * of zero would issue dead links.
 *
 * @returns {number}
 */
export function loginLinkTtlMinutes() {
    const raw = process.env.LOGIN_LINK_TTL_MINUTES;

    if (raw === undefined || raw.trim() === '') {
        return DEFAULT_TTL_MINUTES;
    }

    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        console.warn(
            `[auth] LOGIN_LINK_TTL_MINUTES=${JSON.stringify(raw)} is not a positive number; ` +
            `using ${DEFAULT_TTL_MINUTES} minutes.`
        );
        return DEFAULT_TTL_MINUTES;
    }
    return parsed;
}

/**
 * A fresh unguessable sign-in token.
 *
 * @returns {string} base64url, URL-safe and case-sensitive.
 */
export function generateLoginToken() {
    return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Hashes a sign-in token for storage. SHA-256 rather than a password hash, because these are random values
 * with no dictionary to attack, and the point is only that the database does not hold a usable link.
 *
 * @param {string} token
 * @returns {string} 64 lowercase hex characters.
 */
export function hashLoginToken(token) {
    if (typeof token !== 'string' || token.length === 0) {
        throw new Error('hashLoginToken requires a non-empty string token.');
    }
    return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Compares two token hashes without leaking their difference through timing. Exact, lowercase hex only: a
 * value in any other form is a mismatch rather than a crash.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function tokenHashesMatch(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== TOKEN_HASH_HEX_LENGTH || b.length !== TOKEN_HASH_HEX_LENGTH) return false;
    if (!HEX_PATTERN.test(a) || !HEX_PATTERN.test(b)) return false;

    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * Issues a sign-in link token for an address. The raw token is returned once, for the mail, and is not
 * recoverable afterwards: only its hash is in the database.
 *
 * @param {string} email
 * @returns {{ token: string, expiresAt: string }}
 */
export function issueLoginToken(email) {
    if (typeof email !== 'string' || email.trim() === '') {
        throw new Error('issueLoginToken requires a non-empty email address.');
    }

    const token = generateLoginToken();
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + loginLinkTtlMinutes() * 60_000).toISOString();

    const db = adminConnection();
    db.prepare(
        `INSERT INTO login_token (id, email, token_hash, created_at, expires_at, used_at)
         VALUES (?, ?, ?, ?, ?, NULL)`
    ).run(randomUUID(), email.trim(), hashLoginToken(token), createdAt, expiresAt);

    // The token and its hash are deliberately absent: a log is where a credential leaks.
    console.info(`[auth] issued a sign-in link, valid until ${expiresAt}`);

    return { token, expiresAt };
}

/**
 * Redeems a sign-in token exactly once, before it expires.
 *
 * @param {string} token The bearer value from the link.
 * @returns {{ ok: true, email: string }|{ ok: false, reason: 'unknown'|'expired'|'used' }}
 *   A refusal is data rather than an exception, because a link in the wild that matches nothing is routine,
 *   and the route shows the same page for every reason so it cannot probe which tokens existed.
 */
export function redeemLoginToken(token) {
    if (typeof token !== 'string' || token.length === 0) {
        // A missing ?token= is routine, so this is refused as unknown rather than thrown.
        return { ok: false, reason: 'unknown' };
    }

    const db = adminConnection();
    const hash = hashLoginToken(token);

    const row = db.prepare(
        `SELECT id, email, token_hash, expires_at, used_at
         FROM login_token WHERE token_hash = ?`
    ).get(hash);

    if (!row) {
        console.warn('[auth] a sign-in link token matched no issued token.');
        return { ok: false, reason: 'unknown' };
    }

    // Matched by hash already; re-checked in constant time so the credential check is in one place.
    if (!tokenHashesMatch(row.token_hash, hash)) {
        console.warn('[auth] a sign-in link token matched by hash but failed the constant-time re-check.');
        return { ok: false, reason: 'unknown' };
    }

    if (row.used_at !== null) {
        console.warn('[auth] a sign-in link was already used; refusing the second redemption.');
        return { ok: false, reason: 'used' };
    }

    // Against the stored instant, not a fresh calculation.
    if (Date.parse(row.expires_at) <= Date.now()) {
        console.warn(`[auth] a sign-in link expired at ${row.expires_at}; refusing.`);
        return { ok: false, reason: 'expired' };
    }

    // Single use is enforced by the WHERE clause rather than by reading first, so of two concurrent
    // redemptions exactly one updates a row and the loser sees changes === 0.
    const result = db.prepare(
        'UPDATE login_token SET used_at = ? WHERE id = ? AND used_at IS NULL'
    ).run(nowIso(), row.id);

    if (result.changes === 0) {
        console.warn('[auth] a sign-in link was redeemed twice concurrently; the second attempt lost.');
        return { ok: false, reason: 'used' };
    }

    console.info(`[auth] redeemed a sign-in link for ${row.email}`);
    return { ok: true, email: row.email };
}

/**
 * Removes sign-in tokens that can no longer be used. Housekeeping rather than a control, so the installation
 * database does not grow without bound.
 *
 * @returns {number} Rows removed.
 */
export function pruneLoginTokens() {
    const db = adminConnection();
    const result = db.prepare(
        'DELETE FROM login_token WHERE expires_at <= ?'
    ).run(nowIso());
    return Number(result.changes);
}
