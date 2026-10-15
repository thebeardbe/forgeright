/**
 * The completeness matrix: reconciling what is missing with what the model claims, and reading a
 * process's step flags as a judgement band.
 *
 * `missing` EMPTY IS WHAT FINISHES THE INTERVIEW, not the model's own sense that it is done. That
 * is what makes the loop testable by the script rather than by trusting the model's prose.
 *
 * The field tables, shapes and per-field minimums live in `ai/field-shapes.js` and are re-exported
 * below, so this module's public surface is unchanged.
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
 * The fields a process has been asked about and the participant declined to answer.
 *
 * NOT THE SAME AS MISSING. A declined field WAS asked about, so asking again is the loop this
 * system exists to prevent; and it is not supplied either, so it cannot satisfy the completion
 * gate. See `declinedIn` in field-shapes.js for the full argument.
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
 * The fields a process is still missing, out of the full matrix.
 *
 * THE EITHER/OR PAIR IS ONE REQUIREMENT, read from `fieldsPresentIn` so both callers agree: a
 * process with `frequencyPerWeek` satisfies the effort need, and reporting `timePerPeriod` missing
 * alongside it would send the interviewer back to ask a question it already has the answer to.
     *
     * A DECLINED FIELD IS NOT MISSING. It was asked about and the participant had nothing to give,
     * so asking again is the loop this system exists to prevent. It is not SUPPLIED either - see
     * `fieldsDeclinedIn` - and this function answers only "is there a question left to ask here",
     * which for a declined field is no.
 *
 * @param {object} process
 * @returns {string[]}
 */
export function fieldsMissingFrom(process) {
    const present = new Set(fieldsPresentIn(process));
    const declined = new Set(fieldsDeclinedIn(process));
    const effortSatisfied = EFFORT_FIELDS.some((field) => present.has(field));

    // A declined field is not missing; see the note above.
    return ALL_PROCESS_FIELD_NAMES.filter((field) => {
        if (EFFORT_FIELDS.includes(field)) return !effortSatisfied && !declined.has(field);
        return !present.has(field) && !declined.has(field);
    });
}

/**
 * Reconciles the model's reported have/missing against the processes it sent.
 *
 * THE MODEL'S CLAIM AND THE PAYLOAD SAY DIFFERENT THINGS: `processes` is the partial payload,
 * which mid-interview is a stub, while `have`/`missing` is the model's statement about the
 * CONVERSATION, whether or not it has written it down yet.
 *
 * SO THE PAYLOAD SUBTRACTS, NEVER REPLACES. A field the model claims but the payload lacks is left
 * as claimed - the interview is still going, and disbelieving it would make it re-ask questions
 * already answered. The subtraction catches the dangerous direction instead: a claim that
 * `missing` is empty while a process lacks a field, so the field is put back.
 *
 * @param {object} args
 * @param {Array<object>} args.processes The payload the model sent.
 * @param {string[]|null} args.claimedHave The model's own list, if it sent one.
 * @param {string[]|null} args.claimedMissing The model's own list, if it sent one.
 * @param {boolean} args.closing Whether the model claimed completion.
 * @returns {{ have: string[], missing: string[], supplied: string[], evidenced: string[],
 *   declined: string[] }} `have` means "do not ask again"; `supplied` means "the analysis has
 *   something to work with". They differ for exactly one state - declined - and the completion
 *   gate reads `supplied`, not `have`. `evidenced` is the payload-only list; see `provable`.
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

    // WHILE ASKING, the claim is believed for anything the payload does not carry.
    // WHILE CLOSING, only the payload counts, because at that point it is
    // supposed to hold everything and a claim is what would let a field vanish.
    // WHAT THE PAYLOAD DECLINED, across every process. A field is declined only when EVERY
    // process that could carry it declined: one participant saying "I have no idea" must not
    // close a question that another participant could answer.
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

        // A DECLINED FIELD IS `have` AND NOT `supplied`. That split is the fourth state:
        // do not ask again, but do not count it as evidence. See declinedIn in
        // field-shapes.js for why both halves are needed.
        const isHad = isDeclined || (closing
            ? provable.has(field)
            : provable.has(field) || (claimedHave !== null && claimedHave.includes(field))
                && !(claimedMissing !== null && claimedMissing.includes(field)));

        (isHad ? have : missing).push(field);

        // SUPPLIED MEANS THE ANALYSIS CAN USE IT, which is `provable` for a typed value and
        // the model's own claim while the interview is still going. A declined field is
        // excluded however it arrived, because a claim that a field is `have` must not turn a
        // refusal into evidence - that is the hole the fourth state exists to close.
        if (!isDeclined && (provable.has(field) || isHad)) supplied.push(field);
    }

    // THE PAYLOAD-ONLY LIST, and it exists because `supplied` is NOT monotonic. Mid-interview,
    // `have` and `supplied` both believe the model's CLAIM for a field the payload lacks, so a
    // model that re-partitions its two lists moves both while nothing is recorded - MEASURED as a
    // live model stalling for thirty-one identical questions. `evidenced` counts a field only when
    // the PAYLOAD carries a value of the right shape, the same test `provable` uses at the end.
    //
    // IT CAN SHRINK, because the model rewrites `processes` each turn and drops fields it had
    // filled: one measured series went 1,5,7,6,2,10,2,12,11,0,0,0. THE DESIGN NOTE ELSEWHERE
    // CLAIMS a payload that has a field keeps it, WHICH LIVE RUNS FALSIFY - the sentence is pinned
    // by test/audit-evidence-cap.test.js so the contradiction stays visible. The cap that reads it
    // therefore counts against a PEAK, which is correct for a stall and pessimistic for a dip -
    // recorded as M1 in NOTES.md rather than fixed here.
    return { have, missing, supplied, evidenced: [...provable], declined: [...declinedEverywhere] };
}

/**
 * The process-level judgement band for a workflow, 1 to 5.
 *
 * Workflow 1 reports judgement PER STEP, because a chain can be almost entirely mechanical with
 * one judgement call in the middle, and reading that at process level says "needs a person" and
 * automates nothing. The scorer works in the 1-5 band, so the conversion sits next to the flags it
 * reads.
 *
 * THE SCALE IS INVERTED: 1 is pure judgement and 5 is pure rules, so a workflow with NO reasoning
 * steps scores 5. Everything downstream is written against that direction.
 *
 * Neither an explicit `judgementScore` nor steps falls back to 3, the midpoint - the honest "not
 * enough information" answer rather than a flattering 5.
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
