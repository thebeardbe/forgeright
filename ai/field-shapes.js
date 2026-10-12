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
 * THE FIELDS THAT MUST CARRY A TYPED VALUE, and may never be prose.
 *
 * The owner's list, and only those. `{ said: ... }` does not satisfy them, so they are the
 * floor under the completeness guarantee: a model cannot complete an interview by writing
 * prose into every field, because these would still be missing.
 *
 * FIVE NAMES, FOUR REQUIREMENTS: `frequencyPerWeek` and `timePerPeriod` are the either/or
 * effort pair, and EITHER satisfies it. Listing both is what makes each of them refuse
 * prose - the pair rule is applied where the missing list is computed, so the two mechanisms
 * do not need to know about each other.
 *
 * `peopleAffected` IS DELIBERATELY ABSENT. "I am alone on this" is a good answer that needs no
 * number, and refusing it would make the interview ask for a figure the participant has no
 * reason to give. See the note on the weighing for the consequence that follows from that.
 */
export const TYPED_MINIMUM_FIELDS = Object.freeze([
    'task', 'trigger', 'steps', 'frequencyPerWeek', 'timePerPeriod'
]);

/**
 * The words inside a `{ said: ... }` marker, or null when the value is not one.
 *
 * ONE PLACE DECIDES WHAT THE MARKER IS, so `hasShape` and every reader agree. A malformed
 * marker - an empty string, a number, extra keys - is NOT a marker: it returns null and falls
 * through to the ordinary shape check, which refuses it. Anything else would make
 * `{ said: "" }` a way to close a field by asserting nothing.
 *
 * @param {*} value
 * @returns {string|null}
 */
export function proseSaidIn(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (!Object.hasOwn(value, 'said')) return null;
    const said = value.said;
    if (typeof said !== 'string' || said.trim() === '') return null;
    return said;
}

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

    // THE PROSE MARKER IS CHECKED FIRST, AND FOR EVERY SHAPE.
    //
    // `{ said: "<the participant's words>" }` records an answer that will not fit the field's
    // type. It counts as supplied for any shape EXCEPT the four in TYPED_MINIMUM_FIELDS, so
    // the interview stops asking about a field the participant has genuinely answered, and
    // their words are kept rather than lost.
    //
    // WHY IT EXISTS. A model could only supply a field by placing a correctly-typed value in
    // the payload, so an answer that was real but not a number - "it depends on the mail, no
    // rule I can make" - had NOWHERE TO GO. The field stayed missing, the model asked the only
    // question it had for it, and a real interview looped on the same question five times
    // because the participant's answers could never satisfy it.
    //
    // IT IS NOT AN ESCAPE FROM THE GATE. The fields in TYPED_MINIMUM_FIELDS refuse it,
    // so a model cannot complete an interview by writing prose into everything - demonstrated
    // in the tests. `missing` still names a field that is ABSENT; this distinguishes "they
    // answered, in words" from "they were never asked".
    //
    // CHECKED BEFORE THE PER-FIELD MINIMUM, so `{ said: ... }` on a numeric field is judged by
    // this rule rather than falling through to the minimum, which would report it as not
    // supplied and lose the distinction between prose and absence.
    const said = proseSaidIn(value);
    if (said !== null) return !TYPED_MINIMUM_FIELDS.includes(field);

    // A LOWER BOUND ONLY, and only for numbers. This is not a general range check:
    // there is no upper limit, and a value that is not a number falls through to
    // the shape switch below, which refuses it there. Written this way because the
    // one rule that exists (`frequencyPerWeek` above zero) is a minimum, and
    // reading it as a range check would invite an upper bound to be added here
    // later without the shape being consulted at all.
    //
    // The comparison is written INVERTED on purpose: `!(value > min)` rather than
    // `value <= min`. They agree for every finite number, and they part company at
    // NaN: `NaN <= min` is false, so a naive `value <= min` would let a NaN through
    // as if it cleared the minimum, while `!(NaN > min)` is true and refuses it. Do
    // not "simplify" this one. It is also STRICT, so a fractional frequency like
    // `0.25` passes a minimum of 0.
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

/**
 * Whether one step field holds a usable value.
 *
 * ONE PLACE DECIDES THIS FOR BOTH stepIsComplete AND stepGapsFor. They answer
 * different questions about the same step - "may the interview close?" and "what
 * should be asked next?" - and a field-shape rule written twice is a rule that
 * drifts, which is how `steps` came to be the only all-or-nothing field in the
 * first place.
 *
 * `needsReasoning` is the model's own boolean, so it must BE a boolean: an absent
 * or malformed flag is not a false one. Every other step field is prose.
 *
 * @param {object} step
 * @param {string} field One of STEP_FIELDS.
 * @returns {boolean}
 */
function stepFieldIsUsable(step, field) {
    if (field === 'needsReasoning') return typeof step[field] === 'boolean';
    return hasShape(step[field], 'prose');
}

export function stepIsComplete(step) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return false;

    const required = STEP_FIELDS.every((field) => stepFieldIsUsable(step, field));
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

/**
 * Which step fields are still missing, so the interviewer knows what to ask NEXT.
 *
 * WHY THIS EXISTS, AND WHY THE SINGLE BIT WAS NOT ENOUGH. `steps` is the only field
 * whose completeness gate sits inside a container: every other field accepts the
 * smallest real answer, while a step counts only when `name`, `whatHappens`,
 * `decidedHow` and `needsReasoning` are ALL present. So a participant who answers the
 * basis question before the step has a label or a description moves nothing: `steps`
 * stays in `missing`, the model is told to ask about a field it has partly answered,
 * and it asks the same question again in different words. That was observed on a real
 * interview, three times in one conversation.
 *
 * THE COMPLETION GATE IS NOT TOUCHED. `stepIsComplete` still decides whether a step
 * is done and still requires all four fields, so an interview cannot close on a
 * partial step. THIS FUNCTION ANSWERS A DIFFERENT QUESTION - what is still needed -
 * and the two are deliberately separate signals from one value.
 *
 * THE UNION ACROSS INCOMPLETE STEPS, NOT A PER-STEP REPORT, because the consumer is
 * ONE question for the whole conversation. The interviewer asks about one thing per
 * turn, so what it needs to know is the set of fields that would move some step
 * forward. A per-step breakdown would name `name` for step 3 while step 1 also needs
 * `needsReasoning`, and choosing between them is a decision this function has no way
 * to make well; the union is what the next question can act on either way.
 *
 * A COMPLETE STEP CONTRIBUTES NOTHING. Once every step is complete this returns an
 * empty array, which is the signal that `steps` is about to leave `missing`.
 *
 * @param {unknown} steps The process's `steps` value, in whatever shape it arrived.
 * @returns {string[]} The absent fields, in STEP_FIELDS order, deduplicated.
 */
export function stepGapsFor(steps) {
    if (!Array.isArray(steps) || steps.length === 0) return [...STEP_FIELDS];

    const gaps = new Set();
    for (const step of steps) {
        if (stepIsComplete(step)) continue;
        if (!step || typeof step !== 'object' || Array.isArray(step)) {
            // A malformed entry has every field missing. Not the same as a step with
            // some fields present, and saying so keeps the next question honest.
            for (const field of STEP_FIELDS) gaps.add(field);
            continue;
        }
        for (const field of STEP_FIELDS) {
            if (!stepFieldIsUsable(step, field)) gaps.add(field);
        }
    }

    // STEP_FIELDS order, so the output is stable across calls and a reader comparing
    // two turns sees the same ordering. A Set's insertion order would depend on which
    // step happened to be inspected first.
    return STEP_FIELDS.filter((field) => gaps.has(field));
}

/**
 * The period helpers now live in `./period.js` and are RE-EXPORTED here.
 *
 * MOVED RATHER THAN JUST DELETED, and re-exported, so `isPeriod`,
 * `timePerPeriodIsScorable` and `PERIODS_IN_WEEK` still resolve from this module and
 * nothing importing them has to move. They are a self-contained concern - one table
 * and two predicates over it, with no dependency on `hasShape` - which is what made
 * them the clean thing to lift when this file passed its size budget.
 */
// IMPORTED AS WELL AS RE-EXPORTED, which is not redundant: `hasShape` below CALLS
// `isPeriod` for the 'period' shape, and a bare `export ... from` does not bring the
// name into this module's scope. The first version of this split used the re-export
// alone and every period test failed with "isPeriod is not defined" at the call site
// inside hasShape - caught by the suite, and worth stating because the two lines look
// like they do the same job.
import { isPeriod } from './period.js';

export { isPeriod, timePerPeriodIsScorable, PERIODS_IN_WEEK } from './period.js';
