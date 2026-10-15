/**
 * The invitation lifecycle: create, add a link, reset all access, mark opened, list.
 *
 * The id is the identity and the tokens are credentials: `response.invitation_id` references the id, so
 * revoking and reissuing every token leaves every answer attached, which is what makes a reset safe.
 *
 * "Reset all access" and "Lost my link" are the same operation, differing only in who may ask.
 */
import { requireConnection } from './organisations.js';
import { isUnusableToken } from './connection-guard.js';
import { indexParticipantToken, forgetParticipantToken } from '../token-index.js';
import * as tokenSql from './participant-token-sql.js';
import * as sql from './sqlite.js';

/** The two issuers, so a caller names one rather than passing a string. */
export const ISSUED_BY = tokenSql.ISSUED_BY;

/**
 * Invites one participant and mints their first link token. The token is returned once and stored as a
 * hash, so this is the only moment the bearer value exists outside the recipient's message.
 *
 * @param {object} details email and department, both required.
 */
export function addInvitation(orgId, { email, department } = {}) {
    if (typeof email !== 'string' || email.trim() === '') {
        throw new Error('addInvitation requires a non-empty email.');
    }
    if (typeof department !== 'string' || department.trim() === '') {
        throw new Error('addInvitation requires a non-empty department.');
    }

    const db = requireConnection(orgId);
    if (!sql.selectOrganisation(db)) {
        throw new Error(`Cannot add an invitation to organisation ${orgId}: it does not exist.`);
    }

    const invitation = sql.insertInvitation(db, {
        id: sql.newId(),
        email: email.trim(),
        department: department.trim()
    });

    const token = tokenSql.insertParticipantToken(db, invitation.id, ISSUED_BY.ADMIN);
    indexToken(token, orgId, invitation.id);

    // The token is deliberately absent from this log line; a log is where a credential leaks.
    console.info(`[store] invited invitation ${invitation.id} to organisation ${orgId}`);
    return { ...invitation, token };
}

/**
 * Adds a link for an existing invitation, leaving the others live.
 *
 * @returns {string} The fresh token, to be mailed once and never stored raw.
 */
export function issueAdditionalLink(orgId, invitationId) {
    const db = requireConnection(orgId);
    if (!sql.selectInvitationById(db, invitationId)) {
        throw new Error(`No invitation ${JSON.stringify(invitationId)} in organisation ${orgId}.`);
    }

    const token = tokenSql.insertParticipantToken(db, invitationId, ISSUED_BY.ADMIN);
    indexToken(token, orgId, invitationId);

    console.info(`[store] issued an additional link for invitation ${invitationId}`);
    return token;
}

/**
 * Revokes every live token for an invitation and issues one replacement, for both reset actions. They
 * differ only in who is allowed to ask, which is the caller's authorisation check.
 *
 * The invitation id is untouched, so the participant returns to their existing answers on the new link.
 *
 * @returns {string} The replacement token.
 */
export function resetAccess(orgId, invitationId, issuedBy = ISSUED_BY.ADMIN) {
    const db = requireConnection(orgId);
    if (!sql.selectInvitationById(db, invitationId)) {
        throw new Error(`No invitation ${JSON.stringify(invitationId)} in organisation ${orgId}.`);
    }

    // Forgotten from the routing index first, so none still resolves to this organisation.
    for (const hash of tokenHashesForInvitation(db, invitationId)) {
        forgetParticipantToken(hash);
    }

    const token = tokenSql.revokeAllAndIssue(db, invitationId, issuedBy);
    indexToken(token, orgId, invitationId);

    console.info(`[store] reset access for invitation ${invitationId} in organisation ${orgId} (${issuedBy})`);
    return token;
}

/**
 * Resolves a token to its invitation, and records the visit. A read path, so an unusable, revoked,
 * expired or unknown token returns null rather than throwing.
 *
 * @returns {object|null} The invitation, or null when the token yields nothing.
 */
export function invitationForToken(orgId, token) {
    if (isUnusableToken(token)) {
        console.warn(`[store] organisation ${orgId} was asked for an invitation with no usable token.`);
        return null;
    }

    const db = requireConnection(orgId);
    const row = tokenSql.selectLiveTokenByValue(db, token);
    if (!row) return null;

    // Matched by hash already; re-checked in constant time so the credential check is in one place.
    if (!tokenSql.tokenHashesMatch(row.token_hash, tokenSql.hashFor(token))) {
        console.warn(`[store] a token matched by hash but failed the constant-time re-check.`);
        return null;
    }

    return sql.touchInvitationOpened(db, row.invitation_id);
}

/**
 * The tokens issued for an invitation, for the console: never includes a hash, so a list of live
 * credentials is not readable from a page. `live` is computed here so the view need not know the rule.
 */
export function listTokensForInvitation(orgId, invitationId) {
    const db = requireConnection(orgId);
    const at = new Date().toISOString();

    return tokenSql.listParticipantTokens(db, invitationId).map((row) => ({
        ...row,
        live: row.revoked_at === null && row.expires_at > at
    }));
}

/** The admin's view of progress: never a token or an answer. */
export function listInvitations(orgId) {
    const db = requireConnection(orgId);
    return sql.listInvitations(db);
}

/** Records a token in the routing index, with its organisation and invitation. */
function indexToken(token, orgId, invitationId) {
    indexParticipantToken(tokenSql.hashFor(token), orgId, invitationId);
}

/** The stored hashes for an invitation's live tokens, used only to clear the routing index. */
function tokenHashesForInvitation(db, invitationId) {
    return db.prepare(
        `SELECT token_hash FROM participant_tokens
         WHERE invitation_id = ? AND revoked_at IS NULL`
    ).all(invitationId).map((row) => row.token_hash);
}
