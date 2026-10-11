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

/**
 * Whether a process was BORN from an unsure split, and nobody has settled it since.
 *
 * IT IS ABOUT THE PROCESS, NOT ITS NEWEST REVISION. An earlier version of this
 * function looked only at the current revision, and that answered the wrong
 * question in both directions:
 *
 *   - A low-confidence MERGE was flagged, and described as a split. The revision is
 *     a merge; the tag said "split while unsure". A reader chased a split that did
 *     not exist and missed the merge that did.
 *   - An ordinary merge CLEARED the flag. A second participant joining a process
 *     does not answer whether that process should have existed as its own entry, so
 *     the flag went off while the question stayed open. That was the worse of the
 *     two: it is the only mechanism the unsure-split path has for being noticed.
 *
 * SO THE HISTORY IS SCANNED. Flagged when the FIRST revision is a model-decided
 * low-confidence CREATION and no LATER revision is admin-decided.
 *
 * WHY THE FIRST REVISION IS THE CREATION, which is the part that has to be right:
 * `nextRevision` is `MAX(revision) + 1` for the process, so revision 1 is the first
 * write this process ever had and there was no previous revision to carry forward
 * from. Every later revision in this codebase carries a member set forward:
 * `recordIdentification` copies the previous current revision's responses, and
 * `rebuildWithout` copies the ones that stayed. A revision that carries members
 * forward is a merge or a move, never a creation, so nothing later can be the
 * creation this looks for. Verified against the four writers (create, merge,
 * in-place rejudge, move) rather than assumed.
 *
 * LIMITED BY CONSTRUCTION, AND HONESTLY SO: this reads a creation from position
 * rather than from a stored marker, so it holds only while revision 1 is the first
 * write. A future path that created a process any other way, or that rewrote
 * history, would need this to store a marker instead. There is no such path today
 * and no such column, which is why nothing is stored: a stored flag needs clearing
 * code, and clearing code is where a flag goes stale.
 *
 * THE DELETE ROUTE STAYS OPEN, AND IS A RECORDED LIMIT RATHER THAN A GAP. Nothing
 * in the codebase deletes a revision, which is what makes the assumption hold, but
 * a DELETE would let a later revision take number 1 and this would read the wrong
 * revision as the creation. `idx_process_revision_number` does not close that: a
 * deleted row frees its number for reuse. Enforcing it would need a rule about
 * whether history may be rewritten at all, which is a product question rather than
 * an index. A test asserts that no code deletes a revision, which is the property
 * that keeps this true.
 *
 * CLEARING IS A PERSON'S DECISION, nothing else, and it happens ONE REVIEW PER
 * PROCESS. An ADMIN revision anywhere later in the history clears the flag, because
 * a person has now looked at this process and settled it.
 *
 * A MODEL REVISION DOES NOT SETTLE IT, IN EITHER DIRECTION, and both directions
 * matter:
 *
 *   - it does NOT clear the flag. A merge, a re-split or a move performed by the
 *     model leaves the original question exactly where it was, because "should this
 *     be its own process" is not answered by more work arriving in it.
 *   - it does NOT RE-OPEN the flag either. Once an admin revision has settled a
 *     process, a later low-confidence model revision on top of it does not flag it
 *     again: the person's review stands. This was stated as an assumption in a
 *     commit message ("a re-split while still unsure stays flagged") and the code
 *     has never done that, correctly. The rule is one review per process, so the
 *     contract is written here rather than left to the message.
 *
 * So the flag is on exactly when the process was born from an unsure split AND no
 * admin revision has happened since, at any revision number.
 *
 * `decided_by !== 'admin'` rather than `=== 'model'`: a third decider would be a
 * decision nobody has reviewed, which is the case this flag is for, so anything
 * unrecognised keeps the flag ON rather than silently off.
 *
 * THE FLAG NEVER RE-RANKS ANYTHING. `listRoadmap`'s order is decided by the score,
 * and a flagged process sorts exactly where its number puts it.
 *
 * Pure, and given the revisions rather than a connection, so the rule can be tested
 * without a database.
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
