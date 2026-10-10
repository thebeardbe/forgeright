/**
 * SQLite statements for ONE organisation.
 *
 * This module NEVER opens a connection. It is handed one by
 * lib/store/registry.js, and it cannot tell which organisation that connection
 * belongs to, because it does not need to: the file already determines it. That
 * is deliberate. A function here has no way to widen its scope, so a mistake in
 * this file can lose a row, never leak one to another organisation.
 *
 * All timestamps are UTC ISO 8601 strings, so ordering them as text orders them
 * chronologically. Every parameter is bound; no value is interpolated into SQL.
 */
import { randomUUID } from 'node:crypto';
import { hashToken, tokenHashesMatch } from './tokens.js';

/** ISO 8601 UTC, the format every timestamp column in this schema holds. */
export function nowIso() {
    return new Date().toISOString();
}

/** Fails loudly when a connection was not handed in. A programming error. */
function assertConnection(db) {
    if (!db || typeof db.prepare !== 'function') {
        throw new Error('A DatabaseSync connection is required; lib/store/sqlite.js never opens one.');
    }
    return db;
}

// --- organisation -----------------------------------------------------------

/** The organisation row. The file holds exactly one. */
export function selectOrganisation(db) {
    return assertConnection(db)
        .prepare('SELECT id, name, created_at, finished_at FROM organisation LIMIT 1')
        .get() ?? null;
}

export function insertOrganisation(db, { id, name }) {
    const createdAt = nowIso();
    assertConnection(db)
        .prepare('INSERT INTO organisation (id, name, created_at, finished_at) VALUES (?, ?, ?, NULL)')
        .run(id, name, createdAt);
    return { id, name, created_at: createdAt, finished_at: null };
}

/**
 * Sets finished_at. Idempotent: the first close wins and its timestamp stands,
 * so two admins closing at once cannot move the boundary.
 *
 * @returns {object|null} The organisation, or null when there was no row.
 */
export function markOrganisationFinished(db, finishedAt = nowIso()) {
    assertConnection(db)
        .prepare('UPDATE organisation SET finished_at = ? WHERE finished_at IS NULL')
        .run(finishedAt);
    return selectOrganisation(db);
}

// --- invitation -------------------------------------------------------------

/**
 * The stored hash for a presented token, or null when no invitation matches.
 *
 * Lookup is by hash and never by the raw token, so the bearer value is not used
 * as a query key and never appears in a database file, a query log or a row.
 * The row it returns INCLUDES the stored hash, for findInvitationByToken's
 * constant-time re-check; it is module-private for that reason.
 */
export function selectInvitationByToken(db, token) {
    return selectInvitationRowByToken(db, token);
}

/**
 * The invitation row for a presented token, INCLUDING the stored hash, or null.
 *
 * Private to this module: the token column is present only because
 * findInvitationByToken must re-check the credential in constant time. Callers
 * outside that path use selectInvitationById or listInvitations, which do not
 * select the column, so no caller has to remember to strip it.
 */
function selectInvitationRowByToken(db, token) {
    return assertConnection(db)
        .prepare(`SELECT id, email, department, token, created_at, opened_at, last_seen_at, completed_at
                  FROM invitation WHERE token = ?`)
        .get(hashToken(token)) ?? null;
}

/**
 * The invitation row for an id, WITHOUT the stored token hash, or null.
 *
 * The hash is omitted from the projection rather than removed by the caller:
 * a caller that has to remember to delete a field will eventually forget, and
 * the field it would leak is a credential.
 */
export function selectInvitationById(db, invitationId) {
    return assertConnection(db)
        .prepare(`SELECT id, email, department, created_at, opened_at, last_seen_at, completed_at
                  FROM invitation WHERE id = ?`)
        .get(invitationId) ?? null;
}

export function insertInvitation(db, { id, email, department, token }) {
    const createdAt = nowIso();
    assertConnection(db)
        .prepare(`INSERT INTO invitation
                  (id, email, department, token, created_at, opened_at, last_seen_at, completed_at)
                  VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)`)
        .run(id, email, department, hashToken(token), createdAt);

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

export function listInvitations(db) {
    return assertConnection(db)
        .prepare(`SELECT email, department, opened_at, last_seen_at, completed_at
                  FROM invitation ORDER BY department, email`)
        .all();
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

// --- response ---------------------------------------------------------------

/**
 * A participant's OWN responses, for resume and edit.
 *
 * `data` is parsed here, so callers receive an object. A row whose JSON cannot
 * be parsed is returned with `data: null` and an `unreadable` marker rather than
 * being silently dropped, because "no answer" and "unreadable answer" are
 * different states and the difference matters when a participant says their
 * work is missing.
 */
export function selectResponsesByInvitation(db, invitationId) {
    const rows = assertConnection(db)
        .prepare(`SELECT id, department, data, created_at, updated_at, submitted_at
                  FROM response WHERE invitation_id = ? ORDER BY created_at, id`)
        .all(invitationId);

    return rows.map((row) => {
        const parsed = parseResponseData(row);
        return { ...row, ...parsed };
    });
}

/** True when the response exists and belongs to this invitation. */
export function responseBelongsToInvitation(db, responseId, invitationId) {
    const row = assertConnection(db)
        .prepare('SELECT 1 AS ok FROM response WHERE id = ? AND invitation_id = ?')
        .get(responseId, invitationId);
    return row !== undefined;
}

export function selectResponseById(db, responseId) {
    const row = assertConnection(db)
        .prepare(`SELECT id, department, data, created_at, updated_at, submitted_at
                  FROM response WHERE id = ?`)
        .get(responseId);
    if (!row) return null;

    const parsed = parseResponseData(row);
    return { ...row, ...parsed };
}

export function insertResponse(db, { id, invitationId, department, data }) {
    const at = nowIso();
    const serialised = serialiseResponseData(data);
    assertConnection(db)
        .prepare(`INSERT INTO response
                  (id, invitation_id, department, data, created_at, updated_at, submitted_at)
                  VALUES (?, ?, ?, ?, ?, ?, NULL)`)
        .run(id, invitationId, department, serialised, at, at);

    return {
        id,
        department,
        data,
        created_at: at,
        updated_at: at,
        submitted_at: null
    };
}

/**
 * Overwrites one round of answers.
 *
 * The caller must have checked that the organisation is still open; this layer
 * cannot see the organisation row it does not own. Returns null when the id does
 * not belong to this invitation, which the caller reports as a refusal rather
 * than as a missing participant.
 */
export function updateResponseData(db, responseId, invitationId, data) {
    const at = nowIso();
    const result = assertConnection(db)
        .prepare('UPDATE response SET data = ?, updated_at = ? WHERE id = ? AND invitation_id = ?')
        .run(serialiseResponseData(data), at, responseId, invitationId);

    if (result.changes === 0) return null;
    return selectResponseById(db, responseId);
}

/**
 * Responses for the roadmap, with attribution STRIPPED.
 *
 * The join to invitation is deliberately absent rather than performed and then
 * deleted: there is no column here that could connect an answer to a person, so
 * the admin path physically cannot leak the link, by accident or otherwise. Do
 * not add a join to this query.
 *
 * Accepted, documented trade-off (the product owner's decision): anyone with
 * direct access to the database file can join invitation to response by hand and
 * recover the attribution. This method removes the link from the application's
 * own analysis path; it is not encryption, and the roadmap's anonymity claim
 * rests on the file being protected, not on this query alone.
 */
export function selectResponsesForAnalysis(db) {
    const rows = assertConnection(db)
        .prepare(`SELECT id, department, data, created_at, updated_at, submitted_at
                  FROM response ORDER BY created_at, id`)
        .all();

    return rows.map((row) => {
        const parsed = parseResponseData(row);
        return { ...row, ...parsed };
    });
}

// --- serialisation ----------------------------------------------------------

/**
 * Parses the JSON blob, and never throws.
 *
 * A corrupt row is reported as unreadable rather than as an absent answer. The
 * distinction is the whole reason this function exists: the analysis must not
 * treat a damaged response as a participant who answered nothing.
 */
function parseResponseData(row) {
    let parsed;
    try {
        parsed = JSON.parse(row.data);
    } catch (err) {
        console.error(
            `[store] response ${row.id} holds unreadable JSON (${err.message}); ` +
            `returning it marked unreadable rather than as absent.`
        );
        return { data: null, unreadable: true };
    }
    return { data: parsed, unreadable: false };
}

/** Serialises the answers for storage. A non-serialisable value is loud. */
function serialiseResponseData(data) {
    if (data === undefined) {
        throw new Error('Response data is required; refusing to store undefined as JSON.');
    }
    try {
        return JSON.stringify(data);
    } catch (err) {
        throw new Error(`Response data could not be serialised to JSON: ${err.message}`);
    }
}

/**
 * Resolves a token to its invitation, or null when no invitation matches.
 *
 * The token is not repeated in any log line: a log is a place a bearer
 * credential leaks from, and finding an invitation by token does not require
 * printing it.
 *
 * A stored hash is matched exactly, in lowercase hex. That is the only form
 * hashToken writes, so the SELECT finds the row and this re-check agrees with
 * it. A row in any other form (uppercase, truncated, not hex) never reaches the
 * re-check, because the SELECT does not find it, and so behaves like a missing
 * invitation: the credential fails closed rather than matching something.
 */
export function findInvitationByToken(db, token) {
    const row = selectInvitationRowByToken(db, token);
    if (!row) return null;

    // The SELECT above already matched by hash, so equality is implied. The
    // comparison is still made, in constant time, because the credential check
    // belongs in one place and a future caller that supplies a stored row rather
    // than a token gets the same guarantee. Returns null on any mismatch.
    if (!tokenHashesMatch(row.token, hashToken(token))) {
        console.warn(`[store] invitation ${row.id} matched by hash but failed the constant-time re-check.`);
        return null;
    }

    // The stored hash is dropped here: it is a credential, and the only reason it
    // was selected is the re-check above.
    const { token: _storedHash, ...invitation } = row;
    return invitation;
}

/** A fresh id for a new row. UUID v4, generated here rather than by the schema. */
export function newId() {
    return randomUUID();
}
