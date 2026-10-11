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
 */
import { getResponsesForAnalysis } from '../store/index.js';
import { recordIdentification, listProcessesForConsole } from '../store/processes.js';
import { recordWeighing, listRoadmap } from '../store/weighing.js';
import { runIdentification } from '../../ai/identify-core.js';
import { runWeighing } from '../../ai/weigh-core.js';

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

    // The processes the model compares against, with their reasoning, exactly as
    // the first identification runs.
    const known = listProcessesForConsole(orgId).map((process) => ({
        id: process.id,
        name: process.name,
        reasoning: process.current?.reasoning ?? null
    }));

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

    return { ...identified, ...weighed };
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
        // A process with no responses cannot be re-identified, and that is a data
        // fault rather than an empty result: the grouping claims members it does not
        // have. Refused loudly rather than reweighed on nothing.
        throw new Error('That process has no answers behind it, so there is nothing to re-identify.');
    }

    // The response is read through the attribution-free accessor, as above.
    const response = responseById(orgId, subject.responseId);
    if (!response) {
        throw new Error('The answer behind that process could not be read.');
    }

    // The OTHER processes are the comparison set: the argument may move this
    // response into one of them, which is how a merge implied by the reasoning
    // happens without the admin naming a target.
    const known = listProcessesForConsole(orgId)
        .filter((entry) => entry.id !== processId)
        .map((entry) => ({ id: entry.id, name: entry.name, reasoning: entry.current?.reasoning ?? null }));

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

    return { ...identified, ...weighed };
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
async function reweighProcess({ orgId, processId, adminReasoning, lang }) {
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
            note: 'The regrouping was recorded. The new score could not be produced, so the previous one stands.'
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
            note: `The regrouping was recorded. The new score was refused: ${err.message}`
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
