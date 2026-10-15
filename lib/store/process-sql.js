/**
 * Process statements for one organisation: a process is the work and a revision is one grouping
 * judgement about it. Never opens a connection, because it is handed one by the registry.
 *
 * No participant route may read these projections, because a participant who could see where their
 * answer was grouped would write to influence it. See processes.js.
 */
import { nowIso, assertConnection } from './connection-guard.js';

// The membership queries live in `process-membership.js`; re-exported because call sites reach them
// through processSql.
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
 * Inserts a process. A blank name becomes a placeholder rather than being refused, so a missing name
 * does not stop a grouping from being recorded.
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

/** Derived from MAX rather than a count, so a deletion cannot make two revisions share a number. */
export function nextRevision(db, processId) {
    const row = assertConnection(db)
        .prepare('SELECT MAX(revision) AS highest FROM process_revision WHERE process_id = ?')
        .get(processId);

    return (row?.highest ?? 0) + 1;
}

/**
 * Runs `work` inside one transaction, or joins the caller's if there is one. SQLite has no nested BEGIN,
 * so a joining call defers to the enclosing transaction, and a rollback belongs to whoever opened it.
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
        // A failed COMMIT leaves nothing to roll back, and rolling back a finished transaction throws
        // and would mask the original error.
        try {
            connection.exec('ROLLBACK');
        } catch (rollbackErr) {
            console.error(`[store] rollback after a failed write also failed: ${rollbackErr.message}`);
        }
        throw err;
    }
}

/**
 * Adds a revision and makes it current. Clearing the previous current shares one transaction with the
 * insert, because the partial unique index allows only one current revision per process.
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

/** Derived from MAX rather than a count, so a deletion cannot make two scores share a number. */
export function nextScoreRevision(db, revisionId) {
    const row = assertConnection(db)
        .prepare('SELECT MAX(revision_no) AS highest FROM process_score WHERE revision_id = ?')
        .get(revisionId);

    return (row?.highest ?? 0) + 1;
}

/**
 * Adds a weighing and makes it current, clearing the previous current in the same transaction.
 *
 * The number is computed inside the transaction unless one is given, because computed at the call site
 * the `MAX(revision_no)` read sits outside it and two writers could both insert the same number.
 */
export function insertScore(db, { id, revisionId, score, terms, reasoning, revisionNo = null }) {
    const at = nowIso();
    const connection = assertConnection(db);
    let number = revisionNo;

    writeTransaction(db, () => {
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

/**
 * Every score a process has ever had, newest first, across all its revisions: a rejudge makes a new
 * revision whose numbering restarts, so a per-revision list would hide the earlier score.
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
