/**
 * Extracting a JSON object from a model's reply.
 *
 * LOAD-BEARING, NOT A FALLBACK. DeepSeek's JSON mode returns whitespace as a
 * conversation grows (see NOTES-deepseek-json-mode.md for the measurements), so
 * that provider is asked in plain mode and its replies are parsed out of prose.
 * A model that wraps its JSON in a ```json fence is therefore the NORMAL case
 * here, not an edge, and this module has to be right rather than merely likely.
 *
 * WHY NOT indexOf('{') .. lastIndexOf('}'). Three ordinary replies break it:
 *
 *   - two objects in one reply      -> the slice spans both, and neither parses
 *   - a brace inside a string       -> `{"a": "use {braces}"}` ends at the wrong
 *                                      place
 *   - a truncated reply             -> produces a fragment that looks like an
 *                                      object and fails to parse later, with no
 *                                      indication that the model was cut off
 *
 * So this scans with a brace DEPTH counter that honours string literals and their
 * escapes, and returns null when nothing balanced is found, so the caller can say
 * "the model returned no JSON" rather than surfacing a parse error on a fragment.
 */

/** Where a fenced code block starts. ```json, ```JSON and a bare ``` all count. */
const FENCE_PATTERN = /^\s*```(?:json|JSON)?\s*$/;

/**
 * The JSON object in a model reply, or null when there is none.
 *
 * ORDER OF ATTEMPTS:
 *
 *   1. the whole reply as-is       cleanest, cheap to check
 *   2. a fenced block's contents   the normal plain-mode output; the fence removes
 *                                  the ambiguity about which braces are the object
 *   3. every balanced object       prose around an unfenced object, or a reply that
 *                                  shows a shape and then answers in it
 *
 * WHY EVERY BALANCED OBJECT, NOT THE FIRST OR THE OUTERMOST. `Shape: {...} Answer: {...}`
 * has two SIBLING objects and the answer is the second: taking the first hands back a
 * worked example, and the outermost is meaningless for siblings. So each is tried in
 * order and the first acceptable payload wins. `looksLikePayload` decides, defaulting to
 * "has a `status` field" - the contract every reply here carries - and a caller can
 * override it.
 *
 * When none qualifies, the FIRST parsed object is returned rather than null: the caller's
 * own validation reports what is wrong with it, a better message than "no JSON".
 *
 * @param {string} raw
 * @param {(value: object) => boolean} [looksLikePayload] Which candidate to prefer.
 * @returns {object|null} The parsed object, or null when the reply holds none.
 */
export function extractJsonObject(raw, looksLikePayload = defaultLooksLikePayload) {
    if (typeof raw !== 'string' || raw.trim() === '') return null;

    // 1. The reply is the object.
    const direct = tryParse(raw);
    if (direct !== null) return direct;

    const candidates = [];

    // 2. Fenced blocks, before any guess: the fence states which braces are the
    //    payload, so a fence beats a scan.
    for (const candidate of fencedContents(raw)) {
        const parsed = tryParse(candidate);
        if (parsed !== null) candidates.push(parsed);
    }

    // 3. Every balanced object, in order of appearance.
    for (const candidate of balancedObjects(raw)) {
        const parsed = tryParse(candidate);
        if (parsed !== null) candidates.push(parsed);
    }

    if (candidates.length === 0) return null;

    const preferred = candidates.find((candidate) => looksLikePayload(candidate));
    if (preferred) return preferred;

    // Nothing looked like a payload, so return what was found and let the caller
    // say why it is unusable. "No JSON" would be false.
    return candidates[0];
}

/**
 * The default test for "is this the reply rather than an example".
 *
 * Every reply this system exchanges carries `status`, so that is the signal. A
 * different contract should pass its own predicate rather than this being made
 * vague enough to cover everything.
 */
function defaultLooksLikePayload(value) {
    return typeof value.status === 'string';
}

/**
 * The contents of every fenced block, in order.
 *
 * Returned rather than the first, so a reply with a worked example in one fence
 * and the answer in another can be tried against each. A fence with no language
 * tag counts: models emit them.
 *
 * @param {string} raw
 * @returns {string[]}
 */
function fencedContents(raw) {
    const lines = raw.split('\n');
    const blocks = [];
    let open = false;
    let collected = [];

    for (const line of lines) {
        if (FENCE_PATTERN.test(line)) {
            if (open) {
                blocks.push(collected.join('\n'));
                collected = [];
            }
            open = !open;
            continue;
        }
        if (open) collected.push(line);
    }

    // An UNCLOSED fence is a truncated reply. Its contents are still offered,
    // because a fence that was cut off mid-object will fail to parse and fall
    // through, and one cut off just after the object still yields it.
    if (open && collected.length > 0) blocks.push(collected.join('\n'));

    return blocks;
}

/**
 * EVERY balanced `{...}` run in a string, in order of appearance.
 *
 * STRING-AWARE: a brace inside a quoted string does not change the depth, and an
 * escaped quote does not end the string. That is what stops
 * `{"note": "cost {x} per unit"}` being truncated at the inner `}`.
 *
 * Returns each complete run, so a caller can try them all rather than committing
 * to the first by position. A run that never closes is skipped entirely: it is a
 * truncated reply, and offering a fragment would produce a parse error on
 * something that looks like an object.
 *
 * @param {string} raw
 * @returns {string[]}
 */
export function balancedObjects(raw) {
    const found = [];
    let i = 0;

    while (i < raw.length) {
        const start = raw.indexOf('{', i);
        if (start === -1) break;

        const run = balancedRunFrom(raw, start);
        if (run === null) {
            // Unterminated from here on, so no later start can close either.
            break;
        }

        found.push(run);
        i = start + run.length;
    }

    return found;
}

/**
 * The balanced run beginning at `start`, or null when it never closes.
 *
 * @param {string} raw
 * @param {number} start Index of the opening brace.
 * @returns {string|null}
 */
function balancedRunFrom(raw, start) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < raw.length; i += 1) {
        const ch = raw[i];

        if (escaped) {
            escaped = false;
            continue;
        }

        if (ch === '\\') {
            // Only meaningful inside a string, but harmless outside it: a stray
            // backslash in prose should not start consuming the next character.
            if (inString) escaped = true;
            continue;
        }

        if (ch === '"') {
            inString = !inString;
            continue;
        }

        if (inString) continue;

        if (ch === '{') depth += 1;
        else if (ch === '}') {
            depth -= 1;
            if (depth === 0) return raw.slice(start, i + 1);
        }
    }

    // Never balanced: a truncated reply.
    return null;
}

/**
 * Parses a candidate, or returns null.
 *
 * ONLY AN OBJECT COUNTS. An array, a bare number or a string is valid JSON and is
 * not the shape any caller here wants, and accepting one would push the failure
 * to a later field access with a confusing message.
 *
 * @param {string} text
 * @returns {object|null}
 */
function tryParse(text) {
    try {
        const parsed = JSON.parse(String(text).trim());
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        return parsed;
    } catch {
        return null;
    }
}
