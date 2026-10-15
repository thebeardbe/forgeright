/**
 * The completeness matrix: reconciling what is missing with what the model claims, and reading a
 * process's step flags as a judgement band.
 *
 * `missing` empty is what finishes the interview, not the model's own sense that it is done, which is
 * what makes the loop testable by the script rather than by trusting the model's prose. The field
 * tables, shapes and per-field minimums live in `ai/field-shapes.js` and are re-exported below.
 */

// Re-exported so nothing that imports them from this module has to move:
// test/matrix.test.js reads all of these from this path.
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
    declinedIn,
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
 * The fields a process has been asked about and the participant declined to answer, which is not the
 * same as missing: asking a declined field again is the loop this system exists to prevent, and it
 * cannot satisfy the completion gate either. See `declinedIn` in field-shapes.js.
 *
 * @param {object} process
 * @returns {string[]}
 */
export function fieldsDeclinedIn(process) {
    if (!process || typeof process !== 'object' || Array.isArray(process)) return [];

    const declined = [];
    for (const field of ALL_PROCESS_FIELD_NAMES) {
        if (declinedIn(process[field]) !== null) declined.push(field);
    }
    return declined;
}

/**
 * The fields a process is still missing, out of the full matrix. The either/or pair is one
 * requirement, read from `fieldsPresentIn` so both callers agree: a process with `frequencyPerWeek`
 * satisfies the effort need, and reporting `timePerPeriod` missing alongside it would send the
 * interviewer back to ask a question it already has the answer to. A declined field is not missing:
 * it is not supplied either, so it cannot satisfy the gate.
 *
 * @param {object} process
 * @returns {string[]}
 */
export function fieldsMissingFrom(process) {
    const present = new Set(fieldsPresentIn(process));
    const declined = new Set(fieldsDeclinedIn(process));
    const effortSatisfied = EFFORT_FIELDS.some((field) => present.has(field));

    return ALL_PROCESS_FIELD_NAMES.filter((field) => {
        if (EFFORT_FIELDS.includes(field)) return !effortSatisfied && !declined.has(field);
        return !present.has(field) && !declined.has(field);
    });
}

/**
 * Reconciles the model's reported have/missing against the processes it sent.
 *
 * The claim and the payload say different things: `processes` is the partial payload, which
 * mid-interview is a stub, while `have`/`missing` is the model's statement about the conversation
 * whether or not it has written it down yet. So the payload subtracts and never replaces: a field the
 * model claims but the payload lacks is left as claimed, because the interview is still going, and the
 * subtraction catches the dangerous direction instead, a claim that `missing` is empty while a process
 * lacks a field.
 *
 * @param {object} args
 * @param {Array<object>} args.processes The payload the model sent.
 * @param {string[]|null} args.claimedHave The model's own list, if it sent one.
 * @param {string[]|null} args.claimedMissing The model's own list, if it sent one.
 * @param {boolean} args.closing Whether the model claimed completion.
 * @returns {{ have: string[], missing: string[], supplied: string[], evidenced: string[],
 *   declined: string[] }} `have` means "do not ask again"; `supplied` means "the analysis has
 *   something to work with". They differ for exactly one state, declined, and the completion gate
 *   reads `supplied`, not `have`.
 */
export function reconcileMatrix({ processes, claimedHave = null, claimedMissing = null, closing = false }) {
    if (!Array.isArray(processes) || processes.length === 0) {
        return { have: [], missing: [...ALL_PROCESS_FIELD_NAMES], supplied: [], evidenced: [], declined: [] };
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

    // While asking, the claim is believed for anything the payload does not carry; while closing,
    // only the payload counts, because at that point it is supposed to hold everything and a claim is
    // what would let a field vanish. A field is declined only when EVERY process that could carry it
    // declined, so one participant saying "I have no idea" must not close a question another could
    // answer.
    const declinedEverywhere = new Set();
    for (const field of ALL_PROCESS_FIELD_NAMES) {
        const everywhere = processes.every((process) => fieldsDeclinedIn(process).includes(field));
        if (everywhere) declinedEverywhere.add(field);
    }

    const have = [];
    const missing = [];
    const supplied = [];

    for (const field of ALL_PROCESS_FIELD_NAMES) {
        const isDeclined = declinedEverywhere.has(field);

        // A declined field is `have` and not `supplied`: that split is the fourth state, do not ask
        // again but do not count it as evidence.
        const isHad = isDeclined || (closing
            ? provable.has(field)
            : provable.has(field) || (claimedHave !== null && claimedHave.includes(field))
                && !(claimedMissing !== null && claimedMissing.includes(field)));

        (isHad ? have : missing).push(field);

        // `supplied` means the analysis can use it, which is `provable` for a typed value and the
        // model's own claim while the interview is still going. A declined field is excluded however
        // it arrived, because a claim that a field is `have` must not turn a refusal into evidence,
        // which is the hole the fourth state exists to close.
        if (!isDeclined && (provable.has(field) || isHad)) supplied.push(field);
    }

    // `evidenced` counts a field only when the payload carries a value of the right shape, the same
    // test `provable` uses at the end. It exists because `supplied` is not monotonic: mid-interview
    // both `have` and `supplied` believe the model's claim for a field the payload lacks, so a model
    // that re-partitions its two lists moves both while nothing is recorded. It can shrink, because
    // the model rewrites `processes` each turn and drops fields it had filled, so the cap that reads it
    // counts against a peak: correct for a stall and pessimistic for a dip.
    return { have, missing, supplied, evidenced: [...provable], declined: [...declinedEverywhere] };
}

/**
 * The process-level judgement band for a workflow, 1 to 5.
 *
 * Workflow 1 reports judgement per step, because a chain can be almost entirely mechanical with one
 * judgement call in the middle, and reading that at process level says "needs a person" and automates
 * nothing. THE SCALE IS INVERTED: 1 is pure judgement and 5 is pure rules, so a workflow with no
 * reasoning steps scores 5, and everything downstream is written against that direction.
 *
 * Neither an explicit `judgementScore` nor steps falls back to 3, the midpoint, which is the honest
 * "not enough information" answer rather than a flattering 5.
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

    // `flagged` has a known boolean, so a step whose flag is absent or malformed is not counted either
    // way rather than being read as "no judgement needed".
    const flagged = steps.filter((step) => step && typeof step.needsReasoning === 'boolean');
    if (flagged.length === 0) return 3;

    const reasoningSteps = flagged.filter(stepNeedsReasoning).length;
    const share = reasoningSteps / flagged.length;

    // No reasoning steps is 5 and every step is 1, rounded, so a five-step chain with one judgement
    // call reads as 4 rather than as "needs a person".
    return clampToBand(5 - share * 4);
}

/** Forces a value into the 1-5 band. Kept private: the band has one owner. */
function clampToBand(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 3;
    return Math.min(5, Math.max(1, Math.round(n)));
}
