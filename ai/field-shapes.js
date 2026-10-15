/**
 * The field shapes: what a value must look like to count as supplied, as against matrix.js, which answers
 * what is still missing and what band that gives.
 *
 * matrix.js re-exports the field tables and the shape tests, so `test/matrix.test.js` keeps importing them
 * from that path.
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
 * The fields that satisfy "how much of this is there", one of them and not both: per-instance work has a
 * frequency, while continuous work has a time per period, and the pair counts as one requirement.
 */
export const EFFORT_FIELDS = Object.freeze(['frequencyPerWeek', 'timePerPeriod']);

/** Fields required per step, inside steps[]. */
export const STEP_FIELDS = Object.freeze(['name', 'whatHappens', 'decidedHow', 'needsReasoning']);

/**
 * The step field carrying the evidence for the flag, and it is optional so that a step described
 * completely does not stall the interview. Nothing reads `decidedHow`, so a misflagged step is invisible
 * without it.
 */
export const OPTIONAL_STEP_FIELDS = Object.freeze(['reasoningBasis']);

/**
 * The fields that must carry a typed value, and may never be prose, which makes them the floor under the
 * completeness guarantee: a model cannot complete an interview by writing prose into every field.
 *
 * Five names, four requirements: listing both members of the either/or effort pair is what makes each of
 * them refuse prose. `peopleAffected` is deliberately absent, because "I am alone on this" is a good
 * answer needing no number.
 */
export const TYPED_MINIMUM_FIELDS = Object.freeze([
    'task', 'trigger', 'steps', 'frequencyPerWeek', 'timePerPeriod'
]);

/**
 * The words inside a `{ said: ... }` marker, or null when the value is not one. A malformed marker, such
 * as an empty string or a number, is not a marker and falls through to the shape check.
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
 * Whether a `{ declined: ... }` marker was given, and the words that came with it. Declined is the fourth
 * state: not missing, so the interview stops asking, and not supplied, so refusing everything cannot
 * finish an interview. `{ declined: true }` is accepted with no words.
 *
 * @param {*} value
 * @returns {{declined: true, words: string|null}|null}
 */
export function declinedIn(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (!Object.hasOwn(value, 'declined')) return null;

    const declined = value.declined;
    if (declined === true) return { declined: true, words: null };

    // An empty string is a refusal without words, not a malformed marker.
    if (typeof declined === 'string') {
        const words = declined.trim();
        return { declined: true, words: words === '' ? null : words };
    }

    return null;
}

/**
 * The shape each field must have to count as supplied; a wrong type counts as missing, so the interview
 * keeps asking rather than scoring a silent zero.
 *
 * `count` treats zero as a real answer while a negative count is not.
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
 * Fields whose value must clear a minimum to count as supplied, with that minimum. The boundary is
 * exclusive, so any non-zero frequency still counts, and `mistakesPerPeriod` is deliberately absent
 * because that is the one field where zero carries information rather than signalling a gap.
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
 * Whether a value has the shape its field requires. Empty is not supplied, whichever shape it is, because
 * treating `handoffTo: []` as filled is how a field silently disappears from the matrix.
 *
 * The minimum is applied here, by field name, so that no call site can skip it. The prose marker is
 * checked first and before the minimum: it counts as supplied for any shape except the four in
 * TYPED_MINIMUM_FIELDS, and a refusal returns false so nothing downstream reads it as a usable value.
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

    // A lower bound only: a non-number falls through to the shape switch, and the strict comparison
    // keeps a fractional frequency like `0.25` above a minimum of 0.
    if (field !== undefined && Object.hasOwn(FIELD_MINIMUMS, field)
        && typeof value === 'number' && !(value > FIELD_MINIMUMS[field])) {
        // Not supplied, so the interview asks again rather than scoring a silent zero.
        return false;
    }

    switch (shape) {
        case 'prose':
            return typeof value === 'string' && value.trim() !== '';

        case 'text[]':
            return Array.isArray(value) && value.length > 0
                && value.every((entry) => typeof entry === 'string' && entry.trim() !== '');

        case 'count':
            return typeof value === 'number' && Number.isFinite(value) && value >= 0;

        case 'steps':
            return Array.isArray(value) && value.length > 0 && value.every(stepIsComplete);

        case 'period':
            return isPeriod(value);

        default:
            throw new Error(`Unknown field shape ${JSON.stringify(shape)}; add it to FIELD_SHAPES and hasShape.`);
    }
}


/**
 * The process fields a process object actually supplies, with the either/or pair collapsing to whichever
 * is present.
 *
 * @param {object} process
 * @returns {string[]}
 */
export function fieldsPresentIn(process) {
    if (!process || typeof process !== 'object' || Array.isArray(process)) return [];

    const present = [];

    for (const field of PROCESS_FIELDS) {
        if (hasShape(process[field], FIELD_SHAPES[field], field)) present.push(field);
    }

    for (const field of EFFORT_FIELDS) {
        if (hasShape(process[field], FIELD_SHAPES[field], field)) present.push(field);
    }

    return present;
}

/**
 * Whether a step's basis is a judgement rather than a rule: only `true` moves the boundary, so an absent
 * or malformed flag is not a false one.
 *
 * @param {object} step
 * @returns {boolean}
 */
export function stepNeedsReasoning(step) {
    return Boolean(step) && step.needsReasoning === true;
}

/**
 * Whether one step field holds a usable value, in one place for both `stepIsComplete` and `stepGapsFor`.
 * `needsReasoning` is the model's own boolean and must be a boolean.
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
 * Whether one step carries every field the matrix needs. A present optional field must still have the
 * right shape, because a blank quotation beside the flag reads as the model having nothing to say.
 *
 * @param {object} step
 * @returns {boolean}
 */
export function stepIsComplete(step) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return false;

    const required = STEP_FIELDS.every((field) => stepFieldIsUsable(step, field));
    if (!required) return false;

    return OPTIONAL_STEP_FIELDS.every((field) => {
        if (step[field] === undefined || step[field] === null) return true;
        return hasShape(step[field], 'prose');
    });
}

/**
 * Which step fields are still missing, so the interviewer knows what to ask next. `steps` is the only
 * field whose gate sits inside a container, so a partial step would otherwise move nothing and the model
 * would re-ask in different words.
 *
 * The union across incomplete steps, not a per-step report, because the consumer is one question for the
 * whole conversation.
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
            // A malformed entry has every field missing.
            for (const field of STEP_FIELDS) gaps.add(field);
            continue;
        }
        for (const field of STEP_FIELDS) {
            if (!stepFieldIsUsable(step, field)) gaps.add(field);
        }
    }

    // STEP_FIELDS order, so the output is stable across calls and a reader comparing two turns sees the
    // same ordering.
    return STEP_FIELDS.filter((field) => gaps.has(field));
}

/**
 * The period helpers live in `./period.js` and are re-exported here, so `isPeriod`,
 * `timePerPeriodIsScorable` and `PERIODS_IN_WEEK` still resolve from this module.
 */
// Imported as well as re-exported: `hasShape` calls `isPeriod`, and a bare `export ... from` does not
// bring the name into this module's scope.
import { isPeriod } from './period.js';

export { isPeriod, timePerPeriodIsScorable, PERIODS_IN_WEEK } from './period.js';
