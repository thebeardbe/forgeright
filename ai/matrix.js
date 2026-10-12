/**
 * The completeness matrix: reconciling what is missing with what the model claims,
 * and reading a process's step flags as a judgement band.
 *
 * Workflow 1 asks the model to fill this in from whatever the participant says,
 * and to report which fields it has and which it still needs. The two lists are
 * what make the loop testable by the SCRIPT rather than by trusting the model's
 * prose: `missing` empty is what finishes the interview, not the model's own
 * sense that it is done.
 *
 * The field tables, the shapes and the per-field minimums live in
 * `ai/field-shapes.js` and are RE-EXPORTED below, so this module's public surface
 * is unchanged and every existing import path still resolves. See that file for
 * why the split was made.
 */

// Imported for use here, and re-exported so nothing that imports them from this
// module has to move: `test/matrix.test.js` reads all of these from this path.
import {
    ALL_PROCESS_FIELD_NAMES,
    EFFORT_FIELDS,
    PROCESS_FIELDS,
    STEP_FIELDS,
    OPTIONAL_STEP_FIELDS,
    FIELD_SHAPES,
    FIELD_MINIMUMS,
    stepIsComplete,
    stepNeedsReasoning,
    stepGapsFor,
    fieldsPresentIn,
    isPeriod,
    timePerPeriodIsScorable,
    PERIODS_IN_WEEK
} from './field-shapes.js';

export {
    ALL_PROCESS_FIELD_NAMES,
    EFFORT_FIELDS,
    PROCESS_FIELDS,
    STEP_FIELDS,
    OPTIONAL_STEP_FIELDS,
    FIELD_SHAPES,
    FIELD_MINIMUMS,
    stepIsComplete,
    stepNeedsReasoning,
    stepGapsFor,
    fieldsPresentIn,
    isPeriod,
    timePerPeriodIsScorable,
    PERIODS_IN_WEEK
};

/**
 * The fields a process is still missing, out of the full matrix.
 *
 * THE EITHER/OR PAIR IS ONE REQUIREMENT, applied here as well as in
 * reconcileMatrix: a process with `frequencyPerWeek` satisfies the effort need,
 * and reporting `timePerPeriod` missing alongside it would send the interviewer
 * back to ask a question it already has the answer to. That is the exact failure
 * the matrix exists to prevent, so the rule lives in fieldsPresentIn and both
 * callers read it from there.
 *
 * @param {object} process
 * @returns {string[]}
 */
export function fieldsMissingFrom(process) {
    const present = new Set(fieldsPresentIn(process));
    const effortSatisfied = EFFORT_FIELDS.some((field) => present.has(field));

    return ALL_PROCESS_FIELD_NAMES.filter((field) => {
        if (EFFORT_FIELDS.includes(field)) return !effortSatisfied;
        return !present.has(field);
    });
}

/**
 * Reconciles the model's reported have/missing against the processes it sent.
 *
 * THE MODEL'S CLAIM AND THE PAYLOAD SAY DIFFERENT THINGS, and both are needed:
 *
 *   - `processes` is the partial payload. Mid-interview it is a stub, because the
 *     structured object only takes shape near the end.
 *   - `have`/`missing` is the model's statement about the CONVERSATION: what it
 *     has been told, whether or not it has written it into the payload yet.
 *
 * So the payload is used to SUBTRACT, never to replace. A field the model claims
 * but the payload does not carry is left as claimed: the interview is still going,
 * and refusing to believe the model would make it re-ask questions the
 * participant has already answered, which is the exact failure the matrix exists
 * to prevent.
 *
 * The subtraction is what stops the dangerous direction: a model claiming a field
 * it never wrote down, at the END of the interview, when the payload is supposed
 * to be complete. If `missing` is claimed empty while a process lacks a field,
 * that field is put back.
 *
 * @param {object} args
 * @param {Array<object>} args.processes The payload the model sent.
 * @param {string[]|null} args.claimedHave The model's own list, if it sent one.
 * @param {string[]|null} args.claimedMissing The model's own list, if it sent one.
 * @param {boolean} args.closing Whether the model claimed completion.
 * @returns {{ have: string[], missing: string[] }}
 */
export function reconcileMatrix({ processes, claimedHave = null, claimedMissing = null, closing = false }) {
    if (!Array.isArray(processes) || processes.length === 0) {
        return { have: [], missing: [...ALL_PROCESS_FIELD_NAMES] };
    }

    // What the payload can prove, across every process.
    const provable = new Set();
    for (const field of ALL_PROCESS_FIELD_NAMES) {
        const everywhere = processes.every((process) => {
            const present = fieldsPresentIn(process);
            // The either/or pair: either half satisfies it for that process.
            if (EFFORT_FIELDS.includes(field)) {
                return EFFORT_FIELDS.some((alt) => present.includes(alt));
            }
            return present.includes(field);
        });
        if (everywhere) provable.add(field);
    }

    // WHILE ASKING, the claim is believed for anything the payload does not carry.
    // WHILE CLOSING, only the payload counts, because at that point it is
    // supposed to hold everything and a claim is what would let a field vanish.
    const have = [];
    const missing = [];

    for (const field of ALL_PROCESS_FIELD_NAMES) {
        const isHad = closing
            ? provable.has(field)
            : provable.has(field) || (claimedHave !== null && claimedHave.includes(field))
                && !(claimedMissing !== null && claimedMissing.includes(field));

        (isHad ? have : missing).push(field);
    }

    return { have, missing };
}

/**
 * The process-level judgement band for a workflow, 1 to 5.
 *
 * WHERE THIS BELONGS AND WHY IT IS HERE. Workflow 1 reports judgement per STEP,
 * because a chain can be almost entirely mechanical with one judgement call in
 * the middle, and reading that at process level says "needs a person" and
 * automates nothing. The scorer still works in the 1-5 band, so the conversion
 * sits next to the flags it reads rather than inside the scorer, which workflow 3
 * replaces.
 *
 * THE SCALE IS INVERTED, matching the field it replaces: 1 is pure judgement and
 * 5 is pure rules, so a workflow with NO reasoning steps scores 5. Everything
 * downstream (the rules factor, the conflict labels, the bucket thresholds) is
 * written against that direction, so it is kept rather than reversed.
 *
 * A workflow carrying neither an explicit `judgementScore` nor steps falls back
 * to 3, the midpoint, which is the honest "not enough information" answer rather
 * than a flattering 5.
 *
 * @param {object} workflow
 * @returns {number} 1 to 5.
 */
export function judgementBandFor(workflow) {
    const explicit = workflow && workflow.judgementScore;
    if (explicit !== undefined && explicit !== null) {
        const n = Number(explicit);
        if (Number.isFinite(n)) return clampToBand(n);
    }

    const steps = workflow && Array.isArray(workflow.steps) ? workflow.steps : null;
    if (!steps || steps.length === 0) return 3;

    // `flagged` has a KNOWN boolean, so a step whose flag is absent or malformed is
    // not counted either way rather than being read as "no judgement needed".
    const flagged = steps.filter((step) => step && typeof step.needsReasoning === 'boolean');
    if (flagged.length === 0) return 3;

    const reasoningSteps = flagged.filter(stepNeedsReasoning).length;
    const share = reasoningSteps / flagged.length;

    // No reasoning steps -> 5. Every step -> 1. Rounded, so a five-step chain with
    // one judgement call reads as 4 rather than as "needs a person".
    return clampToBand(5 - share * 4);
}

/** Forces a value into the 1-5 band. Kept private: the band has one owner. */
function clampToBand(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 3;
    return Math.min(5, Math.max(1, Math.round(n)));
}
