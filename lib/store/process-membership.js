/**
 * Membership: which responses sit in which revision.
 *
 * SPLIT OUT OF `process-sql.js`, which had reached the file-size budget. The seam
 * is a real one rather than a mechanical cut: everything here is about the
 * membership of a revision, and everything left in `process-sql.js` is about the
 * process, its revisions and its scores. Membership is also where the store's
 * central invariant lives (a response is in at most ONE current revision), and
 * keeping those queries together is what makes that checkable in one place.
 *
 * A revision carries a SNAPSHOT of its responses, so history keeps every grouping a
 * process has ever had. Only `is_current = 1` says which grouping is in force.
 */
import { nowIso, assertConnection } from './connection-guard.js';

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

/**
 * The process and current revision a response belongs to, or null.
 *
 * ONE QUERY, because a move needs both and a caller that had to resolve them
 * separately could read the process from one revision and the members from
 * another. `is_current = 1` is what makes this "the grouping in force" rather than
 * "every revision this response has ever appeared in", which includes the history.
 *
 * A response can legitimately appear in several revisions of the SAME process (the
 * carry-forward does exactly that), so this orders by revision and takes the
 * current one; a response in two CURRENT revisions is the defect the store's
 * invariant assertion exists to catch.
 *
 * @param {object} db
 * @param {string} responseId
 * @returns {{processId: string, processName: string, revisionId: string, revision: number}|null}
 */
export function selectCurrentHomeForResponse(db, responseId) {
    const row = assertConnection(db)
        .prepare(
            `SELECT p.id AS process_id, p.name AS process_name, pr.id AS revision_id, pr.revision
             FROM process_response ps
             JOIN process_revision pr ON pr.id = ps.revision_id AND pr.is_current = 1
             JOIN process p ON p.id = pr.process_id
             WHERE ps.response_id = ?
             ORDER BY pr.revision DESC
             LIMIT 1`
        )
        .get(responseId);

    if (!row) return null;

    return {
        processId: row.process_id,
        processName: row.process_name,
        revisionId: row.revision_id,
        revision: row.revision
    };
}

/**
 * Every response that is in more than one CURRENT revision.
 *
 * THE INVARIANT, MADE CHECKABLE. A response in two processes counts one person
 * twice: the roadmap shows it behind both, the participant count sent to the model
 * is inflated, and `people` is a reward term, so both entries are scored too high.
 * Nothing in the schema forbids it, because uniqueness is scoped to
 * `(revision_id, response_id)` and `is_current` lives on the other table.
 *
 * Returns the offending response ids, so a caller can name them in the error.
 *
 * @param {object} db
 * @returns {Array<{responseId: string, processes: string}>}
 */
export function selectResponsesInTwoCurrentRevisions(db) {
    return assertConnection(db)
        .prepare(
            `SELECT ps.response_id AS response_id,
                    group_concat(p.name, ' | ') AS processes
             FROM process_response ps
             JOIN process_revision pr ON pr.id = ps.revision_id AND pr.is_current = 1
             JOIN process p ON p.id = pr.process_id
             GROUP BY ps.response_id
             HAVING COUNT(*) > 1`
        )
        .all()
        .map((row) => ({ responseId: row.response_id, processes: row.processes }));
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
