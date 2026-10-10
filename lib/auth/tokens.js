/**
 * Sign-in links for the admin console.
 *
 * A token is 32 CSPRNG bytes in base64url, exactly as lib/store/tokens.js does
 * for participant invitations, and for the same reason: it must survive a URL, a
 * mail client and a QR code without escaping, and nothing about it may be
 * guessable. Only the SHA-256 hash is stored, so a database read does not hand
 * over a usable sign-in link.
 *
 * WHERE THESE LIVE. In the installation database, <STORE_DIR>/admin.db, not in
 * an organisation's file. Admin login is not tenant data: it belongs to the
 * whole installation, there is one admin console, and the console is what
 * CHOOSES an organisation to look at. Putting these in an org file would mean
 * either picking a tenant to hold installation state (wrong) or duplicating the
 * table across every tenant (also wrong).
 *
 * The store is reached through registry.adminConnection(), which is the only
 * place a connection is opened. Nothing here touches lib/store/index.js, whose
 * API is organisation-scoped and cannot see admin.db at all.
 *
 * RULES, and where each is enforced:
 *   single use   the redeem UPDATE sets used_at only WHERE used_at IS NULL, so
 *                two concurrent redemptions cannot both win
 *   expiry       compared here against LOGIN_LINK_TTL_MINUTES, using the stored
 *                expires_at rather than a fresh calculation, so a restart does
 *                not extend a link's life
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
 * How long a sign-in link stays valid, in minutes.
 *
 * Fifteen minutes covers reading the mail and opening the link on a phone. It is
 * short on purpose: a link in a mail archive is a credential, and the shorter
 * its life the smaller the window in which a leaked mailbox is a way in.
 *
 * Empty or whitespace counts as unset, not as zero, for the reason the store's
 * busy-timeout reader documents: an empty variable is how one is disabled in a
 * .env file, and a TTL of zero minutes would issue links that are dead on
 * arrival, which looks exactly like a broken mailer.
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
 * Hashes a sign-in token for storage.
 *
 * SHA-256 rather than a password hash: these are 256-bit random values, not
 * user-chosen secrets, so there is no dictionary to attack and no need for a
 * slow KDF. The point is only that the database does not hold a usable link.
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
 * Compares two token hashes without leaking their difference through timing.
 *
 * Exact, lowercase hex only, as the participant-token comparison is. A value in
 * any other form is a mismatch rather than a crash.
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
 * Issues a sign-in link token for an address.
 *
 * The raw token is returned once, for the mail. It is not stored, not logged,
 * and not recoverable afterwards: only its hash is in the database.
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

    // The token and its hash are deliberately absent from this line. A log is a
    // place a credential leaks from, and the expiry is enough to trace an issue.
    console.info(`[auth] issued a sign-in link, valid until ${expiresAt}`);

    return { token, expiresAt };
}

/**
 * Redeems a sign-in token exactly once, before it expires.
 *
 * @param {string} token The bearer value from the link.
 * @returns {{ ok: true, email: string }|{ ok: false, reason: 'unknown'|'expired'|'used' }}
 *   A refusal is data, not an exception: a link in the wild that matches nothing
 *   is a routine event, and the route shows the same page for every reason so it
 *   cannot be used to probe which tokens existed.
 *   Throws only for a programming error (a non-string token).
 */
export function redeemLoginToken(token) {
    if (typeof token !== 'string' || token.length === 0) {
        // A missing ?token= is routine, so this is refused as unknown rather than
        // thrown; see the read/write rule the store documents.
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

    // The SELECT already matched by hash, so equality is implied. The comparison
    // is still made, in constant time, because the credential check belongs in
    // one place and a stored row supplied by a future caller gets it too.
    if (!tokenHashesMatch(row.token_hash, hash)) {
        console.warn('[auth] a sign-in link token matched by hash but failed the constant-time re-check.');
        return { ok: false, reason: 'unknown' };
    }

    if (row.used_at !== null) {
        console.warn('[auth] a sign-in link was already used; refusing the second redemption.');
        return { ok: false, reason: 'used' };
    }

    // Expiry is compared against the stored instant, not a fresh calculation.
    if (Date.parse(row.expires_at) <= Date.now()) {
        console.warn(`[auth] a sign-in link expired at ${row.expires_at}; refusing.`);
        return { ok: false, reason: 'expired' };
    }

    // Single use, enforced by the WHERE clause rather than by reading first: two
    // concurrent redemptions both pass the checks above, and exactly one of them
    // updates a row here. The loser sees changes === 0 and is refused.
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
 * Removes sign-in tokens that can no longer be used.
 *
 * Housekeeping rather than a security control: the expiry check refuses them
 * regardless. Kept so the installation database does not grow without bound.
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
