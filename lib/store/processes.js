/**
 * Processes: the store's public interface for workflow 2 identification.
 *
 * A process is the WORK; a revision is one grouping judgement about it. The model
 * proposes a grouping, the code validates the shape and stores it, and an admin
 * can later ask for a rejudge that adds a revision rather than overwriting one.
 *
 * NOTHING HERE IS REACHABLE BY A PARTICIPANT, and that is deliberate. A
 * participant who could see where their answer was grouped would write to
 * influence it, so no participant route imports this module and none should. The
 * one function that could tempt a caller, `groupedProcessForResponse`, is not
 * exported; the console path does not need it and the participant path must not
 * have it.
 *
 * KEYED BY ORGANISATION, like the rest of the store: every function takes an
 * orgId first, and the connection it resolves is already scoped to one file.
 */
import { requireConnection } from './organisations.js';
import { timedWrite } from './write-timing.js';
import * as processSql from './process-sql.js';
import { writeTransaction } from './process-sql.js';
import { needsReviewFromRevision } from './process-membership.js';

// RE-EXPORTED: the pinned five names on this module are unchanged, and every caller
// still reaches the read through `processes.js`. It is defined in
// `process-membership.js` now, with the other membership reads.
export { listProcessesForConsole } from './process-membership.js';
import * as sql from './sqlite.js';

/** The confidences a model may report. Validated, so a typo fails loudly. */
export const CONFIDENCE = Object.freeze(['high', 'medium', 'low']);

/** Who decided a revision. */
export const DECIDED_BY = Object.freeze({ MODEL: 'model', ADMIN: 'admin' });

/**
 * Checks a model's identification reply and reports what is wrong with it.
 *
 * EXPORTED SO THE CALLER CAN FAIL CLEARLY RATHER THAN STORE SOMETHING WRONG. The
 * two failures that matter:
 *
 *   - a `matches` id that does not exist. Accepting it would create a link to
 *     nothing, and the process it claimed to join would silently not gain this
 *     response.
 *   - no reasoning. The spec says the reasoning is the only way this step can be
 *     reviewed and is the thing no test can fully pin, so a grouping without it is
 *     not a usable result.
 *
 * A missing NAME is NOT a failure: it is filled with a placeholder, because the
 * reasoning is what a reader needs and a blank name should not lose a grouping.
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

    // `matches` null means a new process, which is the normal case for the first
    // response. Anything else must name a process that exists HERE: an id from
    // another organisation cannot be idempotent with a lookup scoped to this file,
    // so a valid-looking stranger is refused rather than linked.
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
        // A missing confidence is allowed with a warning rather than refused: it is
        // a label for a reader, not the decision, and losing a whole grouping over
        // it would be the wrong trade. It is stored as 'low' so it cannot read as
        // more certain than it is.
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
 * Records an identification: joins an existing process or creates one.
 *
 * THE ONE ENTRY POINT, so the transaction-like sequence (find or create the
 * process, add the revision, link the responses) exists once rather than being
 * assembled by each caller.
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

    // The response must exist in THIS organisation, or the link would point at
    // nothing. Checked before anything is written.
    if (!sql.responseExists(db, responseId)) {
        throw new Error(`Cannot identify response ${JSON.stringify(responseId)}: it is not in organisation ${orgId}.`);
    }

    const knownIds = processSql.listProcesses(db).map((p) => p.id);
    const checked = validateIdentification(reply, knownIds);
    if (!checked.ok) {
        throw new Error(`Refusing an identification: ${checked.reason}.`);
    }

    // ONE TRANSACTION OVER THE WHOLE SEQUENCE, inside the timer. Without it the
    // steps are separate writes: insert the process, insert the revision (its own
    // transaction), then link each response. A crash between the revision and the
    // links left a CURRENT REVISION WITH NO MEMBERS, which renders as a process
    // with nothing behind it and no way to tell it apart from a process whose
    // responses were never linked. `timedWrite` only times the write and reports
    // lock errors, so it provides no atomicity on its own.
    //
    // `insertRevision` opens its own transaction; `writeTransaction` detects the
    // enclosing one and joins it rather than nesting, which SQLite refuses.
    return timedWrite(orgId, 'recordIdentification', () => writeTransaction(db, () => {
        let process;
        let created = false;

        if (checked.matchId) {
            process = processSql.selectProcessById(db, checked.matchId);
        } else {
            process = processSql.insertProcess(db, { id: sql.newId(), name: checked.name });
            created = true;
        }

        // A rejudge or a later grouping may refine the name. Only when the model
        // supplied one, so a merge does not blank a name that was already good.
        if (!created && checked.name) {
            process = processSql.updateProcessName(db, process.id, checked.name) ?? process;
        }

        // WHERE THE RESPONSE COMES FROM, read before anything is written.
        //
        // A RESPONSE CAN MOVE, and the process it LEFT has to be told. The
        // carry-forward below only ever ADDS the response to a process; nothing
        // removed it from the one it was in, so a response re-identified into a
        // different process stayed in both. One person then counted in two roadmap
        // entries, and the participant count sent to the model was inflated on both,
        // which matters because `people` is a REWARD term: both entries scored too
        // high. The console never showed it, because view 1 keys groupings by
        // response id and the later-created process silently overwrote the other.
        //
        // Read here rather than from the carried list, because the source is a
        // different process and its members are not this revision's business.
        const home = processSql.selectCurrentHomeForResponse(db, responseId);
        const moving = home !== null && home.processId !== process.id;

        // WHICH RESPONSES THIS REVISION COVERS.
        //
        // A REVISION IS A SNAPSHOT OF THE PROCESS, not a record of one response.
        // When a response joins an existing process, the new current revision has
        // to cover every response the process already had PLUS this one, or the
        // earlier responses fall out of "the responses behind this process" and
        // the console reports a merge that lost the work it merged. That is a real
        // defect this code had: two responses merged into one process, and the
        // console showed one response behind it.
        //
        // So the previous current revision's membership is carried forward. A
        // REJUDGE does the same thing, which is what keeps an admin's correction
        // from discarding the other participants of a merged process.
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

        // The inherited responses keep the fields THEY contributed, which is not
        // this response's list. Copying this one's list onto them would say the new
        // participant supplied the trigger when the earlier one did.
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

        // THE OTHER HALF OF THE MOVE. The source process gets a new current revision
        // covering its previous members MINUS the one that left, in this same
        // transaction, so membership is never observably in two places or in none.
        //
        // A NEW REVISION RATHER THAN A DELETION: a revision is an immutable snapshot
        // and the history is what lets a reader see what changed, so removing a row
        // from the old revision would rewrite history. The source is left as a
        // PROCESS WITH NOTHING BEHIND IT when the moved response was its only member,
        // which is deliberate: an admin's rejudge should not delete a process they
        // might still be discussing. The roadmap says so on the screen.
        const left = moving ? rebuildWithout(db, home, responseId) : null;

        // THE INVARIANT, CHECKED WHERE IT CAN BE ENFORCED. Called on every
        // identification rather than only on a move, because a move is not the only
        // way it could break, and because a check that runs only on the path that
        // was wrong is a check that stops looking. A violation throws, and the
        // enclosing transaction rolls the whole sequence back.
        assertNoResponseInTwoCurrentRevisions(db, responseId);

        console.info(
            `[store] identified a response as ${created ? 'a new process' : `process ${process.id}`} ` +
            `in organisation ${orgId} (${checked.confidence} confidence)`
        );

        return { process, revision, created, left };
    }));
}

/**
 * Gives a process a new current revision without one response.
 *
 * Returns what the caller needs to report the move, or null when the source had no
 * current revision (which would be a data fault rather than a move).
 *
 * @param {object} db
 * @param {{processId: string, processName: string, revisionId: string}} home
 * @param {string} responseId The response that left.
 * @returns {{id: string, name: string} | null}
 */
function rebuildWithout(db, home, responseId) {
    const members = processSql.selectResponsesForRevision(db, home.revisionId)
        .filter((member) => member.responseId !== responseId);

    const revision = processSql.insertRevision(db, {
        id: sql.newId(),
        processId: home.processId,
        revision: processSql.nextRevision(db, home.processId),
        // The revision that remains is still the grouping the admin last approved,
        // so its reasoning and confidence carry forward. The move is not a new
        // judgement about the source, it is the same judgement with one member less.
        decidedBy: DECIDED_BY.MODEL,
        reasoning: `A response was regrouped elsewhere, so this revision no longer covers it.`,
        confidence: 'high'
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
 * Throws when any response sits in two current revisions.
 *
 * The count is the thing that goes wrong: a response behind two processes makes
 * both report one more person than they have, and the weighing prompt is told
 * "described by N participants". This asserts the invariant after every
 * identification rather than trusting the move logic to be right.
 *
 * @param {object} db
 * @param {string} responseId The response this call touched, named in the error so
 *   the fault is identifiable from the log without a database session.
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
 * The process a response currently belongs to, or null.
 *
 * NOT EXPORTED, deliberately. It is the one function that would let a participant
 * path ask "where was my answer grouped?", which the spec forbids because people
 * would write to influence it. Keeping it private means a route cannot reach it
 * without deliberately reopening this decision.
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
