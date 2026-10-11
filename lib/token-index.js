/**
 * Which organisation owns a participant token.
 *
 * A participant arrives holding a token and nothing else, so something must
 * resolve that token to a tenant before an organisation file can be opened. This
 * module owns that routing fact, which lives in the installation database because
 * it is installation-level, not tenant data.
 *
 * IT HOLDS NO TENANT DATA: a token hash and an organisation id, nothing that
 * identifies a person beyond the token they already hold. The hash is the same
 * hash the invitation stores, so a token that is not in this index resolves to no
 * organisation and is refused.
 *
 * KEEPING IT IN STEP. Every write here is paired with the invitation write in
 * lib/store/index.js, in one function, so the two cannot drift into disagreeing
 * about which token exists.
 */
import { adminConnection } from './store/registry.js';
import { hashToken } from './store/tokens.js';

function nowIso() {
    return new Date().toISOString();
}

/**
 * Records that a token belongs to an organisation and an invitation.
 *
 * Called whenever a token is issued, so the routing fact is written in the same
 * operation as the credential itself and the two cannot drift.
 *
 * @param {string} tokenHash
 * @param {string} organisationId
 * @param {string} invitationId
 */
export function indexParticipantToken(tokenHash, organisationId, invitationId) {
    if (typeof tokenHash !== 'string' || tokenHash === '') {
        throw new Error('indexParticipantToken requires a token hash.');
    }
    if (typeof organisationId !== 'string' || organisationId === '') {
        throw new Error('indexParticipantToken requires an organisation id.');
    }
    if (typeof invitationId !== 'string' || invitationId === '') {
        throw new Error('indexParticipantToken requires an invitation id.');
    }

    const db = adminConnection();
    db.prepare(
        `INSERT OR REPLACE INTO token_index (token_hash, organisation_id, invitation_id, created_at)
         VALUES (?, ?, ?, ?)`
    ).run(tokenHash, organisationId, invitationId, nowIso());
}

/**
 * The organisation and invitation a participant token belongs to, or null.
 *
 * Returns both, because a resolved token names a tenant AND an identity in one
 * lookup: without the invitation id, the caller would find the organisation and
 * then have to search that file for the hash, which is the same fact held twice.
 *
 * @param {string} token The bearer value from the participant's link.
 * @returns {{ organisationId: string, invitationId: string }|null}
 */
export function routeForParticipantToken(token) {
    if (typeof token !== 'string' || token === '') return null;

    const db = adminConnection();
    const row = db.prepare(
        'SELECT organisation_id, invitation_id FROM token_index WHERE token_hash = ?'
    ).get(hashToken(token));

    return row ? { organisationId: row.organisation_id, invitationId: row.invitation_id } : null;
}

/**
 * Forgets a token, so it resolves to no organisation.
 *
 * A token that is no longer in an invitation must not keep resolving here, or a
 * lookup would name an organisation whose file has no such token and the
 * participant would get a confusing "not found" from a different layer.
 *
 * @param {string} tokenHash
 * @returns {boolean} True when a row was removed.
 */
export function forgetParticipantToken(tokenHash) {
    if (typeof tokenHash !== 'string' || tokenHash === '') return false;

    const db = adminConnection();
    const result = db.prepare('DELETE FROM token_index WHERE token_hash = ?').run(tokenHash);
    return result.changes > 0;
}

/**
 * Forgets every indexed token for an invitation.
 *
 * Used by a reset, which must leave no token resolving for that participant: a
 * stale index entry would name an organisation whose file no longer accepts the
 * token, and the participant would get a confusing refusal from a second layer.
 *
 * @param {string} invitationId
 * @returns {number} Rows removed.
 */
export function forgetTokensForInvitation(invitationId) {
    if (typeof invitationId !== 'string' || invitationId === '') return 0;

    const db = adminConnection();
    const result = db.prepare('DELETE FROM token_index WHERE invitation_id = ?').run(invitationId);
    return result.changes;
}

/**
 * Every token hash indexed for one organisation.
 *
 * Retained for an admin overview that needs to know whether an organisation has
 * outstanding links without opening every file.
 *
 * @param {string} organisationId
 * @returns {string[]}
 */
export function tokenHashesForOrganisation(organisationId) {
    if (typeof organisationId !== 'string' || organisationId === '') {
        throw new Error('tokenHashesForOrganisation requires an organisation id.');
    }

    const db = adminConnection();
    return db.prepare('SELECT token_hash FROM token_index WHERE organisation_id = ?')
        .all(organisationId)
        .map((row) => row.token_hash);
}
