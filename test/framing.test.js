/**
 * The framework around the interview: the format commitment, the JSON extractor,
 * and the transcript the completed answers carry.
 *
 * These three are load-bearing rather than incidental:
 *
 *   - `ai/format-commitment.js` is a measured framing, so the exact conditions it
 *     wraps under are worth pinning;
 *   - `ai/json-extract.js` parses a real provider's replies out of prose, so it
 *     has to be right rather than merely likely;
 *   - the transcript is the raw evidence the analysis rests on, and the synthetic
 *     format turn must never reach it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { withFormatCommitment } from '../ai/format-commitment.js';
import { balancedObjects, extractJsonObject } from '../ai/json-extract.js';

// ===========================================================================
// 4. THE TRAILING FORMAT TURN, ai/format-commitment.js
// ===========================================================================

test('a format turn is appended when the conversation ends on a user turn', () => {
    const result = withFormatCommitment([{ role: 'user', content: 'Invoices' }]);

    assert.equal(result.length, 2, 'one turn was added');
    assert.equal(result.at(-1).role, 'assistant', 'the added turn is the assistant\'s');
    assert.equal(typeof result.at(-1).content, 'string');
    assert.ok(result.at(-1).content.trim() !== '', 'it has content to commit to the format');
});

test('NO format turn is appended when the conversation already ends on an assistant turn', () => {
    // A caller that sends its own acknowledgement must not get a duplicate.
    const messages = [
        { role: 'user', content: 'Invoices' },
        { role: 'assistant', content: 'Understood, JSON only.' }
    ];
    const result = withFormatCommitment(messages);

    assert.equal(result.length, messages.length, 'nothing was appended');
    assert.deepEqual(result, messages, 'the conversation is returned unchanged');
});

test('two calls do not stack a second format turn', () => {
    // Idempotence: applying it to its own output must be safe, or a caller that
    // wraps twice puts two commitments in a row.
    const once = withFormatCommitment([{ role: 'user', content: 'Invoices' }]);
    const twice = withFormatCommitment(once);

    assert.equal(twice.length, once.length, 'the second call added nothing');
    assert.deepEqual(twice, once);
});

test('the caller\'s array is NOT mutated', () => {
    // A real bug class: a synthetic turn leaking into the conversation it was
    // copied from would appear in the transcript as something never said.
    const messages = [{ role: 'user', content: 'Invoices' }];
    const before = JSON.parse(JSON.stringify(messages));

    const result = withFormatCommitment(messages);

    assert.equal(messages.length, 1, 'the caller\'s array is the length it was');
    assert.deepEqual(messages, before, 'and its contents are unchanged');
    assert.notEqual(result, messages, 'a new array is returned, not the same one');
});

test('an empty conversation is returned safely', () => {
    assert.deepEqual(withFormatCommitment([]), []);
});

test('a non-array is returned safely rather than throwing', () => {
    for (const bad of [null, undefined, 'messages', 42]) {
        assert.equal(withFormatCommitment(bad), bad);
    }
});

test('the format turn is a fixed string, not derived from the conversation', () => {
    // Pinning the shape: it commits to the JSON format and nothing else, so it
    // cannot accidentally carry participant text into the transcript if it leaked.
    const result = withFormatCommitment([{ role: 'user', content: 'my secret answer' }]);
    assert.equal(result.at(-1).content.includes('my secret answer'), false, 'the added turn carries no participant text');
});

// ===========================================================================
// 5. THE JSON EXTRACTION, ai/json-extract.js
// ===========================================================================

test('a reply that is the object parses directly', () => {
    assert.deepEqual(extractJsonObject('{"status":"asking"}'), { status: 'asking' });
});

test('a fenced block with the json label is extracted', () => {
    assert.deepEqual(extractJsonObject('```json\n{"status":"asking"}\n```'), { status: 'asking' });
});

test('a fenced block WITHOUT a label is extracted', () => {
    // Models emit bare fences; the pattern counts them.
    assert.deepEqual(extractJsonObject('```\n{"status":"asking"}\n```'), { status: 'asking' });
});

test('prose before and after the object is ignored', () => {
    assert.deepEqual(
        extractJsonObject('Here is the next question as JSON: {"status":"asking","content":"How often?"} Hope that helps.'),
        { status: 'asking', content: 'How often?' }
    );
});

test('a brace INSIDE A STRING does not truncate the object', () => {
    // The case indexOf('{')..lastIndexOf('}') gets wrong: the inner brace must not
    // be read as the object's end.
    assert.deepEqual(
        extractJsonObject('{"status":"asking","content":"Use {braces}?"}'),
        { status: 'asking', content: 'Use {braces}?' }
    );
});

test('an escaped quote inside a string does not end the string early', () => {
    assert.deepEqual(
        extractJsonObject('{"status":"asking","content":"say \\"hi\\" now"}'),
        { status: 'asking', content: 'say "hi" now' }
    );
});

test('a brace after an escaped backslash inside a string does not end the run', () => {
    // The scanner must treat a backslash escape as consuming the next character,
    // so a `}` that follows an escaped backslash is still inside the string. Using
    // `\\}` (an escaped backslash, then the brace) keeps the JSON valid.
    const raw = '{"status":"asking","content":"a \\\\} b"}';
    assert.deepEqual(
        extractJsonObject(raw),
        { status: 'asking', content: 'a \\} b' }
    );
});

test('two sibling objects: the first WITH a status field wins', () => {
    // The rule the code implements: each candidate is tried in order and the first
    // that looks like a payload (has a string `status`) is returned, so a worked
    // example followed by the answer returns the ANSWER.
    assert.deepEqual(
        extractJsonObject('Shape: {"a":1} Answer: {"status":"asking"}'),
        { status: 'asking' }
    );
});

test('two siblings that BOTH have a status field: the FIRST is returned', () => {
    assert.deepEqual(
        extractJsonObject('{"status":"first"} {"status":"second"}'),
        { status: 'first' }
    );
});

test('two siblings with NEITHER having a status field: the first found is returned (the fallback)', () => {
    // THE FALLBACK, which is the part a reader would get wrong: when nothing looks
    // like a payload, the first parsed object is returned rather than null, so the
    // caller can report what is wrong with it instead of "no JSON".
    assert.deepEqual(extractJsonObject('{"a":1} {"b":2}'), { a: 1 });
});

test('a custom predicate changes which candidate is preferred', () => {
    // The extractor takes the predicate, so a different contract can pass its own
    // rather than the default being made vague enough to cover everything.
    const raw = '{"kind":"example"} {"kind":"answer"}';
    assert.deepEqual(extractJsonObject(raw, (v) => v.kind === 'answer'), { kind: 'answer' });
});

test('a reply with NO JSON returns null, not a fragment', () => {
    assert.equal(extractJsonObject('What starts one of these off?'), null);
    assert.equal(extractJsonObject('I cannot answer that.'), null);
});

test('an UNBALANCED object returns null rather than a truncated object', () => {
    // A truncated reply must be reported as no JSON, so the caller says "the model
    // returned no JSON" rather than surfacing a parse error on a fragment.
    assert.equal(extractJsonObject('{"status":"asking"'), null);
    assert.equal(extractJsonObject('{"status":"asking", "content": "broken'), null);
    assert.equal(extractJsonObject('text {"status":"asking" more text'), null);
});

test('an empty or whitespace-only reply returns null', () => {
    assert.equal(extractJsonObject(''), null);
    assert.equal(extractJsonObject('   '), null);
    assert.equal(extractJsonObject('\n\t  \n'), null);
});

test('a non-string reply returns null rather than throwing', () => {
    for (const bad of [null, undefined, 42, {}, []]) {
        assert.equal(extractJsonObject(bad), null);
    }
});

test('a bare array or scalar is not accepted as an object', () => {
    // Valid JSON, wrong shape: accepting one would push the failure to a later
    // field access with a confusing message.
    assert.equal(extractJsonObject('[1,2,3]'), null);
    assert.equal(extractJsonObject('42'), null);
    assert.equal(extractJsonObject('"a string"'), null);
});

// --- balancedObjects directly, since it is exported and load-bearing ---------

test('balancedObjects returns every balanced run in order', () => {
    assert.deepEqual(balancedObjects('{"a":1} {"b":2}'), ['{"a":1}', '{"b":2}']);
});

test('balancedObjects is string-aware: a brace in a string does not split the run', () => {
    assert.deepEqual(balancedObjects('{"n":"cost {x} per"} tail'), ['{"n":"cost {x} per"}']);
});

test('balancedObjects skips an unterminated run entirely', () => {
    assert.deepEqual(balancedObjects('{"a":1'), []);
});

test('balancedObjects handles nesting', () => {
    assert.deepEqual(balancedObjects('{"a":{"b":1}} {"c":2}'), ['{"a":{"b":1}}', '{"c":2}']);
});
