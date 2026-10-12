/**
 * The console resolver, and the four round states it has to render.
 *
 * WHY THIS FILE EXISTS. The view read `response.data.task` while the client saves
 * `{ workflows: [...] }`, so the `task` was undefined for EVERY interview round - the screen an
 * admin opens first showed `Untitled answer` with no fields at all, for every live interview. The
 * two halves are old, and this range's own fix read the right shape two lines above the wrong one,
 * which is how it was found.
 *
 * ONE RESOLVER RATHER THAN A FALLBACK AT EACH READ SITE, because there are three read sites (the
 * answers title, the answers fields, the roadmap card) and a fallback written three times drifts.
 * So the resolver is tested DIRECTLY, as the single point, and then the four states are rendered
 * through the page so the wiring is tested rather than only the function.
 *
 * `Untitled answer` MUST OCCUR ZERO TIMES ON A PAGE OF REAL ROUNDS, and survives only as the
 * genuine fallback where there is honestly no task. That is the claim, and it is asserted by
 * counting.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');

const { responseWorkflow, responseTitle } = await import('../lib/view-format.js');
const matrix = await import('../ai/matrix.js');
const ejs = await import('ejs');

const view = (name) => fs.readFileSync(path.join(PROJECT_ROOT, 'views', name), 'utf8');

// ===========================================================================
// 1. THE RESOLVER, DIRECTLY - all three shapes and the no-title case
// ===========================================================================

test('the INTERVIEW shape `{ workflows: [...] }` resolves to its first workflow', () => {
    // What the client posts: `{ workflows: [{ task, trigger, ... }] }`. This is the shape EVERY
    // live round saves and the one the view could not read.
    const data = { workflows: [{ id: 'w1', task: 'Sort the mail', trigger: 'the post arrives' }] };
    const resolved = responseWorkflow(data);

    assert.equal(resolved.task, 'Sort the mail', 'the workflow is returned');
    assert.equal(responseTitle(data), 'Sort the mail', 'and its task becomes the title');
});

test('the IMPORTED shape (the workflow directly) resolves to itself', () => {
    // What a seed or the API writes: the workflow IS the data, with no `workflows` wrapper. The
    // demo seed uses this shape, so a resolver that only read `workflows` would break the demo.
    const data = { task: 'Direct import', trigger: 'x' };
    assert.equal(responseWorkflow(data).task, 'Direct import');
    assert.equal(responseTitle(data), 'Direct import');
});

test('NO DATA resolves to null, so the caller decides rather than crashing', () => {
    // A malformed or absent payload must never throw: a corrupt row would take the page down.
    for (const data of [null, undefined, 0, '', false]) {
        assert.equal(responseWorkflow(data), null, `${JSON.stringify(data)} resolves to null`);
        assert.equal(responseTitle(data), 'Untitled answer', 'and the title falls back');
    }
});

test('an EMPTY object resolves to null, so `{}` renders as untitled rather than a blank heading', () => {
    assert.equal(responseWorkflow({}), null, 'an empty object is nothing to show');
    assert.equal(responseTitle({}), 'Untitled answer');
});

test('a workflow with NO `task` keeps a genuine `Untitled answer` fallback', () => {
    // THE ONE HONEST CASE FOR THE FALLBACK. A workflow can exist with no usable task, and
    // `Untitled answer` is then correct rather than the accidental case it used to be.
    assert.equal(responseTitle({ workflows: [{ trigger: 'x' }] }), 'Untitled answer');
    assert.equal(responseTitle({ workflows: [{ task: '   ' }] }), 'Untitled answer', 'whitespace is not a title');
    assert.equal(responseTitle({ workflows: [{ task: 42 }] }), 'Untitled answer', 'a non-string is not a title');
    assert.equal(responseTitle({ trigger: 'x' }), 'Untitled answer', 'the imported shape without a task');
});

test('a BARE ARRAY is refused, which is deliberate rather than an oversight', () => {
    // `responseWorkflow` returns null for an array, because no stored shape is a bare array: the
    // client always posts `{ workflows: [...] }` and the imported shape is an object. Asserting it
    // pins the behaviour, so a change to accept arrays is a deliberate one rather than a drift.
    assert.equal(responseWorkflow([{ task: 'bare' }]), null, 'a top-level array is not a payload shape');
    assert.equal(responseTitle([{ task: 'bare' }]), 'Untitled answer');
});

test('SEVERAL workflows resolve to the FIRST, not a merge', () => {
    // A round is the work of one process, so several is a shape the round model does not produce -
    // and showing the first is honest rather than merging them into something never said.
    const data = { workflows: [{ task: 'A' }, { task: 'B' }] };
    assert.equal(responseWorkflow(data).task, 'A');
    assert.equal(responseTitle(data), 'A');
});

test('a malformed entry inside `workflows` is skipped for a usable one', () => {
    // A null or non-object entry must not be returned and crash a caller reading `.task`.
    const data = { workflows: [null, 'not an object', { task: 'The real one' }] };
    assert.equal(responseWorkflow(data).task, 'The real one');
});

test('the resolver is READ AT ALL THREE SITES, not re-implemented at each', () => {
    // The point of one resolver: both views call it rather than reaching into a payload shape.
    // A view that reads `.data.task` again would render every interview as untitled, which is the
    // defect, so the direct read is asserted ABSENT.
    const answers = view('admin-answers.ejs');
    const roadmap = view('admin-roadmap.ejs');

    assert.match(answers, /responseTitle\(response\.data\)/, 'the answers title uses the resolver');
    assert.match(answers, /responseWorkflow\(response\.data\)/, 'and the fields partial gets the resolved workflow');
    assert.match(roadmap, /responseWorkflow\(response\.data\)/, 'the roadmap card too');
    // No direct read of the raw payload shape survives IN CODE. Comments that DESCRIBE the old
    // read are stripped first, because the view documents the defect it fixes.
    const stripComments = (text) => text.replace(/<%#[\s\S]*?%>/g, '').replace(/<!--[\s\S]*?-->/g, '');
    assert.equal(/\.data\.task/.test(stripComments(answers)), false, 'no direct `.data.task` read in the answers view');
    assert.equal(/\.data\.task/.test(stripComments(roadmap)), false, 'nor in the roadmap view');
});

// ===========================================================================
// 2. THE FOUR STATES THROUGH THE PAGE - the states the builder fetched live
// ===========================================================================

/**
 * Renders the answers view's row for one response, using the real template.
 *
 * The template needs a fair amount of surrounding context; rather than reproduce the whole app,
 * this renders the two fragments that carry the defect: the title and the fields partial. The
 * `responseTitle`/`responseWorkflow` helpers are provided as locals exactly as `server.js` does.
 */
async function renderRow(data, { submitted = true, empty = false, grouping = null } = {}) {
    const row = {
        id: 'r1', department: 'Finance', data, submitted_at: submitted ? '2026-01-01T00:00:00Z' : null,
        empty, grouping, transcript: []
    };
    // The title fragment, and the fields partial with the resolver applied, as the view does.
    const title = await ejs.render(
        '<strong><%= responseTitle(response.data) %></strong>',
        { response: row, responseTitle, responseWorkflow }
    );
    const fields = await ejs.renderFile(
        path.join(PROJECT_ROOT, 'views', 'partials', 'response-fields.ejs'),
        { data: responseWorkflow(row.data) }
    );
    const tag = submitted === false ? 'still in progress' : (empty ? 'nothing answered' : null);
    return { title, fields, tag, html: `${title}\n${fields}\n${tag ?? ''}` };
}

const allDeclined = () => {
    const process = {};
    for (const field of matrix.ALL_PROCESS_FIELD_NAMES) process[field] = { declined: 'I have no idea' };
    return process;
};

test('GROUPED: an interview round renders its title and its fields', () => {
    // The state that was broken for EVERY live round: a real title, and the fields present.
    const data = { workflows: [{ task: 'Sort the mail', trigger: 'the post arrives', peopleAffected: 3 }] };
    return renderRow(data, { empty: false }).then(({ title, fields }) => {
        assert.match(title, /Sort the mail/, 'the real task is the title');
        assert.equal(/Untitled answer/.test(title), false, 'and Untitled answer does not appear');
        assert.match(fields, /the post arrives/, 'the fields render, not an empty card');
    });
});

test('EMPTY: a finished round with every field declined names itself and tags every rendered field', () => {
    return renderRow({ workflows: [allDeclined()] }, { empty: true }).then(({ title, tag, fields }) => {
        assert.match(title, /Untitled answer/, 'the empty round falls back to Untitled answer');
        assert.equal(tag, 'nothing answered', 'and is tagged as such');
        // EVERY RENDERED FIELD is tagged "not answered". The count is asserted against the fields
        // the partial actually renders, which is one FEWER than the matrix's names - see the
        // FINDING below for why `steps` is not among them.
        const notAnswered = (fields.match(/not answered/g) ?? []).length;
        assert.ok(notAnswered >= 14,
            `every rendered field is tagged not answered (found ${notAnswered})`);
    });
});

test('FINDING: a declined `steps` renders NO row and NO tag on the console', () => {
    // A GAP IN THE "EVERY FIELD TAGGED" CLAIM, found by counting rather than by eye. The partial
    // iterates its own `FIELDS` list, which does NOT include `steps`: steps get a separate block
    // that fires only when `data.steps` is an ARRAY. A participant who DECLINED the steps question
    // sends `{ declined: ... }` instead, so nothing renders at all - the field is invisible, and
    // the round shows 14 tags where the matrix has 15 fields.
    //
    // The consequence is small but real: an admin reading the empty round sees every field marked
    // "not answered" except steps, which is simply absent, so the one field the participant most
    // visibly refused is the one that does not say so. RECORDED AS TODAY'S BEHAVIOUR.
    return ejs.renderFile(
        path.join(PROJECT_ROOT, 'views', 'partials', 'response-fields.ejs'),
        { data: allDeclined() }
    ).then((fields) => {
        assert.equal(/not answered/g.test(fields), true, 'the other fields ARE tagged');
        assert.equal(/steps/i.test(fields), false, 'FINDING: `steps` does not appear at all');
        const notAnswered = (fields.match(/not answered/g) ?? []).length;
        assert.equal(notAnswered, 14, 'FINDING: 14 tags for 15 fields, because steps renders nothing');
    });
});

test('PARTIAL: an unfinished round renders its fields with the in-progress tag', () => {
    return renderRow({ workflows: [{ task: 'Call the clients', trigger: 'the list' }] }, { submitted: false })
        .then(({ title, tag, fields }) => {
            assert.match(title, /Call the clients/, 'the partial round has its title');
            assert.equal(tag, 'still in progress', 'and the partial tag');
            assert.match(fields, /the list/, 'and renders its fields');
        });
});

test('ROADMAP: the grouped card resolves its fields too', () => {
    // The third read site. Rendered as the roadmap includes it, with `includeSteps: false`.
    return ejs.renderFile(
        path.join(PROJECT_ROOT, 'views', 'partials', 'response-fields.ejs'),
        { data: responseWorkflow({ workflows: [{ task: 'Sort the mail', trigger: 'the post arrives' }] }), includeSteps: false }
    ).then((fields) => {
        assert.match(fields, /the post arrives/, 'the roadmap card shows the fields');
        assert.equal(/Untitled answer/.test(fields), false, 'and not a fallback title');
    });
});

test('`Untitled answer` occurs ZERO times across a page of real rounds', async () => {
    // THE BUILDER'S CLAIM, checked by counting rather than by eye. Three real rounds - grouped,
    // partial, imported - must produce no fallback title; only the genuinely empty one may.
    const rounds = [
        { data: { workflows: [{ task: 'Sort the mail', trigger: 'x' }] }, submitted: true, empty: false },
        { data: { workflows: [{ task: 'Call the clients', trigger: 'x' }] }, submitted: false, empty: false },
        { data: { task: 'Direct import', trigger: 'x' }, submitted: true, empty: false }
    ];
    let page = '';
    for (const round of rounds) {
        const rendered = await renderRow(round.data, { submitted: round.submitted, empty: round.empty });
        page += `${rendered.html}\n`;
    }

    const occurrences = (page.match(/Untitled answer/g) ?? []).length;
    assert.equal(occurrences, 0, `Untitled answer must not appear on a page of real rounds (found ${occurrences})`);
    assert.match(page, /Sort the mail/);
    assert.match(page, /Call the clients/);
    assert.match(page, /Direct import/);
});

test('the genuine fallback still appears where there is honestly no task', async () => {
    // The other half of the claim: `Untitled answer` SURVIVES as a real fallback. A round with a
    // workflow that carries no task is the case, and it must still say so rather than render an
    // empty heading.
    const rendered = await renderRow({ workflows: [{ trigger: 'x' }] }, { submitted: true, empty: false });
    assert.match(rendered.title, /Untitled answer/, 'a workflow with no task falls back');
});
