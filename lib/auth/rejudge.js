/**
 * One rejudge path, two entry points.
 *
 * The spec is explicit that a rejudge from an answer and a rejudge from a process
 * are "two places, not two mechanisms": the subject differs, the path does not.
 *
 *   from an ANSWER   "this answer was read wrong"
 *   from a PROCESS   "this flow is wrong"
 *         |
 *         v
 *     workflow 2 re-identifies, with the admin's reasoning
 *     workflow 3 regenerates the score and its paragraph
 *
 * WHY IT ALWAYS GOES BACK TO WORKFLOW 2, even when the admin is disputing the
 * SCORE: a process cannot be reweighed before it is certain what the process is.
 * If the admin's argument shows that two processes are one, or that one is two,
 * then the thing being weighed has changed, and scoring the old grouping would
 * answer the wrong question with a confident number.
 *
 * BOTH VERSIONS ARE KEPT. Re-identification adds a revision and the new weighing
 * adds a score, so the earlier reasoning and the earlier paragraph stay readable.
 * The store already does this; this module only sequences it.
 *
 * ===========================================================================
 * WHEN IDENTIFICATION BECOMES AUTOMATIC, READ THIS FIRST
 * ===========================================================================
 *
 * TODAY A NEW ROUND IS IDENTIFIED ONLY WHEN THIS MODULE IS INVOKED, by an admin
 * rejudging an answer or a process, or by a seed run. Nothing identifies a completed
 * round on its own, and that is why the rule below costs nothing yet.
 *
 * THE RULE IT WOULD COST SOMETHING AGAINST: the interview prompt requires `processes`
 * in a reply to hold THE PROCESS BEING WORKED ON NOW, not every process of the
 * interview - a process that is complete is recorded and the conversation starts again
 * for the next one. That instruction is PROSE, not a mechanism: the server stores the
 * payload as it arrives and cannot tell which process in a growing array is the new
 * one. There is no stable process id, deliberately: see the note in
 * ai/audit-core.js and the discussion it came from.
 *
 * SO A COMPLETED ROUND WHOSE PAYLOAD CARRIES AN ALREADY-IDENTIFIED PROCESS WILL BE
 * IDENTIFIED AGAIN, one model call per repeated process, growing with each round. That
 * is a COST, not a wrong answer: `recordIdentification` merges two descriptions of the
 * same work into one process, so the roadmap stays correct. It is invisible today
 * because no completed round is identified automatically.
 *
 * A PIPELINE THAT IDENTIFIES EVERY COMPLETED ROUND must therefore expect repeat
 * descriptions of processes it has already seen, and must not assume one round holds
 * one new process. THE OBVIOUS CHEAP GUARD, when somebody writes it, is to skip a round
 * whose processes all merge into existing ones with high confidence - but that is a
 * decision to make then, with the merger's behaviour in front of you, rather than to
 * guess at here. What must not happen is that this pipeline is written on the
 * assumption that the prompt is obeyed, because nothing enforces it.
 */
import { getResponsesForAnalysis } from '../store/index.js';
import { recordIdentification, listProcessesForConsole } from '../store/processes.js';
import { recordWeighing, listRoadmap } from '../store/weighing.js';
import { runIdentification } from '../../ai/identify-core.js';
import { runWeighing } from '../../ai/weigh-core.js';

/**
 * Every process the model compares against, with the one holding this response LABELLED.
 *
 * ONE HELPER FOR BOTH ENTRY POINTS, because they need the same list and differed only by accident:
 * the answer path included everything, the process path filtered one out - and that filter was
 * the defect. A single builder means they cannot disagree again about what the model is shown.
 *
 * THE LABEL IS DERIVED FROM `listProcessesForConsole`'s OWN MEMBERSHIP rather than a separate
 * store call, so it cannot disagree with what the console displays: the same rows are read, with
 * `current.responses[].responseId` naming the members.
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
 * FROM `getResponsesForAnalysis`, DELIBERATELY, because that is the accessor that
 * omits the invitation join: a rejudge reads the participant's answers and must not
 * receive the link to who gave them. Using a richer accessor here would put
 * attribution into the console's own path for no benefit.
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
 * THE PROCESS ENTRY POINT. It picks the process's own first response as the subject,
 * because identification is about a response joining or leaving a process: asking
 * the model to "reconsider the process" with no response to compare would give it
 * nothing to decide on. The admin's argument is what may change the answer.
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
        // A process with no responses cannot be re-identified: identification is
        // about a response joining or leaving, and with no response there is nothing
        // to compare. Refused loudly rather than reweighed on nothing.
        //
        // THIS IS A REAL STATE NOW, NOT A DATA FAULT. A move that takes a process's
        // last member leaves it with an empty current revision, deliberately: an
        // admin's rejudge should not delete a process they might still be discussing.
        // The roadmap says so on the screen. So this refusal is the honest answer for
        // a legitimate process rather than a sign of corruption, which is what an
        // earlier version of this comment implied.
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

    // THE PROCESS UNDER REVIEW IS INCLUDED, AND IT IS NAMED AS THE RESPONSE'S CURRENT HOME.
    //
    // IT USED TO BE EXCLUDED, and that made every rejudge look like it had broken the process.
    // In the ordinary case - one process, holding this response - excluding it leaves the list
    // EMPTY, and `buildComparisonMessage` then writes "(none yet, so this is a new process)",
    // which INSTRUCTS the model to create a new one. Measured on the deployed instance: the model
    // did exactly that and said so in its own words - "No existing process was provided to
    // compare against, so there is nothing this response could be the same work as" - and the
    // process being reviewed was left with `0` and "everyone who described this process has since
    // been regrouped elsewhere". The admin saw a second process appear and the first emptied.
    //
    // THE COMMENT'S OWN REASON STILL HOLDS and is not lost: a response may still be moved into
    // ANOTHER process, because every other process is a candidate too. Including this one adds a
    // candidate rather than removing the others. Excluding it did not "allow a move elsewhere" -
    // it forbade the only sensible target, and the one the admin was looking at.
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
 * A MOVE INVALIDATES THE SOURCE'S SCORE WITHOUT LEAVING A STALE ONE BEHIND. The
 * score is keyed on the revision and the move writes a new revision for the source,
 * so there is simply no score for it any more: the roadmap shows "not weighed". That
 * is the honest state, and it is VISIBLE, unlike a stale number which nothing would
 * mark. It is also why a failure here is a note rather than a throw: the move itself
 * is committed and correct, and discarding it to protect a score would lose the only
 * effect the admin's argument had.
 *
 * Returns nothing when the response did not move, so an ordinary rejudge keeps the
 * shape it had.
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
 * A weighing failure does NOT undo the re-identification. The grouping is stored by
 * the time this runs, and the spec keeps both, so the honest outcome is a new
 * grouping with no new score and a note saying the weighing failed: discarding the
 * identification would lose the admin's argument's only effect.
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
