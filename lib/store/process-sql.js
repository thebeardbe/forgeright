/**
 * Process statements for ONE organisation.
 *
 * A process is the WORK, independent of who described it; a revision is one
 * grouping judgement about it. Workflow 2 creates both, and a rejudge adds a
 * revision rather than editing one.
 *
 * This module NEVER opens a connection: it is handed one by the registry, so it
 * cannot tell which organisation it is working on and has no way to widen its
 * scope. All parameters are bound; no value is interpolated into SQL.
 *
 * NOTHING HERE IS READABLE BY A PARTICIPANT. No projection here is reachable from
 * the participant routes, deliberately: a participant who could see where their
 * answer was grouped would write to influence it. See lib/store/processes.js.
 */
import { nowIso, assertConnection } from './connection-guard.js';

/** The name a process carries when the model supplied none. */
const UNNAMED = 'Unnamed process';

/**
 * Inserts a process.
 *
 * The name is held on the process rather than per revision, because a rejudge
 * normally refines the name rather than replacing the identity, and a reader wants
 * the current one. A blank name is stored as a placeholder rather than refused:
 * the reasoning is what matters to a reader, and a missing name should not stop a
 * grouping from being recorded.
 */
export function insertProcess(db, { id, name }) {
    const at = nowIso();
    const safeName = typeof name === 'string' && name.trim() !== '' ? name.trim() : UNNAMED;

    assertConnection(db)
        .prepare('INSERT INTO process (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(id, safeName, at, at);

    return { id, name: safeName, created_at: at, updated_at: at };
}

/** Renames a process, when a rejudge refines the name. */
export function updateProcessName(db, processId, name) {
    if (typeof name !== 'string' || name.trim() === '') return null;

    const at = nowIso();
    assertConnection(db)
        .prepare('UPDATE process SET name = ?, updated_at = ? WHERE id = ?')
        .run(name.trim(), at, processId);

    return selectProcessById(db, processId);
}

/** The process for an id, or null. */
export function selectProcessById(db, processId) {
    return assertConnection(db)
        .prepare('SELECT id, name, created_at, updated_at FROM process WHERE id = ?')
        .get(processId) ?? null;
}

/** Every process for this organisation, oldest first, so ids are stable in order. */
export function listProcesses(db) {
    return assertConnection(db)
        .prepare('SELECT id, name, created_at, updated_at FROM process ORDER BY created_at, id')
        .all();
}

/**
 * The next revision number for a process.
 *
 * Derived from the highest existing number rather than from a count, so a
 * deletion cannot make two revisions share a number.
 */
export function nextRevision(db, processId) {
    const row = assertConnection(db)
        .prepare('SELECT MAX(revision) AS highest FROM process_revision WHERE process_id = ?')
        .get(processId);

    return (row?.highest ?? 0) + 1;
}

/**
 * Adds a revision and makes it the current one.
 *
 * THE PREVIOUS CURRENT IS CLEARED FIRST, in one transaction with the insert,
 * because the partial unique index allows only one current revision per process.
 * Without the transaction a failure between the two statements would leave the
 * process with no current revision, which reads as "ungrouped" when it has been
 * grouped twice.
 */
export function insertRevision(db, { id, processId, revision, decidedBy, reasoning, confidence, adminReasoning }) {
    const at = nowIso();
    const connection = assertConnection(db);

    connection.exec('BEGIN IMMEDIATE');
    try {
        connection.prepare('UPDATE process_revision SET is_current = 0 WHERE process_id = ? AND is_current = 1')
            .run(processId);
        connection.prepare(
            `INSERT INTO process_revision
             (id, process_id, revision, decided_by, reasoning, confidence, admin_reasoning, is_current, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
        ).run(id, processId, revision, decidedBy, reasoning, confidence, adminReasoning ?? null, at);
        connection.exec('COMMIT');
    } catch (err) {
        connection.exec('ROLLBACK');
        throw err;
    }

    return { id, process_id: processId, revision, decided_by: decidedBy, reasoning, confidence, admin_reasoning: adminReasoning ?? null, is_current: 1, created_at: at };
}

/** The current revision for a process, or null. */
export function selectCurrentRevision(db, processId) {
    return assertConnection(db)
        .prepare(`SELECT id, process_id, revision, decided_by, reasoning, confidence, admin_reasoning, created_at
                  FROM process_revision WHERE process_id = ? AND is_current = 1`)
        .get(processId) ?? null;
}

/** Every revision for a process, newest first, for the version history. */
export function listRevisions(db, processId) {
    return assertConnection(db)
        .prepare(`SELECT id, process_id, revision, decided_by, reasoning, confidence, admin_reasoning, is_current, created_at
                  FROM process_revision WHERE process_id = ? ORDER BY revision DESC`)
        .all(processId);
}

/**
 * Links a response to a revision, with what it contributed.
 *
 * `INSERT OR IGNORE` against the (revision, response) unique index, so linking the
 * same pair twice is a no-op rather than an error: a model that names a response
 * twice should not fail the whole grouping.
 *
 * @returns {boolean} True when a row was added.
 */
export function linkResponse(db, { id, revisionId, responseId, contributed }) {
    const at = nowIso();
    const result = assertConnection(db)
        .prepare(`INSERT OR IGNORE INTO process_response (id, revision_id, response_id, contributed, created_at)
                  VALUES (?, ?, ?, ?, ?)`)
        .run(id, revisionId, responseId, JSON.stringify(contributed ?? []), at);

    return result.changes > 0;
}

/** The responses behind a revision, with what each contributed. */
export function selectResponsesForRevision(db, revisionId) {
    const rows = assertConnection(db)
        .prepare(`SELECT pr.response_id, pr.contributed, r.department, r.data, r.created_at
                  FROM process_response pr
                  JOIN response r ON r.id = pr.response_id
                  WHERE pr.revision_id = ?
                  ORDER BY r.created_at, r.id`)
        .all(revisionId);

    return rows.map((row) => ({
        responseId: row.response_id,
        // Parsed here, so a caller reads the field names rather than a JSON string
        // it would have to remember to parse.
        contributed: parseContributed(row),
        department: row.department,
        data: parseData(row),
        created_at: row.created_at
    }));
}

/** The revision ids a response is linked to, so a rejudge can find its process. */
export function selectRevisionIdsForResponse(db, responseId) {
    return assertConnection(db)
        .prepare('SELECT revision_id FROM process_response WHERE response_id = ?')
        .all(responseId)
        .map((row) => row.revision_id);
}

/** A corrupt `contributed` blob is reported, not thrown: a reader loses a list, not the row. */
function parseContributed(row) {
    try {
        const parsed = JSON.parse(row.contributed);
        return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
        console.error(`[store] a process_response row holds unreadable contributed JSON (${err.message}); using an empty list.`);
        return [];
    }
}

/** Parses a response's `data` blob, with the same tolerance. */
function parseData(row) {
    try {
        return JSON.parse(row.data);
    } catch (err) {
        console.error(`[store] response ${row.response_id} holds unreadable JSON (${err.message}); returning null.`);
        return null;
    }
}

// --- weighing (workflow 3) --------------------------------------------------

/**
 * The next weighing number for a revision.
 *
 * Derived from the highest existing number rather than a count, so a deletion
 * cannot make two scores share a number.
 */
export function nextScoreRevision(db, revisionId) {
    const row = assertConnection(db)
        .prepare('SELECT MAX(revision_no) AS highest FROM process_score WHERE revision_id = ?')
        .get(revisionId);

    return (row?.highest ?? 0) + 1;
}

/**
 * Adds a weighing and makes it the current one.
 *
 * THE PREVIOUS CURRENT IS CLEARED FIRST, in one transaction with the insert,
 * because the partial unique index allows only one current score per revision.
 * Without the transaction a failure between the two statements would leave a
 * revision looking unscored when it has been weighed twice.
 */
export function insertScore(db, { id, revisionId, score, terms, reasoning, revisionNo }) {
    const at = nowIso();
    const connection = assertConnection(db);

    connection.exec('BEGIN IMMEDIATE');
    try {
        connection.prepare('UPDATE process_score SET is_current = 0 WHERE revision_id = ? AND is_current = 1')
            .run(revisionId);
        connection.prepare(
            `INSERT INTO process_score
             (id, revision_id, score, terms, reasoning, revision_no, is_current, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
        ).run(id, revisionId, score, JSON.stringify(terms), reasoning, revisionNo, at);
        connection.exec('COMMIT');
    } catch (err) {
        connection.exec('ROLLBACK');
        throw err;
    }

    return { id, revision_id: revisionId, score, terms, reasoning, revision_no: revisionNo, is_current: 1, created_at: at };
}

/** The current weighing for a revision, with its terms parsed, or null. */
export function selectCurrentScore(db, revisionId) {
    const row = assertConnection(db)
        .prepare(`SELECT id, revision_id, score, terms, reasoning, revision_no, created_at
                  FROM process_score WHERE revision_id = ? AND is_current = 1`)
        .get(revisionId);

    return row ? { ...row, terms: parseTerms(row) } : null;
}

/** Every weighing for a revision, newest first, for the version history. */
/**
 * Every score a process has ever had, newest first, ACROSS ALL ITS REVISIONS.
 *
 * Needed because `process_score` is keyed on `revision_id`, so a rejudge (which
 * makes a new revision) starts numbering at 1 again: `listScores` for one revision
 * would show the new score and hide the earlier one. The roadmap promises that an
 * earlier score stays readable, so the history has to span the revisions rather
 * than sit inside one.
 *
 * The revision number is included, because "weighing 2 of revision 3" is what
 * makes two similar-looking numbers tell a story.
 *
 * @returns {Array<object>} Scores, newest first.
 */
export function listScoresForProcess(db, processId) {
    return assertConnection(db)
        .prepare(
            `SELECT s.id, s.revision_id, s.score, s.terms, s.reasoning, s.revision_no, s.is_current, s.created_at,
                    r.revision AS grouping_revision
             FROM process_score s
             JOIN process_revision r ON r.id = s.revision_id
             WHERE r.process_id = ?
             ORDER BY r.revision DESC, s.revision_no DESC`
        )
        .all(processId)
        .map((row) => ({ ...row, terms: parseTerms(row), is_current: row.is_current === 1 }));
}

export function listScores(db, revisionId) {
    return assertConnection(db)
        .prepare(`SELECT id, revision_id, score, terms, reasoning, revision_no, is_current, created_at
                  FROM process_score WHERE revision_id = ? ORDER BY revision_no DESC`)
        .all(revisionId)
        .map((row) => ({ ...row, terms: parseTerms(row), is_current: row.is_current === 1 }));
}

/** A corrupt terms blob is reported, not thrown: a reader loses the breakdown, not the score. */
function parseTerms(row) {
    try {
        const parsed = JSON.parse(row.terms);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (err) {
        console.error(`[store] a process_score row holds unreadable terms JSON (${err.message}); using an empty object.`);
        return {};
    }
}
