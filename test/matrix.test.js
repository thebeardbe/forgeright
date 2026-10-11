/**
 * Workflow 1: the completeness matrix and the interview loop.
 *
 * THE SAFETY PROPERTY THE DESIGN RESTS ON: the matrix decides completion, not the
 * model's `status`. A model that claims `complete` while a field is absent must be
 * sent back to `asking` with that field named, or a field can be skipped by
 * declaring the interview done.
 *
 * Read `ai/matrix.js`, `ai/audit-core.js` and `ai/adapters/mock.js` first. The
 * field lists are read FROM THE MODULE throughout, never restated, so a change to
 * the matrix cannot leave these tests asserting a stale shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    ALL_PROCESS_FIELD_NAMES,
    EFFORT_FIELDS,
    PROCESS_FIELDS,
    STEP_FIELDS,
    fieldsMissingFrom,
    fieldsPresentIn,
    judgementBandFor,
    reconcileMatrix,
    stepIsComplete
} from '../ai/matrix.js';
import { parseModelResponse, workflowsFrom } from '../ai/audit-core.js';

/**
 * A process that satisfies EVERY field in the matrix, built from the field lists
 * rather than by naming them, so adding a field to the matrix makes this builder
 * supply it and a test that then removes one still removes exactly one.
 *
 * `id` and `title` are not matrix fields but are required by validateWorkflows,
 * which the completion path also runs.
 */
function completeProcess(overrides = {}) {
    const process = { id: 'process-1', title: 'A complete process' };

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

/** A step that satisfies every STEP_FIELDS entry, including a boolean flag. */
function completeStep(overrides = {}) {
    const step = {};
    for (const field of STEP_FIELDS) {
        step[field] = field === 'needsReasoning' ? false : `a value for ${field}`;
    }
    return { ...step, ...overrides };
}

/** Parses a completion reply carrying the given processes. */
function completeWith(processes, extra = {}) {
    return parseModelResponse(JSON.stringify({ status: 'complete', content: 'done', processes, ...extra }));
}

// ===========================================================================
// 1. THE MATRIX GATES COMPLETION
// ===========================================================================

test('a complete reply with a COMPLETE process is accepted', () => {
    const result = completeWith([completeProcess()]);

    assert.equal(result.status, 'complete', 'a fully populated process completes the interview');
    assert.deepEqual(result.missing, [], 'nothing is missing');
    assert.equal(result.audit.workflows.length, 1, 'the payload reaches the client');
});

test('a claimed complete with a field absent comes back asking, naming the field', () => {
    const process = completeProcess();
    delete process.frustration;

    const result = completeWith([process]);

    assert.equal(result.status, 'asking', 'the model does not get to declare itself done');
    assert.ok(result.missing.includes('frustration'), `the missing field is named, got ${JSON.stringify(result.missing)}`);
});

test('EVERY matrix field, removed one at a time, blocks completion', () => {
    // Several shapes of incompleteness, not one. Each field the matrix requires
    // is removed in turn and the reply must be downgraded, naming that field.
    for (const field of PROCESS_FIELDS) {
        const process = completeProcess();
        delete process[field];

        const result = completeWith([process]);
        assert.equal(result.status, 'asking', `removing ${field} must block completion`);
        assert.ok(result.missing.includes(field), `removing ${field} must name it in missing`);
    }
});

test('a step missing a required field blocks completion of the PROCESS', () => {
    // `steps` counts only when every step is complete: a step without its basis
    // is precisely the case the matrix exists to catch.
    for (const field of STEP_FIELDS) {
        const process = completeProcess({ steps: [completeStep()] });
        delete process.steps[0][field];

        const result = completeWith([process]);
        assert.equal(result.status, 'asking', `a step without ${field} must block completion`);
        assert.ok(result.missing.includes('steps'), `the missing step field surfaces as steps: ${JSON.stringify(result.missing)}`);
    }
});

test('an empty steps array does not satisfy the steps requirement', () => {
    const process = completeProcess({ steps: [] });
    const result = completeWith([process]);
    assert.equal(result.status, 'asking');
    assert.ok(result.missing.includes('steps'));
});

test('a needsReasoning that is NOT a boolean does not satisfy the step', () => {
    // The flag is derived and must be a boolean; a string or a number is not a
    // decision and must leave the step incomplete.
    for (const bad of ['true', 1, null, undefined, {}]) {
        const process = completeProcess({ steps: [completeStep({ needsReasoning: bad })] });
        const result = completeWith([process]);
        assert.equal(result.status, 'asking', `needsReasoning ${JSON.stringify(bad)} must not count as supplied`);
    }
});

test('ONE incomplete process among several blocks completion of the whole interview', () => {
    // The matrix is per process, and every process must be complete: a second,
    // half-described process cannot ride in on a complete first one.
    const good = completeProcess();
    const stub = { id: 'process-2', title: 'Half described', task: 'something' };

    const result = completeWith([good, stub]);

    assert.equal(result.status, 'asking');
    assert.ok(result.missing.length > 0, 'the incomplete process leaves fields missing');
    assert.ok(result.missing.includes('trigger'), 'a field only the complete process had is missing overall');
});

test('a claimed complete with NO processes at all is not completed', () => {
    const result = parseModelResponse(JSON.stringify({ status: 'complete', content: 'done', processes: [] }));
    assert.notEqual(result.status, 'complete', 'an interview that produced no process has produced nothing to score');
});

test('the model cannot skip completion by omitting have/missing entirely', () => {
    // No claimed lists, a complete status, an incomplete process: the computed
    // matrix must still decide.
    const process = completeProcess();
    delete process.trigger;

    const result = completeWith([process]);
    assert.equal(result.status, 'asking');
    assert.ok(result.missing.includes('trigger'));
});

test('a CLAIMED field cannot make a real gap vanish when closing', () => {
    // The dangerous direction: a model that claims `have` holds everything and
    // `missing` is empty, while the payload is incomplete. At closing only the
    // payload counts, so the gap must be put back and the interview continued.
    // Without this rule a field disappears by being declared present.
    const incomplete = { id: 'p1', title: 'A stub', task: 'something' };

    const result = parseModelResponse(JSON.stringify({
        status: 'complete',
        content: 'done',
        processes: [incomplete],
        have: [...ALL_PROCESS_FIELD_NAMES],
        missing: []
    }));

    assert.equal(result.status, 'asking', 'the claim does not let an incomplete process complete');
    assert.ok(result.missing.length > 0, 'the real gaps are reported');
    assert.ok(result.missing.includes('trigger'), 'a specific absent field is named');
});

test('a claim of missing for a field that IS present does not stall the interview', () => {
    // The other direction: believing a `missing` claim about a field the payload
    // carries would ask a question already answered, forever.
    const result = parseModelResponse(JSON.stringify({
        status: 'complete',
        content: 'done',
        processes: [completeProcess()],
        have: [],
        missing: [...ALL_PROCESS_FIELD_NAMES]
    }));

    assert.equal(result.status, 'complete', 'the payload settles it, the claim does not stall');
    assert.deepEqual(result.missing, []);
});

// ===========================================================================
// 1b. THE EITHER/OR EFFORT PAIR
// ===========================================================================

test('frequencyPerWeek ALONE satisfies the effort requirement', () => {
    const process = completeProcess();
    delete process.timePerPeriod; // already absent; keep frequency
    process.frequencyPerWeek = 4;

    assert.deepEqual(fieldsMissingFrom(process), [], 'the pair is one requirement');
    assert.equal(completeWith([process]).status, 'complete');
});

test('timePerPeriod ALONE satisfies the effort requirement', () => {
    const process = completeProcess();
    delete process.frequencyPerWeek;
    process.timePerPeriod = '2 hours a day';

    assert.equal(fieldsMissingFrom(process).includes('timePerPeriod'), false, 'the continuous half is enough');
    assert.equal(fieldsMissingFrom(process).includes('frequencyPerWeek'), false, 'and the other half is not demanded');
    assert.equal(completeWith([process]).status, 'complete');
});

test('NEITHER half of the effort pair leaves it missing', () => {
    const process = completeProcess();
    delete process.frequencyPerWeek;
    delete process.timePerPeriod;

    const missing = fieldsMissingFrom(process);
    // The effort requirement surfaces as one of the pair, not both.
    assert.ok(EFFORT_FIELDS.some((f) => missing.includes(f)), 'the effort requirement is reported missing');
    assert.equal(missing.includes(EFFORT_FIELDS[0]), true);
    assert.equal(missing.includes(EFFORT_FIELDS[1]), true);
    assert.equal(completeWith([process]).status, 'asking');
});

// ===========================================================================
// 2. needsReasoning IS DERIVED, NOT ASKED
// ===========================================================================
//
// IMPORTANT, from reading the code: there is NO function that derives
// needsReasoning from a decidedHow string. The derivation is the MODEL's reading,
// instructed by the prompt, and stored on the step. What the code DOES hold, and
// what is tested here, is (a) that judgementBandFor reads the flag correctly, and
// (b) that the matrix refuses a step whose flag is absent, so the derived value
// must actually be present.

test('the matrix forces every step to carry the derived flag', () => {
    // A step with a basis but no derived flag is INCOMPLETE: the derivation is
    // required of the model, and the matrix is what makes that non-optional.
    const step = completeStep();
    delete step.needsReasoning;
    assert.equal(stepIsComplete(step), false, 'a step without the flag is not complete');
    assert.equal(stepIsComplete({ ...step, needsReasoning: true }), true, 'with the flag it is');
});

test('a process whose steps carry no flag stays missing steps', () => {
    const process = completeProcess();
    process.steps = process.steps.map((s) => ({ name: s.name, whatHappens: s.whatHappens, decidedHow: s.decidedHow }));
    assert.ok(fieldsMissingFrom(process).includes('steps'));
});

test('judgementBandFor reads the derived flags: all reasoning is band 1', () => {
    assert.equal(judgementBandFor({ steps: [{ needsReasoning: true }, { needsReasoning: true }] }), 1);
});

test('judgementBandFor: no reasoning steps is band 5', () => {
    assert.equal(
        judgementBandFor({ steps: Array.from({ length: 5 }, () => ({ needsReasoning: false })) }),
        5
    );
});

test('judgementBandFor: one judgement step in five reads as band 4, not as "needs a person"', () => {
    // The discriminator: a chain almost entirely mechanical with one judgement
    // call must not collapse to the judgement-bound band.
    assert.equal(
        judgementBandFor({
            steps: [
                { needsReasoning: true },
                { needsReasoning: false },
                { needsReasoning: false },
                { needsReasoning: false },
                { needsReasoning: false }
            ]
        }),
        4
    );
});

test('judgementBandFor falls back to 3 when there is nothing to read', () => {
    // The honest "not enough information" answer, not a flattering 5.
    assert.equal(judgementBandFor({ steps: [] }), 3);
    assert.equal(judgementBandFor({}), 3);
    assert.equal(judgementBandFor({ steps: [{ name: 'no flag' }] }), 3);
});

test('judgementBandFor honours an explicit judgementScore and clamps it', () => {
    assert.equal(judgementBandFor({ judgementScore: 2, steps: [{ needsReasoning: false }] }), 2, 'explicit wins');
    assert.equal(judgementBandFor({ judgementScore: 9 }), 5, 'clamped to the top');
    assert.equal(judgementBandFor({ judgementScore: 0 }), 1, 'clamped to the bottom');
    assert.equal(judgementBandFor({ judgementScore: 'nonsense' }), 3, 'unreadable is the midpoint');
});

test('the scale is INVERTED as documented: judgement is 1, rules are 5', () => {
    // Everything downstream is written against this direction, so it is pinned.
    assert.ok(judgementBandFor({ steps: [{ needsReasoning: true }] }) < judgementBandFor({ steps: [{ needsReasoning: false }] }));
});

test('the fixture pairs a rule with false and a variable basis with true, per the prompt', async () => {
    // The prompt's own examples, as the fixture holds them: a threshold is a rule,
    // "depends on..." is judgement. Reread from the fixture so a change is visible.
    const { buildMockAudit } = await import('../ai/fixtures/mock-audit.js');
    const audit = buildMockAudit('en');
    const steps = audit.workflows.flatMap((w) => (w.steps || []).map((s) => ({ decidedHow: s.decidedHow, needsReasoning: s.needsReasoning })));

    const thresholds = steps.filter((s) => /more than 2 euros|over 10 hours|over the contracted hours/i.test(s.decidedHow));
    assert.ok(thresholds.length > 0, 'the fixture holds the threshold examples');
    for (const step of thresholds) {
        assert.equal(step.needsReasoning, false, `a threshold is a rule: ${JSON.stringify(step.decidedHow)}`);
    }

    const variable = steps.filter((s) => /^depends\b/i.test(s.decidedHow));
    assert.ok(variable.length > 0, 'the fixture holds the variable examples');
    for (const step of variable) {
        assert.equal(step.needsReasoning, true, `a variable basis is judgement: ${JSON.stringify(step.decidedHow)}`);
    }
});

// ===========================================================================
// 4. BOTH PAYLOAD SHAPES
// ===========================================================================
//
// A defect fixed in the last commit: a reply carrying `processes` and no `audit`
// fell through to the older single-shot check and errored. Both directions are
// pinned here so it cannot return. `workflowsFrom` is the one place that reads
// either shape, so it is tested directly as well as through parseModelResponse.

test('a processes-only reply with a complete process returns complete', () => {
    const result = completeWith([completeProcess()]);

    assert.equal(result.status, 'complete', 'the interview shape completes');
    assert.equal(result.audit.workflows.length, 1, 'the payload is normalised for the client');
    assert.equal(result.processes.length, 1, 'and the raw processes are kept');
});

test('an audit.workflows reply returns complete', () => {
    const result = parseModelResponse(JSON.stringify({
        status: 'complete',
        content: 'done',
        audit: { workflows: [{ id: 'w1', title: 'Invoice entry' }] }
    }));

    assert.equal(result.status, 'complete', 'the older single-shot shape still completes');
    assert.equal(result.audit.workflows.length, 1);
});

test('a reply with NEITHER shape is an error', () => {
    const result = parseModelResponse(JSON.stringify({ status: 'complete', content: 'done' }));
    assert.equal(result.status, 'error', 'completion with nothing to score is refused');
});

test('a reply with an EMPTY processes array and no audit is an error or asking, never complete', () => {
    // An interview that produced no process has produced nothing to score.
    const result = parseModelResponse(JSON.stringify({ status: 'complete', content: 'done', processes: [] }));
    assert.notEqual(result.status, 'complete');
});

test('workflowsFrom reads the interview shape', () => {
    assert.deepEqual(workflowsFrom({ processes: [{ id: 'p1' }] }), [{ id: 'p1' }]);
});

test('workflowsFrom reads the single-shot shape', () => {
    assert.deepEqual(workflowsFrom({ audit: { workflows: [{ id: 'w1' }] } }), [{ id: 'w1' }]);
});

test('workflowsFrom returns undefined when neither shape is present', () => {
    assert.equal(workflowsFrom({}), undefined);
    assert.equal(workflowsFrom({ content: 'just text' }), undefined);
    assert.equal(workflowsFrom(null), undefined);
});

test('workflowsFrom treats an EMPTY processes array as no payload', () => {
    // Empty is not a payload: it must not shadow a valid audit, and it must not
    // read as success on its own.
    assert.equal(workflowsFrom({ processes: [] }), undefined);
});

test('workflowsFrom prefers processes when BOTH shapes are present', () => {
    // Pinning the precedence: the interview shape is the current one, so a model
    // that emits both is read as an interview. This is a behaviour, not an
    // endorsement; see the report.
    assert.deepEqual(
        workflowsFrom({ processes: [{ id: 'interview' }], audit: { workflows: [{ id: 'singleshot' }] } }),
        [{ id: 'interview' }]
    );
});

test('an interview reply with a stub processes and a complete audit does not complete', () => {
    // The consequence of the precedence above: the stub wins, so the reply is
    // downgraded rather than closing on the audit. Pinned so a change to the
    // precedence is visible.
    const result = parseModelResponse(JSON.stringify({
        status: 'complete',
        content: 'done',
        processes: [{ task: 'a stub' }],
        audit: { workflows: [{ id: 'w1', title: 'A complete workflow' }] }
    }));
    assert.equal(result.status, 'asking', 'the incomplete interview shape governs');
});

// ===========================================================================
// 5. COMPLETE VERSUS INCOMPLETE
// ===========================================================================

test('a fully populated process built from the field lists is COMPLETE', () => {
    const process = completeProcess();
    assert.deepEqual(fieldsMissingFrom(process), [], 'nothing is missing');
    assert.equal(completeWith([process]).status, 'complete');
});

test('removing ANY ONE process field makes it incomplete', () => {
    for (const field of PROCESS_FIELDS) {
        const process = completeProcess();
        delete process[field];
        assert.ok(fieldsMissingFrom(process).includes(field), `removing ${field} leaves it missing`);
    }
});

test('removing ANY ONE step field makes the PROCESS incomplete', () => {
    for (const field of STEP_FIELDS) {
        const process = completeProcess();
        delete process.steps[0][field];
        assert.ok(fieldsMissingFrom(process).includes('steps'), `a step without ${field} is not complete`);
    }
});

test('an empty steps array is incomplete', () => {
    assert.ok(fieldsMissingFrom(completeProcess({ steps: [] })).includes('steps'));
});

test('a null or empty-string field is NOT supplied, and the code says so', () => {
    // Asserted from the code's own rule (isSupplied), not from expectation: an
    // empty value must leave the field missing, or a blank answer would count.
    for (const field of PROCESS_FIELDS) {
        if (field === 'steps') continue; // steps has its own rule, covered above
        for (const empty of [null, '', '   ']) {
            const process = completeProcess();
            process[field] = empty;
            assert.ok(
                fieldsMissingFrom(process).includes(field),
                `${field}=${JSON.stringify(empty)} must count as not supplied`
            );
        }
        // And a zero NUMBER is not empty: 0 is a real answer for a count.
        if (['mistakesPerPeriod', 'peopleAffected'].includes(field)) {
            const process = completeProcess();
            process[field] = 0;
            assert.equal(fieldsMissingFrom(process).includes(field), false, `${field}=0 is a supplied count`);
        }
    }
});

test('an EMPTY ARRAY is not supplied, because it is a statement nobody made', () => {
    // handoffTo: [] says "the work does not go anywhere else", which is a real
    // answer only if the participant said so.
    for (const field of ['handoffTo', 'waitsFor', 'dependsOn', 'systems', 'touchedDepartments']) {
        const process = completeProcess();
        process[field] = [];
        assert.ok(fieldsMissingFrom(process).includes(field), `${field}=[] must count as not supplied`);
    }
});

test('the either/or pair: frequencyPerWeek alone is complete', () => {
    const process = completeProcess();
    delete process.timePerPeriod;
    assert.equal(completeWith([process]).status, 'complete');
});

test('the either/or pair: timePerPeriod alone is complete', () => {
    const process = completeProcess();
    delete process.frequencyPerWeek;
    process.timePerPeriod = '2 hours a day';
    assert.equal(completeWith([process]).status, 'complete');
});

test('the either/or pair: neither leaves it missing', () => {
    const process = completeProcess();
    delete process.frequencyPerWeek;
    delete process.timePerPeriod;
    assert.equal(completeWith([process]).status, 'asking');
});

test('the either/or pair: BOTH present is not an error', () => {
    // A participant who gives both a frequency and a time per period is answering
    // more fully, not making a mistake. It must complete.
    const process = completeProcess();
    process.frequencyPerWeek = 3;
    process.timePerPeriod = '2 hours a day';

    assert.deepEqual(fieldsMissingFrom(process), []);
    assert.equal(completeWith([process]).status, 'complete');
});

// ===========================================================================
// 6. THE MOCK'S SHAPE MATCHES THE PROMPT'S
// ===========================================================================

/** One mock turn for the given number of prior user answers. */
async function mockTurn(userTurns, lang = 'en') {
    const { generate } = await import('../ai/adapters/mock.js');
    const messages = Array.from({ length: userTurns }, (_, i) => ({ role: 'user', content: `answer ${i}` }));
    return JSON.parse(await generate({ messages, providerConfig: { lang } }));
}

test('the mock emits `processes` and NOT `audit` on completion', async () => {
    // THE MASKING THAT HID THE DEFECT. Emitting a second shape to satisfy the
    // parser hides exactly the defect the parser has, so the absence is asserted
    // explicitly: a future change that re-adds the old key fails here.
    const reply = await mockTurn(8);

    assert.equal(reply.status, 'complete');
    assert.ok(Array.isArray(reply.processes) && reply.processes.length > 0, 'processes is the payload');
    assert.equal('audit' in reply, false, 'the mock must not emit an audit envelope');
});

test('the mock emits `processes` and NOT `audit` while still asking', async () => {
    const reply = await mockTurn(2);

    assert.equal(reply.status, 'asking');
    assert.ok(Array.isArray(reply.processes), 'a partial process keeps the shape stable');
    assert.equal('audit' in reply, false, 'no audit envelope at any turn');
});

test('the mock emits illustrative and note on completion', async () => {
    const reply = await mockTurn(8);

    assert.equal(reply.illustrative, true, 'generated data is labelled as illustrative');
    assert.equal(typeof reply.note, 'string');
    assert.ok(reply.note.trim() !== '', 'the note is not blank');
});

test('the mock reports an empty missing list on completion', async () => {
    const reply = await mockTurn(8);
    assert.deepEqual(reply.missing, [], 'the scripted interview finishes with nothing missing');
});

test('the mock\'s reported matrix narrows as the conversation goes on', async () => {
    // The pair must CHANGE turn by turn, which is the behaviour the server's loop
    // relies on; a fixed pair would make the loop untestable.
    const early = await mockTurn(1);
    const late = await mockTurn(8);

    assert.ok(early.missing.length > late.missing.length, 'the missing list shrinks as answers arrive');
    assert.ok(late.have.length > early.have.length, 'the have list grows');
});

test('the mock\'s reply survives parseModelResponse as complete with a normalised payload', async () => {
    // End to end through the parser: the mock's actual output, not a hand-built
    // reply, must complete the interview and carry workflows the client can read.
    const reply = await mockTurn(8);
    const parsed = parseModelResponse(JSON.stringify(reply));

    assert.equal(parsed.status, 'complete', 'a real mock completion parses as complete');
    assert.ok(Array.isArray(parsed.audit?.workflows) && parsed.audit.workflows.length > 0);
    assert.equal(parsed.audit.illustrative, true, 'the illustrative flag survives normalisation');
});
