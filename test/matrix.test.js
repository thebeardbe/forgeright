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
