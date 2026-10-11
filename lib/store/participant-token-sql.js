/**
 * Participant token statements for ONE organisation.
 *
 * A PARTICIPANT MAY HAVE SEVERAL LIVE TOKENS. The invitation is the identity;
 * each row here is one issued credential for it. That is what lets "Send a link"
 * add another without retiring the last, while "Reset all access" and
 * "Lost my link" revoke the lot and issue one.
 *
 * TOKENS ARE STORED AS A SHA-256 HASH, never verbatim, so a database read yields
 * nothing usable. Lookup is by hash, so revocation is a timestamp rather than a
 * delete: the row stays and simply stops matching.
 *
 * This module NEVER opens a connection: it is handed one by the registry, so it
 * cannot tell which organisation it is working on and has no way to widen its
 * scope. All parameters are bound.
 */
import { randomUUID } from 'node:crypto';
import { generateToken, hashToken, tokenHashesMatch } from './tokens.js';
import { nowIso, assertConnection } from './connection-guard.js';

/** Token lifetime in days. Generous on purpose; see the note in the org schema. */
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
 * This is the "Send a link" action: a participant who has lost the first mail
 * gets another working link without the one they already hold being retired.
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
 * Revokes every live token for an invitation, and issues one new one.
 *
 * THE ONE IMPLEMENTATION of both reset actions. The console's "Reset all access"
 * and the participant's "Lost my link" do exactly this and differ only in who is
 * allowed to ask, which is the caller's check rather than this function's.
 *
 * The invitation id is untouched, which is the whole point: responses reference
 * it, so the participant returns to their existing answers on the new link.
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
 * The live token for a presented value, or null.
 *
 * Live means: not revoked, and not expired. A token that is either resolves to
 * nothing, which the caller treats the same as an unknown one. The row INCLUDES
 * the stored hash so the caller can re-check the credential in constant time.
 */
export function selectLiveTokenByValue(db, token) {
    if (typeof token !== 'string' || token === '') return null;

    return assertConnection(db)
        .prepare(`SELECT id, invitation_id, token_hash, issued_at, expires_at, revoked_at, issued_by
                  FROM participant_tokens
                  WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`)
        .get(hashToken(token), nowIso()) ?? null;
}

/**
 * The hash a token value would have.
 *
 * Exported so the caller can verify a resolved token in constant time against a
 * row selected by hash, without hashing twice in two places.
 */
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

/**
 * The most recent live token's issue time, or null.
 *
 * The console shows when a link was last issued, which is the newest live one.
 */
export function selectTokenIssuedAt(db, invitationId) {
    const row = assertConnection(db)
        .prepare(`SELECT issued_at FROM participant_tokens
                  WHERE invitation_id = ? AND revoked_at IS NULL AND expires_at > ?
                  ORDER BY issued_at DESC LIMIT 1`)
        .get(invitationId, nowIso());
    return row ? row.issued_at : null;
}

/**
 * How many tokens are live for an invitation.
 *
 * The console shows this, so an admin can see whether several links are
 * outstanding and decide whether to reset.
 */
export function countLiveTokens(db, invitationId) {
    const row = assertConnection(db)
        .prepare(`SELECT COUNT(*) AS n FROM participant_tokens
                  WHERE invitation_id = ? AND revoked_at IS NULL AND expires_at > ?`)
        .get(invitationId, nowIso());
    return row.n;
}

/**
 * Constant-time comparison of two token hashes, re-exported.
 *
 * The implementation is shared with the admin sign-in path in tokens.js, so there
 * is one comparison rather than two that can drift. Re-exported here so a caller
 * working with participant tokens imports from one module.
 */
export { tokenHashesMatch };
