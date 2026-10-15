/**
 * The field shapes: what a value must look like to count as supplied.
 *
 * THE SEAM AGAINST `ai/matrix.js` IS REAL: everything here answers "does this value have the shape
 * its field requires", and matrix.js answers "what is still missing, and what band does that
 * give" - a table of rules about values against arithmetic over a set of fields.
 *
 * `ai/matrix.js` RE-EXPORTS THE FIELD TABLES AND THE SHAPE TESTS, so `test/matrix.test.js` keeps
 * importing them from that path. The three readers a weighing needs - `proseSaidIn`, `declinedIn`
 * and `TYPED_MINIMUM_FIELDS` - are imported from here directly instead.
 *
 * THE SHAPE AND THE MINIMUM LIVE WITH THE FIELD, in one table: two lists are two things to keep
 * in step, and the one that gets forgotten is the one nothing fails on.
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
 * NOTHING IN THE CODE READS `decidedHow`, so a misflagged step is invisible: a step reading "I use
 * my judgement" flagged `false` puts a mechanical-looking process at band 5, and one flagged `true`
 * reads judgement as pure rules. `reasoningBasis` is the phrase that decided the flag, so a reader
 * sees the two side by side.
 *
 * WHY NOT REQUIRED: `STEP_FIELDS` is the gate that keeps an incomplete step in `missing`, and
 * putting the quotation there would stall an interview permanently on a step that is otherwise
 * described completely - worse than a flag shown without its evidence.
 *
 * NOT A CHECK: a heuristic over `decidedHow` would be a worse discriminator dressed as a real one.
 */
export const OPTIONAL_STEP_FIELDS = Object.freeze(['reasoningBasis']);

/**
 * THE FIELDS THAT MUST CARRY A TYPED VALUE, and may never be prose.
 *
 * The owner's list, and only those. `{ said: ... }` does not satisfy them, so they are the
 * floor under the completeness guarantee: a model cannot complete an interview by writing
 * prose into every field, because these would still be missing.
 *
 * FIVE NAMES, FOUR REQUIREMENTS: `frequencyPerWeek` and `timePerPeriod` are the either/or effort
 * pair and either satisfies it, so listing both is what makes each of them refuse prose - the pair
 * rule is applied where the missing list is computed, so the two mechanisms need not know each
 * other.
 *
 * `peopleAffected` IS DELIBERATELY ABSENT: "I am alone on this" is a good answer needing no number,
 * and refusing it would make the interview ask for a figure the participant has no reason to give.
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
 * THIS IS AN ANSWER, NOT A REFUSAL, and the difference is `declined` below. "It depends on
 * the supplier" is the participant telling you something real that will not fit a typed field;
 * "I have no idea" is them telling you nothing. Both used to arrive here, which let a refusal
 * be recorded as an answer and complete an interview - see the note on declinedIn.
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
 * Whether a `{ declined: ... }` marker was given, and the words that came with it.
 *
 * THE FOURTH STATE, and the reason the matrix has THREE lists rather than two:
 *
 *   absent     never asked                     -> in `missing`, ask about it
 *   typed      a value of the right shape      -> in `have`, supplied
 *   said       a real answer, in their words   -> in `have`, SUPPLIED
 *   declined   asked, and no answer given      -> NOT missing, NOT supplied
 *
 * A REFUSAL PULLS IN TWO DIRECTIONS AND MUST SATISFY BOTH: it stops the interview asking
 * again, because a participant with nothing to give asked a third time is the loop this
 * system exists to prevent; and it must NOT count as supplied, or refusing everything would
 * finish an interview. `have` means "do not ask again", `supplied` means "the analysis has
 * something to work with" - this field is in the first and not the second.
 *
 * WHY IT IS NOT "ANOTHER KIND OF said", measured: before the split, a live interview
 * recorded `{"said":"I have no idea"}` against seven fields and COMPLETED, so a fabrication
 * reached the audit. The words are kept, so the roadmap reports honestly that this was asked
 * and not answered. `{ declined: true }` is accepted with no words.
 *
 * @param {*} value
 * @returns {{declined: true, words: string|null}|null}
 */
export function declinedIn(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (!Object.hasOwn(value, 'declined')) return null;

    const declined = value.declined;
    if (declined === true) return { declined: true, words: null };

    // A string keeps what they said, so the reader sees the refusal itself rather than a
    // summary of it. An empty string is a refusal without words, not a malformed marker.
    if (typeof declined === 'string') {
        const words = declined.trim();
        return { declined: true, words: words === '' ? null : words };
    }

    return null;
}

/**
 * The shape each field must have to count as supplied.
 *
 * TYPE IS PART OF THE ANSWER, NOT A DETAIL, and the reason is measured: checking only for
 * emptiness let `frequencyPerWeek: "forty"` satisfy the matrix, so the interview closed reporting
 * `missing: 0` and scored the workflow at zero effort - a headline reading "nothing worth
 * automating", indistinguishable from a correct empty result. A wrong type therefore counts as
 * MISSING and the interview keeps asking: one more question rather than a silent zero.
 *
 * THE SHAPE LIVES WITH THE FIELD, in one table, rather than in a second list of names beside it.
 *
 * `prose` is a non-empty string (the participant's own words). `text[]` is a non-empty array of
 * strings. `count` is a finite number, and ZERO IS A REAL ANSWER ("it never goes wrong") while a
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
 * THE PROSE MARKER IS CHECKED FIRST, AND FOR EVERY SHAPE. `{ said: "<the participant's words>" }`
 * records an answer that will not fit the field's type; it counts as supplied for any shape EXCEPT
 * the four in TYPED_MINIMUM_FIELDS, so the interview stops asking about a field that was genuinely
 * answered and the words are kept rather than lost.
 *
 * WHY IT EXISTS: a model could only supply a correctly-typed value, so an answer that was real but
 * not a number - "it depends on the mail, no rule I can make" - had NOWHERE TO GO. The field stayed
 * missing and a real interview looped on the same question five times.
 *
 * IT IS NOT AN ESCAPE FROM THE GATE: TYPED_MINIMUM_FIELDS refuses it, so a model cannot complete
 * an interview by writing prose into everything - demonstrated in the tests. `missing` still names
 * a field that is ABSENT; this distinguishes "they answered, in words" from "never asked".
 * CHECKED BEFORE THE PER-FIELD MINIMUM, or `{ said: ... }` on a numeric field falls through to the
 * minimum and loses that distinction.
 *
 * A REFUSAL IS ANSWERED-BUT-NOT-SUPPLIED, which is neither of the two things this function
 * returns. It is resolved in `fieldsPresentIn` and `fieldsDeclinedIn`; FALSE here stops anything
 * downstream mistaking it for a usable value. See `declinedIn` for why the two must differ.
 *
 * @param {string} shape One of the FIELD_SHAPES values.
 * @param {string} [field] The field name, so a per-field minimum can apply.
 * @returns {boolean}
 */
function hasShape(value, shape, field) {
    if (value === undefined || value === null) return false;

    // See the prose-marker note above.
    if (declinedIn(value) !== null) return false;

    const said = proseSaidIn(value);
    if (said !== null) return !TYPED_MINIMUM_FIELDS.includes(field);

    // A LOWER BOUND ONLY, and not a general range check: there is no upper limit, and a
    // non-number falls through to the shape switch below. Reading it as a range check would invite
    // an upper bound to be added here without the shape being consulted at all.
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
 * Whether a step's basis is a judgement rather than a rule.
 *
 * ONE DEFINITION, because two callers ask it for different figures: `judgementBandFor` averages a
 * SHARE of flagged steps within a workflow, and the console counts the merged steps needing a
 * person. Different numbers, the same comparison - and a comparison written twice drifts.
 *
 * A NON-BOOLEAN IS NOT A FLAG: an absent or malformed value says nothing rather than "false",
 * because only `true` moves the boundary.
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

/**
 * Whether one step carries every field the matrix needs.
 *
 * The shapes are written in `stepFieldIsUsable` rather than in FIELD_SHAPES: the step table is
 * small and fixed, and a step's `name` is prose for the same reason a process's `task` is.
 *
 * @param {object} step
 * @returns {boolean}
 */
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
 * `steps` IS THE ONLY FIELD WHOSE GATE SITS INSIDE A CONTAINER, and a single bit was not enough.
 * A step counts only when all four of its fields are present, so a participant who answers the
 * basis question before the step has a label moves nothing: `steps` stays in `missing`, the model
 * is told to ask about a field it has partly answered, and it re-asks in different words. MEASURED
 * three times in one interview.
 *
 * THE COMPLETION GATE IS UNTOUCHED - `stepIsComplete` still requires all four, so an interview
 * cannot close on a partial step. This answers a different question: what is still needed.
 *
 * THE UNION ACROSS INCOMPLETE STEPS, not a per-step report, because the consumer is ONE question
 * for the whole conversation. A complete step contributes nothing, so an empty array means `steps`
 * is about to leave `missing`.
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
