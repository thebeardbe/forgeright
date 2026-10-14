/**
 * One rejudge path, two entry points.
 *
 * A rejudge from an answer and one from a process are "two places, not two mechanisms": the subject
 * differs and the path does not. Both re-identify through workflow 2 with the admin's reasoning,
 * then regenerate the score and its paragraph through workflow 3.
 *
 * WHY IT ALWAYS GOES BACK TO WORKFLOW 2, even when the admin disputes the SCORE: a process cannot
 * be reweighed before it is certain what the process is. If the argument shows two processes are
 * one, the thing being weighed has changed, and scoring the old grouping would answer the wrong
 * question with a confident number.
 *
 * BOTH VERSIONS ARE KEPT - re-identification adds a revision, the new weighing adds a score - so
 * the earlier reasoning and paragraph stay readable. The store does that; this module sequences it.
 *
 * AUTOMATIC IDENTIFICATION NOW EXISTS (lib/auth/identify-response.js), which this file's earlier
 * note said to expect before writing. It fires on a COMPLETED round from the participant route, and
 * the repeat-description cost that note predicted is handled by `alreadyIdentified`, which skips a
 * response that already has a current grouping. Nothing here depends on the interview prompt's
 * one-process-per-round rule being obeyed, because nothing enforces it.
 */
import { getResponsesForAnalysis } from '../store/index.js';
import { recordIdentification, listProcessesForConsole } from '../store/processes.js';
import { recordWeighing, listRoadmap } from '../store/weighing.js';
import { runIdentification } from '../../ai/identify-core.js';
import { runWeighing } from '../../ai/weigh-core.js';

/**
 * Every process the model compares against, with the one holding this response LABELLED.
 *
 * ONE HELPER FOR BOTH ENTRY POINTS, which differed only by accident: the answer path included
 * everything and the process path filtered one out - that filter was the defect.
 *
 * THE LABEL COMES FROM `listProcessesForConsole`'s OWN MEMBERSHIP rather than a separate store
 * call, so it cannot disagree with what the console displays.
 *
 * @param {string} orgId
 * @param {string} responseId
 * @returns {Array<{id: string, name: string, reasoning: string|null, isCurrentHome: boolean}>}
 */
function withCurrentHome(orgId, responseId) {
    return listProcessesForConsole(orgId).map((process) => {
        const members = process.current?.responses ?? [];
        return {
            id: process.id,
            name: process.name,
            reasoning: process.current?.reasoning ?? null,
            // True for the process this response is already in, so the model can answer
            // "unchanged" rather than placing it afresh.
            isCurrentHome: members.some((row) => row.responseId === responseId)
        };
    });
}

/**
 * The response a rejudge starts from, by id, or null.
 *
 * FROM `getResponsesForAnalysis`, DELIBERATELY: that accessor omits the invitation join, so a
 * rejudge reads the participant's answers and must not receive the link to who gave them.
 *
 * @param {string} orgId
 * @param {string} responseId
 * @returns {object|null}
 */
function responseById(orgId, responseId) {
    return getResponsesForAnalysis(orgId).find((response) => response.id === responseId) ?? null;
}

/**
 * Re-identifies one response, then reweighs whichever process resulted.
 *
 * @param {object} args
 * @param {string} args.orgId The SESSION's organisation, never a request field.
 * @param {string} args.responseId
 * @param {string} args.adminReasoning The admin's argument. Required.
 * @param {string} [args.lang]
 * @returns {Promise<{process: object, revision: object, score: object|null, weighed: boolean, note: string}>}
 * @throws {Error} When the argument is empty, the response is unknown, or the model
 *   refuses or returns something unusable. The caller renders the message.
 */
export async function rejudgeFromResponse({ orgId, responseId, adminReasoning, lang = 'en' }) {
    const reason = requireReasoning(adminReasoning);

    const response = responseById(orgId, responseId);
    if (!response) {
        throw new Error('That answer is not in this organisation.');
    }

    // The processes the model compares against, with their reasoning, exactly as the first
    // identification runs - PLUS the response's current home, labelled. The list is already
    // complete here; the label is what tells the model that one of these candidates is where the
    // response already is, so "the argument changes nothing" is an answer it can give.
    const known = withCurrentHome(orgId, responseId);

    const reply = await runIdentification({ response, knownProcesses: known, lang, adminReasoning: reason });
    assertUsable(reply, 'identification');

    // DECIDED_BY.ADMIN and the admin's own words are recorded, so a reader can see
    // which revisions a person asked for and what they argued.
    const identified = recordIdentification({
        orgId,
        responseId,
        reply,
        adminReasoning: reason,
        decidedBy: 'admin'
    });

    const weighed = await reweighProcess({
        orgId,
        processId: identified.process.id,
        adminReasoning: reason,
        lang
    });

    // THE OTHER SIDE OF A MOVE. The process the response left has a new current
    // revision with one member fewer, and ITS score is keyed on the revision, so the
    // old number no longer describes what is there. It is reweighed too, and a failure
    // here does not undo anything: the membership is committed and the source is left
    // with no score, which the roadmap already renders as "not weighed".
    const left = await reweighLeft({ orgId, left: identified.left, lang });

    return { ...identified, ...weighed, ...left };
}

/**
 * Re-identifies one process's membership, then reweighs it.
 *
 * THE PROCESS ENTRY POINT. It picks the process's own first response as the subject, because
 * identification is about a response joining or leaving: asking the model to "reconsider the
 * process" with no response to compare gives it nothing to decide on.
 *
 * @param {object} args
 * @param {string} args.orgId
 * @param {string} args.processId
 * @param {string} args.adminReasoning
 * @param {string} [args.lang]
 * @returns {Promise<{process: object, revision: object, score: object|null, weighed: boolean, note: string}>}
 */
export async function rejudgeFromProcess({ orgId, processId, adminReasoning, lang = 'en' }) {
    const reason = requireReasoning(adminReasoning);

    const process = listProcessesForConsole(orgId).find((entry) => entry.id === processId);
    if (!process) {
        throw new Error('That process is not in this organisation.');
    }

    const subject = process.current?.responses?.[0];
    if (!subject) {
        // A REAL STATE, NOT A DATA FAULT: a move that takes a process's last member deliberately
        // leaves it with an empty current revision, because an admin's rejudge should not delete a
        // process they might still be discussing. The roadmap renders that, so this refusal is the
        // honest answer for a legitimate process.
        throw new Error(
            'That process has no answers behind it, so there is nothing to re-identify. ' +
            'Everyone who described it has since been regrouped elsewhere.'
        );
    }

    // The response is read through the attribution-free accessor, as above.
    const response = responseById(orgId, subject.responseId);
    if (!response) {
        throw new Error('The answer behind that process could not be read.');
    }

    // THE PROCESS UNDER REVIEW IS INCLUDED AND NAMED AS THE RESPONSE'S CURRENT HOME.
    //
    // IT USED TO BE EXCLUDED, which made every rejudge look like it had broken the process: in the
    // ordinary case that leaves the list EMPTY, and `buildComparisonMessage` then says "(none yet,
    // so this is a new process)". MEASURED on the deployed instance - the model created one and
    // said so, and the process under review was left with `0` members.
    //
    // A MERGE ELSEWHERE STILL WORKS: every other process is a candidate too, so including this one
    // adds a candidate rather than removing the others.
    const known = withCurrentHome(orgId, subject.responseId);

    const reply = await runIdentification({ response, knownProcesses: known, lang, adminReasoning: reason });
    assertUsable(reply, 'identification');

    const identified = recordIdentification({
        orgId,
        responseId: subject.responseId,
        reply,
        adminReasoning: reason,
        decidedBy: 'admin'
    });

    const weighed = await reweighProcess({
        orgId,
        processId: identified.process.id,
        adminReasoning: reason,
        lang
    });

    // Same second side as above: the process this response left must be reweighed,
    // because its member count changed and its current revision is new.
    const left = await reweighLeft({ orgId, left: identified.left, lang });

    return { ...identified, ...weighed, ...left };
}

/**
 * Reweighs the process a response LEFT, and reports what happened to the admin.
 *
 * A MOVE INVALIDATES THE SOURCE'S SCORE AND LEAVES NO STALE ONE. The score is keyed on the
 * revision and the move writes a new revision for the source, so there is simply no score for it:
 * the roadmap shows "not weighed", which is honest and VISIBLE where a stale number would not be.
 * A failure here is therefore a note rather than a throw - the move is committed and correct, and
 * discarding it would lose the only effect the admin's argument had.
 *
 * @returns {Promise<{moved: object|null, leftWeighed: boolean, leftNote: string}>}
 */
async function reweighLeft({ orgId, left, lang }) {
    if (!left) return { moved: null, leftWeighed: false, leftNote: '' };

    const weighed = await reweighProcess({ orgId, processId: left.id, lang });
    if (weighed.weighed) {
        return { moved: left, leftWeighed: true, leftNote: '' };
    }

    // THE WHY, AND ONLY THE WHY. The notice already says the process it left now
    // has no score; repeating that here produced a sentence that said the same thing
    // twice. `reweighProcess`'s note names the reason, which is the part a reader
    // cannot infer from the sentence above it.
    console.error(`[rejudge] the move was recorded but the process it left could not be reweighed: ${weighed.note}`);
    return { moved: left, leftWeighed: false, leftNote: weighed.note };
}

/**
 * Weighs a process's current grouping and records the result.
 *
 * A WEIGHING FAILURE DOES NOT UNDO THE RE-IDENTIFICATION: the grouping is stored by the time this
 * runs, so the honest outcome is a new grouping with no new score and a note saying so. Discarding
 * the identification would lose the admin's argument's only effect.
 *
 * @returns {Promise<{score: object|null, weighed: boolean, note: string}>}
 */
export async function reweighProcess({ orgId, processId, adminReasoning, lang }) {
    const entry = listRoadmap(orgId).find((process) => process.id === processId);
    if (!entry || !entry.grouping) {
        return { score: null, weighed: false, note: 'The process was regrouped, but has no grouping to weigh.' };
    }

    const reply = await runWeighing({
        process: { id: entry.id, name: entry.name },
        grouping: entry.grouping,
        lang,
        adminReasoning
    });

    if (reply.status === 'error' || reply.status === 'rejected') {
        console.error(`[rejudge] regrouping succeeded but the weighing failed: ${reply.reason ?? reply.status}`);
        return {
            score: null,
            weighed: false,
            // NOT "the previous one stands". The score is keyed on the revision id
            // and this regrouping wrote a NEW revision, so there is no previous score
            // for the current grouping: the process is simply unscored. The old number
            // survives in the history, attached to the revision it was computed for,
            // and the roadmap shows "not weighed". An earlier version of this note
            // claimed the old score stood, which was wrong and would have had an admin
            // reading a missing number as an unchanged one.
            note: 'The regrouping was recorded. The new score could not be produced, so this process now has no score.'
        };
    }

    try {
        const { score } = recordWeighing({ orgId, processId, reply });
        return { score, weighed: true, note: 'Regrouped and reweighed.' };
    } catch (err) {
        // A validation refusal here means the model's reply was unusable. Logged with
        // the reason, because the admin needs to know why the number did not move.
        console.error(`[rejudge] regrouping succeeded but the weighing was refused: ${err.message}`);
        return {
            score: null,
            weighed: false,
            note: `The regrouping was recorded. The new score was refused, so this process now has no score: ${err.message}`
        };
    }
}

/** The admin's argument is required, and empty is not an argument. */
function requireReasoning(adminReasoning) {
    if (typeof adminReasoning !== 'string' || adminReasoning.trim() === '') {
        throw new Error('A rejudge needs a reason: explain why the current result looks wrong.');
    }
    return adminReasoning.trim();
}

/** A model reply that failed is turned into a thrown error naming which step. */
function assertUsable(reply, step) {
    if (reply && (reply.status === 'error' || reply.status === 'rejected')) {
        throw new Error(`${step} could not be completed: ${reply.reason ?? reply.content ?? reply.status}`);
    }
}
