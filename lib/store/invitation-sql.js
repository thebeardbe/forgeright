/**
 * Invitation statements for one organisation. An invitation is the identity, and its credentials live in
 * participant_tokens, which is a separate module because there may be several. Never opens a connection,
 * because one is handed to it by the registry.
 *
 * No projection here selects a token hash: a list of live credentials must not be readable from the
 * console or a log.
 */
import { nowIso, assertConnection } from './connection-guard.js';

/**
 * The invitation for an id, or null.
 *
 * @returns {object|null}
 */
export function selectInvitationById(db, invitationId) {
    return assertConnection(db)
        .prepare(`SELECT id, email, department, created_at, opened_at, last_seen_at, completed_at
                  FROM invitation WHERE id = ?`)
        .get(invitationId) ?? null;
}

export function insertInvitation(db, { id, email, department }) {
    const createdAt = nowIso();
    assertConnection(db)
        .prepare(`INSERT INTO invitation
                  (id, email, department, created_at, opened_at, last_seen_at, completed_at)
                  VALUES (?, ?, ?, ?, NULL, NULL, NULL)`)
        .run(id, email, department, createdAt);

    return {
        id,
        email,
        department,
        created_at: createdAt,
        opened_at: null,
        last_seen_at: null,
        completed_at: null
    };
}

/**
 * The admin's view of invitations.
 *
 * Includes the id, because the console acts on an invitation by id and the id is
 * the identity that never changes. Includes how many links are live, so an admin
 * can see whether several are outstanding, and when the newest was issued. Never
 * includes a token: a list of live credentials must not be readable from a page.
 */
export function listInvitations(db) {
    return assertConnection(db)
        .prepare(`SELECT i.id, i.email, i.department, i.created_at,
                         i.opened_at, i.last_seen_at, i.completed_at,
                         (SELECT COUNT(*) FROM participant_tokens t
                           WHERE t.invitation_id = i.id
                             AND t.revoked_at IS NULL AND t.expires_at > ?) AS live_tokens,
                         (SELECT MAX(t.issued_at) FROM participant_tokens t
                           WHERE t.invitation_id = i.id
                             AND t.revoked_at IS NULL AND t.expires_at > ?) AS token_issued_at
                  FROM invitation i ORDER BY i.department, i.email`)
        .all(nowIso(), nowIso());
}

/**
 * Records that the link was opened, and when it was last seen.
 *
 * COALESCE keeps the first opened_at: a participant who opens the link five
 * times was still first seen the first time, and the admin view would otherwise
 * report the most recent visit as the opening.
 */
export function touchInvitationOpened(db, invitationId) {
    const at = nowIso();
    assertConnection(db)
        .prepare(`UPDATE invitation
                  SET opened_at = COALESCE(opened_at, ?), last_seen_at = ?
                  WHERE id = ?`)
        .run(at, at, invitationId);
    return selectInvitationById(db, invitationId);
}

/**
 * The invitation an email address belongs to, or null.
 *
 * Case-insensitive, because an address is, and a participant who typed their
 * address with a capital letter must find the invitation they were sent.
 */
export function selectInvitationByEmail(db, email) {
    return assertConnection(db)
        .prepare(`SELECT id, email, department, created_at, opened_at, last_seen_at, completed_at
                  FROM invitation WHERE lower(email) = lower(?) LIMIT 1`)
        .get(email) ?? null;
}
