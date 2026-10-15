/**
 * Identifying a finished round into a process, on the ordinary path.
 *
 * This is the seed's ordinary path, `runIdentification` then `recordIdentification` with the default
 * `decidedBy: 'model'`, applied to a live round. It is not a rejudge: no admin argument and no
 * `decidedBy: 'admin'`, so the console does not read every live interview as a console full of corrections.
 *
 * It is not inline in the route because that file is close to the 400-line soft limit, and not in the store
 * because `recordTurn` there is synchronous, so a model call would put the network inside a write
 * transaction.
 */

import { runIdentification } from '../../ai/identify-core.js';
import { listProcessesForConsole, recordIdentification } from '../store/processes.js';

/**
 * Whether a response already belongs to a process, in the grouping currently in force: the same fact the
 * console reads for its "not yet read" badge, so the two cannot disagree.
 *
 * The guard exists because a second `recordIdentification` with `matches: null` creates a second process of
 * the same name, and the prompt tells the model to answer `matches: null` when unsure.
 *
 * @param {string} orgId
 * @param {string} responseId
 * @returns {boolean}
 */
export function alreadyIdentified(orgId, responseId) {
    return listProcessesForConsole(orgId).some((process) => {
        const members = process.current?.responses ?? [];
        return members.some((row) => row.responseId === responseId);
    });
}

/**
 * Identifies one finished response into a process, on the ordinary path.
 *
 * Never throws: every failure is reported and swallowed, because this runs after the participant's turn has
 * already been saved, so a model outage must not turn a completed interview into an error the participant
 * sees. The failure mode is "not identified yet" rather than "lost", a state the console already renders
 * and an admin can fix with Rejudge.
 *
 * @param {object} args
 * @param {string} args.orgId
 * @param {object} args.response The stored response, with `data` parsed.
 * @param {string} [args.lang]
 * @returns {Promise<{identified: boolean, reason?: string}>}
 */
export async function identifyFinishedResponse({ orgId, response, lang = 'en' }) {
    if (!response || typeof response.id !== 'string' || response.id === '') {
        return { identified: false, reason: 'no response to identify' };
    }

    // Before the model call, so a response that already has a grouping never costs a call or risks a
    // second process.
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
            console.warn(
                `[identify] the finished answer ${response.id} was not identified: ${reason}. ` +
                'It stays as "not yet read" and an admin can rejudge it.'
            );
            return { identified: false, reason };
        }

        // The default `decidedBy` is `model`: passing `admin` here would mark every live interview as a
        // console full of regroupings.
        recordIdentification({ orgId, responseId: response.id, reply });
        return { identified: true };
    } catch (err) {
        // Reported rather than rethrown: the answers are already saved, so this is a delay in the roadmap
        // rather than a loss.
        console.warn(
            `[identify] the finished answer ${response.id} could not be identified: ${err.message}. ` +
            'It stays as "not yet read" and an admin can rejudge it.'
        );
        return { identified: false, reason: err.message };
    }
}
