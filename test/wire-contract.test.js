/**
 * The SERIALISED contract of /api/chat: what the browser can actually see.
 *
 * WHY THE ASSERTIONS ARE ON A RE-PARSE. The object the server holds and the JSON
 * the client receives are NOT the same thing:
 *
 *     in-memory:  Object.hasOwn(result, 'audit') === true,   result.audit === undefined
 *     wire:       no `audit` key at all
 *
 * `parseModelResponse` builds its reply with `{ ...parsed, audit: ... }`, so an
 * empty payload slot leaves an OWN property whose value is `undefined`, and
 * `JSON.stringify` DROPS it. An assertion against the returned object passes while
 * proving nothing about the client, and `assert.equal(body.audit, undefined)` passes
 * on both shapes because it cannot tell an absent key from a present-`undefined` one.
 *
 * THE PROPERTY IS THE CLIENT'S OWN TEST. `public/js/audit.js` shows an analysis
 * with `const payload = data.audit || ...`, so `Boolean(body.audit)` is that test
 * verbatim - and it fails for `{}`, `[]`, `''`, `0` and `false` alike.
 *
 * Both shapes are covered because either can satisfy the payload: the interview
 * shape carries `processes` and the older single-shot shape carries
 * `audit.workflows`. See ARCHITECTURE.md, "The questionnaire turn".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseModelResponse, runAuditTurn } from '../ai/audit-core.js';
import { ALL_PROCESS_FIELD_NAMES, PROCESS_FIELDS, STEP_FIELDS } from '../ai/matrix.js';

/**
 * The reply as the client receives it: serialised and parsed again. `structuredClone` would keep
 * an own `undefined` property, reproducing the in-memory shape rather than the wire one.
 *
 * @param {object} reply The value `parseModelResponse` returned.
 * @returns {object} What the HTTP response body parses to.
 */
function overTheWire(reply) {
    return JSON.parse(JSON.stringify(reply));
}

/**
 * A process that satisfies the completeness matrix, built from the field lists so adding a field
 * to the matrix supplies it here too.
 *
 * `id` and `title` are not matrix fields but are required by `validateWorkflows`.
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

/** A step satisfying every STEP_FIELDS entry, including the boolean flag. */
function completeStep(overrides = {}) {
    const step = {};
    for (const field of STEP_FIELDS) {
        step[field] = field === 'needsReasoning' ? false : `a value for ${field}`;
    }
    return { ...step, ...overrides };
}

/** A completion reply carrying the given fields alongside a complete process. */
function wire(raw) {
    return overTheWire(parseModelResponse(raw));
}

// ===========================================================================
// 1. THE PRIMARY PROPERTY: NO USABLE CLIENT PAYLOAD MEANS FALSY `audit`
// ===========================================================================
//
// `data.audit || fallback` must take the fallback. The assertion is on `Boolean(body.audit)`, so
// a reply carrying something merely truthy ({}, [], 'x', 1, true) fails too.

test('the ASKING reply carries no usable audit over the wire', () => {
    // The only path where the code decides NOT to build a payload, so the only one where a stray
    // `{}` can reach the client's payload slot.
    const body = wire('{"status":"asking","content":"How often does this happen?"}');

    assert.equal(body.status, 'asking', 'it is still an asking turn');
    assert.equal(
        Boolean(body.audit),
        false,
        `the client must take its fallback, got audit=${JSON.stringify(body.audit)}`
    );
});

test('an asking reply whose payload slot holds a non-array carries no usable audit', () => {
    // Every way the payload source can be a non-array. `false` and `0` are falsy but wrong values
    // in the slot; `{}` and `[]` are TRUTHY and unusable.
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
    // The same non-arrays on the completion path: nothing to score, so the reply is refused.
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
    // The older single-shot shape with a payload that is not a workflows object.
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
    // The envelope is present and truthy while the list inside it is not a list.
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
    // A truthy-but-unusable `audit` must not beat a good `processes`: it would make the client
    // score an empty list, so the participant sees the scoring-failed panel after a successful
    // interview.
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

// ===========================================================================
// 2. THE SECONDARY PROPERTY: A PRESENT PAYLOAD IS USABLE
// ===========================================================================
//
// Together with section 1: the client either takes its fallback, or gets an object whose
// `workflows` is an array it can score.

test('the COMPLETE reply over processes carries a usable workflows array', () => {
    // The control: without it, section 1 could be satisfied by never sending a payload.
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
    // Part of what the client receives, not server-side bookkeeping.
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

// ===========================================================================
// 3. EVERY REPLY THIS FUNCTION CAN PRODUCE OBEYS THE PATTERN
// ===========================================================================
//
// One invariant rather than case by case, so a shape nobody thought of is caught: the body either
// has no usable `audit`, or one whose `workflows` is an array.

test('every reply obeys: no usable audit, or a usable workflows array', () => {
    // JSON.stringify, NOT a template literal: `[completeProcess()]` inside a quoted string is just
    // text, so `wire()` would hand the parser a reply with no `processes` key.
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

    // Guard the guard: a case carrying no `processes` would pass the invariant for the wrong reason.
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

// ===========================================================================
// 4. THE SAME PROPERTY FOR A REAL TURN, THROUGH runAuditTurn
// ===========================================================================
//
// The route reaches `parseModelResponse` through `runAuditTurn`, whose reply `res.json(result)`
// serialises, so the property is asserted on the mock provider's real output as well.

test('a real asking turn WITH a partial process carries a usable workflows array', async () => {
    // The mock sends a partial process on an asking turn, so `audit` IS present there. The property
    // that matters is the secondary one: a truthy `audit` is USABLE. It is acted on only when
    // `status === 'complete'`, so a partial process cannot open the analysis.
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
    // Serialising and parsing twice must give the same body, so nothing depends on object identity
    // or property order that JSON cannot carry.
    const messages = [];
    for (let i = 0; i < ALL_PROCESS_FIELD_NAMES.length; i += 1) {
        messages.push({ role: 'user', content: `answer ${i}` });
    }
    const turn = await runAuditTurn({ messages, lang: 'en' });

    assert.deepEqual(overTheWire(turn), overTheWire(turn));
});

// ===========================================================================
// 5. NOT COVERED HERE: public/js/audit.js HAS NO AUTOMATED COVERAGE
// ===========================================================================
//
// The client makes the same payload decision this file pins on the server side
// (`data.audit || Array.isArray(data.processes) && ...`), and there is NO test of it. Nothing in
// this repository loads that file: there is no browser harness and no driver (`puppeteer` was
// removed as unused; no jsdom, no playwright), and `public/js/audit.js` is one IIFE with no exports
// and no seam.
//
// What that costs: a client guard of `data.audit || ...` short-circuits on a truthy-but-unusable
// `audit` and discards a good `processes` array beside it. A hand-copied replica of the expression
// AGREES WITH ITSELF and certifies nothing, so do not re-create the replica.
//
// THE TWO WAYS TO CLOSE IT:
//   1. Extract the payload decision into a small pure module the client calls and `node --test`
//      can import.
//   2. Drive the real page in a browser harness with `fetch` intercepted, which needs a driver
//      installed first (a system Chromium exists at /usr/bin/chromium).
//

