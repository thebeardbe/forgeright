/**
 * An admin correcting one value the score is computed from: a data edit rather than a rejudge, because a
 * rejudge argues about which process a response belongs to and can never reach a value.
 *
 * Not a model call: the value is validated at the boundary and stored as a row, so the answers view keeps
 * the participant's words while the score uses the corrected figure.
 */

import { listProcessesForConsole } from '../store/processes.js';
import { recordFieldCorrection, readCorrectedValue } from '../store/corrections.js';
import { getResponsesForAnalysis } from '../store/index.js';
import { reweighProcess } from './rejudge.js';

/**
 * Read through `getResponsesForAnalysis`, the same accessor the rejudge uses, so a correction reads the
 * answers without the link to who gave them.
 *
 * @returns {object|null}
 */
function responseById(orgId, responseId) {
    return getResponsesForAnalysis(orgId).find((response) => response.id === responseId) ?? null;
}

/**
 * Records a correction to one value, then reweighs the process it belongs to. A reweigh failure is
 * tolerated, so an outage does not discard the admin's work.
 *
 * @param {object} args
 * @param {string} args.orgId The session's organisation, never a request field.
 * @param {string} args.field One of CORRECTABLE_FIELDS, the four the effort formula reads.
 * @param {*} args.rawValue The submitted value, validated here.
 * @param {string} args.adminReasoning Required: a changed number must be reviewable.
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

    // Read before the correction is written, so the action is refused when the answer is in no process:
    // there would be no score for the admin to have been looking at.
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

    // Written before the weighing, so a model outage leaves the admin's edit in place.
    const weighed = await reweighProcess({ orgId, processId: home.id, adminReasoning: reason, lang });
    return { correction, processId: home.id, weighed: weighed.weighed, note: weighed.note };
}
