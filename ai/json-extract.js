/**
 * Extracting a JSON object from a model's reply.
 *
 * This is load-bearing rather than a fallback: DeepSeek's JSON mode returns whitespace as a
 * conversation grows, so that provider is asked in plain mode and its replies are parsed out of prose.
 * A model that wraps its JSON in a ```json fence is therefore the normal case here, not an edge.
 *
 * Not `indexOf('{') .. lastIndexOf('}')`, because three ordinary replies break it: two objects in one
 * reply make the slice span both and neither parses, a brace inside a string ends it at the wrong
 * place, and a truncated reply produces a fragment that looks like an object and fails later. So this
 * scans with a brace depth counter that honours string literals and their escapes, and returns null
 * when nothing balanced is found.
 */

/** Where a fenced code block starts. ```json, ```JSON and a bare ``` all count. */
const FENCE_PATTERN = /^\s*```(?:json|JSON)?\s*$/;

/**
 * The JSON object in a model reply, or null when there is none.
 *
 * Order of attempts: the whole reply as-is, then a fenced block's contents (the normal plain-mode
 * output), then every balanced object, for prose around an unfenced object. Every balanced object
 * rather than the first or the outermost, because `Shape: {...} Answer: {...}` has two sibling objects
 * and the answer is the second: taking the first hands back a worked example, and the outermost is
 * meaningless for siblings. `looksLikePayload` decides which is acceptable, and when none qualifies the
 * first parsed object is returned rather than null, so the caller's validation reports what is wrong
 * with it.
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

    // 2. Fenced blocks, before any guess: the fence states which braces are the payload.
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

    // Nothing looked like a payload, so return what was found and let the caller say why it is
    // unusable; "no JSON" would be false.
    return candidates[0];
}

/**
 * The default test for "is this the reply rather than an example". Every reply this system exchanges
 * carries `status`, so that is the signal; a different contract should pass its own predicate rather
 * than this being made vague enough to cover everything.
 */
function defaultLooksLikePayload(value) {
    return typeof value.status === 'string';
}

/**
 * The contents of every fenced block, in order, so a reply with a worked example in one fence and the
 * answer in another can be tried against each. A fence with no language tag counts.
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

    // An unclosed fence is a truncated reply whose contents are still offered, because one cut off
    // mid-object will fail to parse and fall through, and one cut off just after the object still
    // yields it.
    if (open && collected.length > 0) blocks.push(collected.join('\n'));

    return blocks;
}

/**
 * Every balanced `{...}` run in a string, in order of appearance. It is string-aware, so a brace inside
 * a quoted string does not change the depth and an escaped quote does not end the string, which stops
 * `{"note": "cost {x} per unit"}` being truncated at the inner `}`.
 *
 * Each complete run is returned so a caller can try them all. A run that never closes is skipped
 * entirely, because offering a fragment would produce a parse error on something that looks like an
 * object.
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
            // Only meaningful inside a string, but harmless outside it: a stray backslash in prose
            // should not start consuming the next character.
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
 * Parses a candidate, or returns null. Only an object counts: an array, a bare number or a string is
 * valid JSON and is not the shape any caller here wants, and accepting one would push the failure to a
 * later field access with a confusing message.
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
