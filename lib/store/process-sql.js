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

// RE-EXPORTED SO THE MOVE IS INVISIBLE TO CALLERS. Membership queries live in
// `process-membership.js` now, but six call sites reach them through `processSql`,
// and changing an import path in five files to satisfy a file-size split would be
// churn without benefit. `process-membership.js` is where they are defined.
export {
    linkResponse,
    selectResponsesForRevision,
    selectRevisionIdsForResponse,
    selectCurrentHomeForResponse,
    selectResponsesInTwoCurrentRevisions
} from './process-membership.js';

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
 * Runs `work` inside one transaction, or JOINS the caller's if there is one.
 *
 * NESTING IS THE REASON THIS EXISTS. `insertRevision` and `insertScore` each open
 * their own `BEGIN IMMEDIATE`, and a caller that wraps several statements needs
 * them all inside ONE transaction. SQLite has no nested `BEGIN`: a second one
 * while a transaction is open throws "cannot start a transaction within a
 * transaction". So the helper defers to an enclosing transaction rather than
 * assuming it is the outermost, which is what lets `recordIdentification` wrap
 * its whole sequence without changing how these two behave on their own.
 *
 * The connection reports its state through `isTransaction`, which is how the
 * caller's transaction is detected. A rollback belongs to whoever opened the
 * transaction, so a joining call rethrows and lets the outer frame roll back.
 *
 * @param {object} db
 * @param {Function} work Runs inside the transaction.
 * @returns {*} Whatever `work` returns.
 */
export function writeTransaction(db, work) {
    const connection = assertConnection(db);

    // Already inside a transaction: join it, and let its owner decide the outcome.
    if (connection.isTransaction) return work();

    connection.exec('BEGIN IMMEDIATE');
    try {
        const result = work();
        connection.exec('COMMIT');
        return result;
    } catch (err) {
        // A failed COMMIT leaves nothing to roll back, and rolling back a finished
        // transaction throws and would mask the original error.
        try {
            connection.exec('ROLLBACK');
        } catch (rollbackErr) {
            console.error(`[store] rollback after a failed write also failed: ${rollbackErr.message}`);
        }
        throw err;
    }
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

    writeTransaction(db, () => {
        connection.prepare('UPDATE process_revision SET is_current = 0 WHERE process_id = ? AND is_current = 1')
            .run(processId);
        connection.prepare(
            `INSERT INTO process_revision
             (id, process_id, revision, decided_by, reasoning, confidence, admin_reasoning, is_current, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
        ).run(id, processId, revision, decidedBy, reasoning, confidence, adminReasoning ?? null, at);
    });

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
 *
 * THE NUMBER IS COMPUTED INSIDE THE TRANSACTION, NOT BY THE CALLER, unless one is given. Called
 * at the call site it put the `MAX(revision_no)` READ OUTSIDE this transaction: only the UPDATE
 * and the INSERT were guarded, so two writers could both read 17 and both insert 18 - REPRODUCED
 * with six concurrent OS processes. Nothing broke visibly, because the partial index on
 * `is_current` still allowed exactly one current score, but the numbering was duplicated and
 * `revision_no` orders the version history, so that order became ambiguous.
 *
 * The revision numbering next door never had this: `nextRevision` is called inside
 * `recordIdentification`'s transaction. This brings the scores into line with it.
 */
export function insertScore(db, { id, revisionId, score, terms, reasoning, revisionNo = null }) {
    const at = nowIso();
    const connection = assertConnection(db);
    let number = revisionNo;

    writeTransaction(db, () => {
        // Computed inside the transaction; see the note above.
        if (number === null) number = nextScoreRevision(db, revisionId);

        connection.prepare('UPDATE process_score SET is_current = 0 WHERE revision_id = ? AND is_current = 1')
            .run(revisionId);
        connection.prepare(
            `INSERT INTO process_score
             (id, revision_id, score, terms, reasoning, revision_no, is_current, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
        ).run(id, revisionId, score, JSON.stringify(terms), reasoning, number, at);
    });

    return { id, revision_id: revisionId, score, terms, reasoning, revision_no: number, is_current: 1, created_at: at };
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
