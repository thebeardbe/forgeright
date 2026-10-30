/**
 * The SERIALISED contract of /api/chat: what the browser can actually see.
 *
 * WHY THE ASSERTIONS ARE ON A RE-PARSE: the server's reply has an OWN `audit` property whose value
 * is `undefined`, and `JSON.stringify` DROPS it. So an assertion against the returned object passes
 * while proving nothing about the client, and `assert.equal(body.audit, undefined)` passes on both
 * shapes because it cannot tell an absent key from a present-`undefined` one.
 *
 * THE PROPERTY IS THE CLIENT'S OWN TEST: `public/js/audit.js` uses `data.audit || ...`, so
 * `Boolean(body.audit)` is that test verbatim, failing for `{}`, `[]`, `''`, `0` and `false` alike.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseModelResponse, runAuditTurn } from '../ai/audit-core.js';
import { ALL_PROCESS_FIELD_NAMES, PROCESS_FIELDS, STEP_FIELDS } from '../ai/matrix.js';

/**
 * The reply as the client receives it. `structuredClone` would keep an own `undefined` property,
 * reproducing the in-memory shape rather than the wire one.
 */
function overTheWire(reply) {
    return JSON.parse(JSON.stringify(reply));
}

/**
 * A process satisfying the completeness matrix, built from the field lists. `id` and `title` are
 * required by `validateWorkflows`, not the matrix.
 */
function completeProcess(overrides = {}) {
    const process = { id: 'w1', title: 'Invoice intake' };
    for (const field of PROCESS_FIELDS) {
        if (field === 'steps') continue;
        if (['handoffTo', 'waitsFor', 'dependsOn', 'systems', 'touchedDepartments'].includes(field)) {
            process[field] = ['someone'];
        } else if (['mistakesPerPeriod', 'peopleAffected'].includes(field)) {
            process[field] = 2;
        } else {
            process[field] = `a value for ${field}`;
        }
    }
    process.steps = [completeStep()];
    process.frequencyPerWeek = 3;
    return { ...process, ...overrides };
}

function completeStep(overrides = {}) {
    const step = {};
    for (const field of STEP_FIELDS) {
        step[field] = field === 'needsReasoning' ? false : `a value for ${field}`;
    }
    return { ...step, ...overrides };
}

function wire(raw) {
    return overTheWire(parseModelResponse(raw));
}

test('the ASKING reply carries no usable audit over the wire', () => {
    const body = wire('{"status":"asking","content":"How often does this happen?"}');

    assert.equal(body.status, 'asking', 'it is still an asking turn');
    assert.equal(
        Boolean(body.audit),
        false,
        `the client must take its fallback, got audit=${JSON.stringify(body.audit)}`
    );
});

test('an asking reply whose payload slot holds a non-array carries no usable audit', () => {
    const processValues = ['null', '"a string"', '{}', '0', 'false', '[]'];
    for (const processes of processValues) {
        const body = wire(`{"status":"asking","content":"Next?","processes":${processes}}`);

        assert.equal(
            Boolean(body.audit),
            false,
            `processes=${processes} must not produce a usable audit, got ${JSON.stringify(body.audit)}`
        );
    }
});

test('a complete reply whose ONLY payload source is unusable is not completed, and carries no usable audit', () => {
    for (const processes of ['null', '"a string"', '{}', '0', 'false']) {
        const body = wire(`{"status":"complete","content":"Done","processes":${processes}}`);

        assert.equal(body.status, 'error', `processes=${processes} must not complete`);
        assert.equal(
            Boolean(body.audit),
            false,
            `an error body must not carry a usable audit, got ${JSON.stringify(body.audit)}`
        );
    }
});

test('an audit that is a string, or an empty array, carries no usable audit', () => {
    for (const audit of ['"nope"', '[]', '{}', '{"workflows":null}']) {
        const body = wire(`{"status":"complete","content":"Done","audit":${audit}}`);

        assert.equal(
            Boolean(body.audit),
            false,
            `audit=${audit} must not reach the client as a payload, got ${JSON.stringify(body.audit)}`
        );
    }
});

test('an audit.workflows that is a string, or an empty array, carries no usable audit', () => {
    for (const workflows of ['"nope"', '[]', '{}', '0', 'false', 'null']) {
        const body = wire(`{"status":"complete","content":"Done","audit":{"workflows":${workflows}}}`);

        assert.equal(
            Boolean(body.audit),
            false,
            `audit.workflows=${workflows} must not reach the client as a payload, got ${JSON.stringify(body.audit)}`
        );
    }
});

test('a complete processes wins over an unusable audit, over the wire', () => {
    for (const audit of ['{"workflows":[]}', '"nope"', '{}', '[]']) {
        const body = wire(JSON.stringify({
            status: 'complete',
            content: 'Done',
            processes: [completeProcess()],
            audit: JSON.parse(audit)
        }));

        assert.equal(body.status, 'complete', `audit=${audit} must not block completion`);
        assert.equal(Boolean(body.audit), true, `audit=${audit} must not beat the processes`);
        assert.equal(Array.isArray(body.audit.workflows), true, 'the client receives a workflows array');
        assert.equal(body.audit.workflows[0].id, 'w1', 'and it is the process the model just produced');
    }
});

test('the COMPLETE reply over processes carries a usable workflows array', () => {
    const body = wire(JSON.stringify({ status: 'complete', content: 'Done', processes: [completeProcess()] }));

    assert.equal(body.status, 'complete');
    assert.equal(Boolean(body.audit), true, 'a completed interview must carry a payload');
    assert.equal(Array.isArray(body.audit.workflows), true, 'and its workflows must be an array');
    assert.equal(body.audit.workflows.length, 1);
    assert.equal(body.audit.workflows[0].id, 'w1');
});

test('the COMPLETE reply over audit.workflows carries a usable workflows array', () => {
    const body = wire('{"status":"complete","content":"Done","audit":{"workflows":[{"id":"w1","title":"Invoice intake"}]}}');

    assert.equal(body.status, 'complete');
    assert.equal(Boolean(body.audit), true);
    assert.equal(Array.isArray(body.audit.workflows), true);
    assert.deepEqual(body.audit.workflows, [{ id: 'w1', title: 'Invoice intake' }]);
});

test('the illustrative flag and the note survive serialisation', () => {
    const body = wire(JSON.stringify({
        status: 'complete',
        content: 'Done',
        processes: [completeProcess()],
        illustrative: true,
        note: 'Illustrative data'
    }));

    assert.equal(body.audit.illustrative, true);
    assert.equal(body.audit.note, 'Illustrative data');
});

test('every reply obeys: no usable audit, or a usable workflows array', () => {
    // JSON.stringify, NOT a template literal: inside a quoted string it is just text.
    const usableProcesses = JSON.stringify({ status: 'complete', content: 'Done', processes: [completeProcess()] });
    const usableProcessesWithEmptyAudit = JSON.stringify({
        status: 'complete',
        content: 'Done',
        processes: [completeProcess()],
        audit: { workflows: [] }
    });

    const replies = [
        '{"status":"asking","content":"A question"}',
        '{"status":"asking","content":"A question","processes":[]}',
        '{"status":"asking","content":"A question","processes":null}',
        '{"status":"complete","content":"Done"}',
        '{"status":"complete","content":"Done","processes":null}',
        '{"status":"complete","content":"Done","audit":"nope"}',
        '{"status":"complete","content":"Done","audit":{}}',
        '{"status":"complete","content":"Done","audit":{"workflows":[]}}',
        '{"status":"complete","content":"Done","audit":{"workflows":"nope"}}',
        usableProcesses,
        usableProcessesWithEmptyAudit,
        '{"status":"complete","content":"Done","audit":{"workflows":[{"id":"w1","title":"T"}]}}',
        'not json at all',
        ''
    ];

    assert.match(usableProcesses, /"processes":\[/, 'the built control really carries a processes array');
    assert.match(usableProcessesWithEmptyAudit, /"audit":\{"workflows":\[\]\}/, 'and the bad-audit control really carries the empty audit');

    for (const raw of replies) {
        const body = wire(raw);
        const usable = Boolean(body.audit) && Array.isArray(body.audit.workflows);

        assert.ok(
            body.audit === undefined || body.audit === null || usable,
            `reply ${raw} produced a truthy but unusable audit: ${JSON.stringify(body.audit)}`
        );
    }
});

test('a real asking turn WITH a partial process carries a usable workflows array', async () => {
    // Acted on only when `status === 'complete'`, so a partial process cannot open the analysis.
    const messages = [
        { role: 'user', content: 'I enter invoices' },
        { role: 'user', content: 'Every morning' }
    ];
    const body = overTheWire(await runAuditTurn({ messages, lang: 'en' }));

    assert.equal(body.status, 'asking');
    assert.equal(Boolean(body.audit), true, 'the partial process is normalised into a payload');
    assert.equal(Array.isArray(body.audit.workflows), true, 'and the payload is usable');
    assert.equal(Array.isArray(body.processes), true, 'the raw processes travel beside it');
});

test('a real completed turn over the wire carries a usable workflows array', async () => {
    const messages = [];
    for (let i = 0; i < ALL_PROCESS_FIELD_NAMES.length; i += 1) {
        messages.push({ role: 'user', content: `answer ${i}` });
    }
    const body = overTheWire(await runAuditTurn({ messages, lang: 'en' }));

    assert.equal(body.status, 'complete');
    assert.equal(Boolean(body.audit), true, 'a completed interview carries a payload');
    assert.equal(Array.isArray(body.audit.workflows), true);
    assert.ok(body.audit.workflows.length > 0, 'and it is not an empty list');
    for (const workflow of body.audit.workflows) {
        assert.equal(typeof workflow.id, 'string', 'every workflow the client is handed has an id');
    }
});

test('a real completed turn survives being re-parsed from its own serialisation, deterministically', async () => {
    const messages = [];
    for (let i = 0; i < ALL_PROCESS_FIELD_NAMES.length; i += 1) {
        messages.push({ role: 'user', content: `answer ${i}` });
    }
    const turn = await runAuditTurn({ messages, lang: 'en' });

    assert.deepEqual(overTheWire(turn), overTheWire(turn));
});

// NOT covered: the client's own payload decision. Nothing here loads `public/js/audit.js` (one IIFE,
// no exports, no browser driver). A hand-copied replica AGREES WITH ITSELF, so do not re-create it.

