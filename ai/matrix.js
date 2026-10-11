/**
 * The completeness matrix.
 *
 * Workflow 1 asks the model to fill this in from whatever the participant says,
 * and to report which fields it has and which it still needs. The two lists are
 * what make the loop testable by the SCRIPT rather than by trusting the model's
 * prose: `missing` empty is what finishes the interview, not the model's own
 * sense that it is done.
 *
 * The list lives here rather than in the prompt alone, because the prompt is a
 * document a model reads and this is the thing the server validates against. Two
 * copies written in different languages is how they drift.
 */

/** Fields required per process, in the order the prompt introduces them. */
export const PROCESS_FIELDS = Object.freeze([
    'task',
    'trigger',
    'steps',
    'peopleAffected',
    'handoffTo',
    'waitsFor',
    'dependsOn',
    'systems',
    'touchedDepartments',
    'mistakesPerPeriod',
    'mistakeConsequence',
    'currentState',
    'frustration'
]);

/**
 * The fields that satisfy "how much of this is there".
 *
 * ONE OF THESE, NOT BOTH. Per-instance work has a frequency; continuous work
 * (overseeing a line, watching a queue) has a time per period, and asking "how
 * long does one instance take" of it is unanswerable. The pair is treated as one
 * requirement, so the model picks and says which.
 */
export const EFFORT_FIELDS = Object.freeze(['frequencyPerWeek', 'timePerPeriod']);

/** Fields required per step, inside steps[]. */
export const STEP_FIELDS = Object.freeze(['name', 'whatHappens', 'decidedHow', 'needsReasoning']);

/**
 * The shape each field must have to count as supplied.
 *
 * TYPE IS PART OF THE ANSWER, NOT A DETAIL. Checking only for emptiness let a
 * wrong-typed field pass: `frequencyPerWeek: "forty"` satisfied the matrix, so
 * the interview closed reporting `missing: 0` and then scored the workflow at
 * zero effort. The headline read as "this business has nothing worth automating",
 * which is indistinguishable from a correct empty result. The matrix exists to
 * make a missing field LOUD; a wrong-typed one has to be as loud as an absent one.
 *
 * So a wrong type counts as MISSING and the interview keeps asking, which is the
 * safe direction: one more question rather than a silent zero.
 *
 * THE SHAPE LIVES WITH THE FIELD, in one table, rather than in a second list of
 * names beside this one. Two lists are two things to keep in step, and the one
 * that gets forgotten is the one nothing fails on.
 *
 * `prose` means a non-empty string: the participant's own words, which is what
 * the field is for. A number there is not prose.
 * `text[]` means a non-empty array of strings.
 * `count` means a finite number. Zero is a real answer ("it never goes wrong"),
 * so it counts as supplied; a negative one is not, since a count cannot be.
 */
export const FIELD_SHAPES = Object.freeze({
    task: 'prose',
    trigger: 'prose',
    steps: 'steps',
    peopleAffected: 'count',
    handoffTo: 'text[]',
    waitsFor: 'text[]',
    dependsOn: 'text[]',
    systems: 'text[]',
    touchedDepartments: 'text[]',
    mistakesPerPeriod: 'count',
    mistakeConsequence: 'prose',
    currentState: 'prose',
    frustration: 'prose',
    frequencyPerWeek: 'count',
    timePerPeriod: 'period'
});

/** Every process-level field name, including the either/or pair, for reporting. */
export const ALL_PROCESS_FIELD_NAMES = Object.freeze([
    ...PROCESS_FIELDS,
    ...EFFORT_FIELDS
]);

/**
 * Whether a value has the shape its field requires.
 *
 * Empty is NOT supplied, whichever shape it is: `handoffTo: []` says "the work
 * does not go anywhere else", which is a real answer only if the participant said
 * so, and treating it as filled is how a field silently disappears from the
 * matrix. The model must leave it out and keep it in `missing` until it knows.
 *
 * @param {*} value
 * @param {string} shape One of the FIELD_SHAPES values.
 * @returns {boolean}
 */
function hasShape(value, shape) {
    if (value === undefined || value === null) return false;

    switch (shape) {
        case 'prose':
            // The participant's words. A number or an object here is not prose.
            return typeof value === 'string' && value.trim() !== '';

        case 'text[]':
            return Array.isArray(value) && value.length > 0
                && value.every((entry) => typeof entry === 'string' && entry.trim() !== '');

        case 'count':
            // Zero is a real answer; a negative count is not a count.
            return typeof value === 'number' && Number.isFinite(value) && value >= 0;

        case 'steps':
            return Array.isArray(value) && value.length > 0 && value.every(stepIsComplete);

        case 'period':
            // The prompt's own shape for continuous work: { hours, period }.
            return isPeriod(value);

        default:
            // An unknown shape is a programming error, not a value to judge.
            throw new Error(`Unknown field shape ${JSON.stringify(shape)}; add it to FIELD_SHAPES and hasShape.`);
    }
}

/**
 * Whether a value is the continuous-work shape the prompt asks for.
 *
 * TWO ACCEPTED FORMS, because the participant's own words are a valid answer as
 * well as the structured object:
 *
 *   { hours: 6, period: "week" }   the shape the prompt documents, convertible to
 *                                  weekly hours by the effort calculation
 *   "2 hours a day"                a description, which answers the field but
 *                                  cannot be converted without parsing prose
 *
 * The structured form is what M1's conversion reads. A description is accepted so
 * that an interview which got a real answer is not told the field is missing, and
 * because the matrix asks for the participant's words rather than a particular
 * encoding. Its hours are read as ZERO by the effort calculation, and that is
 * deliberate and visible: `timePerPeriodIsScorable` says which kind arrived, so a
 * caller can tell "this workflow consumes nothing" from "this description could
 * not be measured".
 *
 * A wrong-typed value that is neither, such as a number or an array, is refused.
 *
 * @param {*} value
 * @returns {boolean}
 */
export function isPeriod(value) {
    if (typeof value === 'string') return value.trim() !== '';
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (typeof value.hours !== 'number' || !Number.isFinite(value.hours) || value.hours <= 0) return false;
    return PERIODS_IN_WEEK[value.period] !== undefined;
}

/**
 * Whether a `timePerPeriod` can actually be turned into weekly hours.
 *
 * TRUE for the structured shape, FALSE for a description. The distinction exists
 * so a zero effort figure can be read correctly: a scorable period of zero would
 * mean the work consumes nothing, while an unscorable description means the
 * figure is unknown. Collapsing those two is how "we could not measure it" starts
 * reading as "there is nothing here".
 *
 * @param {*} value
 * @returns {boolean}
 */
export function timePerPeriodIsScorable(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        && typeof value.hours === 'number' && Number.isFinite(value.hours) && value.hours > 0
        && PERIODS_IN_WEEK[value.period] !== undefined;
}

/**
 * How many of each period fit in a week.
 *
 * The conversion M1 needed. One table, used by the effort calculation, so a period
 * this system cannot read is rejected at the matrix rather than scoring zero.
 */
export const PERIODS_IN_WEEK = Object.freeze({
    day: 5,      // A working week, matching how the prompt reads "daily".
    week: 1,
    month: 1 / 4.345,
    quarter: 1 / 13,
    year: 1 / 52
});

/**
 * The process fields a process object actually supplies.
 *
 * The either/or pair collapses to whichever is present, so a process with
 * `timePerPeriod` and no `frequencyPerWeek` is not reported as missing anything.
 *
 * @param {object} process
 * @returns {string[]}
 */
export function fieldsPresentIn(process) {
    if (!process || typeof process !== 'object' || Array.isArray(process)) return [];

    const present = [];

    for (const field of PROCESS_FIELDS) {
        // `steps` carries its own shape check inside hasShape, which requires every
        // step to be complete. A step without `decidedHow` is precisely the case
        // the matrix exists to catch, so `steps` stays missing until they all are.
        if (hasShape(process[field], FIELD_SHAPES[field])) present.push(field);
    }

    for (const field of EFFORT_FIELDS) {
        if (hasShape(process[field], FIELD_SHAPES[field])) present.push(field);
    }

    return present;
}

/**
 * Whether one step carries every field the matrix needs.
 *
 * The step fields are prose and one boolean, so the shapes are written here rather
 * than in FIELD_SHAPES: the step table is small and fixed, and a step's `name` is
 * prose for the same reason a process's `task` is.
 */
export function stepIsComplete(step) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return false;

    return STEP_FIELDS.every((field) => {
        if (field === 'needsReasoning') return typeof step[field] === 'boolean';
        return hasShape(step[field], 'prose');
    });
}

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

    const flagged = steps.filter((step) => step && typeof step.needsReasoning === 'boolean');
    if (flagged.length === 0) return 3;

    const reasoningSteps = flagged.filter((step) => step.needsReasoning === true).length;
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
