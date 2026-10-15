/**
 * SQLite statements for one organisation. This module never opens a connection: it is handed one by
 * registry.js, which already determines the organisation, so a function here has no way to widen its
 * scope and a mistake can lose a row but never leak one to another organisation.
 *
 * All timestamps are UTC ISO 8601 strings, so ordering them as text orders them chronologically, and
 * every parameter is bound rather than interpolated into SQL.
 */
import { randomUUID } from 'node:crypto';

// Shared with invitation-sql.js, so there is one implementation of each rule. nowIso is re-exported
// because callers of this module already import it here.
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

/**
 * Changes the organisation's name: a first sign-in creates it with a placeholder derived from the
 * address, because self-service gives nobody to ask for a real one, and this is deliberately the
 * only mutable field.
 *
 * @returns {object|null} The organisation, or null when there was no row.
 */
export function updateOrganisationName(db, name) {
    assertConnection(db).prepare('UPDATE organisation SET name = ?').run(name);
    return selectOrganisation(db);
}

/**
 * Sets finished_at. Idempotent: the first close wins and its timestamp stands, so two admins closing
 * at once cannot move the boundary.
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
//
// The invitation statements live in ./invitation-sql.js, and the credentials in
// ./participant-token-sql.js. Re-exported here so callers keep one import path.
export {
    selectInvitationById,
    selectInvitationByEmail,
    insertInvitation,
    listInvitations,
    touchInvitationOpened
} from './invitation-sql.js';

// --- response ---------------------------------------------------------------

/**
 * A participant's own responses, for resume and edit. `data` is parsed here, so callers receive an
 * object, and a row whose JSON cannot be parsed is returned marked unreadable rather than dropped,
 * because "no answer" and "unreadable answer" are different states.
 */
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

/** True when the response exists and belongs to this invitation. */
export function responseBelongsToInvitation(db, responseId, invitationId) {
    const row = assertConnection(db)
        .prepare('SELECT 1 AS ok FROM response WHERE id = ? AND invitation_id = ?')
        .get(responseId, invitationId);
    return row !== undefined;
}

/**
 * True when the response exists in this organisation's file. Used before linking a response to a
 * process: a link to an id from elsewhere would be a foreign key to nothing, and because the
 * connection is already scoped to one file, an id belonging to another organisation is not found.
 */
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
        // The array that was supplied, returned as-is rather than parsed, because parseTranscript
        // reads a stored string; a shallow copy keeps the caller's array out of the store's state.
        transcript: Array.isArray(transcript) ? transcript.map((turn) => ({ ...turn })) : null,
        created_at: at,
        updated_at: at,
        submitted_at: null
    };
}

/**
 * The round this participant is still filling in, or null. A round is open when `submitted_at IS
 * NULL`, and at most one is ever open, because a `complete` reply closes the round in the same
 * request that carries it.
 *
 * Newest first, deliberately: two open rounds should be impossible, but if a bug or a hand-edited
 * file ever produced two, the participant must carry on with the one they were last working on
 * rather than silently writing into an older row.
 *
 * @returns {object|null} The open round, or null when every round is finalised.
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
 * Marks a round as finalised, and returns it. `submitted_at` is set once and never moved, because the
 * moment a round was concluded is a fact about that round and overwriting it would make the console's
 * ordering depend on when somebody last touched the row. Returns null when the id does not belong to
 * this invitation, matching updateResponseData, so a caller cannot conclude that an id exists
 * elsewhere.
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
 * Overwrites one round of answers, with its conversation. The caller must have checked that the
 * organisation is still open; this layer cannot see the organisation row it does not own. Returns
 * null when the id does not belong to this invitation, which the caller reports as a refusal rather
 * than as a missing participant.
 *
 * The transcript is written here too, and must be: an update that omits it keeps the conversation
 * from the first save and silently drops everything after it, which is what progressive saving does
 * on every turn. An absent transcript is not an error, matching insertResponse: `undefined` leaves
 * the column alone and an array replaces it.
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
 * Responses for the roadmap, with attribution stripped. The join to invitation is deliberately absent
 * rather than performed and then deleted: no column here could connect an answer to a person, so the
 * admin path physically cannot leak the link. Do not add a join to this query.
 *
 * Accepted trade-off: anyone with direct access to the database file can join invitation to response
 * by hand and recover the attribution, so the anonymity claim rests on the file being protected.
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

/**
 * Every response, partial rounds included, for the answers view. The only difference from
 * selectResponsesForAnalysis is the `submitted_at` clause, and it is the product decision: partial
 * rounds are visible and not scored, so the row is shown while contributing nothing to the roadmap.
 *
 * The exclusion lives in the analysis query rather than in a caller's filter, because a filter is a
 * thing a new caller forgets. Ordered the same way, newest last, so a reader comparing the two lists
 * sees the partials slotted into the position they will occupy once finished.
 */
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

/**
 * Parses the JSON blob, and never throws. A corrupt row is reported as unreadable rather than as an
 * absent answer, which is the whole reason this function exists: the analysis must not treat a
 * damaged response as a participant who answered nothing.
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

    // The transcript travels with the row, parsed by the same rule and reported by the same
    // distinction: null means there is none, and a corrupt one is flagged rather than dropped.
    return { data: parsed, unreadable: false, transcript: parseTranscript(row.transcript) };
}

/**
 * Parses a stored transcript into an array of messages. Three outcomes, kept distinct: null means no
 * transcript was stored, `[]` means one was stored and is empty, and an array is the conversation in
 * order. A corrupt transcript logs and returns null, matching how a corrupt `data` blob is treated,
 * so a damaged transcript cannot look like an absent one.
 *
 * @param {string|null} stored
 * @returns {Array<object>|null}
 */
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

/**
 * Serialises a transcript for storage: an array of { role, content } as JSON text, so a long
 * interview is one column rather than a row per message. Absent stays NULL rather than becoming the
 * string "null", because the column distinguishes "no transcript" from "an empty one".
 *
 * @param {Array<object>|null|undefined} transcript
 * @returns {string|null}
 */
function serialiseTranscript(transcript) {
    if (transcript === undefined || transcript === null) return null;
    if (!Array.isArray(transcript)) {
        throw new Error('A transcript must be an array of messages; refusing to store anything else.');
    }
    return JSON.stringify(transcript);
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

/** A fresh id for a new row. UUID v4, generated here rather than by the schema. */
export function newId() {
    return randomUUID();
}
