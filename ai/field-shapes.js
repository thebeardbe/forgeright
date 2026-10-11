/**
 * The field shapes: what a field must look like to count as supplied.
 *
 * SPLIT OUT OF `ai/matrix.js`, which had grown past the size budget once the
 * frequency minimum and the optional step quotation were added. The seam is real
 * rather than mechanical: everything here answers "does this value have the shape
 * its field requires", and everything left in `matrix.js` answers "what is still
 * missing, and what band does that give". One is a table of rules about values,
 * the other is arithmetic over a set of fields.
 *
 * `ai/matrix.js` RE-EXPORTS ALL OF THIS, so `AI/matrix.js` keeps its public surface
 * and nothing that imports from it has to move. That matters because
 * `test/matrix.test.js` imports these names from `../ai/matrix.js`, and a split
 * that quietly changed an import path would be a change to the tests.
 *
 * THE SHAPE AND THE MINIMUM LIVE WITH THE FIELD, in one table, rather than in a
 * second list of names beside it: two lists are two things to keep in step, and
 * the one that gets forgotten is the one nothing fails on.
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
 * The step field that carries the EVIDENCE for the flag, and it is OPTIONAL.
 *
 * `needsReasoning` is derived by the model and nothing in the code reads
 * `decidedHow`, so a misflagged step is currently invisible: a step reading "I use
 * my judgement" flagged `false` puts a mechanical-looking process at band 5, and
 * one flagged `true` reads judgement as pure rules. `reasoningBasis` is the phrase
 * from `decidedHow` that decided the flag, so a reader can see the two side by
 * side and judge the derivation for themselves.
 *
 * WHY OPTIONAL RATHER THAN REQUIRED. `STEP_FIELDS` is the gate that keeps an
 * incomplete step in `missing`, which is what makes the interview ask again.
 * Putting `reasoningBasis` there would mean a model that forgot the quotation
 * stalls the interview permanently on a step it has otherwise described
 * completely, and an interview that cannot close is a worse failure than a flag
 * shown without its evidence. So the flag stays load-bearing and the quotation is
 * the reviewable extra: when it is present it is shown, and its absence is visible
 * as absence rather than being papered over.
 *
 * Not a check. A heuristic over `decidedHow` would be a worse discriminator
 * dressed as a real one; visibility is the honest fix.
 */
export const OPTIONAL_STEP_FIELDS = Object.freeze(['reasoningBasis']);

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

/**
 * Fields whose value must CLEAR a minimum to count as supplied, with that minimum.
 *
 * THE RULE LIVES WITH THE FIELD, for the same reason the shapes do: a second list
 * of names elsewhere is a second thing to keep in step, and the one that gets
 * forgotten is the one nothing fails on.
 *
 * `frequencyPerWeek: 0` is the case this exists for. Zero does not mean "rare", it
 * means the process does not happen, and a model that did not get a frequency
 * answer can fill `0` as a placeholder. Measured, that completed the interview:
 * `status: complete, missing: [], effort: 0, score: 0`, so a process that
 * contributes nothing closed cleanly and said nothing about why.
 *
 * **THE BOUNDARY IS EXCLUSIVE, so any non-zero frequency still counts.** `0.25`
 * for monthly work is intended and the prompt says so, and `0.01` must not be
 * rounded away by a minimum of 1. Only exact zero is refused.
 *
 * `mistakesPerPeriod` is deliberately ABSENT: "it never goes wrong" is a real
 * answer, and it is the one field where zero carries information rather than
 * signalling a gap. This is why the rule is per field rather than a change to the
 * `count` shape.
 */
export const FIELD_MINIMUMS = Object.freeze({
    frequencyPerWeek: 0
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
 * THE MINIMUM IS APPLIED HERE, by field name, rather than by its caller: a
 * `frequencyPerWeek` of exactly zero passes the `count` shape and must still be
 * refused, and putting that test at each call site is how one call site ends up
 * without it. The comparison is strict, so any non-zero frequency counts.
 *
 * @param {*} value
 * @param {string} shape One of the FIELD_SHAPES values.
 * @param {string} [field] The field name, so a per-field minimum can apply.
 * @returns {boolean}
 */
function hasShape(value, shape, field) {
    if (value === undefined || value === null) return false;

    if (field !== undefined && Object.hasOwn(FIELD_MINIMUMS, field)
        && typeof value === 'number' && !(value > FIELD_MINIMUMS[field])) {
        // Reported as not supplied so the interview asks again, which is the safe
        // direction: one more question rather than a silent zero.
        return false;
    }

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
        if (hasShape(process[field], FIELD_SHAPES[field], field)) present.push(field);
    }

    for (const field of EFFORT_FIELDS) {
        if (hasShape(process[field], FIELD_SHAPES[field], field)) present.push(field);
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
/**
 * Whether a step's basis is a judgement rather than a rule.
 *
 * ONE DEFINITION OF "NEEDS REASONING", because two callers ask it for different
 * figures: `judgementBandFor` below averages a SHARE of flagged steps within one
 * workflow to set the complexity band, and the console counts the MERGED steps
 * that need a person to show a reader the automation boundary. Those numbers are
 * not the same number, but they are the same comparison, and a comparison written
 * twice is a comparison that drifts. Both call this.
 *
 * A non-boolean is NOT a flag: an absent or malformed value says nothing rather
 * than saying "false", because only `true` moves the boundary.
 *
 * @param {object} step
 * @returns {boolean}
 */
export function stepNeedsReasoning(step) {
    return Boolean(step) && step.needsReasoning === true;
}

export function stepIsComplete(step) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return false;

    const required = STEP_FIELDS.every((field) => {
        if (field === 'needsReasoning') return typeof step[field] === 'boolean';
        return hasShape(step[field], 'prose');
    });
    if (!required) return false;

    // A PRESENT OPTIONAL FIELD MUST STILL HAVE ITS SHAPE. An empty string or a
    // number here would render as evidence beside the flag and say nothing, which
    // is worse than omitting it: the reader would take a blank quotation as the
    // model having nothing to say rather than having failed to quote. Absent is
    // fine; present-and-wrong is not.
    return OPTIONAL_STEP_FIELDS.every((field) => {
        if (step[field] === undefined || step[field] === null) return true;
        return hasShape(step[field], 'prose');
    });
}
