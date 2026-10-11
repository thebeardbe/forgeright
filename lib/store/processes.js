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

    return timedWrite(orgId, 'recordIdentification', () => {
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

        console.info(
            `[store] identified a response as ${created ? 'a new process' : `process ${process.id}`} ` +
            `in organisation ${orgId} (${checked.confidence} confidence)`
        );

        return { process, revision, created };
    });
}

/**
 * Every process with its current revision, its responses and its history.
 *
 * ONE READ for the console, so a page renders a process completely rather than
 * the view assembling it from four queries and getting the order wrong. The
 * history is included because the spec keeps earlier versions and a reviewer
 * needs to see what changed.
 */
export function listProcessesForConsole(orgId) {
    const db = requireConnection(orgId);

    return processSql.listProcesses(db).map((process) => {
        const current = processSql.selectCurrentRevision(db, process.id);

        return {
            id: process.id,
            name: process.name,
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
                    responses: processSql.selectResponsesForRevision(db, current.id)
                }
                : null,
            history: processSql.listRevisions(db, process.id).map((revision) => ({
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
