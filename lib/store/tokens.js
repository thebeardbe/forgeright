/**
 * Tokens for participant links: 32 bytes from a CSPRNG, base64url encoded. Nothing is derived from an
 * email address, a counter or a timestamp, because a guessable token is a way into someone else's
 * answers.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 32 bytes of entropy becomes 43 characters of base64url. */
const TOKEN_BYTES = 32;

/** Length of the stored SHA-256 hash, in hex characters. */
const TOKEN_HASH_HEX_LENGTH = 64;

/** Lowercase hex: the only form `hashToken` writes and the only form a lookup finds. */
const HEX_PATTERN = /^[0-9a-f]+$/;

/**
 * A fresh unguessable token.
 *
 * @returns {string} base64url, URL-safe and case-sensitive.
 */
export function generateToken() {
    return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Hashes a token for storage, so a database read does not hand over usable credentials. SHA-256 rather
 * than a password hash, because these are random values with no dictionary to attack.
 *
 * @param {string} token
 * @returns {string} 64 lowercase hex characters.
 */
export function hashToken(token) {
    if (typeof token !== 'string' || token.length === 0) {
        throw new Error('hashToken requires a non-empty string token.');
    }
    return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Compares two token hashes without leaking their difference through timing. The comparison is exact and
 * lowercase hex is the only accepted form, so a hand-edited row behaves like a missing invitation.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function tokenHashesMatch(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== TOKEN_HASH_HEX_LENGTH || b.length !== TOKEN_HASH_HEX_LENGTH) return false;
    if (!HEX_PATTERN.test(a) || !HEX_PATTERN.test(b)) return false;

    const bufA = Buffer.from(a, 'hex');
    const bufB = Buffer.from(b, 'hex');
    // The length guard above is what keeps timingSafeEqual from throwing.
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
}
