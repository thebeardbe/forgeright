/**
 * The completeness matrix: reconciling what is missing with what the model claims, and reading a
 * process's step flags as a judgement band.
 *
 * `missing` empty is what finishes the interview, not the model's own sense that it is done, which is what
 * makes the loop testable by the script rather than by trusting the model's prose.
 */

// Re-exported: test/matrix.test.js reads all of these from this path.
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
 * The fields a process was asked about and the participant declined, which is neither missing nor supplied.
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
 * The fields a process is still missing, out of the full matrix. The either/or pair counts as one
 * requirement, read from `fieldsPresentIn` so both callers agree, and a declined field is not missing.
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
 * Reconciles the model's reported have/missing against the processes it sent. The payload subtracts and
 * never replaces, because it is a partial stub mid-interview while `have`/`missing` is the model's
 * statement about the conversation. What the subtraction catches is a claim that `missing` is empty while
 * a process lacks a field.
 *
 * @param {object} args
 * @param {Array<object>} args.processes The payload the model sent.
 * @param {string[]|null} args.claimedHave The model's own list, if it sent one.
 * @param {string[]|null} args.claimedMissing The model's own list, if it sent one.
 * @param {boolean} args.closing Whether the model claimed completion.
 * @returns {{ have: string[], missing: string[], supplied: string[], evidenced: string[],
 *   declined: string[] }} `have` means "do not ask again"; `supplied` means "the analysis has
 *   something to work with". They differ only for declined, and the completion gate reads `supplied`.
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
            // Either half of the effort pair satisfies it for that process.
            if (EFFORT_FIELDS.includes(field)) {
                return EFFORT_FIELDS.some((alt) => present.includes(alt));
            }
            return present.includes(field);
        });
        if (everywhere) provable.add(field);
    }

    // While asking, a claim is believed for anything the payload lacks; while closing, only the payload
    // counts, because at that point a claim is what would let a field vanish. A field is declined only
    // when EVERY process declined it, so one refusal cannot close a question another could answer.
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

        // A declined field is `have` and not `supplied`: do not ask again, but not evidence either.
        const isHad = isDeclined || (closing
            ? provable.has(field)
            : provable.has(field) || (claimedHave !== null && claimedHave.includes(field))
                && !(claimedMissing !== null && claimedMissing.includes(field)));

        (isHad ? have : missing).push(field);

        // Excluded however it arrived, because a claim that a field is `have` must not turn a refusal
        // into evidence.
        if (!isDeclined && (provable.has(field) || isHad)) supplied.push(field);
    }

    // `evidenced` counts a field only when the payload carries a value of the right shape. It exists
    // because `supplied` is not monotonic: mid-interview both it and `have` believe the model's claim for
    // a field the payload lacks, so re-partitioning the two lists moves both while nothing is recorded.
    // It can shrink, because the model rewrites `processes` each turn, so a reader counting it counts
    // against a peak. That makes a working run look stalled near the turn cap; NOTES.md M1 records the
    // rate and why the obvious union fix is a no-op.
    return { have, missing, supplied, evidenced: [...provable], declined: [...declinedEverywhere] };
}

/**
 * The process-level judgement band for a workflow, 1 to 5.
 *
 * Workflow 1 reports judgement per step, because a chain can be almost entirely mechanical with one
 * judgement call in the middle. THE SCALE IS INVERTED: 1 is pure judgement and 5 is pure rules, and
 * everything downstream is written against that direction.
 *
 * Neither an explicit `judgementScore` nor steps falls back to the midpoint, the honest "not enough
 * information" answer rather than a flattering 5.
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

    // A step whose flag is absent or malformed is not counted either way.
    const flagged = steps.filter((step) => step && typeof step.needsReasoning === 'boolean');
    if (flagged.length === 0) return 3;

    const reasoningSteps = flagged.filter(stepNeedsReasoning).length;
    const share = reasoningSteps / flagged.length;

    // No reasoning steps is 5 and every step is 1, rounded.
    return clampToBand(5 - share * 4);
}

/** Forces a value into the 1-5 band. Kept private: the band has one owner. */
function clampToBand(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 3;
    return Math.min(5, Math.max(1, Math.round(n)));
}
