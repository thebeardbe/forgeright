/**
 * One rejudge path, two entry points: a rejudge from an answer and from a process differ only in the
 * subject, and both re-identify with the admin's reasoning then regenerate the score.
 *
 * It always goes back to workflow 2, even when the admin disputes the score, because a process cannot be
 * reweighed before it is certain what the process is: if the argument shows two processes are one, the
 * thing being weighed has changed.
 */
import { getResponsesForAnalysis } from '../store/index.js';
import { recordIdentification, listProcessesForConsole } from '../store/processes.js';
import { recordWeighing, listRoadmap } from '../store/weighing.js';
import { runIdentification } from '../../ai/identify-core.js';
import { runWeighing } from '../../ai/weigh-core.js';

/**
 * Every process the model compares against, with the one holding this response labelled. The label comes
 * from `listProcessesForConsole`'s own membership rather than a separate store call, so it cannot disagree
 * with what the console displays.
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
            // True for the process this response is already in, so the model can answer "unchanged".
            isCurrentHome: members.some((row) => row.responseId === responseId)
        };
    });
}

/**
 * The response a rejudge starts from, by id, or null. Read through `getResponsesForAnalysis`, deliberately:
 * that accessor omits the invitation join, so a rejudge reads the answers without the link to who gave them.
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
 * @param {string} args.orgId The session's organisation, never a request field.
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

    // The list is complete here; the label tells the model that one candidate is where the response
    // already is, so "the argument changes nothing" is an answer it can give.
    const known = withCurrentHome(orgId, responseId);

    const reply = await runIdentification({ response, knownProcesses: known, lang, adminReasoning: reason });
    assertUsable(reply, 'identification');

    // `admin` and the admin's own words are recorded, so a reader can see which revisions a person
    // asked for.
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

    // The process the response left also changed, so it is reweighed too; a failure here does not undo
    // anything, because the membership is committed and the roadmap renders a missing score as "not
    // weighed".
    const left = await reweighLeft({ orgId, left: identified.left, lang });

    return { ...identified, ...weighed, ...left };
}

/**
 * Re-identifies one process's membership, then reweighs it. It picks the process's own first response as
 * the subject, because identification is about a response joining or leaving and "reconsider the process"
 * with no response gives the model nothing to decide on.
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
        // A real state rather than a data fault: a move that takes a process's last member deliberately
        // leaves it with an empty current revision, because an admin's rejudge should not delete a process
        // they might still be discussing.
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

    // The process under review is included and named as the response's current home; excluding it left the
    // list empty and the model created a duplicate. Every other process is still a candidate, so a merge
    // elsewhere works.
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

    // Same second side as above: the process this response left changed too.
    const left = await reweighLeft({ orgId, left: identified.left, lang });

    return { ...identified, ...weighed, ...left };
}

/**
 * Reweighs the process a response left. The move writes a new revision for the source and the score is keyed
 * on the revision, so there is no stale score to keep, and a failure here is a note rather than a throw
 * because the move is already committed and correct.
 *
 * @returns {Promise<{moved: object|null, leftWeighed: boolean, leftNote: string}>}
 */
async function reweighLeft({ orgId, left, lang }) {
    if (!left) return { moved: null, leftWeighed: false, leftNote: '' };

    const weighed = await reweighProcess({ orgId, processId: left.id, lang });
    if (weighed.weighed) {
        return { moved: left, leftWeighed: true, leftNote: '' };
    }

    // Only the reason: the notice above already says the process now has no score.
    console.error(`[rejudge] the move was recorded but the process it left could not be reweighed: ${weighed.note}`);
    return { moved: left, leftWeighed: false, leftNote: weighed.note };
}

/**
 * Weighs a process's current grouping and records the result.
 *
 * A weighing failure does not undo the re-identification: the grouping is stored by the time this runs, so
 * the outcome is a new grouping with a note saying there is no new score.
 *
 * The previous score does NOT stand on failure: it is keyed on the revision id and this regrouping wrote a
 * new revision, so the process is simply unscored, with the old number surviving in the history against the
 * revision it was computed for.
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
            // NOT "the previous one stands"; see the note above.
            note: 'The regrouping was recorded. The new score could not be produced, so this process now has no score.'
        };
    }

    try {
        const { score } = recordWeighing({ orgId, processId, reply });
        return { score, weighed: true, note: 'Regrouped and reweighed.' };
    } catch (err) {
        // The model's reply was unusable; the admin needs to know why the number did not move.
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
