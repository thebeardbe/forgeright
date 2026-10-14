/**
 * Identifying a finished round into a process, on the ORDINARY path.
 *
 * THE GAP THIS CLOSES. `runIdentification` was called in exactly two places: the admin's
 * rejudge (`lib/auth/rejudge.js`, twice) and the demo seed (`scripts/seed-demo-org.js`). A LIVE
 * INTERVIEW CALLED IT NOWHERE. So a participant finished, their answer sat with "not yet read"
 * and "This answer has not been identified into a process yet", and the roadmap showed nothing
 * from them - which is how a correct answer card looked like a broken deployment.
 *
 * THE SEED'S OWN COMMENT NAMED THE DISTINCTION BEING DRAWN, and it is the right one to keep:
 *
 *   "The rejudge route would mark every revision as an admin correction and require an admin's
 *    argument, and a demo should show the ordinary result rather than a console full of
 *    regroupings." (scripts/seed-demo-org.js)
 *
 * So this is the seed's ordinary path - `runIdentification` then `recordIdentification` with the
 * default `decidedBy: 'model'` - applied to a live round. It is NOT a rejudge: no admin
 * argument, and no `decidedBy.admin`, so the console does not read every live interview as a
 * console full of corrections.
 *
 * WHY THIS IS NOT IN THE STORE (`lib/store/index.js`), measured rather than assumed:
 *   - `recordTurn` THERE IS SYNCHRONOUS, and the whole store layer is: a deepseek call inside
 *     it would block the write and put the network inside a write transaction;
 *   - `lib/store/` imports NOTHING from `ai/` except one pure predicate (`fieldsPresentIn` in
 *     console-read.js). No AI, no network, anywhere in that layer. A model call there would be
 *     the first, and in the wrong direction of the dependency arrow.
 *
 * AND WHY IT IS NOT INLINE IN THE ROUTE: `lib/auth/participant-routes.js` is 365 lines against a
 * 400-line soft limit, so the logic lives here and the route calls it.
 */

import { runIdentification } from '../../ai/identify-core.js';
import { listProcessesForConsole, recordIdentification } from '../store/processes.js';

/**
 * Whether a response already belongs to a process, in the grouping currently in force.
 *
 * THE SAME FACT THE CONSOLE READS, so the guard and the "not yet read" badge cannot disagree:
 * `lib/store/console-read.js` sets `grouping: null` for a response with no current grouping, and
 * `views/admin-answers.ejs` renders that as "not yet read".
 *
 * WHY THE GUARD EXISTS, MEASURED against the store rather than reasoned about:
 *   a second `recordIdentification` with `matches: <id>`   -> still ONE process (idempotent)
 *   a second `recordIdentification` with `matches: null`   -> TWO processes, same name
 * and the identify prompt TELLS the model to answer `matches: null` when it is unsure
 * (`identify_en.md`: "When you are genuinely unsure, report `matches: null`"). So a second
 * automatic identification is not harmless: it can add a duplicate process for work the console
 * has already grouped. A response that already has a home is therefore left alone.
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
