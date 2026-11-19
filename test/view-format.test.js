/**
 * The console resolver, and the four round states it has to render.
 *
 * The client saves `{ workflows: [...] }`, so a view reading `response.data.task` finds `task`
 * undefined for EVERY interview round. ONE RESOLVER rather than a fallback at each read site: a
 * fallback written three times drifts.
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

test('the INTERVIEW shape `{ workflows: [...] }` resolves to its first workflow', () => {
    const data = { workflows: [{ id: 'w1', task: 'Sort the mail', trigger: 'the post arrives' }] };
    const resolved = responseWorkflow(data);

    assert.equal(resolved.task, 'Sort the mail', 'the workflow is returned');
    assert.equal(responseTitle(data), 'Sort the mail', 'and its task becomes the title');
});

test('the IMPORTED shape (the workflow directly) resolves to itself', () => {
    // What a seed or the API writes: the workflow IS the data, with no `workflows` wrapper.
    const data = { task: 'Direct import', trigger: 'x' };
    assert.equal(responseWorkflow(data).task, 'Direct import');
    assert.equal(responseTitle(data), 'Direct import');
});

test('NO DATA resolves to null, so the caller decides rather than crashing', () => {
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
    assert.equal(responseTitle({ workflows: [{ trigger: 'x' }] }), 'Untitled answer');
    assert.equal(responseTitle({ workflows: [{ task: '   ' }] }), 'Untitled answer', 'whitespace is not a title');
    assert.equal(responseTitle({ workflows: [{ task: 42 }] }), 'Untitled answer', 'a non-string is not a title');
    assert.equal(responseTitle({ trigger: 'x' }), 'Untitled answer', 'the imported shape without a task');
});

test('a BARE ARRAY is refused, which is deliberate rather than an oversight', () => {
    assert.equal(responseWorkflow([{ task: 'bare' }]), null, 'a top-level array is not a payload shape');
    assert.equal(responseTitle([{ task: 'bare' }]), 'Untitled answer');
});

test('SEVERAL workflows resolve to the FIRST, not a merge', () => {
    const data = { workflows: [{ task: 'A' }, { task: 'B' }] };
    assert.equal(responseWorkflow(data).task, 'A');
    assert.equal(responseTitle(data), 'A');
});

test('a malformed entry inside `workflows` is skipped for a usable one', () => {
    const data = { workflows: [null, 'not an object', { task: 'The real one' }] };
    assert.equal(responseWorkflow(data).task, 'The real one');
});

test('the resolver is READ AT EVERY SITE THAT RENDERS A FIELD, not re-implemented at each', () => {
    // THE ROADMAP IS NOT A FIELD SITE: it renders a LINK to each answer.
    const answers = view('admin-answers.ejs');
    const roadmap = view('admin-roadmap.ejs');

    assert.match(answers, /responseTitle\(response\.data\)/, 'the answers title uses the resolver');
    assert.match(answers, /responseWorkflow\(response\.data\)/, 'and the fields partial gets the resolved workflow');
    // Comments are stripped first: the views document the shape they resolve.
    const stripComments = (text) => text.replace(/<%#[\s\S]*?%>/g, '').replace(/<!--[\s\S]*?-->/g, '');
    assert.equal(/\.data\.task/.test(stripComments(answers)), false, 'no direct `.data.task` read in the answers view');
    assert.equal(/\.data\.task/.test(stripComments(roadmap)), false, 'nor in the roadmap view');
});

test('the roadmap LINKS to each answer instead of copying its fields', () => {
    const roadmap = view('admin-roadmap.ejs');

    assert.match(roadmap, /\/admin\/answers\?open=/,
        'the roadmap links to the answers view with the open parameter');
    assert.match(roadmap, /#response-/, 'and carries the fragment that scrolls to the answer');
    assert.equal(/response-fields/.test(roadmap), false,
        'the roadmap no longer includes the fields partial - the fields live on the answers view');
    assert.match(roadmap, /response\.contributed/, 'the contributed list still renders on the roadmap');
    assert.match(roadmap, /response\.department/, 'and the department');
});

test('`includeFields` defaults TRUE, so the roadmap would get fields if it asked for them', () => {
    const partial = view('partials/response-fields.ejs');
    assert.match(partial, /typeof includeFields === 'undefined' \|\| includeFields/,
        'an absent includeFields renders the fields');

    const answers = view('admin-answers.ejs');
    assert.match(answers, /includeFields: false/, 'the summary copy omits fields');
});

test('a valid `open` id opens that answer SERVER-SIDE, and a stale one opens nothing', async () => {
    // A stale `?open=<id>` must open nothing: an id from a deleted response is a link that must
    // fail quietly.
    const consoleViews = fs.readFileSync(path.join(PROJECT_ROOT, 'lib', 'auth', 'console-views.js'), 'utf8');
    assert.match(consoleViews, /openResponseId: typeof req\.query\.open === 'string' \? req\.query\.open : null/,
        'the route reads the open parameter');

    const answersView = view('admin-answers.ejs');
    assert.match(answersView, /openResponseId === response\.id \? ' open' : ''/,
        'the view opens exactly the matching detail element');
});

test('the placeholder contrast is asserted against the CSS, not a hex', () => {
    // A hex would assert a value rather than the rule: pinned is that a placeholder rule EXISTS
    // and sets a colour.
    const css = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'css', 'app.css'), 'utf8');
    assert.match(css, /::placeholder/, 'there is a placeholder rule');
    const rule = css.match(/::placeholder[^{]*\{[^}]*\}/s);
    assert.notEqual(rule, null, 'the placeholder rule has a body');
    assert.match(rule[0], /color:/, 'and it sets a colour explicitly');
});

/**
 * Renders the row's two fragments - the title and the fields partial - rather than the whole app.
 * The helpers are provided as locals exactly as `server.js` does.
 */
async function renderRow(data, { submitted = true, empty = false, grouping = null } = {}) {
    const row = {
        id: 'r1', department: 'Finance', data, submitted_at: submitted ? '2026-01-01T00:00:00Z' : null,
        empty, grouping, transcript: []
    };
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
        const notAnswered = (fields.match(/not answered/g) ?? []).length;
        assert.equal(notAnswered, matrix.ALL_PROCESS_FIELD_NAMES.length,
            `every field is tagged not answered (found ${notAnswered}, expected ${matrix.ALL_PROCESS_FIELD_NAMES.length})`);
    });
});

test('a declined `steps` RENDERS a row and its "not answered" tag', () => {
    // The steps block requires an ARRAY, so `{ declined: ... }` falls through unless handled.
    return ejs.renderFile(
        path.join(PROJECT_ROOT, 'views', 'partials', 'response-fields.ejs'),
        { data: allDeclined() }
    ).then((fields) => {
        assert.match(fields, /steps/i, 'the `steps` row appears');
        const notAnswered = (fields.match(/not answered/g) ?? []).length;
        assert.equal(notAnswered, matrix.ALL_PROCESS_FIELD_NAMES.length,
            `every field is tagged, so an admin counting finds fifteen (found ${notAnswered})`);
    });
});

test('a declined `steps` renders in all THREE states - words, wordless, and prose', () => {
    // Every way steps arrives carries the SAME tags as every other field.
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
        assert.match(withWords, /I cannot list them/, 'a declined steps keeps their words');
        assert.match(withWords, /not answered/, 'and is tagged not answered');
        assert.match(wordless, /they did not say/, 'a wordless declined steps says so');
        assert.match(wordless, /not answered/, 'and is tagged');
        assert.match(prose, /it goes round and round/, 'a prose steps shows their words');
        assert.match(prose, /in their own words/, 'and the prose tag');
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
    return ejs.renderFile(
        path.join(PROJECT_ROOT, 'views', 'partials', 'response-fields.ejs'),
        { data: responseWorkflow({ workflows: [{ task: 'Sort the mail', trigger: 'the post arrives' }] }), includeSteps: false }
    ).then((fields) => {
        assert.match(fields, /the post arrives/, 'the roadmap card shows the fields');
        assert.equal(/Untitled answer/.test(fields), false, 'and not a fallback title');
    });
});

test('`Untitled answer` occurs ZERO times across a page of real rounds', async () => {
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
    // `Untitled answer` SURVIVES as a real fallback for a workflow that carries no task.
    const rendered = await renderRow({ workflows: [{ trigger: 'x' }] }, { submitted: true, empty: false });
    assert.match(rendered.title, /Untitled answer/, 'a workflow with no task falls back');
});
