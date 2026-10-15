/**
 * Participant token statements for one organisation. A participant may have several live tokens, because
 * the invitation is the identity and each row here is one issued credential for it.
 *
 * Tokens are stored as a SHA-256 hash, never verbatim, and lookup is by hash, so revocation is a
 * timestamp rather than a delete. Never opens a connection, because one is handed to it by the registry.
 */
import { randomUUID } from 'node:crypto';
import { generateToken, hashToken, tokenHashesMatch } from './tokens.js';
import { nowIso, assertConnection } from './connection-guard.js';

/** Token lifetime in days. */
const TOKEN_TTL_DAYS = 90;

/** Named issuers, so the column is not a free-text field. */
export const ISSUED_BY = Object.freeze({ ADMIN: 'admin', PARTICIPANT: 'participant' });

/** Expiry instant for a token issued now. */
function expiryFrom(now) {
    return new Date(Date.parse(now) + TOKEN_TTL_DAYS * 86_400_000).toISOString();
}

function assertIssuer(issuedBy) {
    if (issuedBy !== ISSUED_BY.ADMIN && issuedBy !== ISSUED_BY.PARTICIPANT) {
        throw new Error(
            `Unknown token issuer ${JSON.stringify(issuedBy)}. Expected ${ISSUED_BY.ADMIN} or ${ISSUED_BY.PARTICIPANT}.`
        );
    }
    return issuedBy;
}

/**
 * Issues a token for an invitation, leaving existing ones live.
 *
 * @returns {string} The fresh token, to be mailed once and never stored raw.
 */
export function insertParticipantToken(db, invitationId, issuedBy) {
    assertIssuer(issuedBy);

    const token = generateToken();
    const at = nowIso();

    assertConnection(db)
        .prepare(`INSERT INTO participant_tokens
                  (id, invitation_id, token_hash, issued_at, expires_at, revoked_at, issued_by)
                  VALUES (?, ?, ?, ?, ?, NULL, ?)`)
        .run(randomUUID(), invitationId, hashToken(token), at, expiryFrom(at), issuedBy);

    return token;
}

/**
 * Revokes every live token for an invitation and issues one new one, the one implementation of both reset
 * actions.
 *
 * The invitation id is untouched, so the participant returns to their existing answers on the new link.
 *
 * @returns {string} The replacement token.
 */
export function revokeAllAndIssue(db, invitationId, issuedBy) {
    assertIssuer(issuedBy);

    const at = nowIso();
    assertConnection(db)
        .prepare(`UPDATE participant_tokens SET revoked_at = ?
                  WHERE invitation_id = ? AND revoked_at IS NULL`)
        .run(at, invitationId);

    return insertParticipantToken(db, invitationId, issuedBy);
}

/**
 * The live token for a presented value, or null. The row includes the stored hash so the caller can
 * re-check the credential in constant time.
 */
export function selectLiveTokenByValue(db, token) {
    if (typeof token !== 'string' || token === '') return null;

    return assertConnection(db)
        .prepare(`SELECT id, invitation_id, token_hash, issued_at, expires_at, revoked_at, issued_by
                  FROM participant_tokens
                  WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`)
        .get(hashToken(token), nowIso()) ?? null;
}

/** The hash a token value would have, so a caller verifies a resolved token without hashing twice. */
export function hashFor(token) {
    return hashToken(token);
}

/** Every token for an invitation, newest first, without the hash. */
export function listParticipantTokens(db, invitationId) {
    return assertConnection(db)
        .prepare(`SELECT id, issued_at, expires_at, revoked_at, issued_by
                  FROM participant_tokens WHERE invitation_id = ? ORDER BY issued_at DESC`)
        .all(invitationId);
}

/** The most recent live token's issue time, or null. */
export function selectTokenIssuedAt(db, invitationId) {
    const row = assertConnection(db)
        .prepare(`SELECT issued_at FROM participant_tokens
                  WHERE invitation_id = ? AND revoked_at IS NULL AND expires_at > ?
                  ORDER BY issued_at DESC LIMIT 1`)
        .get(invitationId, nowIso());
    return row ? row.issued_at : null;
}

/** How many tokens are live for an invitation. */
export function countLiveTokens(db, invitationId) {
    const row = assertConnection(db)
        .prepare(`SELECT COUNT(*) AS n FROM participant_tokens
                  WHERE invitation_id = ? AND revoked_at IS NULL AND expires_at > ?`)
        .get(invitationId, nowIso());
    return row.n;
}

/** Constant-time comparison of two token hashes, shared with the admin sign-in path in tokens.js. */
export { tokenHashesMatch };
