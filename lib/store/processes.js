/**
 * Processes: the store's public interface for workflow 2 identification. A process is the work and a
 * revision is one grouping judgement about it.
 *
 * No participant route may import this module, because a participant who could see where their answer was
 * grouped would write to influence it.
 */
import { requireConnection } from './organisations.js';
import { timedWrite } from './write-timing.js';
import * as processSql from './process-sql.js';
import { writeTransaction } from './process-sql.js';

export { listProcessesForConsole } from './process-membership.js';
import * as sql from './sqlite.js';

/** The confidences a model may report. Validated, so a typo fails loudly. */
export const CONFIDENCE = Object.freeze(['high', 'medium', 'low']);

/** Who decided a revision. */
export const DECIDED_BY = Object.freeze({ MODEL: 'model', ADMIN: 'admin' });

/**
 * Checks a model's identification reply and reports what is wrong with it. A `matches` id that does not
 * exist and a missing reasoning are refused; a missing name is filled with a placeholder.
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

    // Anything other than null must name a process that exists in this organisation's file.
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
        // Recorded as 'low' rather than refused, and never higher.
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
 * Records an identification: joins an existing process or creates one. The whole sequence runs in one
 * transaction, inside the timer, because `timedWrite` provides no atomicity of its own and a crash
 * between the revision and the links would leave a current revision with no members.
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

        // Only when the model supplied one, so a merge does not blank a good name.
        if (!created && checked.name) {
            process = processSql.updateProcessName(db, process.id, checked.name) ?? process;
        }

        // Read before anything is written. The carry-forward below only ever adds the response, so
        // without this a response re-identified elsewhere stays in both processes, counting one person
        // twice and inflating `people`, which is a reward term.
        const home = processSql.selectCurrentHomeForResponse(db, responseId);
        const moving = home !== null && home.processId !== process.id;

        // A revision is a snapshot of the process, not of one response, so the new current revision
        // must cover every response the process already had plus this one.
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

        // Inherited responses keep the fields they contributed.
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

        // The other half of the move, in the same transaction, so membership is never observably in
        // two places or in none. A new revision rather than a deletion, because the history is what
        // lets a reader see what changed.
        const left = moving ? rebuildWithout(db, home, responseId, decidedBy) : null;

        // Checked on every identification, not only on a move, and a violation rolls the whole
        // sequence back.
        assertNoResponseInTwoCurrentRevisions(db, responseId);

        console.info(
            `[store] identified a response as ${created ? 'a new process' : `process ${process.id}`} ` +
            `in organisation ${orgId} (${checked.confidence} confidence)`
        );

        return { process, revision, created, left };
    }));
}

/**
 * Gives a process a new current revision without one response. Returns what the caller needs to report the
 * move, or null when the source had no current revision.
 *
 * `decidedBy` is the caller's and `confidence` is carried forward: hardcoding either lies about the audit
 * trail, and `needsReview` is derived from the confidence.
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
 * Throws when any response sits in two current revisions, which makes both report one person too many.
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
 * The process a response currently belongs to, or null. Not exported, deliberately: a participant path
 * must not be able to ask where an answer was grouped.
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
