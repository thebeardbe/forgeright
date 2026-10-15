/**
 * The invitation lifecycle: create, add a link, reset all access, mark opened, list.
 *
 * The id is the identity and the tokens are credentials: `invitation.id` never changes and
 * `response.invitation_id` references it, so revoking and reissuing every token leaves every answer
 * attached. That split is what makes a reset safe to offer.
 *
 * "Reset all access" (admin) and "Lost my link" (participant) are the same operation, differing only
 * in who may ask, so both call resetAccess once.
 */
import { requireConnection } from './organisations.js';
import { isUnusableToken } from './connection-guard.js';
import { indexParticipantToken, forgetParticipantToken } from '../token-index.js';
import * as tokenSql from './participant-token-sql.js';
import * as sql from './sqlite.js';

/** The two issuers, so a caller names one rather than passing a string. */
export const ISSUED_BY = tokenSql.ISSUED_BY;

/**
 * Invites one participant and mints their first link token. The token is returned once, to the caller
 * that will put it in the mail, and stored as a hash, so this is the only moment the bearer value
 * exists outside the recipient's message.
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

    // The token is deliberately absent from this line: a log is a place a credential leaks from, and
    // the invitation id is enough to trace one.
    console.info(`[store] invited invitation ${invitation.id} to organisation ${orgId}`);
    return { ...invitation, token };
}

/**
 * Adds a link for an existing invitation, leaving the others live: nothing is invalidated, so a second
 * mail cannot break the first.
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
 * Revokes every live token for an invitation and issues one replacement, for both the console's
 * "Reset all access" and the participant's "Lost my link". They differ only in who is allowed to ask,
 * which is the caller's authorisation check; both revoke the lot, so a token that leaked stops working
 * the moment either runs.
 *
 * The invitation id is untouched, which is the point: responses reference it, so the participant
 * returns to their existing answers on the new link.
 *
 * @returns {string} The replacement token.
 */
export function resetAccess(orgId, invitationId, issuedBy = ISSUED_BY.ADMIN) {
    const db = requireConnection(orgId);
    if (!sql.selectInvitationById(db, invitationId)) {
        throw new Error(`No invitation ${JSON.stringify(invitationId)} in organisation ${orgId}.`);
    }

    // Every live token for this invitation is forgotten from the routing index first, so none of them
    // can still resolve to this organisation after the reset.
    for (const hash of tokenHashesForInvitation(db, invitationId)) {
        forgetParticipantToken(hash);
    }

    const token = tokenSql.revokeAllAndIssue(db, invitationId, issuedBy);
    indexToken(token, orgId, invitationId);

    console.info(`[store] reset access for invitation ${invitationId} in organisation ${orgId} (${issuedBy})`);
    return token;
}

/**
 * Resolves a token to its invitation, and records the visit. A read path: a token that is unusable,
 * revoked, expired or simply unknown returns null rather than throwing, because all of those are
 * routine events for a link in the wild.
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

    // The SELECT matched by hash, so equality is implied; the comparison is still made, in constant
    // time, because the credential check belongs in one place.
    if (!tokenSql.tokenHashesMatch(row.token_hash, tokenSql.hashFor(token))) {
        console.warn(`[store] a token matched by hash but failed the constant-time re-check.`);
        return null;
    }

    return sql.touchInvitationOpened(db, row.invitation_id);
}

/**
 * The tokens issued for an invitation, for the console to display. Never includes a hash: a list of
 * live credentials must not be readable from a page. `live` is computed here so the view does not have
 * to know the rule.
 */
export function listTokensForInvitation(orgId, invitationId) {
    const db = requireConnection(orgId);
    const at = new Date().toISOString();

    return tokenSql.listParticipantTokens(db, invitationId).map((row) => ({
        ...row,
        live: row.revoked_at === null && row.expires_at > at
    }));
}

/**
 * The admin's view of progress: never a token or an answer, only whether someone is reachable and has
 * been seen.
 */
export function listInvitations(orgId) {
    const db = requireConnection(orgId);
    return sql.listInvitations(db);
}

/** Records a token in the routing index, with its organisation and invitation. */
function indexToken(token, orgId, invitationId) {
    indexParticipantToken(tokenSql.hashFor(token), orgId, invitationId);
}

/**
 * The stored hashes for an invitation's live tokens, read from the organisation file and used only to
 * clear the routing index, so the values never leave this module.
 */
function tokenHashesForInvitation(db, invitationId) {
    return db.prepare(
        `SELECT token_hash FROM participant_tokens
         WHERE invitation_id = ? AND revoked_at IS NULL`
    ).all(invitationId).map((row) => row.token_hash);
}
