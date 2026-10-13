/**
 * The step merge: `mergeProcessSteps` in `ai/merge-steps.js`.
 *
 * This rule was previously inline in `views/admin-roadmap.ejs`, where no test
 * could reach it. It decides what the automation boundary is — which is the one
 * thing a reader of the roadmap most needs to be true — so it now has the coverage
 * it never had.
 *
 * THE RULE IS NOT RESTATED HERE. Cases are built from the module's own exports and
 * the real fixture where the fixture is the point, so a change to the merge cannot
 * leave these tests asserting a stale copy of it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeProcessSteps, stepNeedsReasoning } from '../ai/merge-steps.js';
import { buildMockAudit } from '../ai/fixtures/mock-audit.js';
import { TERMS } from '../lib/store/weighing.js';

/** A response row as the store hands it to the merge: steps under `data`. */
function response(steps, extra = {}) {
    return { department: 'Finance', data: { steps }, ...extra };
}

// ===========================================================================
// 1. mergeProcessSteps
// ===========================================================================

test('steps are merged by name, so overlapping accounts produce NO duplicate', () => {
    const first = response([
        { name: 'Open the invoice', whatHappens: 'open it', needsReasoning: false },
        { name: 'Book the invoice', whatHappens: 'book it', needsReasoning: false }
    ]);
    const second = response([
        { name: 'Open the invoice', whatHappens: 'open it too', needsReasoning: false },
        { name: 'Book the invoice', whatHappens: 'book it', needsReasoning: false }
    ]);

    const merged = mergeProcessSteps([first, second]);

    assert.equal(merged.stepCount, 2, 'two distinct names, not four entries');
    assert.deepEqual(merged.steps.map((s) => s.name), ['Open the invoice', 'Book the invoice']);
});

test('the step count does NOT grow with the number of responses', () => {
    // The failure this prevents: rendering the same three-step process once per
    // response showed a three-step process three times over.
    const steps = [
        { name: 'One', whatHappens: 'a', needsReasoning: false },
        { name: 'Two', whatHappens: 'b', needsReasoning: true },
        { name: 'Three', whatHappens: 'c', needsReasoning: false }
    ];
    const one = mergeProcessSteps([response(steps)]);
    const three = mergeProcessSteps([response(steps), response(steps), response(steps)]);

    assert.equal(one.stepCount, 3);
    assert.equal(three.stepCount, 3, 'three accounts of one process are still three steps');
    assert.deepEqual(three.steps.map((s) => s.name), one.steps.map((s) => s.name));
});

test('merging is case- and whitespace-insensitive on the name', () => {
    const merged = mergeProcessSteps([
        response([{ name: 'Open the invoice', whatHappens: 'a', needsReasoning: false }]),
        response([{ name: '  OPEN THE INVOICE  ', whatHappens: 'b', needsReasoning: false }])
    ]);

    assert.equal(merged.stepCount, 1, 'the same step named differently by case is still one step');
});

test('a step only ONE response mentioned SURVIVES the merge', () => {
    // THE DATA-LOSS CASE, and the reason this task exists. Dropping a step somebody
    // described would quietly remove work from the roadmap.
    const first = response([
        { name: 'Match the amounts', whatHappens: 'compare', decidedHow: 'a two-euro rule', needsReasoning: false }
    ]);
    const second = response([
        { name: 'Match the amounts', whatHappens: 'compare totals', decidedHow: 'depends on the supplier', needsReasoning: true },
        { name: 'Query a mismatch', whatHappens: 'email the supplier', decidedHow: 'depends who replies fastest', needsReasoning: true }
    ]);

    const merged = mergeProcessSteps([first, second]);

    assert.equal(merged.stepCount, 2, 'the step one account mentioned is kept');
    assert.ok(merged.steps.some((s) => s.name === 'Query a mismatch'), 'Query a mismatch survives');
});

test('needsReasoning is TRUE if ANY response says true', () => {
    // The pessimistic reading, and the point of the merge: taking the optimistic
    // one would hide exactly the work the roadmap exists to surface.
    const merged = mergeProcessSteps([
        response([{ name: 'Match the amounts', whatHappens: 'a', decidedHow: 'a rule', needsReasoning: false }]),
        response([{ name: 'Match the amounts', whatHappens: 'b', decidedHow: 'depends', needsReasoning: true }])
    ]);

    assert.equal(merged.steps.length, 1);
    assert.equal(merged.steps[0].needsReasoning, true, 'one person saying judgement means judgement');
});

test('needsReasoning stays FALSE when every response says false', () => {
    const merged = mergeProcessSteps([
        response([{ name: 'Open', whatHappens: 'a', needsReasoning: false }]),
        response([{ name: 'Open', whatHappens: 'bb', needsReasoning: false }])
    ]);

    assert.equal(merged.steps[0].needsReasoning, false);
});

test('the LONGER whatHappens wins', () => {
    const merged = mergeProcessSteps([
        response([{ name: 'Open', whatHappens: 'short', needsReasoning: false }]),
        response([{ name: 'Open', whatHappens: 'a much longer description of the same step', needsReasoning: false }])
    ]);

    assert.equal(merged.steps[0].whatHappens, 'a much longer description of the same step');
});

test('the FIRST non-empty decidedHow wins', () => {
    // A basis is a basis: the first account to state one is not made wrong by a
    // second that omits it.
    const merged = mergeProcessSteps([
        response([{ name: 'Open', whatHappens: 'a', decidedHow: '', needsReasoning: false }]),
        response([{ name: 'Open', whatHappens: 'b', decidedHow: 'the inbox order', needsReasoning: false }]),
        response([{ name: 'Open', whatHappens: 'c', decidedHow: 'something else', needsReasoning: false }])
    ]);

    assert.equal(merged.steps[0].decidedHow, 'the inbox order');
});

test('a single response is returned unchanged, including order and flags', () => {
    const steps = [
        { name: 'First', whatHappens: 'a', decidedHow: 'x', needsReasoning: false },
        { name: 'Second', whatHappens: 'b', decidedHow: 'y', needsReasoning: true },
        { name: 'Third', whatHappens: 'c', decidedHow: 'z', needsReasoning: false }
    ];

    const merged = mergeProcessSteps([response(steps)]);

    assert.deepEqual(merged.steps, steps, 'nothing to merge, so nothing changes');
    assert.equal(merged.reasoningSteps, 1);
});

test('first-seen order is kept, and later steps append rather than reorder', () => {
    const merged = mergeProcessSteps([
        response([{ name: 'A', whatHappens: 'a', needsReasoning: false }, { name: 'B', whatHappens: 'b', needsReasoning: false }]),
        response([{ name: 'B', whatHappens: 'b2', needsReasoning: false }, { name: 'C', whatHappens: 'c', needsReasoning: false }])
    ]);

    assert.deepEqual(merged.steps.map((s) => s.name), ['A', 'B', 'C']);
});

test('the merged steps are a COPY: mutating them does not touch the input', () => {
    const steps = [{ name: 'Open', whatHappens: 'a', needsReasoning: false }];
    const input = response(steps);
    const merged = mergeProcessSteps([input]);

    merged.steps[0].whatHappens = 'changed';
    assert.equal(input.data.steps[0].whatHappens, 'a', 'the caller\'s response is not mutated');
});

// --- negative and malformed input -------------------------------------------

test('an empty response list gives an empty result', () => {
    const merged = mergeProcessSteps([]);
    assert.deepEqual(merged.steps, []);
    assert.equal(merged.stepCount, 0);
    assert.equal(merged.reasoningSteps, 0);
    assert.deepEqual(merged.describedBy, []);
});

test('a non-array argument is treated as no responses', () => {
    for (const bad of [null, undefined, 'responses', 42, {}]) {
        const merged = mergeProcessSteps(bad);
        assert.deepEqual(merged.steps, [], `input ${JSON.stringify(bad)} must give no steps`);
    }
});

test('a response with no steps contributes nothing but does not throw', () => {
    const merged = mergeProcessSteps([{ department: 'Finance', data: {} }, null, undefined]);
    assert.deepEqual(merged.steps, []);
});

test('steps that are not objects are skipped, and a nameless step too', () => {
    // A non-object step has no name to merge on, and a step with neither name nor
    // whatHappens has no key at all.
    const merged = mergeProcessSteps([
        response([null, 42, 'a string', {}, { name: 'Real', whatHappens: 'r', needsReasoning: false }])
    ]);

    assert.deepEqual(merged.steps.map((s) => s.name), ['Real']);
});

test('a step with only a whatHappens is keyed and kept', () => {
    // The key falls back to whatHappens when there is no name, so a step that
    // describes the work without naming it is not dropped.
    const merged = mergeProcessSteps([response([{ whatHappens: 'Key a number in', needsReasoning: false }])]);
    assert.equal(merged.stepCount, 1);
});

test('reasoningSteps counts only the steps that need a person', () => {
    const merged = mergeProcessSteps([
        response([
            { name: 'A', whatHappens: 'a', needsReasoning: true },
            { name: 'B', whatHappens: 'b', needsReasoning: false },
            { name: 'C', whatHappens: 'c', needsReasoning: true }
        ])
    ]);

    assert.equal(merged.reasoningSteps, 2);
    assert.equal(merged.reasoningSteps, merged.steps.filter(stepNeedsReasoning).length);
});

test('a needsReasoning that is not the boolean true does not count', () => {
    const merged = mergeProcessSteps([
        response([{ name: 'A', whatHappens: 'a', needsReasoning: 'true' }, { name: 'B', whatHappens: 'b', needsReasoning: 1 }])
    ]);

    assert.equal(merged.reasoningSteps, 0, 'the flag is the boolean true or it is not a judgement');
});

// --- describedBy ------------------------------------------------------------

test('describedBy counts the departments that described the work', () => {
    const merged = mergeProcessSteps([
        { department: 'Ops', data: { touchedDepartments: ['Ops'], steps: [] } },
        { department: 'Ops', data: { touchedDepartments: ['Ops'], steps: [] } },
        { department: 'Finance', data: { touchedDepartments: ['Finance'], steps: [] } }
    ]);

    assert.deepEqual(merged.describedBy, [['Ops', 2], ['Finance', 1]], 'sorted by count, highest first');
});

test('describedBy falls back to the response department when none were listed', () => {
    const merged = mergeProcessSteps([
        { department: 'Warehouse', data: { steps: [] } },
        { department: 'Warehouse', data: { steps: [] } }
    ]);

    assert.deepEqual(merged.describedBy, [['Warehouse', 2]]);
});

// ===========================================================================
// THE REAL FIXTURE: THE DISAGREEMENT AND THE ONE-ACCOUNT STEP
// ===========================================================================

test('the fixture\'s two invoice accounts merge into one step list, with no duplicates', () => {
    const audit = buildMockAudit('en');
    const invoiceProcesses = audit.workflows.filter((w) => /invoice/i.test(w.title));
    assert.equal(invoiceProcesses.length, 2, 'the fixture carries two accounts of one process');

    const responses = invoiceProcesses.map((w) => ({ department: 'Finance', data: { steps: w.steps, touchedDepartments: w.touchedDepartments } }));
    const merged = mergeProcessSteps(responses);

    // One process, so the merged count is a single account's count plus anything
    // only the other account mentioned; it must NOT be the sum of both.
    const sum = invoiceProcesses.reduce((n, w) => n + w.steps.length, 0);
    assert.ok(merged.stepCount < sum, `no duplicate steps: got ${merged.stepCount} of ${sum} raw`);
    assert.equal(new Set(merged.steps.map((s) => s.name)).size, merged.stepCount);
});

test('the fixture\'s disagreement on Match the amounts resolves to TRUE', () => {
    // Verified against the fixture, where one account calls it a two-euro rule and
    // the other a judgement about the supplier.
    const audit = buildMockAudit('en');
    const invoiceProcesses = audit.workflows.filter((w) => /invoice/i.test(w.title));
    const responses = invoiceProcesses.map((w) => ({ department: 'Finance', data: { steps: w.steps } }));

    const merged = mergeProcessSteps(responses);
    const match = merged.steps.find((s) => s.name === 'Match the amounts');

    assert.ok(match, 'the step is present');
    assert.equal(match.needsReasoning, true, 'the pessimistic reading wins');

    // And the accounts really did disagree, so this is not a case of both saying true.
    const flags = invoiceProcesses.map((w) => w.steps.find((s) => s.name === 'Match the amounts').needsReasoning);
    assert.deepEqual(flags.sort(), [false, true].sort(), 'the fixture holds a genuine disagreement');
});

test('the fixture\'s one-account step Query a mismatch survives the merge', () => {
    // The real case the merge must not drop: it exists in ONE account only.
    const audit = buildMockAudit('en');
    const invoiceProcesses = audit.workflows.filter((w) => /invoice/i.test(w.title));

    const owners = invoiceProcesses.filter((w) => w.steps.some((s) => s.name === 'Query a mismatch'));
    assert.equal(owners.length, 1, 'the fixture has the step in exactly one account, which is the point');

    const responses = invoiceProcesses.map((w) => ({ department: 'Finance', data: { steps: w.steps } }));
    const merged = mergeProcessSteps(responses);

    assert.ok(merged.steps.some((s) => s.name === 'Query a mismatch'), 'the single-account step is not dropped');
});

// ===========================================================================
// 2. ONE LIST, NOT TWO DERIVATIONS
// ===========================================================================
//
// The weighing prompt and the roadmap view must show the SAME merged steps. They
// were two independent derivations before, and a divergence would be invisible:
// the page showing five steps while the model was shown nine.

test('the weighing prompt and the view derive the SAME steps for one process', async () => {
    const weighCore = await import('../ai/weigh-core.js');
    const audit = buildMockAudit('en');
    const responses = audit.workflows
        .filter((w) => /invoice/i.test(w.title))
        .map((w) => ({ department: 'Finance', data: { steps: w.steps, touchedDepartments: w.touchedDepartments } }));

    // The view's derivation, exactly as the template calls it.
    const viewSteps = mergeProcessSteps(responses).steps;

    // The prompt's derivation, via buildWeighingMessage, parsed back out of the
    // message the model would receive.
    const message = weighCore.buildWeighingMessage({ process: { name: 'Invoices' }, grouping: { responses } });
    const marker = '## The steps, in order';
    const afterMarker = message.slice(message.indexOf(marker));
    const jsonText = afterMarker.slice(afterMarker.indexOf('['), afterMarker.lastIndexOf(']') + 1);
    const promptSteps = JSON.parse(jsonText);

    assert.deepEqual(promptSteps, viewSteps, 'the model is shown the same steps the page renders');
    assert.deepEqual(
        promptSteps.map((s) => s.name),
        viewSteps.map((s) => s.name),
        'the names and their order agree'
    );
});

test('both derivations go through the ONE module, not two copies of the rule', async () => {
    // The unit-level version of the property above: `collectSteps` in the weighing
    // core delegates rather than reimplementing, which is what made the two agree.
    const weighCore = await import('../ai/weigh-core.js');
    const responses = [
        { department: 'Finance', data: { steps: [{ name: 'A', whatHappens: 'a', needsReasoning: false }] } },
        { department: 'Finance', data: { steps: [{ name: 'A', whatHappens: 'aa', needsReasoning: true }, { name: 'B', whatHappens: 'b', needsReasoning: false }] } }
    ];

    const message = weighCore.buildWeighingMessage({ process: { name: 'P' }, grouping: { responses } });
    const marker = '## The steps, in order';
    const afterMarker = message.slice(message.indexOf(marker));
    const jsonText = afterMarker.slice(afterMarker.indexOf('['), afterMarker.lastIndexOf(']') + 1);

    assert.deepEqual(JSON.parse(jsonText), mergeProcessSteps(responses).steps);
});

test('the merge is pure: no store, no connection, no org id', async () => {
    // It is given plain responses and returns plain steps, which is what makes it
    // testable with literals and safe for both callers.
    const source = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../ai/merge-steps.js', import.meta.url), 'utf8'));
    assert.equal(/from '\.\.\/lib\//.test(source), false, 'ai/ does not import lib/');
    assert.equal(/requireConnection|new DatabaseSync/.test(source), false, 'no connection is opened');
    // And the only imports are within the ai layer.
    //
    // THE EXHAUSTIVE LIST, KEPT EXHAUSTIVE. The property is "no dependency outside ai/", and
    // naming the imports is what makes it exhaustive rather than approximate - an omitted entry
    // would let a `../lib/` import ride in beside a listed `./matrix.js` and pass. So the list is
    // updated when the layer gains a module rather than loosened to a prefix check, and
    // `./response-shape.js` is the resolution helper both readers now share.
    const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
    assert.deepEqual(imports, ['./matrix.js', './response-shape.js'],
        'the only dependencies are within ai/');
});

// ===========================================================================
// reasoningBasis SURVIVES THE MERGE — FIRST NON-EMPTY WINS, EITHER ORDER
// ===========================================================================
//
// The quote behind a step's `needsReasoning` flag. This had a bug: the merge
// carried it only when the FIRST account had one, so a second account's evidence
// was dropped. Both orders are tested, because that bug was order-dependent.

test('the quote survives when the FIRST account has it and the second does not', () => {
    const merged = mergeProcessSteps([
        response([{ name: 'Match', whatHappens: 'compare', decidedHow: 'depends', needsReasoning: true, reasoningBasis: 'first evidence' }]),
        response([{ name: 'Match', whatHappens: 'compare totals', decidedHow: 'depends', needsReasoning: true }])
    ]);

    assert.equal(merged.steps.length, 1);
    assert.equal(merged.steps[0].reasoningBasis, 'first evidence');
});

test('the quote survives when the SECOND account has it and the first does not', () => {
    // THE ORDER THAT WAS BROKEN: the first account had no quote, so the second
    // account's evidence was dropped.
    const merged = mergeProcessSteps([
        response([{ name: 'Match', whatHappens: 'compare', decidedHow: 'depends', needsReasoning: true }]),
        response([{ name: 'Match', whatHappens: 'compare totals', decidedHow: 'depends', needsReasoning: true, reasoningBasis: 'second evidence' }])
    ]);

    assert.equal(merged.steps.length, 1);
    assert.equal(merged.steps[0].reasoningBasis, 'second evidence', 'the second account\'s evidence is not dropped');
});

test('the FIRST non-empty quote wins when both accounts have one', () => {
    // Like `decidedHow`: a quotation is a quotation, and the first account to give
    // one is not made wrong by a second.
    const merged = mergeProcessSteps([
        response([{ name: 'Match', whatHappens: 'a', decidedHow: 'd', needsReasoning: true, reasoningBasis: 'AAA the first quote' }]),
        response([{ name: 'Match', whatHappens: 'bb', decidedHow: 'd', needsReasoning: true, reasoningBasis: 'BBB the second quote' }])
    ]);

    assert.equal(merged.steps[0].reasoningBasis, 'AAA the first quote');
});

test('an EMPTY quote in the first account is skipped for a real one in the second', () => {
    // "First non-empty", not "first present": an empty string is not evidence.
    const merged = mergeProcessSteps([
        response([{ name: 'Match', whatHappens: 'a', decidedHow: 'd', needsReasoning: true, reasoningBasis: '' }]),
        response([{ name: 'Match', whatHappens: 'b', decidedHow: 'd', needsReasoning: true, reasoningBasis: 'the real quote' }])
    ]);

    assert.equal(merged.steps[0].reasoningBasis, 'the real quote');
});

test('the quote is absent when NO account gave one, rather than invented', () => {
    const merged = mergeProcessSteps([
        response([{ name: 'Match', whatHappens: 'a', decidedHow: 'd', needsReasoning: true }]),
        response([{ name: 'Match', whatHappens: 'b', decidedHow: 'd', needsReasoning: true }])
    ]);

    assert.equal(merged.steps[0].reasoningBasis, undefined, 'absence is shown as absence');
});

test('the quote does not affect the pessimistic flag', () => {
    // The flag and its evidence are independent: a quote from one account does not
    // change what the other said about judgement.
    const merged = mergeProcessSteps([
        response([{ name: 'Match', whatHappens: 'a', decidedHow: 'd', needsReasoning: false, reasoningBasis: 'a threshold rule' }]),
        response([{ name: 'Match', whatHappens: 'b', decidedHow: 'd', needsReasoning: true }])
    ]);

    assert.equal(merged.steps[0].needsReasoning, true, 'the pessimistic reading stands');
    assert.equal(merged.steps[0].reasoningBasis, 'a threshold rule', 'and the quote is kept');
});
