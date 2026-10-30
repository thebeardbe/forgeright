/**
 * parseModelResponse in ai/audit-core.js. A malformed reply is an expected failure that must
 * become a structured `{ status: 'error' }`, not an exception and not a silently-wrong answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseModelResponse, validateWorkflows } from '../ai/audit-core.js';

test('parses a valid asking response unchanged', () => {
    const result = parseModelResponse('{"status":"asking","content":"How often do you do this?"}');
    assert.equal(result.status, 'asking');
    assert.equal(result.content, 'How often do you do this?');
});

test('parses a valid complete response with a non-empty workflows array', () => {
    const result = parseModelResponse('{"status":"complete","content":"Done","audit":{"workflows":[{"id":"w1","title":"Invoice entry"}]}}');
    assert.equal(result.status, 'complete');
    assert.deepEqual(result.audit, { workflows: [{ id: 'w1', title: 'Invoice entry' }] });
});

test('returns a structured error for invalid JSON instead of throwing', () => {
    const result = parseModelResponse('not json at all');
    assert.equal(result.status, 'error');
    assert.equal(typeof result.content, 'string');
    assert.ok(result.content.length > 0);
});

test('returns a structured error for an empty response', () => {
    const result = parseModelResponse('');
    assert.equal(result.status, 'error');
});

test('returns a structured error when there is no status field', () => {
    assert.equal(parseModelResponse('{"content":"hi"}').status, 'error');
    assert.equal(parseModelResponse('{"audit":{}}').status, 'error');
});

test('returns a structured error for JSON that is not an object', () => {
    assert.equal(parseModelResponse('"a string"').status, 'error');
    assert.equal(parseModelResponse('42').status, 'error');
    assert.equal(parseModelResponse('null').status, 'error');
    assert.equal(parseModelResponse('[1,2,3]').status, 'error');
});

test('returns a structured error when "complete" carries no audit data', () => {
    const result = parseModelResponse('{"status":"complete","content":"All done"}');
    assert.equal(result.status, 'error', 'completion without audit data must be an error, not a valid completion');
});

test('a complete response with a null audit is treated as missing', () => {
    const result = parseModelResponse('{"status":"complete","content":"Done","audit":null}');
    assert.equal(result.status, 'error');
});

test('a complete response whose audit has no workflows array is an error', () => {
    for (const audit of ['{}', '{"foo":1}', '{"workflows":null}']) {
        const result = parseModelResponse(`{"status":"complete","content":"Done","audit":${audit}}`);
        assert.equal(result.status, 'error', `audit ${audit} must be rejected`);
        assert.equal(typeof result.content, 'string');
    }
});

test('a complete response whose workflows field is not an array is an error', () => {
    for (const workflows of ['"nope"', '{}', '42', 'true']) {
        const result = parseModelResponse(`{"status":"complete","content":"Done","audit":{"workflows":${workflows}}}`);
        assert.equal(result.status, 'error', `workflows ${workflows} must be rejected`);
    }
});

test('a complete response with an EMPTY workflows array is an error', () => {
    const result = parseModelResponse('{"status":"complete","content":"Done","audit":{"workflows":[]}}');
    assert.equal(result.status, 'error');
});

test('a complete response with a non-object workflow entry is an error', () => {
    for (const entry of ['"nope"', '42', 'null', 'true', '[]']) {
        const result = parseModelResponse(`{"status":"complete","content":"Done","audit":{"workflows":[${entry}]}}`);
        assert.equal(result.status, 'error', `entry ${entry} must be rejected`);
    }
});

test('a complete response with one malformed entry among valid ones is an error', () => {
    const result = parseModelResponse('{"status":"complete","content":"Done","audit":{"workflows":[{"id":"w1"},"broken",{"id":"w2"}]}}');
    assert.equal(result.status, 'error');
});

test('a complete response whose workflow entry has no string id is an error', () => {
    for (const entry of ['{}', '{"id":7}', '{"id":null}', '{"id":true}', '{"id":{}}', '{"id":[]}']) {
        const result = parseModelResponse(`{"status":"complete","content":"Done","audit":{"workflows":[${entry}]}}`);
        assert.equal(result.status, 'error', `entry ${entry} must be rejected`);
    }
});

test('a complete response whose workflow id is empty or whitespace is an error', () => {
    for (const entry of ['{"id":""}', '{"id":"   "}']) {
        const result = parseModelResponse(`{"status":"complete","content":"Done","audit":{"workflows":[${entry}]}}`);
        assert.equal(result.status, 'error', `entry ${entry} must be rejected`);
    }
});

test('a rejected audit does not leak the malformed payload back to the client', () => {
    // The error must be a structured status: otherwise the browser shows a network error.
    const result = parseModelResponse('{"status":"complete","content":"Done","audit":{"workflows":"nope"}}');
    assert.equal(result.status, 'error');
    assert.equal(result.audit, undefined);
});

test('an asking response with no audit data is still valid', () => {
    const result = parseModelResponse('{"status":"asking","content":"Next question?"}');
    assert.equal(result.status, 'asking');
});

test('an unknown status value is passed through rather than validated', () => {
    const result = parseModelResponse('{"status":"thinking","content":"..."}');
    assert.equal(result.status, 'thinking');
});

test('parseModelResponse is deterministic for the same input', () => {
    const raw = '{"status":"complete","content":"Done","audit":{"workflows":[{"id":"w1"}]}}';
    assert.deepEqual(parseModelResponse(raw), parseModelResponse(raw));
});

// A payload with a valid id but no `title` must be rejected here, not thrown: passing it on crashes
// scoring with a TypeError.

test('a complete response whose workflow has no title is an error', () => {
    const result = parseModelResponse('{"status":"complete","content":"Done","audit":{"workflows":[{"id":"w1"}]}}');
    assert.equal(result.status, 'error');
    assert.equal(result.audit, undefined, 'the malformed payload must not leak through');
});

test('a complete response whose workflow title is an empty string is an error', () => {
    for (const entry of ['{"id":"w1","title":""}']) {
        const result = parseModelResponse(`{"status":"complete","content":"Done","audit":{"workflows":[${entry}]}}`);
        assert.equal(result.status, 'error', `entry ${entry} must be rejected`);
    }
});

test('a complete response whose workflow title is whitespace only is an error', () => {
    for (const entry of ['{"id":"w1","title":"   "}', '{"id":"w1","title":"\\t"}', '{"id":"w1","title":"\\n"}']) {
        const result = parseModelResponse(`{"status":"complete","content":"Done","audit":{"workflows":[${entry}]}}`);
        assert.equal(result.status, 'error', `entry ${entry} must be rejected`);
    }
});

test('a complete response whose workflow title is not a string is an error', () => {
    for (const entry of ['{"id":"w1","title":7}', '{"id":"w1","title":null}', '{"id":"w1","title":true}', '{"id":"w1","title":{}}', '{"id":"w1","title":[]}']) {
        const result = parseModelResponse(`{"status":"complete","content":"Done","audit":{"workflows":[${entry}]}}`);
        assert.equal(result.status, 'error', `entry ${entry} must be rejected`);
    }
});

test('a complete response with one titleless entry among titled ones is an error', () => {
    const result = parseModelResponse('{"status":"complete","content":"Done","audit":{"workflows":[{"id":"w1","title":"A"},{"id":"w2"},{"id":"w3","title":"C"}]}}');
    assert.equal(result.status, 'error', 'one bad entry rejects the whole audit at the boundary');
});

test('a title with surrounding whitespace and real content is accepted', () => {
    const result = parseModelResponse('{"status":"complete","content":"Done","audit":{"workflows":[{"id":"w1","title":"  Invoice entry  "}]}}');
    assert.equal(result.status, 'complete');
});

test('a complete response with valid workflow entries is still accepted', () => {
    const result = parseModelResponse('{"status":"complete","content":"Done","audit":{"workflows":[{"id":"w1","title":"Invoice entry"},{"id":"w2","title":"Data entry"}]}}');
    assert.equal(result.status, 'complete');
    assert.equal(result.audit.workflows.length, 2);
});

// Both the model path and POST /api/score call this, and the route takes its payload straight from
// the client, so a weak rule here is reachable over HTTP. The reason string is asserted, not just
// the boolean.

test('validateWorkflows accepts a well-formed payload', () => {
    const result = validateWorkflows([{ id: 'w1', title: 'Invoice entry' }]);
    assert.equal(result.ok, true);
    assert.equal(result.reason, undefined, 'a valid payload carries no reason');
});

test('validateWorkflows accepts a payload with extra, unvalidated fields', () => {
    const result = validateWorkflows([
        { id: 'w1', title: 'Invoice entry', frequencyPerWeek: 4, minutesPerInstance: 8, peopleAffected: 3 }
    ]);
    assert.equal(result.ok, true);
});

test('validateWorkflows rejects a non-array payload', () => {
    for (const bad of [undefined, null, {}, 'nope', 42, true]) {
        const result = validateWorkflows(bad);
        assert.equal(result.ok, false, `input ${JSON.stringify(bad)} must be rejected`);
        assert.equal(result.reason, 'workflows is missing, not an array, or empty');
    }
});

test('validateWorkflows rejects an empty array', () => {
    const result = validateWorkflows([]);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'workflows is missing, not an array, or empty');
});

test('validateWorkflows rejects a single non-object entry with a singular reason', () => {
    const result = validateWorkflows([null]);
    assert.equal(result.ok, false);
    assert.equal(result.reason, '1 entry is not an object');
});

test('validateWorkflows rejects two non-object entries with a plural reason', () => {
    const result = validateWorkflows([null, null]);
    assert.equal(result.ok, false);
    assert.equal(result.reason, '2 entries are not objects', 'the reason must pluralise for more than one');
});

test('validateWorkflows rejects every shape that is not a plain object', () => {
    for (const entry of [null, 42, 'nope', true, []]) {
        const result = validateWorkflows([entry]);
        assert.equal(result.ok, false, `entry ${JSON.stringify(entry)} must be rejected`);
        assert.equal(result.reason, '1 entry is not an object');
    }
});

test('validateWorkflows reports the count of malformed entries', () => {
    const result = validateWorkflows([null, { id: 'a', title: 'A' }, 'broken']);
    assert.equal(result.ok, false);
    assert.equal(result.reason, '2 entries are not objects');
});

test('validateWorkflows rejects a missing or non-string id with a singular reason', () => {
    for (const entry of [{ title: 'A' }, { id: '', title: 'A' }, { id: '   ', title: 'A' }, { id: 7, title: 'A' }, { id: null, title: 'A' }]) {
        const result = validateWorkflows([entry]);
        assert.equal(result.ok, false, `entry ${JSON.stringify(entry)} must be rejected`);
        assert.equal(result.reason, '1 entry has no id');
    }
});

test('validateWorkflows pluralises the missing-id reason', () => {
    const result = validateWorkflows([{ id: '', title: 'A' }, { title: 'B' }]);
    assert.equal(result.reason, '2 entries have no id');
});

test('validateWorkflows rejects a missing, empty, whitespace or non-string title', () => {
    for (const entry of [{ id: 'a' }, { id: 'a', title: '' }, { id: 'a', title: '   ' }, { id: 'a', title: 7 }, { id: 'a', title: null }, { id: 'a', title: {} }]) {
        const result = validateWorkflows([entry]);
        assert.equal(result.ok, false, `entry ${JSON.stringify(entry)} must be rejected`);
        assert.equal(result.reason, '1 entry has no title');
    }
});

test('validateWorkflows pluralises the missing-title reason', () => {
    const result = validateWorkflows([{ id: 'a', title: '   ' }, { id: 'b' }]);
    assert.equal(result.reason, '2 entries have no title');
});

test('validateWorkflows checks malformed entries before ids before titles', () => {
    // The order is observable: a null entry beside a titleless one reports the malformed entry.
    const result = validateWorkflows([null, { id: 'a' }]);
    assert.equal(result.reason, '1 entry is not an object', 'the earliest failing check wins');
});

test('validateWorkflows gives no reason when the payload is valid', () => {
    const result = validateWorkflows([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }]);
    assert.deepEqual(result, { ok: true });
});

test('parseModelResponse rejects the same title shapes validateWorkflows rejects', () => {
    for (const title of ['   ', '', null, 7]) {
        const payload = JSON.stringify({
            status: 'complete',
            content: 'Done',
            audit: { workflows: [{ id: 'w1', title }] }
        });
        assert.equal(parseModelResponse(payload).status, 'error', `title ${JSON.stringify(title)} must be rejected at the boundary`);
    }
});

test('parseModelResponse accepts a title validateWorkflows accepts', () => {
    const payload = JSON.stringify({
        status: 'complete',
        content: 'Done',
        audit: { workflows: [{ id: 'w1', title: 'Invoice entry' }] }
    });
    assert.equal(parseModelResponse(payload).status, 'complete');
});
