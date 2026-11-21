/**
 * THE SIZE BOUND ON ONE PARTICIPANT FIELD.
 *
 * A participant answer is stored and later assembled into a prompt. Nothing bounded it: a 50,000
 * character string in `task` was accepted by the field shape (`prose` is any non-empty string), stored
 * as sent, and reached the model whole. The document budget in prompt-budget.js cut the message at
 * 32,000, but that does not limit WHO SPENDS IT: one participant with one oversized field consumed the
 * entire budget and 18,532 characters of it were discarded, so a later participant and the structure of
 * the message were squeezed out by the first one to type.
 *
 * THE BOUND IS APPLIED AT THE WRITE PATH, in lib/store/, and it REFUSES rather than truncates. That
 * distinction is the whole point of this line of work:
 *
 *   A truncated answer is a false record. It is stored under the participant's name, counted as their
 *   own words, and read later by the model and by an admin as though the participant had written the
 *   shorter thing. Refusing tells them, while they are still at the form, and they can act on it.
 *
 * THE NUMBERS COME FROM THE DECLARED SHAPE, not from a second table. `FIELD_SHAPES` in
 * ai/field-shapes.js already says what each field is, and that is one rule in one place: this module
 * maps a shape to a size rather than restating which field is which. A field added to FIELD_SHAPES
 * with an existing shape is bounded with no change here, and a field given a shape this module does not
 * know throws, exactly as hasShape does.
 *
 * WHAT EACH BOUND IS FOR, and the evidence behind it.
 *
 * The demo store (data/demo, copied to /tmp and read read-only) holds 8 real responses. The longest
 * prose value in it is 64 characters; the longest text[] entry 39; the longest step value 68. Those are
 * the floor of what real use looks like, not a target, because the demo participants were answering
 * tersely.
 *
 * The interview itself asks for "the work, in their words - a sentence, but a real one", and its own
 * worked examples are one clause each. A careful participant answering the hardest question ("what
 * frustrates you about this work") writes a short paragraph, not a page.
 *
 *   MAX_PROSE_CHARS = 4000
 *     About 600 words, and about sixty times the longest real prose value measured. A paragraph is
 *     two or three sentences; 600 words is a page of dense prose, which is far past anything the
 *     interview asks for and far short of the 50,000 that reached the model. A participant writing
 *     one proud paragraph uses a tenth of it.
 *
 *   MAX_TEXT_ENTRY_CHARS = 500
 *     A text[] entry is a list item: the prompt's own example is "the open folder". 500 characters
 *     is a long sentence, and about twelve times the longest real entry measured (39).
 *
 *   MAX_LIST_LENGTH = 50
 *     A list is people, systems, departments or dependencies. Fifty is more than any real handover
 *     or department list, and it stops the length bound being defeated by count instead of size.
 *
 *   MAX_STEPS = 60
 *     The demo's longest round has 28 turns and a process is described over a handful of steps. 60
 *     is generous for one process and bounds an array that would otherwise be unbounded.
 *
 * A TRANSCRIPT TURN is bounded separately, at MAX_TRANSCRIPT_CHARS = 8000, matching the
 * MAX_CONTENT_CHARS the chat endpoint already applies to one message. That is the same quantity: one
 * turn of the conversation. The write path accepted any length, so a client could store a transcript
 * turn the chat endpoint itself would have refused.
 */

/** The longest one prose field may be, in characters. See the header for the evidence. */
export const MAX_PROSE_CHARS = 4000;

/** The longest one text[] entry may be, in characters. */
export const MAX_TEXT_ENTRY_CHARS = 500;

/** The most entries one text[] field may hold. */
export const MAX_LIST_LENGTH = 50;

/** The most steps one process may hold. */
export const MAX_STEPS = 60;

/** The longest one transcript turn may be, matching the chat endpoint's MAX_CONTENT_CHARS. */
export const MAX_TRANSCRIPT_CHARS = 8000;

/** The longest a `{ declined: "..." }` explanation may be. It is prose, so the same bound. */
export const MAX_DECLINED_WORDS_CHARS = MAX_PROSE_CHARS;

/**
 * The limits that apply to a shape, or a throw for a shape nobody has bounded.
 *
 * Throwing is deliberate: a new shape must be given a bound rather than silently inheriting none,
 * which is exactly how this defect arose. This mirrors hasShape's `Unknown field shape` throw.
 *
 * @param {string} shape one of the FIELD_SHAPES values
 * @returns {{chars: number, entries?: number}}
 */
function limitsForShape(shape) {
    switch (shape) {
        case 'prose':
            return { chars: MAX_PROSE_CHARS };
        case 'text[]':
            return { chars: MAX_TEXT_ENTRY_CHARS, entries: MAX_LIST_LENGTH };
        case 'steps':
            return { chars: MAX_PROSE_CHARS, entries: MAX_STEPS };
        // A count is a number and a period is two numbers: neither can be long, so neither spends
        // budget. They are named rather than defaulted so that adding a shape is a visible decision.
        case 'count':
        case 'period':
            return { chars: 0 };
        default:
            throw new Error(
                `Unknown field shape ${JSON.stringify(shape)}; add a size bound to limitsForShape.`
            );
    }
}

/**
 * Check one stored answer payload against the per-field size bounds.
 *
 * Returns the first problem rather than every problem, because the participant is asked to fix one
 * thing and the route reports it: a list of forty failures is not a message anybody acts on.
 *
 * NOTHING IS TRUNCATED HERE. A value over its bound is reported so the route can refuse it.
 *
 * @param {object} data the payload as the client sent it
 * @param {Record<string, string>} fieldShapes the shape table, normally FIELD_SHAPES
 * @returns {{ok: true} | {ok: false, field: string, reason: string, limit: number, actual: number}}
 */
export function checkAnswerSizes(data, fieldShapes) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: true };

    // The payload is stored as the model sent it, so it may be flat or nested under `workflows`.
    const payloads = Array.isArray(data.workflows) && data.workflows.length > 0
        ? data.workflows
        : [data];

    for (const payload of payloads) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;

        for (const [field, value] of Object.entries(payload)) {
            const shape = fieldShapes[field];
            // A field outside the known set is not sized here: it is not read as evidence by any
            // workflow, and refusing it would reject payloads the interview legitimately carries.
            if (shape === undefined) continue;

            const problem = checkFieldSize(field, value, shape);
            if (problem) return problem;
        }
    }

    return { ok: true };
}

/** One field's value against its shape's limits, or null when it fits. */
function checkFieldSize(field, value, shape) {
    const limits = limitsForShape(shape);

    // A refusal marker carries words too, and they are prose.
    if (value && typeof value === 'object' && !Array.isArray(value)
        && typeof value.declined === 'string'
        && value.declined.length > MAX_DECLINED_WORDS_CHARS) {
        return {
            ok: false, field, limit: MAX_DECLINED_WORDS_CHARS, actual: value.declined.length,
            reason: 'is longer than a reason for declining may be'
        };
    }

    if (shape === 'prose') {
        const text = typeof value === 'string'
            ? value
            : (value && typeof value === 'object' && typeof value.said === 'string' ? value.said : null);
        if (text !== null && text.length > limits.chars) {
            return {
                ok: false, field, limit: limits.chars, actual: text.length,
                reason: 'is longer than one answer may be'
            };
        }
        return null;
    }

    if (shape === 'text[]') {
        if (!Array.isArray(value)) return null;
        if (value.length > limits.entries) {
            return {
                ok: false, field, limit: limits.entries, actual: value.length, unit: 'entries',
                reason: 'has more entries than one list may hold'
            };
        }
        for (const entry of value) {
            if (typeof entry !== 'string') continue;
            if (entry.length > limits.chars) {
                return {
                    ok: false, field, limit: limits.chars, actual: entry.length,
                    reason: 'has an entry longer than a list item may be'
                };
            }
        }
        return null;
    }

    if (shape === 'steps') {
        if (!Array.isArray(value)) return null;
        if (value.length > limits.entries) {
            return {
                ok: false, field, limit: limits.entries, actual: value.length, unit: 'steps',
                reason: 'has more steps than one process may hold'
            };
        }
        for (const step of value) {
            if (!step || typeof step !== 'object') continue;
            for (const [key, inner] of Object.entries(step)) {
                if (typeof inner !== 'string') continue;
                if (inner.length > MAX_PROSE_CHARS) {
                    return {
                        ok: false, field: `${field}.${key}`, limit: MAX_PROSE_CHARS, actual: inner.length,
                        reason: 'is longer than one step description may be'
                    };
                }
            }
        }
        return null;
    }

    return null;
}

/**
 * Check every transcript turn against the per-turn bound.
 *
 * The chat endpoint has always refused a single message over MAX_CONTENT_CHARS, so a transcript turn
 * longer than that is one the server would not have accepted in a conversation. The write path took
 * any length, so the two disagreed about the same quantity.
 *
 * @param {Array<{role: string, content: string}>|undefined} transcript
 * @returns {{ok: true} | {ok: false, index: number, limit: number, actual: number}}
 */
export function checkTranscriptSizes(transcript) {
    if (!Array.isArray(transcript)) return { ok: true };

    for (let i = 0; i < transcript.length; i += 1) {
        const content = transcript[i]?.content;
        if (typeof content === 'string' && content.length > MAX_TRANSCRIPT_CHARS) {
            return { ok: false, index: i, limit: MAX_TRANSCRIPT_CHARS, actual: content.length };
        }
    }
    return { ok: true };
}

/**
 * A stored value that exceeds its bound.
 *
 * Its own class so the route can tell a participant's oversized answer from a store fault, and answer
 * 400 with a readable message rather than 500. An unnamed Error here would be indistinguishable in a
 * log from a broken database, which is exactly the confusion the last few reviews removed.
 */
export class FieldTooLargeError extends Error {
    /**
     * @param {{field: string, limit: number, actual: number, reason: string, unit?: string}} problem
     */
    constructor(problem) {
        super(
            `The answer for ${problem.field} ${problem.reason}: `
            + `${problem.actual} characters, limit ${problem.limit}.`
        );
        this.name = 'FieldTooLargeError';
        this.field = problem.field;
        this.limit = problem.limit;
        this.actual = problem.actual;
        // 'characters' for a length, 'entries' or 'steps' for a count.
        this.unit = problem.unit ?? 'characters';
    }
}

/**
 * Every shape a field can have must have a size bound, and this says so AT LOAD rather than at first
 * use.
 *
 * `limitsForShape` throws on an unknown shape, but only when a field carrying that shape has a value,
 * so an operator who adds a field with an unmapped shape finds out from a participant's complaint: a
 * 500, or the old 409 "the questionnaire is closed", with nothing pointing at the cause. Called from
 * startup, this turns that into a boot failure naming the shape.
 *
 * @param {Record<string, string>} fieldShapes the shape table, normally FIELD_SHAPES
 * @returns {string[]} the shapes with no bound; empty when every shape is covered
 */
export function unboundedShapes(fieldShapes) {
    const missing = [];
    for (const shape of new Set(Object.values(fieldShapes || {}))) {
        try {
            limitsForShape(shape);
        } catch (err) {
            // The throw is the answer; the message is repeated by the caller.
            missing.push(shape);
        }
    }
    return missing;
}

/**
 * Fail to start unless every value in FIELD_SHAPES has a size bound.
 *
 * Throws rather than warning: a field nobody has bounded is exactly how a 50,000 character answer
 * reached the model, and a warning at startup is read once and then scrolled past.
 *
 * @param {Record<string, string>} fieldShapes
 */
export function assertEveryShapeIsBounded(fieldShapes) {
    const missing = unboundedShapes(fieldShapes);
    if (missing.length > 0) {
        throw new Error(
            `These field shapes have no size bound: ${missing.map((s) => JSON.stringify(s)).join(', ')}. `
            + 'Add each to limitsForShape in lib/store/field-limits.js before starting the server.'
        );
    }
}
