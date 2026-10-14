/**
 * Tokens for participant links.
 *
 * One primitive, used for the invitation link: 32 bytes from a CSPRNG,
 * base64url encoded so the value survives a URL, an email client and a QR code
 * without escaping. Nothing here is derived from an email address, a counter or
 * a timestamp, because a guessable participant token is a way into someone
 * else's answers.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 32 bytes of entropy becomes 43 characters of base64url. */
const TOKEN_BYTES = 32;

/** Length of the stored SHA-256 hash, in hex characters. */
const TOKEN_HASH_HEX_LENGTH = 64;

/** Hex characters, lowercase. The only form `hashToken` writes and the only
 * form a lookup can find. */
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
 * Hashes a token for storage, so a database read does not hand over usable
 * credentials.
 *
 * SHA-256 rather than a password hash: these are 256-bit random values, not
 * user-chosen secrets, so there is no dictionary to attack and no need for a
 * deliberately slow KDF. The point is only to avoid storing the bearer value
 * verbatim.
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
 * Compares two token hashes without leaking their difference through timing.
 *
 * THE COMPARISON IS EXACT, AND LOWERCASE HEX IS THE ONLY ACCEPTED FORM. Both sides come from
 * `hashToken` on the legitimate path and `digest('hex')` is always lowercase, so a valid hash
 * passes. A value in any other form - uppercase, truncated, not hex - is a MISMATCH rather than a
 * crash or a match, for two reasons: it makes this function's rule true by itself rather than
 * relying on the caller, whose `WHERE token = ?` lookup happens to fail closed too; and a
 * hand-edited row then behaves like a missing invitation, which is failing closed rather than open.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function tokenHashesMatch(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== TOKEN_HASH_HEX_LENGTH || b.length !== TOKEN_HASH_HEX_LENGTH) return false;
    // Case-sensitive on purpose: HEX_PATTERN is lowercase, and normalising here
    // would accept a form hashToken never produces. See the note above.
    if (!HEX_PATTERN.test(a) || !HEX_PATTERN.test(b)) return false;

    const bufA = Buffer.from(a, 'hex');
    const bufB = Buffer.from(b, 'hex');
    // Lengths are both 32 bytes by the guard above. timingSafeEqual still throws
    // on a length mismatch, so the guard is what keeps this from throwing; it
    // also avoids leaking a length difference through an exception.
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
}

