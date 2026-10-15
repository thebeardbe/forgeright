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
import {
    listProcesses,
    selectCurrentRevision,
    listRevisions
} from './process-sql.js';
import { requireConnection } from './organisations.js';
import { correctionsForResponse } from './corrections.js';
import { responseWorkflow } from '../../ai/response-shape.js';

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

    return rows.map((row) => {
        const corrections = correctionsForResponse(db, row.response_id);
        return {
            responseId: row.response_id,
            // Parsed here, so a caller reads the field names rather than a JSON string
            // it would have to remember to parse.
            contributed: parseContributed(row),
            department: row.department,
            // AN ADMIN'S CORRECTION IS LAID OVER THE ANSWER HERE, at the one seam both the
            // weighing and the console read, so the score and the field shown beside it cannot
            // disagree. `response.data` IN THE TABLE IS NOT TOUCHED: the answers view reads the
            // response row and goes on showing what the participant actually said.
            data: applyCorrections(parseData(row), corrections),
            // THE CORRECTIONS ARE ALSO CARRIED, so a caller can tell the admin's reading from the
            // participant's own value and say "corrected by an admin" rather than presenting the
            // admin's number as their words.
            corrections,
            created_at: row.created_at
        };
    });
}

/**
 * Lays an admin's corrections over a stored answer, without changing the stored answer.
 *
 * THE SHAPE IS RESOLVED, NOT ASSUMED, which is the recurring defect in this file's neighbours: a
 * live round holds `{ workflows: [ {...} ] }` and an imported one holds the workflow directly, so
 * `responseWorkflow` - the one resolver for that shape - decides where the fields live.
 *
 * IT RETURNS A NEW OBJECT AND NEVER MUTATES ITS ARGUMENT, so a caller holding the parsed row
 * cannot be surprised by a correction appearing under it. WHEN NOTHING IS CORRECTED IT RETURNS
 * THE ORIGINAL REFERENCE, so the common path allocates nothing.
 *
 * @param {object} data The parsed response payload.
 * @param {Object<string, *>} corrections Corrected values by field. Empty means no change.
 * @returns {object} The payload with corrected fields applied.
 */
function applyCorrections(data, corrections) {
    const fields = Object.keys(corrections);
    if (fields.length === 0) return data;

    const workflow = responseWorkflow(data);
    if (!workflow) {
        // REPORTED RATHER THAN SILENT: a correction against a payload with no workflow would
        // otherwise be invisible and the score would quietly use the stored value.
        console.warn(
            'a correction exists for a response whose payload holds no workflow, so it could not ' +
            'be applied; the stored value will be scored.'
        );
        return data;
    }

    const corrected = { ...workflow };
    for (const field of fields) corrected[field] = corrections[field];

    // BACK INTO WHICHEVER SHAPE IT CAME IN. Rewriting the wrapper as a bare object would turn an
    // interview payload into an imported one, and every reader that resolves the shape would then
    // look for the workflow somewhere else.
    if (Array.isArray(data.workflows)) {
        const workflows = [...data.workflows];
        workflows[data.workflows.indexOf(workflow)] = corrected;
        return { ...data, workflows };
    }
    return { ...data, ...corrected };
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

/**
 * True when a process was BORN from an unsure split, unsettled since.
 *
 * Process-level, not newest-revision: that flagged a confident MERGE as a split,
 * and an ordinary merge cleared the flag.
 *
 * Revision 1 is the creation. `nextRevision` is MAX + 1, and create, merge,
 * rejudge and move all carry members forward.
 *
 * `!== 'admin'` not `=== 'model'`, so a third decider keeps it on. One review
 * clears, a MODEL revision does not re-open. Never re-ranks. Pure.
 *
 * @param {Array<object>} revisions A process's revisions, in any order, each with
 *   `revision`, `confidence` and `decided_by`.
 * @returns {{needsReview: boolean, reason: string}}
 */
export function needsReviewFromRevisions(revisions) {
    const history = Array.isArray(revisions) ? revisions.filter(Boolean) : [];
    if (history.length === 0) {
        // No revisions means nothing has been grouped, which is not a split.
        return { needsReview: false, reason: '' };
    }

    // Lowest revision number first, so "the first revision" does not depend on the
    // order a caller happened to read them in.
    const ordered = [...history].sort((a, b) => a.revision - b.revision);
    const born = ordered[0];

    if (born.confidence !== 'low' || born.decided_by === 'admin') {
        return { needsReview: false, reason: '' };
    }

    // Any later admin revision clears it. A later MODEL revision does not.
    const settledByAPerson = ordered.some((r) => r.revision > born.revision && r.decided_by === 'admin');
    if (settledByAPerson) {
        return { needsReview: false, reason: '' };
    }

    return {
        needsReview: true,
        reason: 'Split while unsure: born as its own process when the model could not tell whether it was the same work, and nobody has reviewed that since.'
    };
}

/**
 * Every process with its current revision, its responses and its history.
 *
 * ONE READ for the console, so a page renders a process completely rather than the
 * view assembling it from four queries and getting the order wrong. The history is
 * included because the spec keeps earlier versions and a reviewer needs to see what
 * changed.
 *
 * IT LIVES HERE, WITH THE OTHER MEMBERSHIP READS, rather than in `processes.js`:
 * it is the console's view of a process, and it reads the current revision and its
 * members, which is this module's subject. `processes.js` writes and this reads,
 * which is a cleaner seam than the file-size budget alone would justify.
 */
export function listProcessesForConsole(orgId) {
    const db = requireConnection(orgId);

    return listProcesses(db).map((process) => {
        const current = selectCurrentRevision(db, process.id);
        const history = listRevisions(db, process.id);
        // The roadmap's flag, from the same function and the same history, so the
        // views cannot disagree about which processes need a look.
        const review = needsReviewFromRevisions(history);

        return {
            id: process.id,
            name: process.name,
            needsReview: review.needsReview,
            needsReviewReason: review.reason,
            created_at: process.created_at,
            updated_at: process.updated_at,
            current: current
                ? {
                    revision: current.revision,
                    decidedBy: current.decided_by,
                    reasoning: current.reasoning,
                    confidence: current.confidence,
                    adminReasoning: current.admin_reasoning,
                    decided_at: current.created_at,
                    responses: selectResponsesForRevision(db, current.id)
                }
                : null,
            history: history.map((revision) => ({
                revision: revision.revision,
                decidedBy: revision.decided_by,
                reasoning: revision.reasoning,
                confidence: revision.confidence,
                adminReasoning: revision.admin_reasoning,
                isCurrent: revision.is_current === 1,
                decided_at: revision.created_at
            }))
        };
    });
}
