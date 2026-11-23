/**
 * Identifying a finished round into a process, on the ordinary path: `runIdentification` then
 * `recordIdentification` with the default `decidedBy: 'model'`. It is not a rejudge, so the console does not
 * read every live interview as a console full of corrections.
 *
 * Not in the store, because `recordTurn` there is synchronous and a model call would put the network inside a
 * write transaction.
 */

import { runIdentification } from '../../ai/identify-core.js';
import { listProcessesForConsole, recordIdentification } from '../store/processes.js';

/**
 * The guard exists because a second `recordIdentification` with `matches: null` creates a second process of the
 * same name, and the prompt tells the model to answer `matches: null` when unsure.
 *
 * @returns {boolean}
 */
export function alreadyIdentified(orgId, responseId) {
    return listProcessesForConsole(orgId).some((process) => {
        const members = process.current?.responses ?? [];
        return members.some((row) => row.responseId === responseId);
    });
}

/**
 * Never throws: every failure is reported and swallowed, because this runs after the participant's turn has
 * been saved, so a model outage must not turn a completed interview into an error they see. The failure mode is
 * "not identified yet", which the console already renders and an admin can fix with Rejudge.
 *
 * @param {object} args
 * @param {string} args.orgId
 * @param {object} args.response The stored response, with `data` parsed.
 * @returns {Promise<{identified: boolean, reason?: string}>}
 */
export async function identifyFinishedResponse({ orgId, response, lang = 'en' }) {
    if (!response || typeof response.id !== 'string' || response.id === '') {
        return { identified: false, reason: 'no response to identify' };
    }

    // Before the model call, so a response that already has a grouping never costs a call.
    if (alreadyIdentified(orgId, response.id)) {
        return { identified: false, reason: 'already identified' };
    }

    try {
        // Exactly as the rejudge path and the seed build them, so a live round is grouped against the same
        // picture an admin's correction would see.
        const known = listProcessesForConsole(orgId).map((process) => ({
            id: process.id,
            name: process.name,
            reasoning: process.current?.reasoning ?? null
        }));

        const reply = await runIdentification({ response, knownProcesses: known, lang });

        if (!reply || reply.status === 'error' || reply.status === 'rejected') {
            const reason = reply?.reason ?? reply?.content ?? reply?.status ?? 'the model returned nothing';

            // WHAT ACTUALLY UNBLOCKS THIS, per case. The previous wording promised an admin could
            // rejudge their way out, for both cases at once, and MEASURED that was false for the stored
            // answer: a rejudge ran the same screen on the same text and was refused identically. An
            // operator followed a promise with nothing behind it.
            //
            // `rejected` now means THE ADMIN'S OWN ARGUMENT matched the screen (a stored answer is a
            // signal and no longer refuses), so a rejudge with a rephrased argument DOES work, and the
            // sentence says to do exactly that. An `error` is the model failing, which a rejudge can also
            // clear because it runs again.
            const nextStep = reply?.status === 'rejected'
                ? 'The admin argument itself matched the injection screen: rephrase it as an argument '
                    + 'about how the work should be read, and rejudge. The stored answer does not block.'
                : 'A rejudge runs identification again, so it clears a model failure like this one.';

            console.warn(
                `[identify] the finished answer ${response.id} was not identified: ${reason}. ` +
                `It stays as "not yet read". ${nextStep}`
            );
            return { identified: false, reason };
        }

        // The default `decidedBy` is `model`: `admin` here would mark every live interview as a regrouping.
        recordIdentification({ orgId, responseId: response.id, reply });
        return { identified: true };
    } catch (err) {
        // Reported rather than rethrown: the answers are saved, so this delays the roadmap rather than losing it.
        console.warn(
            `[identify] the finished answer ${response.id} could not be identified: ${err.message}. ` +
            'It stays as "not yet read". A rejudge runs identification again, so it clears a transient '
            + 'failure like this one.'
        );
        return { identified: false, reason: err.message };
    }
}
