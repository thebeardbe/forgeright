/**
 * The field shapes: what a value must look like to count as supplied. Everything here answers "does
 * this value have the shape its field requires", and matrix.js answers "what is still missing, and
 * what band does that give".
 *
 * matrix.js re-exports the field tables and the shape tests, so `test/matrix.test.js` keeps importing
 * them from that path. The shape and the minimum live with the field, in one table, because two lists
 * are two things to keep in step.
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
 * The fields that satisfy "how much of this is there", one of them and not both: per-instance work has
 * a frequency, while continuous work (overseeing a line, watching a queue) has a time per period, and
 * asking "how long does one instance take" of it is unanswerable. The pair is treated as one
 * requirement.
 */
export const EFFORT_FIELDS = Object.freeze(['frequencyPerWeek', 'timePerPeriod']);

/** Fields required per step, inside steps[]. */
export const STEP_FIELDS = Object.freeze(['name', 'whatHappens', 'decidedHow', 'needsReasoning']);

/**
 * The step field that carries the evidence for the flag, and it is optional. Nothing in the code reads
 * `decidedHow`, so a misflagged step is invisible unless the phrase that decided the flag is kept
 * beside it. Requiring it would stall an interview permanently on a step that is otherwise described
 * completely, which is worse than a flag shown without its evidence.
 */
export const OPTIONAL_STEP_FIELDS = Object.freeze(['reasoningBasis']);

/**
 * The fields that must carry a typed value, and may never be prose. `{ said: ... }` does not satisfy
 * them, so they are the floor under the completeness guarantee: a model cannot complete an interview
 * by writing prose into every field, because these would still be missing.
 *
 * Five names, four requirements: `frequencyPerWeek` and `timePerPeriod` are the either/or effort pair,
 * and listing both is what makes each of them refuse prose. `peopleAffected` is deliberately absent,
 * because "I am alone on this" is a good answer needing no number.
 */
export const TYPED_MINIMUM_FIELDS = Object.freeze([
    'task', 'trigger', 'steps', 'frequencyPerWeek', 'timePerPeriod'
]);

/**
 * The words inside a `{ said: ... }` marker, or null when the value is not one. One place decides what
 * the marker is, so `hasShape` and every reader agree; a malformed marker, such as an empty string or a
 * number, is not a marker and falls through to the ordinary shape check, which refuses it.
 *
 * This is an answer rather than a refusal, and the difference is `declined` below: "it depends on the
 * supplier" is something real that will not fit a typed field, while "I have no idea" is nothing.
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
 * Whether a `{ declined: ... }` marker was given, and the words that came with it. This is the fourth
 * state, and the reason the matrix has three lists rather than two: absent is never asked, a typed or
 * `said` value is in `have` and supplied, and declined is neither missing nor supplied.
 *
 * A refusal pulls in two directions and satisfies both: it stops the interview asking again, because a
 * participant with nothing to give asked a third time is the loop this system exists to prevent, and
 * it must not count as supplied, or refusing everything would finish an interview. `{ declined: true }`
 * is accepted with no words.
 *
 * @param {*} value
 * @returns {{declined: true, words: string|null}|null}
 */
export function declinedIn(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (!Object.hasOwn(value, 'declined')) return null;

    const declined = value.declined;
    if (declined === true) return { declined: true, words: null };

    // A string keeps what they said, so the reader sees the refusal itself. An empty string is a
    // refusal without words, not a malformed marker.
    if (typeof declined === 'string') {
        const words = declined.trim();
        return { declined: true, words: words === '' ? null : words };
    }

    return null;
}

/**
 * The shape each field must have to count as supplied. Type is part of the answer: a wrong type counts
 * as missing and the interview keeps asking, which is one more question rather than a silent zero.
 *
 * `prose` is a non-empty string, the participant's own words. `text[]` is a non-empty array of
 * strings. `count` is a finite number, and zero is a real answer ("it never goes wrong") while a
 * negative count is not.
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
 * Fields whose value must clear a minimum to count as supplied, with that minimum. The rule lives with
 * the field for the same reason the shapes do.
 *
 * `frequencyPerWeek: 0` is the case this exists for: zero does not mean "rare", it means the process
 * does not happen, and a model that did not get a frequency answer can fill `0` as a placeholder. The
 * boundary is exclusive, so any non-zero frequency still counts: `0.25` for monthly work is intended,
 * and `0.01` must not be rounded away by a minimum of 1.
 *
 * `mistakesPerPeriod` is deliberately absent, because "it never goes wrong" is the one field where zero
 * carries information rather than signalling a gap.
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
 * Empty is not supplied, whichever shape it is: `handoffTo: []` says "the work does not go anywhere
 * else", which is a real answer only if the participant said so, and treating it as filled is how a
 * field silently disappears from the matrix. The minimum is applied here, by field name, rather than by
 * its caller, because putting that test at each call site is how one call site ends up without it.
 *
 * The prose marker is checked first and for every shape: `{ said: "<their words>" }` records an answer
 * that will not fit the field's type, and counts as supplied for any shape except the four in
 * TYPED_MINIMUM_FIELDS. It is not an escape from the gate, because TYPED_MINIMUM_FIELDS refuses it,
 * and it is checked before the per-field minimum, so `{ said: ... }` on a numeric field does not fall
 * through and lose that distinction. A refusal returns false here, so nothing downstream mistakes it
 * for a usable value; see `declinedIn`.
 *
 * @param {*} value
 * @param {string} shape One of the FIELD_SHAPES values.
 * @param {string} [field] The field name, so a per-field minimum can apply.
 * @returns {boolean}
 */
function hasShape(value, shape, field) {
    if (value === undefined || value === null) return false;

    if (declinedIn(value) !== null) return false;

    const said = proseSaidIn(value);
    if (said !== null) return !TYPED_MINIMUM_FIELDS.includes(field);

    // A lower bound only, not a range check: there is no upper limit, and a non-number falls through
    // to the shape switch. The comparison is strict, so a fractional frequency like `0.25` passes a
    // minimum of 0.
    if (field !== undefined && Object.hasOwn(FIELD_MINIMUMS, field)
        && typeof value === 'number' && !(value > FIELD_MINIMUMS[field])) {
        // Not supplied, so the interview asks again, which is the safe direction: one more question
        // rather than a silent zero.
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
 * The process fields a process object actually supplies. The either/or pair collapses to whichever is
 * present, so a process with `timePerPeriod` and no `frequencyPerWeek` is not reported as missing
 * anything.
 *
 * @param {object} process
 * @returns {string[]}
 */
export function fieldsPresentIn(process) {
    if (!process || typeof process !== 'object' || Array.isArray(process)) return [];

    const present = [];

    for (const field of PROCESS_FIELDS) {
        // `steps` carries its own shape check inside hasShape, which requires every step to be
        // complete, so `steps` stays missing until they all are.
        if (hasShape(process[field], FIELD_SHAPES[field], field)) present.push(field);
    }

    for (const field of EFFORT_FIELDS) {
        if (hasShape(process[field], FIELD_SHAPES[field], field)) present.push(field);
    }

    return present;
}

/**
 * Whether a step's basis is a judgement rather than a rule. One definition, because two callers ask it
 * for different figures: `judgementBandFor` averages a share of flagged steps, and the console counts
 * the merged steps needing a person. A non-boolean is not a flag, because only `true` moves the
 * boundary.
 *
 * @param {object} step
 * @returns {boolean}
 */
export function stepNeedsReasoning(step) {
    return Boolean(step) && step.needsReasoning === true;
}

/**
 * Whether one step field holds a usable value: one place decides this for both `stepIsComplete` and
 * `stepGapsFor`, which answer "may the interview close?" and "what should be asked next?" about the
 * same step, and a field-shape rule written twice is a rule that drifts.
 *
 * `needsReasoning` is the model's own boolean, so it must be a boolean: an absent or malformed flag is
 * not a false one. Every other step field is prose.
 *
 * @param {object} step
 * @param {string} field One of STEP_FIELDS.
 * @returns {boolean}
 */
function stepFieldIsUsable(step, field) {
    if (field === 'needsReasoning') return typeof step[field] === 'boolean';
    return hasShape(step[field], 'prose');
}

/**
 * Whether one step carries every field the matrix needs. The shapes are written in
 * `stepFieldIsUsable` rather than in FIELD_SHAPES, because the step table is small and fixed.
 *
 * @param {object} step
 * @returns {boolean}
 */
export function stepIsComplete(step) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return false;

    const required = STEP_FIELDS.every((field) => stepFieldIsUsable(step, field));
    if (!required) return false;

    // A present optional field must still have its shape: an empty string or a number here would
    // render as evidence beside the flag and say nothing, and the reader would take a blank quotation
    // as the model having nothing to say. Absent is fine; present-and-wrong is not.
    return OPTIONAL_STEP_FIELDS.every((field) => {
        if (step[field] === undefined || step[field] === null) return true;
        return hasShape(step[field], 'prose');
    });
}

/**
 * Which step fields are still missing, so the interviewer knows what to ask next. `steps` is the only
 * field whose gate sits inside a container: a step counts only when all four of its fields are present,
 * so a single bit is not enough, because a participant who answers the basis question before the step
 * has a label moves nothing and the model re-asks in different words.
 *
 * The completion gate is untouched, so an interview cannot close on a partial step; this answers what is
 * still needed. The union across incomplete steps, not a per-step report, because the consumer is one
 * question for the whole conversation.
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
            // A malformed entry has every field missing, which is not the same as a step with some
            // fields present.
            for (const field of STEP_FIELDS) gaps.add(field);
            continue;
        }
        for (const field of STEP_FIELDS) {
            if (!stepFieldIsUsable(step, field)) gaps.add(field);
        }
    }

    // STEP_FIELDS order, so the output is stable across calls and a reader comparing two turns sees the
    // same ordering; a Set's insertion order would depend on which step was inspected first.
    return STEP_FIELDS.filter((field) => gaps.has(field));
}

/**
 * The period helpers live in `./period.js` and are re-exported here, so `isPeriod`,
 * `timePerPeriodIsScorable` and `PERIODS_IN_WEEK` still resolve from this module.
 */
// Imported as well as re-exported, which is not redundant: `hasShape` calls `isPeriod` for the
// 'period' shape, and a bare `export ... from` does not bring the name into this module's scope.
import { isPeriod } from './period.js';

export { isPeriod, timePerPeriodIsScorable, PERIODS_IN_WEEK } from './period.js';
