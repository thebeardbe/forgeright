/**
 * THE TWO STORED SHAPES, AND THE READERS THAT MUST AGREE ABOUT THEM.
 *
 * WHY THIS FILE EXISTS. A live interview saves `{ workflows: [ ... ] }`; an imported round saves the
 * workflow directly. Two readers assumed the second shape:
 *
 *   ai/merge-steps.js   read `response.data.steps`          -> 0 steps, 0 departments
 *   ai/weigh-core.js    read `response.data?.[field]`       -> {} for all fourteen fields
 *
 * On a real interview that scored a described process at ZERO, with "No steps were recorded" for
 * work the participant had described in three steps, and an EMPTY "what the participants said"
 * section in the weighing prompt - a reader failure that reads as a model failure.
 *
 * THE DEMO HID IT COMPLETELY: `scripts/seed-demo-org.js` writes the FLAT shape, so the committed
 * demo artefact weighs correctly and the deployed demo looks perfect. The first real client
 * interview would have been the one that scored zero.
 *
 * THE ROOT CAUSE IS THE SHAPE OF THE COVERAGE, NOT A MISSING ASSERTION. Every existing fixture in
 * both files used the flat shape, so the nested read was never exercised by anybody - and a shape
 * change in one module is invisible to another module's tests. So this file builds ONE workflow in
 * TWO stored shapes and asserts the two produce the SAME result, through EACH reader. That pairing
 * is what would have caught the defect on the day it broke: it fails the moment either reader
 * stops resolving, whichever shape the rest of the suite happens to use.
 *
 * BOTH SHAPES ARE ASSERTED, NOT ONLY THE NESTED ONE. A test that covered only the nested shape
 * would leave the demo path unguarded, and the demo is what the owner deploys - so the flat variant
 * is not legacy here, it is the deployed artefact.
 *
 * NO PRODUCTION CODE IS TOUCHED, and `data/demo/` plus `scripts/seed-demo-org.js` are unchanged:
 * the flat shape is deliberate and the committed scores (68, 58, 58, 58, 58, 38, 38) depend on it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeProcessSteps } from '../ai/merge-steps.js';
import { buildWeighingMessage } from '../ai/weigh-core.js';
import { responseWorkflow } from '../ai/response-shape.js';
import { responseWorkflow as reExported } from '../lib/view-format.js';

// ===========================================================================
// THE FIXTURE - one workflow, two stored shapes
// ===========================================================================

/**
 * A workflow as a participant described it, with the fields both readers consume.
 *
 * Three steps, one marked as needing a person, and one touched department - the shape of a real
 * answer rather than a single field. The counts matter: the defect reported 0 steps and 0
 * departments where the resolved read sees 3 and 1.
 */
const WORKFLOW = {
    task: 'entering invoices',
    trigger: 'the mail arrives',
    frequencyPerWeek: 40,
    peopleAffected: 3,
    touchedDepartments: ['Finance'],
    systems: ['Email', 'Excel'],
    currentState: 'by hand',
    frustration: 'the re-typing',
    steps: [
        { name: 'Open the invoice', whatHappens: 'open it in the mail client', decidedHow: 'a person decides', needsReasoning: false },
        { name: 'Check it against the order', whatHappens: 'compare with the order sheet', decidedHow: 'judgement for odd cases', needsReasoning: true },
        { name: 'Book it into the ledger', whatHappens: 'type it into the package', decidedHow: 'the package validates', needsReasoning: false }
    ]
};

/** The IMPORTED shape: the workflow IS the data. What the demo seed writes. */
const flatResponse = (overrides = {}) => ({ department: 'Finance', data: { ...WORKFLOW, ...overrides } });

/** The INTERVIEW shape: `{ workflows: [ ... ] }`. What the client posts on a live round. */
const nestedResponse = (overrides = {}) => ({
    department: 'Finance',
    data: { workflows: [{ ...WORKFLOW, ...overrides }] }
});

// ===========================================================================
// 1. mergeProcessSteps - BOTH SHAPES, SAME RESULT
// ===========================================================================

test('mergeProcessSteps: a NESTED payload yields the participant\'s steps, flags and departments', () => {
    // THE DEFECT ITSELF. This read `response.data.steps` and found nothing, so a described process
    // merged to zero steps with every step-derived term unmeasured.
    const merged = mergeProcessSteps([nestedResponse()]);

    assert.equal(merged.stepCount, 3, 'three steps are seen, not zero');
    assert.deepEqual(merged.steps.map((s) => s.name),
        ['Open the invoice', 'Check it against the order', 'Book it into the ledger']);
    assert.equal(merged.reasoningSteps, 1, 'the one step needing judgement is counted');
    assert.deepEqual(merged.describedBy, [['Finance', 1]], 'the touched department is seen, not zero');
});

test('mergeProcessSteps: the FLAT payload yields the SAME result as the nested one', () => {
    // THE PAIRING IS THE POINT. One workflow, two shapes, one answer - so a change that breaks
    // either read fails here whichever shape the rest of the suite uses. The flat variant is the
    // DEPLOYED demo artefact rather than a legacy case, so it is asserted rather than tolerated.
    const flat = mergeProcessSteps([flatResponse()]);
    const nested = mergeProcessSteps([nestedResponse()]);

    assert.deepEqual(flat, nested, 'the two shapes merge to the same result');
    // And the result is not the degenerate one, so this cannot pass by both being empty.
    assert.equal(flat.stepCount, 3);
    assert.deepEqual(flat.describedBy, [['Finance', 1]]);
});

test('the counts the defect reported: 0 steps and 0 departments become 3 and 1', () => {
    // The numbers from the live payload, pinned. A regression that reintroduced the flat read would
    // make this 0 and [] while every flat-shape test in merge-steps.test.js still passed.
    const merged = mergeProcessSteps([nestedResponse()]);

    assert.notEqual(merged.stepCount, 0, 'no longer zero steps');
    assert.notEqual(merged.describedBy.length, 0, 'no longer zero departments');
    assert.equal(merged.stepCount, WORKFLOW.steps.length);
    assert.deepEqual(merged.describedBy, [['Finance', 1]]);
});

test('mergeProcessSteps: TWO nested responses merge, so the shape works through the whole loop', () => {
    // The defect is per-response inside the loop. One response proves the read; two prove it is not
    // resolved once outside the loop and reused for the next, differently-shaped row.
    const second = nestedResponse({ steps: [{ name: 'Book it into the ledger', whatHappens: 'type it in', decidedHow: 'the package validates', needsReasoning: false }] });

    const merged = mergeProcessSteps([nestedResponse(), second]);

    assert.equal(merged.stepCount, 3, 'the shared step is merged, not duplicated');
    // BOTH responses came from Finance, so the department is counted TWICE - `describedBy` counts
    // how many people spoke rather than how many teams the work crosses, and two responses are two
    // people. This is also the assertion that the two-response path resolves the shape per response
    // rather than once for the first.
    assert.deepEqual(merged.describedBy, [['Finance', 2]]);
});

// ===========================================================================
// 2. mergeParticipants - THE SECOND ROUTE TO ZERO
// ===========================================================================

/** A weighing message built from one response, with the named workflow. */
function weighingMessage(response) {
    return buildWeighingMessage({
        process: { name: 'Invoice intake' },
        grouping: { responses: [response] }
    });
}

/**
 * The JSON block the prompt carries under `## What the participants said`.
 *
 * BALANCED-BRACE EXTRACTION rather than first-brace-to-last: the block is `JSON.stringify(merged,
 * null, 2)`, pretty-printed with NESTED objects, and a later section carries its own braces - so a
 * naive slice would swallow the steps block and fail to parse.
 */
function participantFields(message) {
    const marker = '## What the participants said';
    const start = message.indexOf('{', message.indexOf(marker));
    assert.notEqual(start, -1, 'the participants section carries a JSON object');

    let depth = 0;
    for (let i = start; i < message.length; i += 1) {
        if (message[i] === '{') depth += 1;
        else if (message[i] === '}') {
            depth -= 1;
            if (depth === 0) return JSON.parse(message.slice(start, i + 1));
        }
    }
    assert.fail('the participants JSON block is unterminated');
}

test('mergeParticipants: a NESTED payload reaches the weighing prompt, not an empty section', () => {
    // THE SECOND ROUTE TO ZERO, and the nastier one: an empty prompt section looks like a MODEL
    // failure rather than a reader failure, so it is investigated in the wrong place. This read
    // `response.data?.[field]` and found nothing for any of the fourteen fields.
    const message = weighingMessage(nestedResponse());
    const fields = participantFields(message);

    assert.notDeepEqual(fields, {}, 'the participant section is NOT empty');
    assert.equal(fields.task, 'entering invoices', 'the task reaches the prompt');
    assert.equal(fields.frequencyPerWeek, 40, 'a number reaches the prompt');
    assert.deepEqual(fields.touchedDepartments, ['Finance'], 'a list reaches the prompt');
});

test('mergeParticipants: the FLAT payload reaches the SAME prompt fields', () => {
    // The pairing, as in the merge. Both shapes must produce the same participant block.
    const flat = participantFields(weighingMessage(flatResponse()));
    const nested = participantFields(weighingMessage(nestedResponse()));

    assert.deepEqual(flat, nested, 'the two shapes produce the same participant block');
    assert.notDeepEqual(flat, {}, 'and it is not empty');
});

test('the participant block carries ALL the fields the participant supplied', () => {
    // A single-field check would pass on a reader that resolved one field and dropped the rest. Each
    // field the fixture carries is asserted separately, so a partial resolution fails.
    const fields = participantFields(weighingMessage(nestedResponse()));

    assert.equal(fields.task, WORKFLOW.task);
    assert.equal(fields.trigger, WORKFLOW.trigger);
    assert.equal(fields.frequencyPerWeek, WORKFLOW.frequencyPerWeek);
    assert.equal(fields.peopleAffected, WORKFLOW.peopleAffected);
    assert.equal(fields.currentState, WORKFLOW.currentState);
    assert.equal(fields.frustration, WORKFLOW.frustration);
    assert.deepEqual(fields.systems, WORKFLOW.systems);
    assert.deepEqual(fields.touchedDepartments, WORKFLOW.touchedDepartments);
});

test('the weighing prompt keeps its section heading with content under it', () => {
    // The empty section was the SYMPTOM, so the heading plus content is asserted as a pair: the
    // heading alone would render for an empty block too, which is what made the defect look like a
    // model failure.
    const message = weighingMessage(nestedResponse());
    assert.match(message, /## What the participants said\s*\{[^}]*"task"/,
        'the heading is followed by real fields, not an empty object');
});

// ===========================================================================
// 3. responseWorkflow - IN ITS NEW HOME, AND THE RE-EXPORT
// ===========================================================================

test('responseWorkflow returns the FLAT input BY REFERENCE, so a caller can rely on identity', () => {
    const workflow = { task: 'direct' };
    assert.equal(responseWorkflow(workflow), workflow, 'the flat shape is the object itself');
});

test('responseWorkflow returns the FIRST workflow of the nested shape', () => {
    const first = { task: 'A' };
    assert.equal(responseWorkflow({ workflows: [first, { task: 'B' }] }), first);
});

test('responseWorkflow returns null for `{}`, null, an array, and a non-object', () => {
    // The cases the old suite covered, re-asserted here so the MOVE did not lose any of them - the
    // resolver's behaviour is a contract three readers depend on.
    for (const input of [{}, null, undefined, 0, '', false, [{ task: 'bare' }]]) {
        assert.equal(responseWorkflow(input), null, `${JSON.stringify(input)} resolves to null`);
    }
});

test('responseWorkflow skips a malformed entry inside `workflows` for a usable one', () => {
    const usable = { task: 'The real one' };
    assert.equal(responseWorkflow({ workflows: [null, 'not an object', usable] }), usable);
});

test('the RE-EXPORT from lib/view-format.js is the same function, so callers are unchanged', () => {
    // The move is an implementation detail: `server.js` and the views import from `lib/view-format.js`
    // and must keep working. Identity is the strongest form of that assertion.
    assert.equal(reExported, responseWorkflow, 'the re-export is the same function object');
    assert.equal(reExported({ workflows: [{ task: 'x' }] }).task, 'x', 'and it resolves');
});

// ===========================================================================
// 4. THE PROPERTY THAT WOULD HAVE CAUGHT IT ON THE DAY
// ===========================================================================

test('BOTH READERS AGREE ABOUT BOTH SHAPES - the shape of the coverage that was missing', () => {
    // THE TEST THIS FILE EXISTS FOR. The defect was not a missing assertion inside one reader; it
    // was that no reader's tests exercised the shape the OTHER module produced. So this asserts the
    // two shapes produce identical results through BOTH readers AT ONCE - and it fails if either
    // reader stops resolving, whichever shape the other tests in the suite happen to use.
    const nested = {
        merged: mergeProcessSteps([nestedResponse()]),
        fields: participantFields(weighingMessage(nestedResponse()))
    };
    const flat = {
        merged: mergeProcessSteps([flatResponse()]),
        fields: participantFields(weighingMessage(flatResponse()))
    };

    assert.deepEqual(nested, flat, 'both readers agree about both shapes');
    // And neither result is degenerate, so agreement is not agreement-on-nothing.
    assert.equal(nested.merged.stepCount, 3);
    assert.equal(nested.fields.task, 'entering invoices');
});

test('a SHAPE CHANGE IN A RESPONSE IS VISIBLE TO BOTH READERS, not to one', () => {
    // The generalisation of the root cause: change one field in the payload and BOTH readers must
    // see the change. If a reader is reading the wrong shape it sees nothing, and this catches it
    // with a single-field delta rather than a full fixture.
    const renamed = nestedResponse({ task: 'a different task' });

    const merged = mergeProcessSteps([renamed]);
    const fields = participantFields(weighingMessage(renamed));

    assert.equal(fields.task, 'a different task', 'the weighing reader sees the change');
    assert.equal(merged.stepCount, 3, 'and the step reader still resolves the same payload');
});
