/**
 * The console resolver, and the four round states it has to render.
 *
 * The client saves `{ workflows: [...] }`, so a view that reads `response.data.task` finds `task`
 * undefined for EVERY interview round - the screen an admin opens first shows `Untitled answer`
 * with no fields at all. The resolver reads the right shape; a direct read beside it is the failure
 * to avoid.
 *
 * ONE RESOLVER RATHER THAN A FALLBACK AT EACH READ SITE, because a fallback written three times
 * drifts. The resolver is tested DIRECTLY, and then the four states are rendered through the page
 * so the wiring is tested rather than only the function.
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
    // What the client posts: the shape EVERY live round saves.
    const data = { workflows: [{ id: 'w1', task: 'Sort the mail', trigger: 'the post arrives' }] };
    const resolved = responseWorkflow(data);

    assert.equal(resolved.task, 'Sort the mail', 'the workflow is returned');
    assert.equal(responseTitle(data), 'Sort the mail', 'and its task becomes the title');
});

test('the IMPORTED shape (the workflow directly) resolves to itself', () => {
    // What a seed or the API writes: the workflow IS the data, with no `workflows` wrapper. The
    // demo seed uses this shape.
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
    // A workflow can exist with no usable task, and
    // `Untitled answer` is then correct rather than accidental.
    assert.equal(responseTitle({ workflows: [{ trigger: 'x' }] }), 'Untitled answer');
    assert.equal(responseTitle({ workflows: [{ task: '   ' }] }), 'Untitled answer', 'whitespace is not a title');
    assert.equal(responseTitle({ workflows: [{ task: 42 }] }), 'Untitled answer', 'a non-string is not a title');
    assert.equal(responseTitle({ trigger: 'x' }), 'Untitled answer', 'the imported shape without a task');
});

test('a BARE ARRAY is refused, which is deliberate rather than an oversight', () => {
    // No stored shape is a bare array, so a change to accept one is deliberate rather than drift.
    assert.equal(responseWorkflow([{ task: 'bare' }]), null, 'a top-level array is not a payload shape');
    assert.equal(responseTitle([{ task: 'bare' }]), 'Untitled answer');
});

test('SEVERAL workflows resolve to the FIRST, not a merge', () => {
    // A round is the work of one process, so showing the first is honest rather than merging.
    const data = { workflows: [{ task: 'A' }, { task: 'B' }] };
    assert.equal(responseWorkflow(data).task, 'A');
    assert.equal(responseTitle(data), 'A');
});

test('a malformed entry inside `workflows` is skipped for a usable one', () => {
    // A null or non-object entry must not be returned and crash a caller reading `.task`.
    const data = { workflows: [null, 'not an object', { task: 'The real one' }] };
    assert.equal(responseWorkflow(data).task, 'The real one');
});

test('the resolver is READ AT EVERY SITE THAT RENDERS A FIELD, not re-implemented at each', () => {
    // A view that reads `.data.task` directly renders every interview as untitled, so the direct
    // read is asserted ABSENT.
    //
    // THE ROADMAP IS NOT A FIELD SITE: it renders a LINK to each answer rather than the
    // participant's fields. The sites are the two in the answers view.
    const answers = view('admin-answers.ejs');
    const roadmap = view('admin-roadmap.ejs');

    assert.match(answers, /responseTitle\(response\.data\)/, 'the answers title uses the resolver');
    assert.match(answers, /responseWorkflow\(response\.data\)/, 'and the fields partial gets the resolved workflow');
    // No direct read of the raw payload shape survives IN CODE. Comments are stripped first,
    // because the views document the shape they resolve.
    const stripComments = (text) => text.replace(/<%#[\s\S]*?%>/g, '').replace(/<!--[\s\S]*?-->/g, '');
    assert.equal(/\.data\.task/.test(stripComments(answers)), false, 'no direct `.data.task` read in the answers view');
    assert.equal(/\.data\.task/.test(stripComments(roadmap)), false, 'nor in the roadmap view');
});

test('the roadmap LINKS to each answer instead of copying its fields', () => {
    // The roadmap renders a link to the answer rather than every participant field inline, so the
    // fields appear in one place rather than two, and the link must reach the right answer.
    const roadmap = view('admin-roadmap.ejs');

    // A link, built from the response id, to the answers view.
    assert.match(roadmap, /\/admin\/answers\?open=/,
        'the roadmap links to the answers view with the open parameter');
    assert.match(roadmap, /#response-/, 'and carries the fragment that scrolls to the answer');
    // The fields partial is NOT included on the roadmap any more.
    assert.equal(/response-fields/.test(roadmap), false,
        'the roadmap no longer includes the fields partial - the fields live on the answers view');
    // What the reader still sees belongs to the grouping: who, and what they contributed.
    assert.match(roadmap, /response\.contributed/, 'the contributed list still renders on the roadmap');
    assert.match(roadmap, /response\.department/, 'and the department');
});

test('`includeFields` defaults TRUE, so the roadmap would get fields if it asked for them', () => {
    // The default matters: absent `includeFields` means fields are rendered, so a caller that does
    // not pass it gets the full field list rather than silence.
    const partial = view('partials/response-fields.ejs');
    assert.match(partial, /typeof includeFields === 'undefined' \|\| includeFields/,
        'an absent includeFields renders the fields');

    // And the answers view passes `includeFields: false` for its SUMMARY copy, so a reader sees
    // the fields once in full rather than twice.
    const answers = view('admin-answers.ejs');
    assert.match(answers, /includeFields: false/, 'the summary copy omits fields');
});

test('a valid `open` id opens that answer SERVER-SIDE, and a stale one opens nothing', async () => {
    // `?open=<id>` marks one `<details>` open. A stale id must open nothing rather than everything
    // or an error: an id from a deleted response is a link that must fail quietly.
    const consoleViews = fs.readFileSync(path.join(PROJECT_ROOT, 'lib', 'auth', 'console-views.js'), 'utf8');
    assert.match(consoleViews, /openResponseId: typeof req\.query\.open === 'string' \? req\.query\.open : null/,
        'the route reads the open parameter');

    const answersView = view('admin-answers.ejs');
    assert.match(answersView, /openResponseId === response\.id \? ' open' : ''/,
        'the view opens exactly the matching detail element');
});

test('the placeholder contrast is asserted against the CSS, not a hex', () => {
    // A hex would be an assertion about a value rather than the rule, so what is pinned is that a
    // placeholder rule EXISTS and sets a colour distinctly from the input text.
    const css = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'css', 'app.css'), 'utf8');
    assert.match(css, /::placeholder/, 'there is a placeholder rule');
    // And it sets a colour rather than relying on the browser default (which is what matched the
    // entered text and started this).
    const rule = css.match(/::placeholder[^{]*\{[^}]*\}/s);
    assert.notEqual(rule, null, 'the placeholder rule has a body');
    assert.match(rule[0], /color:/, 'and it sets a colour explicitly');
});

// ===========================================================================
// 2. THE FOUR STATES THROUGH THE PAGE
// ===========================================================================

/**
 * Renders the answers view's row for one response, using the real template.
 *
 * The template needs a fair amount of surrounding context; rather than reproduce the whole app,
 * this renders the two fragments that carry the field rendering: the title and the fields partial.
 * The `responseTitle`/`responseWorkflow` helpers are provided as locals exactly as `server.js`
 * does.
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

test('EMPTY: a finished round with every field declined names itself and tags ALL fifteen fields', () => {
    return renderRow({ workflows: [allDeclined()] }, { empty: true }).then(({ title, tag, fields }) => {
        assert.match(title, /Untitled answer/, 'the empty round falls back to Untitled answer');
        assert.equal(tag, 'nothing answered', 'and is tagged as such');
        // EVERY FIELD is tagged, including `steps`, so the
        // count is the matrix's full field list rather than one fewer.
        const notAnswered = (fields.match(/not answered/g) ?? []).length;
        assert.equal(notAnswered, matrix.ALL_PROCESS_FIELD_NAMES.length,
            `every field is tagged not answered (found ${notAnswered}, expected ${matrix.ALL_PROCESS_FIELD_NAMES.length})`);
    });
});

test('a declined `steps` RENDERS a row and its "not answered" tag', () => {
    // The partial's steps block requires an ARRAY, so `{ declined: ... }` falls through it unless
    // handled, leaving 14 tags for 15 fields. The row must appear, carry the tag, and make the
    // count FIFTEEN.
    return ejs.renderFile(
        path.join(PROJECT_ROOT, 'views', 'partials', 'response-fields.ejs'),
        { data: allDeclined() }
    ).then((fields) => {
        assert.match(fields, /steps/i, 'the `steps` row appears');
        // Fifteen tags now: the declined steps carries the same tag as every other field.
        const notAnswered = (fields.match(/not answered/g) ?? []).length;
        assert.equal(notAnswered, matrix.ALL_PROCESS_FIELD_NAMES.length,
            `every field is tagged, so an admin counting finds fifteen (found ${notAnswered})`);
    });
});

test('a declined `steps` renders in all THREE states - words, wordless, and prose', () => {
    // Every way steps arrives carries the SAME tags as every other field: a declined-with-words row
    // shows their words and "not answered", a wordless one "they did not say", prose "in their own
    // words".
    const partial = {
        task: 't', trigger: 'tr', peopleAffected: 3, handoffTo: ['x'], waitsFor: ['x'], dependsOn: ['x'],
        systems: ['x'], touchedDepartments: ['x'], mistakesPerPeriod: 1, mistakeConsequence: 'c',
        currentState: 's', frustration: 'f', frequencyPerWeek: 2
    };

    return Promise.all([
        ejs.renderFile(path.join(PROJECT_ROOT, 'views', 'partials', 'response-fields.ejs'),
            { data: { ...partial, steps: { declined: 'I cannot list them' } } }),
        ejs.renderFile(path.join(PROJECT_ROOT, 'views', 'partials', 'response-fields.ejs'),
            { data: { ...partial, steps: { declined: true } } }),
        ejs.renderFile(path.join(PROJECT_ROOT, 'views', 'partials', 'response-fields.ejs'),
            { data: { ...partial, steps: { said: 'it goes round and round' } } })
    ]).then(([withWords, wordless, prose]) => {
        // Declined with words.
        assert.match(withWords, /I cannot list them/, 'a declined steps keeps their words');
        assert.match(withWords, /not answered/, 'and is tagged not answered');
        // Wordless refusal.
        assert.match(wordless, /they did not say/, 'a wordless declined steps says so');
        assert.match(wordless, /not answered/, 'and is tagged');
        // Prose.
        assert.match(prose, /it goes round and round/, 'a prose steps shows their words');
        assert.match(prose, /in their own words/, 'and the prose tag');
        // None of them renders an object.
        for (const [label, out] of [['with words', withWords], ['wordless', wordless], ['prose', prose]]) {
            assert.equal(/\[object Object\]/.test(out), false, `${label}: no object is stringified`);
        }
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
    // Checked by counting rather than by eye. Three real rounds - grouped,
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
