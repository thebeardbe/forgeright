/**
 * The field lists are read FROM THE MODULE throughout, never restated, so a change to the matrix
 * cannot leave these tests asserting a stale shape.
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
 * Built from the field lists, so adding a field to the matrix makes this builder supply it.
 * `id` and `title` are required by validateWorkflows, not the matrix.
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

function completeStep(overrides = {}) {
    const step = {};
    for (const field of STEP_FIELDS) {
        step[field] = field === 'needsReasoning' ? false : `a value for ${field}`;
    }
    return { ...step, ...overrides };
}

function completeWith(processes, extra = {}) {
    return parseModelResponse(JSON.stringify({ status: 'complete', content: 'done', processes, ...extra }));
}

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
    for (const field of PROCESS_FIELDS) {
        const process = completeProcess();
        delete process[field];

        const result = completeWith([process]);
        assert.equal(result.status, 'asking', `removing ${field} must block completion`);
        assert.ok(result.missing.includes(field), `removing ${field} must name it in missing`);
    }
});

test('a step missing a required field blocks completion of the PROCESS', () => {
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
    for (const bad of ['true', 1, null, undefined, {}]) {
        const process = completeProcess({ steps: [completeStep({ needsReasoning: bad })] });
        const result = completeWith([process]);
        assert.equal(result.status, 'asking', `needsReasoning ${JSON.stringify(bad)} must not count as supplied`);
    }
});

test('ONE incomplete process among several blocks completion of the whole interview', () => {
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
    const process = completeProcess();
    delete process.trigger;

    const result = completeWith([process]);
    assert.equal(result.status, 'asking');
    assert.ok(result.missing.includes('trigger'));
});

test('a CLAIMED field cannot make a real gap vanish when closing', () => {
    // At closing only the payload counts, so a `have` claim cannot hide an absent field.
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
    assert.ok(EFFORT_FIELDS.some((f) => missing.includes(f)), 'the effort requirement is reported missing');
    assert.equal(missing.includes(EFFORT_FIELDS[0]), true);
    assert.equal(missing.includes(EFFORT_FIELDS[1]), true);
    assert.equal(completeWith([process]).status, 'asking');
});

//
// There is NO function deriving needsReasoning from a decidedHow string: it is the MODEL's reading,
// stored on the step.

test('the matrix forces every step to carry the derived flag', () => {
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
    assert.ok(judgementBandFor({ steps: [{ needsReasoning: true }] }) < judgementBandFor({ steps: [{ needsReasoning: false }] }));
});

test('the fixture pairs a rule with false and a variable basis with true, per the prompt', async () => {
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

//
// A reply carrying `processes` and no `audit` must not fall through to the single-shot check.

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
    assert.equal(workflowsFrom({ processes: [] }), undefined);
});

test('workflowsFrom prefers processes when BOTH shapes are present', () => {
    assert.deepEqual(
        workflowsFrom({ processes: [{ id: 'interview' }], audit: { workflows: [{ id: 'singleshot' }] } }),
        [{ id: 'interview' }]
    );
});

test('an interview reply with a stub processes and a complete audit does not complete', () => {
    const result = parseModelResponse(JSON.stringify({
        status: 'complete',
        content: 'done',
        processes: [{ task: 'a stub' }],
        audit: { workflows: [{ id: 'w1', title: 'A complete workflow' }] }
    }));
    assert.equal(result.status, 'asking', 'the incomplete interview shape governs');
});

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
        if (['mistakesPerPeriod', 'peopleAffected'].includes(field)) {
            const process = completeProcess();
            process[field] = 0;
            assert.equal(fieldsMissingFrom(process).includes(field), false, `${field}=0 is a supplied count`);
        }
    }
});

test('an EMPTY ARRAY is not supplied, because it is a statement nobody made', () => {
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
    const process = completeProcess();
    process.frequencyPerWeek = 3;
    process.timePerPeriod = '2 hours a day';

    assert.deepEqual(fieldsMissingFrom(process), []);
    assert.equal(completeWith([process]).status, 'complete');
});

async function mockTurn(userTurns, lang = 'en') {
    const { generate } = await import('../ai/adapters/mock.js');
    const messages = Array.from({ length: userTurns }, (_, i) => ({ role: 'user', content: `answer ${i}` }));
    return JSON.parse(await generate({ messages, providerConfig: { lang } }));
}

test('the mock emits `processes` and NOT `audit` on completion', async () => {
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
    const early = await mockTurn(1);
    const late = await mockTurn(8);

    assert.ok(early.missing.length > late.missing.length, 'the missing list shrinks as answers arrive');
    assert.ok(late.have.length > early.have.length, 'the have list grows');
});

test('the mock\'s reply survives parseModelResponse as complete with a normalised payload', async () => {
    const reply = await mockTurn(8);
    const parsed = parseModelResponse(JSON.stringify(reply));

    assert.equal(parsed.status, 'complete', 'a real mock completion parses as complete');
    assert.ok(Array.isArray(parsed.audit?.workflows) && parsed.audit.workflows.length > 0);
    assert.equal(parsed.audit.illustrative, true, 'the illustrative flag survives normalisation');
});

//
// Keeping `audit` whenever it is merely non-null lets an empty or stale one win over a good
// `processes`, so the client scores an empty list.

test('a complete processes beats an EMPTY audit.workflows', () => {
    const result = completeWith([completeProcess()], { audit: { workflows: [] } });

    assert.equal(result.status, 'complete');
    assert.ok(Array.isArray(result.audit.workflows), 'the client still receives a workflows array');
    assert.equal(result.audit.workflows.length, 1, 'the processes are used, not the empty audit');
    assert.equal(result.audit.workflows[0].id, 'process-1');
});

test('a complete processes beats a WRONG-TYPED audit.workflows', () => {
    for (const bad of ['oops', {}, 42, null]) {
        const result = completeWith([completeProcess()], { audit: { workflows: bad } });

        assert.equal(result.status, 'complete', `audit.workflows=${JSON.stringify(bad)} must not break completion`);
        assert.equal(result.audit.workflows.length, 1, `the processes win over ${JSON.stringify(bad)}`);
        assert.equal(result.audit.workflows[0].id, 'process-1');
    }
});

test('a complete processes beats an audit with NO workflows key', () => {
    const result = completeWith([completeProcess()], { audit: {} });

    assert.equal(result.status, 'complete');
    assert.equal(result.audit.workflows.length, 1);
    assert.equal(result.audit.workflows[0].id, 'process-1');
});

test('a complete processes beats a STALE audit.workflows carrying an older entry', () => {
    const result = completeWith([completeProcess()], {
        audit: { workflows: [{ id: 'a-stale-entry', title: 'From an earlier turn' }] }
    });

    assert.equal(result.status, 'complete');
    assert.equal(result.audit.workflows.length, 1);
    assert.equal(result.audit.workflows[0].id, 'process-1', 'the fresh processes win, not the stale audit');
    assert.equal(
        result.audit.workflows.some((w) => w.id === 'a-stale-entry'),
        false,
        'the stale entry is not in the payload the client reads'
    );
});

test('an audit.workflows still resolves when there are NO processes', () => {
    const result = parseModelResponse(JSON.stringify({
        status: 'complete',
        content: 'done',
        audit: { workflows: [{ id: 'w1', title: 'From the single-shot shape' }] }
    }));

    assert.equal(result.status, 'complete');
    assert.deepEqual(result.audit.workflows, [{ id: 'w1', title: 'From the single-shot shape' }]);
});

test('the illustrative and note flags are still taken from either place', () => {
    const fromRoot = completeWith([completeProcess()], { illustrative: true, note: 'at the root' });
    assert.equal(fromRoot.audit.illustrative, true);
    assert.equal(fromRoot.audit.note, 'at the root');

    const fromEnvelope = completeWith([completeProcess()], { audit: { workflows: [], illustrative: true, note: 'in the envelope' } });
    assert.equal(fromEnvelope.audit.illustrative, true);
    assert.equal(fromEnvelope.audit.note, 'in the envelope');
});

test('frequencyPerWeek: 0 asks again, and names the field', () => {
    // Zero means the process does not happen, which a model without an answer fills as a placeholder.
    const result = completeWith([completeProcess({ frequencyPerWeek: 0 })]);

    assert.equal(result.status, 'asking');
    assert.ok(result.missing.includes('frequencyPerWeek'), `the field is named, got ${JSON.stringify(result.missing)}`);
});

test('any NON-ZERO frequency counts, so the intended range is preserved', () => {
    for (const frequency of [0.01, 0.08, 0.25, 1, 52]) {
        const result = completeWith([completeProcess({ frequencyPerWeek: frequency })]);
        assert.equal(result.status, 'complete', `frequency ${frequency} must count as supplied`);
        assert.equal(result.missing.includes('frequencyPerWeek'), false, `frequency ${frequency} must not be missing`);
    }
});

test('a NEGATIVE frequency is refused, as a count cannot be negative', () => {
    for (const frequency of [-1, -0.5, -52]) {
        const result = completeWith([completeProcess({ frequencyPerWeek: frequency })]);
        assert.equal(result.status, 'asking', `frequency ${frequency} must be refused`);
        assert.ok(result.missing.includes('frequencyPerWeek'));
    }
});

test('mistakesPerPeriod: 0 is STILL SUPPLIED, because "it never goes wrong" is an answer', () => {
    const result = completeWith([completeProcess({ mistakesPerPeriod: 0 })]);

    assert.equal(result.status, 'complete', 'a process that never goes wrong is a complete answer');
    assert.equal(result.missing.includes('mistakesPerPeriod'), false);
});

test('the two zero rules are DIFFERENT, asserted together', () => {
    const frequencyZero = completeWith([completeProcess({ frequencyPerWeek: 0 })]);
    const mistakesZero = completeWith([completeProcess({ mistakesPerPeriod: 0 })]);

    assert.equal(frequencyZero.status, 'asking', 'frequency 0 is a gap');
    assert.equal(mistakesZero.status, 'complete', 'mistakes 0 is a fact');
    assert.notEqual(frequencyZero.status, mistakesZero.status);
});

test('a negative mistakesPerPeriod is still refused, only zero is special', () => {
    const result = completeWith([completeProcess({ mistakesPerPeriod: -1 })]);
    assert.equal(result.status, 'asking');
    assert.ok(result.missing.includes('mistakesPerPeriod'));
});

test('a step WITHOUT reasoningBasis still completes the interview', () => {
    const step = completeStep();
    assert.equal(step.reasoningBasis, undefined, 'the builder does not set it');

    const result = completeWith([completeProcess({ steps: [step] })]);
    assert.equal(result.status, 'complete', 'an optional field cannot gate completion');
    assert.deepEqual(result.missing, []);
});

test('a PRESENT reasoningBasis must be real prose, or the step is incomplete', () => {
    for (const bad of ['', '   ', '\t\n', 42, {}, []]) {
        const result = completeWith([completeProcess({ steps: [completeStep({ reasoningBasis: bad })] })]);
        assert.equal(result.status, 'asking', `reasoningBasis ${JSON.stringify(bad)} must not count`);
        assert.ok(result.missing.includes('steps'), 'the step is missing');
    }
});

test('a null or undefined reasoningBasis is treated as absent, not as wrong', () => {
    for (const absent of [null, undefined]) {
        const result = completeWith([completeProcess({ steps: [completeStep({ reasoningBasis: absent })] })]);
        assert.equal(result.status, 'complete', `reasoningBasis ${String(absent)} is simply not there`);
    }
});

test('a well-formed reasoningBasis completes and is kept', () => {
    const step = completeStep({ reasoningBasis: 'if stock is under ten' });
    const result = completeWith([completeProcess({ steps: [step] })]);

    assert.equal(result.status, 'complete');
    assert.equal(result.audit.workflows[0].steps[0].reasoningBasis, 'if stock is under ten');
});

test('the band distinguishes one judgement in six from six mechanical', () => {
    const oneOfSix = judgementBandFor({ steps: [...Array(1)].map(() => ({ needsReasoning: true })).concat([...Array(5)].map(() => ({ needsReasoning: false }))) });
    const zeroOfSix = judgementBandFor({ steps: [...Array(6)].map(() => ({ needsReasoning: false })) });

    assert.equal(oneOfSix, 4, 'one judgement in six is band 4');
    assert.equal(zeroOfSix, 5, 'six mechanical is band 5');
    assert.notEqual(oneOfSix, zeroOfSix);
});

test('THE FLATTENING POINT: one judgement in EIGHT reads the same as none', () => {
    // The dilution: 1/8 = 0.125, 5 - 0.125*4 = 4.5, which rounds to 5. At eight steps the boundary
    // vanishes.
    const oneOfEight = judgementBandFor({ steps: [...Array(1)].map(() => ({ needsReasoning: true })).concat([...Array(7)].map(() => ({ needsReasoning: false }))) });
    const zeroOfEight = judgementBandFor({ steps: [...Array(8)].map(() => ({ needsReasoning: false })) });

    assert.equal(oneOfEight, 5, 'one judgement in eight rounds up to band 5');
    assert.equal(zeroOfEight, 5, 'and so does none');
    assert.equal(oneOfEight, zeroOfEight, 'the boundary is invisible at this length');
});

test('one judgement in SEVEN is still band 4, so the flattening starts at eight', () => {
    const oneOfSeven = judgementBandFor({ steps: [...Array(1)].map(() => ({ needsReasoning: true })).concat([...Array(6)].map(() => ({ needsReasoning: false }))) });
    assert.equal(oneOfSeven, 4, 'seven is the last length where one judgement is visible');
});

test('the band monotonicity holds: more reasoning steps never raises the band', () => {
    for (const total of [2, 3, 5, 6, 8, 10]) {
        let previous = 6;
        for (let reasoning = 0; reasoning <= total; reasoning += 1) {
            const steps = [...Array(reasoning)].map(() => ({ needsReasoning: true }))
                .concat([...Array(total - reasoning)].map(() => ({ needsReasoning: false })));
            const band = judgementBandFor({ steps });
            assert.ok(band <= previous, `${reasoning}/${total} must not be higher than ${reasoning - 1}/${total}`);
            previous = band;
        }
        assert.equal(judgementBandFor({ steps: [...Array(total)].map(() => ({ needsReasoning: true })) }), 1, `all judgement of ${total} is band 1`);
    }
});

test('an explicit judgementScore still wins, and the flags are then ignored', () => {
    const withFlags = { judgementScore: 2, steps: [...Array(6)].map(() => ({ needsReasoning: false })) };
    assert.equal(judgementBandFor(withFlags), 2, 'the explicit score is used');
});
