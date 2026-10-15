/**
 * Processes: the store's public interface for workflow 2 identification.
 *
 * A process is the work; a revision is one grouping judgement about it. The model proposes a
 * grouping, the code validates the shape and stores it, and an admin can later ask for a rejudge
 * that adds a revision rather than overwriting one.
 *
 * Nothing here is reachable by a participant, and that is deliberate: a participant who could see
 * where their answer was grouped would write to influence it, so no participant route imports this
 * module. Every function takes an org id first, like the rest of the store.
 */
import { requireConnection } from './organisations.js';
import { timedWrite } from './write-timing.js';
import * as processSql from './process-sql.js';
import { writeTransaction } from './process-sql.js';

// Re-exported so every caller still reaches the read through this module; it is defined in
// `process-membership.js` with the other membership reads.
export { listProcessesForConsole } from './process-membership.js';
import * as sql from './sqlite.js';

/** The confidences a model may report. Validated, so a typo fails loudly. */
export const CONFIDENCE = Object.freeze(['high', 'medium', 'low']);

/** Who decided a revision. */
export const DECIDED_BY = Object.freeze({ MODEL: 'model', ADMIN: 'admin' });

/**
 * Checks a model's identification reply and reports what is wrong with it, so the caller can fail
 * clearly rather than store something wrong.
 *
 * A `matches` id that does not exist is refused, because accepting it would link to nothing and the
 * process it claimed to join would silently not gain this response. No reasoning is refused, because
 * the spec says the reasoning is the only way this step can be reviewed. A missing name is not a
 * failure: it is filled with a placeholder, because a blank name should not lose a grouping.
 *
 * @param {object} reply The model's parsed reply.
 * @param {Array<string>} knownProcessIds The ids that exist in this organisation.
 * @returns {{ok: true, matchId: string|null, confidence: string, reasoning: string, name: string|null, contributed: string[]}
 *   | {ok: false, reason: string}}
 */
export function validateIdentification(reply, knownProcessIds) {
    if (!reply || typeof reply !== 'object' || Array.isArray(reply)) {
        return { ok: false, reason: 'the reply is not an object' };
    }

    const reasoning = reply.reasoning;
    if (typeof reasoning !== 'string' || reasoning.trim() === '') {
        return { ok: false, reason: 'no reasoning was given, and a grouping cannot be reviewed without it' };
    }

    // `matches` null means a new process. Anything else must name a process that exists here: a
    // lookup scoped to this file cannot match an id from another organisation.
    let matchId = null;
    if (reply.matches !== null && reply.matches !== undefined && reply.matches !== '') {
        if (typeof reply.matches !== 'string') {
            return { ok: false, reason: `"matches" must be a process id or null, got ${typeof reply.matches}` };
        }
        if (!knownProcessIds.includes(reply.matches)) {
            return { ok: false, reason: `"matches" names process ${JSON.stringify(reply.matches)}, which does not exist here` };
        }
        matchId = reply.matches;
    }

    const confidence = reply.confidence;
    if (!CONFIDENCE.includes(confidence)) {
        // A missing confidence is a label for a reader rather than the decision, so it is recorded
        // as 'low' with a warning instead of losing the whole grouping, and 'low' cannot read as more
        // certain than it is.
        console.warn(
            `[store] identification reported confidence ${JSON.stringify(confidence)}, ` +
            `expected one of ${CONFIDENCE.join(', ')}; recording it as "low".`
        );
        return {
            ok: true,
            matchId,
            confidence: 'low',
            reasoning: reasoning.trim(),
            name: normaliseName(reply.name),
            contributed: normaliseContributed(reply.contributed)
        };
    }

    return {
        ok: true,
        matchId,
        confidence,
        reasoning: reasoning.trim(),
        name: normaliseName(reply.name),
        contributed: normaliseContributed(reply.contributed)
    };
}

/** A name, trimmed, or null when absent. */
function normaliseName(name) {
    if (typeof name !== 'string' || name.trim() === '') return null;
    return name.trim();
}

/** Field names the response contributed, as a list of non-empty strings. */
function normaliseContributed(contributed) {
    if (!Array.isArray(contributed)) return [];
    return contributed.filter((field) => typeof field === 'string' && field.trim() !== '');
}

/**
 * Records an identification: joins an existing process or creates one. The one entry point, so the
 * sequence (find or create the process, add the revision, link the responses) exists once rather
 * than being assembled by each caller.
 *
 * The whole sequence runs in one transaction, inside the timer: without it a crash between the
 * revision and the links leaves a current revision with no members, which renders as a process with
 * nothing behind it. `timedWrite` only times the write and reports lock errors, so it provides no
 * atomicity on its own; `insertRevision` opens its own transaction, and `writeTransaction` detects
 * the enclosing one and joins it rather than nesting, which SQLite refuses.
 *
 * @param {object} args
 * @param {string} args.orgId
 * @param {object} args.reply The model's identification reply, already parsed.
 * @param {string} args.responseId The response being identified.
 * @param {string} [args.adminReasoning] Set when an admin asked for a rejudge.
 * @param {string} [args.decidedBy] DECIDED_BY.MODEL or DECIDED_BY.ADMIN.
 * @returns {{process: object, revision: object, created: boolean}}
 * @throws {Error} When the reply is unusable, naming what is wrong.
 */
export function recordIdentification({ orgId, reply, responseId, adminReasoning = null, decidedBy = DECIDED_BY.MODEL }) {
    if (!Object.values(DECIDED_BY).includes(decidedBy)) {
        throw new Error(`Unknown decidedBy ${JSON.stringify(decidedBy)}; expected ${Object.values(DECIDED_BY).join(' or ')}.`);
    }

    const db = requireConnection(orgId);

    // The response must exist in this organisation, or the link would point at nothing.
    if (!sql.responseExists(db, responseId)) {
        throw new Error(`Cannot identify response ${JSON.stringify(responseId)}: it is not in organisation ${orgId}.`);
    }

    const knownIds = processSql.listProcesses(db).map((p) => p.id);
    const checked = validateIdentification(reply, knownIds);
    if (!checked.ok) {
        throw new Error(`Refusing an identification: ${checked.reason}.`);
    }

    return timedWrite(orgId, 'recordIdentification', () => writeTransaction(db, () => {
        let process;
        let created = false;

        if (checked.matchId) {
            process = processSql.selectProcessById(db, checked.matchId);
        } else {
            process = processSql.insertProcess(db, { id: sql.newId(), name: checked.name });
            created = true;
        }

        // A rejudge or a later grouping may refine the name, but only when the model supplied one,
        // so a merge does not blank a name that was already good.
        if (!created && checked.name) {
            process = processSql.updateProcessName(db, process.id, checked.name) ?? process;
        }

        // Read before anything is written: the process the response came from has to be told, because
        // the carry-forward below only ever adds the response and nothing removes it from the process
        // it was in. A response re-identified elsewhere would otherwise stay in both, counting one
        // person in two roadmap entries and inflating `people`, which is a reward term.
        const home = processSql.selectCurrentHomeForResponse(db, responseId);
        const moving = home !== null && home.processId !== process.id;

        // A revision is a snapshot of the process, not a record of one response, so the new current
        // revision has to cover every response the process already had plus this one; otherwise the
        // earlier responses fall out of "the responses behind this process" and the console reports a
        // merge that lost the work it merged. A rejudge does the same, which keeps an admin's
        // correction from discarding the other participants of a merged process.
        const previous = created ? null : processSql.selectCurrentRevision(db, process.id);
        const carried = previous ? processSql.selectResponsesForRevision(db, previous.id) : [];

        const revision = processSql.insertRevision(db, {
            id: sql.newId(),
            processId: process.id,
            revision: processSql.nextRevision(db, process.id),
            decidedBy,
            reasoning: checked.reasoning,
            confidence: checked.confidence,
            adminReasoning
        });

        // The inherited responses keep the fields they contributed, not this response's list.
        for (const carriedResponse of carried) {
            if (carriedResponse.responseId === responseId) continue;
            processSql.linkResponse(db, {
                id: sql.newId(),
                revisionId: revision.id,
                responseId: carriedResponse.responseId,
                contributed: carriedResponse.contributed
            });
        }

        processSql.linkResponse(db, {
            id: sql.newId(),
            revisionId: revision.id,
            responseId,
            contributed: checked.contributed
        });

        // The other half of the move: the source process gets a new current revision covering its
        // previous members minus the one that left, in this same transaction, so membership is never
        // observably in two places or in none. A new revision rather than a deletion, because a
        // revision is an immutable snapshot and the history is what lets a reader see what changed.
        const left = moving ? rebuildWithout(db, home, responseId, decidedBy) : null;

        // The invariant is checked on every identification rather than only on a move, because a move
        // is not the only way it could break; a violation throws and the enclosing transaction rolls
        // the whole sequence back.
        assertNoResponseInTwoCurrentRevisions(db, responseId);

        console.info(
            `[store] identified a response as ${created ? 'a new process' : `process ${process.id}`} ` +
            `in organisation ${orgId} (${checked.confidence} confidence)`
        );

        return { process, revision, created, left };
    }));
}

/**
 * Gives a process a new current revision without one response, returning what the caller needs to
 * report the move, or null when the source had no current revision (a data fault rather than a move).
 *
 * The source's own revision is read rather than invented, so the revision that remains is the same
 * grouping with one member fewer. `decidedBy` is the caller's and must not be forced to MODEL, or a
 * move an admin asked for writes a model-decided source revision and the audit trail lies.
 * `confidence` is carried forward and must not be hardcoded, or a move silently upgrades a
 * low-confidence grouping, and `needsReview` is derived from exactly that value.
 *
 * @param {object} db
 * @param {{processId: string, processName: string, revisionId: string}} home
 * @param {string} responseId The response that left.
 * @returns {{id: string, name: string} | null}
 */
function rebuildWithout(db, home, responseId, decidedBy) {
    const members = processSql.selectResponsesForRevision(db, home.revisionId)
        .filter((member) => member.responseId !== responseId);

    const previous = processSql.selectCurrentRevision(db, home.processId);

    const revision = processSql.insertRevision(db, {
        id: sql.newId(),
        processId: home.processId,
        revision: processSql.nextRevision(db, home.processId),
        decidedBy,
        reasoning: 'A response was regrouped elsewhere, so this revision no longer covers it.',
        confidence: previous ? previous.confidence : 'high'
    });

    for (const member of members) {
        processSql.linkResponse(db, {
            id: sql.newId(),
            revisionId: revision.id,
            responseId: member.responseId,
            contributed: member.contributed
        });
    }

    return { id: home.processId, name: home.processName };
}

/**
 * Throws when any response sits in two current revisions. The count is the thing that goes wrong: a
 * response behind two processes makes both report one more person than they have, and the weighing
 * prompt is told "described by N participants".
 *
 * @param {object} db
 * @param {string} responseId The response this call touched, named in the error so the fault is
 *   identifiable from the log without a database session.
 */
function assertNoResponseInTwoCurrentRevisions(db, responseId) {
    const doubled = processSql.selectResponsesInTwoCurrentRevisions(db);
    if (doubled.length === 0) return;

    const named = doubled.map((row) => `${row.responseId} (${row.processes})`).join('; ');
    throw new Error(
        `Refusing to record an identification: ${doubled.length} response(s) are in more than one ` +
        `current revision, which counts one person twice. This identification touched ${responseId}. ` +
        `Affected: ${named}.`
    );
}


/**
 * The process a response currently belongs to, or null. Not exported, deliberately: it would let a
 * participant path ask where an answer was grouped, which the spec forbids because people would
 * write to influence it, so a route cannot reach it without reopening this decision.
 *
 * @param {object} db
 * @param {string} responseId
 * @returns {object|null}
 */
function groupedProcessForResponse(db, responseId) {
    for (const revisionId of processSql.selectRevisionIdsForResponse(db, responseId)) {
        const row = db.prepare(
            'SELECT process_id FROM process_revision WHERE id = ? AND is_current = 1'
        ).get(revisionId);
        if (row) return processSql.selectProcessById(db, row.process_id);
    }
    return null;
}
