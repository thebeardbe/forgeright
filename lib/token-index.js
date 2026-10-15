/**
 * Which organisation owns a participant token: installation-level routing rather than tenant data, because a
 * participant arrives holding a token and nothing else.
 *
 * It holds no tenant data, only a token hash and an organisation id, and a token absent from this index
 * resolves to no organisation.
 *
 * Every write here is paired with the invitation write in lib/store/index.js, in one function, so the two
 * cannot drift.
 */
import { adminConnection } from './store/registry.js';
import { hashToken } from './store/tokens.js';

function nowIso() {
    return new Date().toISOString();
}

/**
 * Records that a token belongs to an organisation and an invitation. Called whenever a token is issued, in
 * the same operation as the credential itself.
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
 * The organisation and invitation a participant token belongs to, or null. Both from one lookup, because the
 * token names a tenant and an identity together.
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
 * Forgets a token, so it resolves to no organisation: one still indexed would name an organisation whose
 * file has no such token, and the participant would get a refusal from a different layer.
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
 * Forgets every indexed token for an invitation, used by a reset so no token keeps resolving for that
 * participant.
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
 * Every token hash indexed for one organisation, for an admin overview that must not open every file.
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
