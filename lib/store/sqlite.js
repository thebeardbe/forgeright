/**
 * SQLite statements for one organisation. Never opens a connection: it is handed one by registry.js,
 * which already determines the organisation.
 */
import { randomUUID } from 'node:crypto';

import { nowIso, assertConnection } from './connection-guard.js';

export { nowIso };

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

export function updateOrganisationName(db, name) {
    assertConnection(db).prepare('UPDATE organisation SET name = ?').run(name);
    return selectOrganisation(db);
}

/** The first close wins: the timestamp stands rather than being overwritten by a later close. */
export function markOrganisationFinished(db, finishedAt = nowIso()) {
    assertConnection(db)
        .prepare('UPDATE organisation SET finished_at = ? WHERE finished_at IS NULL')
        .run(finishedAt);
    return selectOrganisation(db);
}

// --- invitation -------------------------------------------------------------

export {
    selectInvitationById,
    selectInvitationByEmail,
    insertInvitation,
    listInvitations,
    touchInvitationOpened
} from './invitation-sql.js';

// --- response ---------------------------------------------------------------

/** Rows whose JSON cannot be parsed come back marked `unreadable` rather than dropped. */
export function selectResponsesByInvitation(db, invitationId) {
    const rows = assertConnection(db)
        .prepare(`SELECT id, department, data, transcript, created_at, updated_at, submitted_at
                  FROM response WHERE invitation_id = ? ORDER BY created_at, id`)
        .all(invitationId);

    return rows.map((row) => {
        const parsed = parseResponseData(row);
        return { ...row, ...parsed };
    });
}

export function responseBelongsToInvitation(db, responseId, invitationId) {
    const row = assertConnection(db)
        .prepare('SELECT 1 AS ok FROM response WHERE id = ? AND invitation_id = ?')
        .get(responseId, invitationId);
    return row !== undefined;
}

export function responseExists(db, responseId) {
    const row = assertConnection(db)
        .prepare('SELECT 1 AS ok FROM response WHERE id = ?')
        .get(responseId);
    return row !== undefined;
}

export function selectResponseById(db, responseId) {
    const row = assertConnection(db)
        .prepare(`SELECT id, department, data, transcript, created_at, updated_at, submitted_at
                  FROM response WHERE id = ?`)
        .get(responseId);
    if (!row) return null;

    const parsed = parseResponseData(row);
    return { ...row, ...parsed };
}

export function insertResponse(db, { id, invitationId, department, data, transcript }) {
    const at = nowIso();
    assertConnection(db)
        .prepare(`INSERT INTO response
                  (id, invitation_id, department, data, transcript, created_at, updated_at, submitted_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`)
        .run(id, invitationId, department, serialiseResponseData(data),
            serialiseTranscript(transcript), at, at);

    return {
        id,
        department,
        data,
        // The supplied array, not a parse of it; copied so the caller's array is not the store's state.
        transcript: Array.isArray(transcript) ? transcript.map((turn) => ({ ...turn })) : null,
        created_at: at,
        updated_at: at,
        submitted_at: null
    };
}

/**
 * Newest first, so that if two open rounds somehow exist the participant continues the one they were
 * last working on rather than an older row.
 */
export function selectOpenResponse(db, invitationId) {
    const row = assertConnection(db)
        .prepare(`SELECT id, department, data, transcript, created_at, updated_at, submitted_at
                  FROM response WHERE invitation_id = ? AND submitted_at IS NULL
                  ORDER BY created_at DESC, id DESC LIMIT 1`)
        .get(invitationId);

    if (!row) return null;
    return { ...row, ...parseResponseData(row) };
}

/**
 * Sets `submitted_at` once and returns the row.
 *
 * THE RETURN VALUE IS THE ROW, NOT A SUCCESS FLAG, and a repeat call is deliberately not refused: the
 * second call's WHERE clause matches nothing, so the original instant stands, and the row is re-selected
 * so the caller gets it either way. `test/rounds.test.js` pins that idempotence.
 *
 * SO A CROSS-INVITATION ID DOES NOT GIVE NULL HERE, unlike `updateResponseData`: the UPDATE matches
 * nothing, and the re-select below is by id alone, so another invitation's row comes back. No caller does
 * this today - all three sites in index.js pass an id they resolved from the same invitation - but a
 * caller that needs the refusal must check the invitation itself.
 */
export function markResponseSubmitted(db, responseId, invitationId) {
    const at = nowIso();
    assertConnection(db)
        .prepare(`UPDATE response SET submitted_at = ?, updated_at = ?
                  WHERE id = ? AND invitation_id = ? AND submitted_at IS NULL`)
        .run(at, at, responseId, invitationId);

    return selectResponseById(db, responseId);
}

/**
 * The caller must have checked that the organisation is still open, because this layer cannot see the
 * organisation row it does not own. Returns null when the id does not belong to this invitation.
 *
 * Omitted transcript keeps the stored one, and writing it here is what stops a progressive save from
 * dropping everything after the first turn.
 */
export function updateResponseData(db, responseId, invitationId, data, transcript) {
    const at = nowIso();
    const hasTranscript = transcript !== undefined;
    const statement = hasTranscript
        ? 'UPDATE response SET data = ?, transcript = ?, updated_at = ? WHERE id = ? AND invitation_id = ?'
        : 'UPDATE response SET data = ?, updated_at = ? WHERE id = ? AND invitation_id = ?';
    const args = hasTranscript
        ? [serialiseResponseData(data), serialiseTranscript(transcript), at, responseId, invitationId]
        : [serialiseResponseData(data), at, responseId, invitationId];

    const result = assertConnection(db).prepare(statement).run(...args);
    if (result.changes === 0) return null;
    return selectResponseById(db, responseId);
}

/**
 * Do not add a join to this query: the absence of one is what strips attribution. That strips it from the
 * console only, not from the database file - "Anonymity, and its limit" in README.md states the limit.
 */
export function selectResponsesForAnalysis(db) {
    const rows = assertConnection(db)
        .prepare(`SELECT id, department, data, transcript, created_at, updated_at, submitted_at
                  FROM response WHERE submitted_at IS NOT NULL ORDER BY created_at, id`)
        .all();

    return rows.map((row) => {
        const parsed = parseResponseData(row);
        return { ...row, ...parsed };
    });
}

/** Partial rounds included, for the answers view; the exclusion lives in the analysis query above. */
export function selectAllResponses(db) {
    const rows = assertConnection(db)
        .prepare(`SELECT id, department, data, transcript, created_at, updated_at, submitted_at
                  FROM response ORDER BY created_at, id`)
        .all();

    return rows.map((row) => {
        const parsed = parseResponseData(row);
        return { ...row, ...parsed };
    });
}

// --- serialisation ----------------------------------------------------------

/** Never throws: a corrupt row comes back `unreadable`, not as an absent answer. */
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

    return { data: parsed, unreadable: false, transcript: parseTranscript(row.transcript) };
}

/** A corrupt transcript is null, like an absent one, rather than being thrown. */
function parseTranscript(stored) {
    if (stored === null || stored === undefined || stored === '') return null;

    try {
        const parsed = JSON.parse(stored);
        return Array.isArray(parsed) ? parsed : null;
    } catch (err) {
        console.error(`[store] a response holds an unreadable transcript (${err.message}); returning null.`);
        return null;
    }
}

/** Absent stays NULL rather than becoming the string "null". */
function serialiseTranscript(transcript) {
    if (transcript === undefined || transcript === null) return null;
    if (!Array.isArray(transcript)) {
        throw new Error('A transcript must be an array of messages; refusing to store anything else.');
    }
    return JSON.stringify(transcript);
}

/** A non-serialisable value is loud. */
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

/** UUID v4, generated here rather than by the schema. */
export function newId() {
    return randomUUID();
}
