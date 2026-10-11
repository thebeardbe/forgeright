/**
 * The SERIALISED contract of /api/chat: what the browser can actually see.
 *
 * WHY THIS FILE EXISTS, and why it asserts on a re-parse rather than on the
 * object `parseModelResponse` returns.
 *
 * twice in this project a claim about behaviour was wrong because the object the
 * server holds and the JSON the client receives are NOT the same thing:
 *
 *     in-memory:  Object.hasOwn(result, 'audit') === true,   result.audit === undefined
 *     wire:       no `audit` key at all
 *
 * `parseModelResponse` builds its reply with `{ ...parsed, audit: ... }`. When
 * the payload slot has nothing to hold, the spread plus the explicit key leaves an
 * OWN property whose value is `undefined`, and `JSON.stringify` DROPS it. So a
 * test written against the returned object can pass while proving nothing about
 * what the client gets, and an equality assertion against `undefined` cannot tell
 * the two shapes apart at all, because it treats an absent key and a present-
 * `undefined` key as the same. That test passes on the buggy shape. The
 * assertions below are therefore written on `JSON.parse(JSON.stringify(reply))`,
 * which is the shape the HTTP response body carries and the only thing the client
 * ever sees.
 *
 * THE PROPERTY IS STATED IN THE CLIENT'S TERMS, and it is a property of THIS
 * SERVER. `public/js/audit.js` decides whether to show an analysis with
 *
 *     const payload = data.audit || ...
 *
 * so `Boolean(body.audit)` is the client's test verbatim, and it is the primary
 * assertion here because it is the one that fails for `{}`, `[]`, `''`, `0` and
 * `false` alike: every truthy-but-unusable value, not only the shape that
 * regressed last time. The client file is NOT loaded by this test and has no
 * automated coverage of its own; section 5 says what that costs. What is pinned
 * here is the server's side of the agreement, so that a bad body never reaches the
 * one place that cannot be tested.
 *
 * NOTHING HERE ASSERTS `assert.equal(body.audit, undefined)`. That check passes
 * on an absent key and on a present-`undefined` key, so it cannot fail for the
 * reason this file exists.
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
 * The reply as the client receives it: serialised and parsed again.
 *
 * This is the whole point of the file. `structuredClone` is NOT used, and neither
 * is the returned object directly: a clone keeps an own `undefined` property, so
 * it would reproduce the in-memory shape rather than the wire one and reinstate
 * exactly the trap this file exists to close.
 *
 * @param {object} reply The value `parseModelResponse` returned.
 * @returns {object} What the HTTP response body parses to.
 */
function overTheWire(reply) {
    return JSON.parse(JSON.stringify(reply));
}

/**
 * A process that satisfies the completeness matrix, built from the field lists
 * rather than by naming fields, so adding a field to the matrix supplies it here
 * too and a control case cannot silently stop being complete.
 *
 * `id` and `title` are not matrix fields but are required by `validateWorkflows`,
 * which the completion path runs as well.
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
// In the client's terms: `data.audit || fallback` must take the fallback. The
// assertion is on `Boolean(body.audit)`, not on a shape match, so a reply that
// carries something merely truthy ({} , [], 'x', 1, true) fails too.

test('the ASKING reply carries no usable audit over the wire', () => {
    // THE PATH THAT CAN REGRESS. It is the only one where the code has to decide
    // NOT to build a payload, so it is the only one where a stray `{}` can appear
    // in the client's payload slot. A complete reply returns earlier and always has
    // an array; an error reply returns earlier still.
    const body = wire('{"status":"asking","content":"How often does this happen?"}');

    assert.equal(body.status, 'asking', 'it is still an asking turn');
    assert.equal(
        Boolean(body.audit),
        false,
        `the client must take its fallback, got audit=${JSON.stringify(body.audit)}`
    );
});

test('an asking reply whose payload slot holds a non-array carries no usable audit', () => {
    // Every way the payload source can be a non-array, none of which is usable.
    // `false` and `0` are here because they are falsy but would still be wrong
    // values in the slot, and `{}` and `[]` because they are TRUTHY and are the
    // two that reach the client as an unusable payload.
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
    // The same non-arrays on the completion path: there is nothing to score, so
    // the reply is refused rather than sent to the client with a broken payload.
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
    // One field deeper, which is where this defect has been found before: the
    // envelope is present and truthy while the list inside it is not a list.
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
    // The regression this contract was fixed for: a truthy-but-unusable `audit`
    // used to win over a good `processes`, so the client scored an empty list and
    // the participant saw the scoring-failed panel after a successful interview.
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
// Taken together with section 1: the client either takes its fallback, or gets an
// object whose `workflows` is an array it can score. There is no third outcome in
// which it holds something truthy it cannot use.

test('the COMPLETE reply over processes carries a usable workflows array', () => {
    // The control: without it, section 1 could be satisfied by never sending a
    // payload at all.
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
    // The banner the reader sees comes from these, so they are part of what the
    // client receives rather than server-side bookkeeping.
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
// Stated as one invariant rather than case by case, so a shape nobody thought of
// is caught: the body either has no usable `audit`, or has one whose `workflows`
// is an array. Nothing in between.

test('every reply obeys: no usable audit, or a usable workflows array', () => {
    // Built with JSON.stringify, NOT as a template literal: `[completeProcess()]`
    // inside a quoted string is just text, so `wire()` would hand the parser a
    // reply with no `processes` key and the case would pass for the wrong reason.
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

    // Guard the guard: a case that does not even carry `processes` would pass the
    // invariant for the wrong reason, and the two built above are the ones at risk.
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
// `parseModelResponse` is not reached directly by the route: it is called by
// `runAuditTurn`, whose reply is what `res.json(result)` serialises. The property
// is asserted there as well, on the mock provider's real output, so it holds for
// the pipeline rather than only for hand-written literals.

test('a real asking turn WITH a partial process carries a usable workflows array', async () => {
    // Measured behaviour, pinned deliberately rather than assumed away. The mock
    // (and, per the prompt, a real model from the second turn on) sends a partial
    // process with every una answered turn, so the server normalises it and `audit`
    // IS present on an asking turn. The property that matters is the secondary one:
    // a truthy `audit` is USABLE. It is acted on only when `status === 'complete'`,
    // so a partial process cannot open the analysis.
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
    // Determinism at the wire boundary: serialising and parsing twice must give
    // the same body, so nothing about the payload depends on object identity or
    // property order that JSON cannot carry.
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
// (`data.audit || Array.isArray(data.processes) && ...` -> a payload or nothing),
// and there is NO test of it. Nothing in this repository loads that file:
//
//   - there is no browser harness here. `puppeteer` is a dependency and is
//     imported by nothing; there is no jsdom, no playwright, no client-side setup
//     of any kind. `node --test` is the whole suite.
//   - `public/js/audit.js` is one IIFE with no exports and no seam, so no part of
//     it can be imported and called directly.
//
// What that costs, measured: its payload guard was once `data.audit || ...`, which
// short-circuits on a truthy-but-unusable `audit` ({} or {workflows: []}) and
// discards a perfectly good `processes` array beside it. That survived five review
// rounds, because a hand-copied replica of the expression in a test AGREES WITH
// ITSELF and certifies nothing. It was found by reading, and the fix was verified
// by one-off browser run. See the note below; do not re-create the replica.
//
// So a change to the client's payload handling is currently unprotected. That is
// stated here rather than implied away, because a reader who sees only the server
// contract in this file could reasonably assume the client half is covered too.
//
// THE TWO WAYS TO CLOSE IT, in order of cost:
//   1. Extract the payload decision into a small pure module the client calls and
//      `node --test` can import. No browser needed; the decision is pure data in,
//      data out, which is exactly what makes it worth testing.
//   2. Drive the real page in a browser harness (puppeteer is installed and the
//      system Chromium works with the bundled one), with `fetch` intercepted and
//      the POSTed payload observed. Real coverage of the real file, at the cost of
//      a page fixture, a stub backend, and making puppeteer load-bearing.
//
// A THIRD THING THAT LOOKS LIKE A WAY AND IS NOT: copying the expression into a
// test. It is what was here before; it is how the defect above got through. The
// property this file asserts is what the SERVER must guarantee, asserted on a
// fresh parse of the serialised form, so that the one place that cannot be tested
// is also not the only thing standing between a bad body and a blank analysis.

