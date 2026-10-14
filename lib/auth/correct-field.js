/**
 * An admin correcting ONE VALUE the score is computed from.
 *
 * WHY THIS IS A SEPARATE ACTION FROM A REJUDGE, and a separate module from it. Both the
 * regrouping actions in `rejudge.js` are arguments about WHICH PROCESS a response belongs to; a
 * rejudge re-identifies a membership and can never reach a value. So an admin who looked at a
 * score and said:
 *
 *   "it is not 56 a week, but 56 every morning so 7 times 56"
 *
 * got a sentence back and a score that had not moved. Measured on the deployed instance: the
 * weighing still read "fifty-six checks a week, every morning". The model had recorded the
 * participant's "56 checks every morning" as a WEEKLY FREQUENCY, so the error was in the stored
 * READING - and correcting a reading is a data edit, not a model call.
 *
 * NOT A MODEL CALL, deliberately, and an earlier attempt at this is worth recording because it
 * was wrong three times over. It had the weighing prompt parse the admin's sentence into a figure
 * ("56 every morning is 392"):
 *   - THE CORRECTION HAD NO HOME. It lived in a prompt, so the next reweigh recomputed from the
 *     stored 56 and the correction silently evaporated, and a second participant joining the
 *     process never saw it at all.
 *   - THE ARITHMETIC WAS IN THE PROMPT. A model multiplying words is how a number gets invented
 *     from a sentence, which is precisely what the prose marker exists to prevent, and nothing
 *     refused a wrong product at the boundary.
 *   - IT WAS NOT RECORDED AS ONE. The console would have shown a score derived from 392 beside a
 *     field saying 56, with no way to tell that an admin had intervened.
 * Here the value is VALIDATED at the boundary, STORED as a row, and read back through the one
 * seam the weighing and the console both use.
 *
 * WHY IT IS NOT IN `rejudge.js`: that file was over the 400-line soft limit once this was added,
 * and the project's rule for 401-600 is "extract before adding a concern". Correcting a value is
 * a different concern from regrouping a membership, so it moved rather than the file growing.
 */

import { listProcessesForConsole } from '../store/processes.js';
import { recordFieldCorrection, readCorrectedValue } from '../store/corrections.js';
import { getResponsesForAnalysis } from '../store/index.js';
import { reweighProcess } from './rejudge.js';

/**
 * The response a correction applies to, by id, or null.
 *
 * FROM `getResponsesForAnalysis`, the same accessor the rejudge uses and for the same reason: it
 * omits the invitation join, so a correction reads the participant's answers and never receives
 * the link to who gave them. A richer accessor would put attribution into the console's own path
 * for no benefit.
 *
 * @param {string} orgId
 * @param {string} responseId
 * @returns {object|null}
 */
function responseById(orgId, responseId) {
    return getResponsesForAnalysis(orgId).find((response) => response.id === responseId) ?? null;
}

/**
 * Records an admin's correction to one value, then reweighs the process it belongs to.
 *
 * THE PARTICIPANT'S ANSWER IS NEVER REWRITTEN. A correction is the analysis's reading of what
 * they said, held in its own table, so the answers view goes on showing their words and the score
 * uses the corrected figure. Showing one and scoring the other is the defect this closes, not a
 * trade it makes.
 *
 * THE REWEIGH IS IMMEDIATE, because a corrected value beside an uncorrected score IS the state
 * the owner reported. A reweigh failure is already tolerated the same way a rejudge tolerates one:
 * the correction stands, no new score is written, and the roadmap says "not weighed" - so an
 * outage does not discard the admin's work.
 *
 * @param {object} args
 * @param {string} args.orgId The SESSION's organisation, never a request field.
 * @param {string} args.responseId
 * @param {string} args.field One of CORRECTABLE_FIELDS - the four the effort formula reads.
 * @param {*} args.rawValue The submitted value, validated here.
 * @param {string} args.adminReasoning Required: a changed number must be reviewable.
 * @param {string} [args.lang]
 * @returns {Promise<{correction: object, processId: string, weighed: boolean, note: string}>}
 * @throws {Error} When the value, the field, the response or the reasoning is unusable.
 */
export async function correctField({ orgId, responseId, field, rawValue, adminReasoning, lang = 'en' }) {
    const reason = typeof adminReasoning === 'string' ? adminReasoning.trim() : '';
    if (reason === '') {
        throw new Error('A correction needs a reason: say what is wrong with the stored value.');
    }

    const checked = readCorrectedValue(field, rawValue);
    if (!checked.ok) throw new Error(checked.reason);

    const response = responseById(orgId, responseId);
    if (!response) throw new Error('That answer is not in this organisation.');

    // THE PROCESS TO REWEIGH, read BEFORE the correction is written so the action can be refused
    // when the answer is in no process: a correction changes what a score is computed from, and
    // with no process there is no score for the admin to have been looking at.
    const home = listProcessesForConsole(orgId)
        .find((entry) => (entry.current?.responses ?? []).some((row) => row.responseId === responseId));
    if (!home) {
        throw new Error(
            'That answer is not in a process yet, so there is no score for a correction to change. ' +
            'Rejudge it into one first.'
        );
    }

    const correction = recordFieldCorrection({
        orgId, responseId, field, value: checked.value, adminReasoning: reason
    });

    // The correction is WRITTEN BEFORE the weighing, so a model outage leaves the admin's edit in
    // place rather than discarding it - the same ordering the rejudge uses for the same reason.
    const weighed = await reweighProcess({ orgId, processId: home.id, adminReasoning: reason, lang });
    return { correction, processId: home.id, weighed: weighed.weighed, note: weighed.note };
}
