/**
 * Identifying a finished round into a process, on the ORDINARY path.
 *
 * THE GAP THIS CLOSES. `runIdentification` was called from the admin's rejudge and the demo seed,
 * and NOWHERE on a live interview. So a participant finished, their answer sat with "not yet read"
 * and "This answer has not been identified into a process yet", and the roadmap showed nothing
 * from them - which is how a correct answer card looked like a broken deployment.
 *
 * THIS IS THE SEED'S ORDINARY PATH - `runIdentification` then `recordIdentification` with the
 * default `decidedBy: 'model'` - applied to a live round. IT IS NOT A REJUDGE: no admin argument
 * and no `decidedBy: 'admin'`, so the console does not read every live interview as a console full
 * of corrections. (scripts/seed-demo-org.js states that distinction; it is the right one.)
 *
 * NOT IN THE STORE, measured rather than assumed: `recordTurn` there is SYNCHRONOUS, and the store
 * layer imports nothing from `ai/` except one pure predicate - so a deepseek call would block a
 * write and put the network inside a write transaction.
 *
 * NOT INLINE IN THE ROUTE because that file is close to the 400-line soft limit, so the logic lives
 * here and the route calls it.
 */

import { runIdentification } from '../../ai/identify-core.js';
import { listProcessesForConsole, recordIdentification } from '../store/processes.js';

/**
 * Whether a response already belongs to a process, in the grouping currently in force.
 *
 * THE SAME FACT THE CONSOLE READS, so the guard and the "not yet read" badge cannot disagree:
 * the console sets `grouping: null` for a response with no current grouping and renders that as
 * "not yet read".
 *
 * WHY THE GUARD EXISTS, MEASURED: a second `recordIdentification` with `matches: <id>` leaves ONE
 * process, but with `matches: null` it creates a SECOND with the same name - and the identify
 * prompt TELLS the model to answer `matches: null` when unsure. So a second automatic
 * identification can add a duplicate process for work the console has already grouped.
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
 * NEVER THROWS. Every failure is reported and swallowed, because this runs after the
 * participant's turn has already been saved and answered: a model outage must not turn a
 * completed interview into an error the participant sees.
 *
 * THE FAILURE MODE IS "NOT IDENTIFIED YET", NEVER "LOST". `recordTurn` has already written the
 * answers and finalised the round before this is called, so the worst outcome of a failure here
 * - or of the process being killed mid-call - is an answer that still reads "not yet read". That
 * is a state the console already renders and an admin can already fix with Rejudge, which is
 * exactly the right place for it.
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

    // THE GUARD, checked before the model call rather than after, so a response that already
    // has a grouping never costs a call or risks a second process.
    if (alreadyIdentified(orgId, response.id)) {
        return { identified: false, reason: 'already identified' };
    }

    try {
        // The processes the model compares against, with their reasoning, exactly as the
        // rejudge path and the seed build them - so a live round is grouped against the same
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

        // THE ORDINARY PATH: the default `decidedBy` is `model`, so this is not recorded as an
        // admin correction. Passing `decidedBy: 'admin'` here would mark every live interview as
        // a console full of regroupings - the thing the seed's comment says to avoid.
        recordIdentification({ orgId, responseId: response.id, reply });
        return { identified: true };
    } catch (err) {
        // Reported rather than rethrown. The answers are already saved, so this is a delay in
        // the roadmap rather than a loss, and the participant must not see it.
        console.warn(
            `[identify] the finished answer ${response.id} could not be identified: ${err.message}. ` +
            'It stays as "not yet read" and an admin can rejudge it.'
        );
        return { identified: false, reason: err.message };
    }
}
