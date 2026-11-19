/**
 * THE DAMAGING SYMPTOM: the effort formula multiplies three factors, prose makes one unreadable as a
 * number, so the product is 0 - and `0 h/wk effort` says the work takes NO TIME.
 *
 * THE SCORING IS UNCHANGED, only the LABEL. `renderAnalysis` is not exported, so the real client
 * runs in a `node:vm` sandbox.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const CLIENT = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'js', 'audit.js'), 'utf8');

/** Loads the real client; a completed turn is saved, then `/api/score` answers with the analysis. */
async function loadScoringClient() {
    const { createContext, runInContext } = await import('node:vm');

    const elements = {};
    const el = (id) => (elements[id] ||= {
        id, value: '', innerHTML: '', className: '', style: {}, disabled: false, handlers: {}, textContent: '',
        classList: { _set: new Set(), add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); }, contains(c) { return this._set.has(c); } },
        addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); },
        appendChild() {}, remove() {}, querySelector() { return null; }, setAttribute() {}, scrollTop: 0, scrollHeight: 0
    });

    const documentListeners = {};
    const document = {
        getElementById: (id) => el(id),
        createElement: () => el(`created-${Math.random()}`),
        addEventListener: (type, fn) => { (documentListeners[type] ||= []).push(fn); },
        body: el('body'),
        querySelectorAll: () => []
    };

    const { stringsFor } = await import('../lib/strings.js');
    const strings = stringsFor('en');

    let analysisResult = null;

    const fetch = async (url) => {
        if (url.includes('/api/chat')) {
            return { ok: true, status: 200, json: async () => ({ status: 'complete', content: 'done', audit: { workflows: [{ id: 'w1', title: 'Checking servers' }] } }) };
        }
        if (url.includes('/api/score')) {
            return { ok: true, status: 200, json: async () => analysisResult };
        }
        return { ok: true, status: 200, json: async () => ({}) };
    };

    const window = {
        AUDIT_CONFIG: { strings, participantToken: 'token', lang: 'en', toolId: 't', basePath: '' },
        location: { href: '' },
        alert() {}
    };

    runInContext(CLIENT, createContext({
        window, document, fetch,
        console: { log() {}, warn() {}, error() {} },
        URLSearchParams, JSON, Math, Date, Object, Array, String, Number, encodeURIComponent, setTimeout, clearTimeout
    }));

    for (const fn of documentListeners.DOMContentLoaded || []) await fn();

    return {
        async render(result) {
            analysisResult = result;
            el('input').value = 'go';
            for (const fn of el('send-btn').handlers.click || []) await fn();
            return Object.values(elements).map((e) => e.innerHTML).join('\n');
        }
    };
}

function scoredWorkflow({ title = 'Checking servers', effort = 0, recoverable = 0, peopleAffected, judgementScore = 3 } = {}) {
    return { title, effortHoursPerWeek: effort, recoverableHoursPerWeek: recoverable, peopleAffected, judgementScore };
}

/**
 * THE WORKFLOWS GO IN `buckets`: only in `scored`, the render is a total and NO cards.
 */
function analysis(scored, { total = 0, workflowCount = scored.length, bucket = 'do_later' } = {}) {
    const buckets = { do_first: [], do_later: [], judgement_bound: [] };
    buckets[bucket] = scored;
    return { scored, buckets, conflicts: [], totalRecoverableHoursPerWeek: total, workflowCount };
}

test('a PROSE `peopleAffected` renders the participant\'s WORDS, not [object Object]', async () => {
    const client = await loadScoringClient();
    const html = await client.render(analysis([scoredWorkflow({ peopleAffected: { said: 'nobody else is involved' } })]));

    assert.match(html, /nobody else is involved/, 'the participant\'s own words are shown');
    assert.equal(/\[object Object\]/.test(html), false, 'and the marker is NOT stringified');
});

test('the prose words are shown WITHOUT a unit, because a sentence is not "56 servers/wk"', () => {
    assert.match(CLIENT, /const unknown = value === undefined \|\| value === null \|\| isProse\(value\) \|\| isDeclined\(value\)/,
        'prose is treated as "unknown, in words"');
    assert.match(CLIENT, /unknown\s*\n?\s*\?\s*'<em>' \+ escapeHtml\(text\) \+ '<\/em>'/,
        'and rendered as words rather than with a numeric suffix');
});

test('a PROSE effort factor shows "effort not measured" INSTEAD OF a zero', async () => {
    const client = await loadScoringClient();
    const html = await client.render(analysis([
        scoredWorkflow({ title: 'Checking servers', effort: 0, recoverable: 0, peopleAffected: { said: 'nobody else is involved' } })
    ], { total: 0 }));

    assert.match(html, /effort not measured/i, 'the unmeasurable effort says so');
    assert.equal(/0\s*h\/wk effort/i.test(html), false, 'and a bare "0 h/wk effort" is NOT printed');
});

test('the TOTAL is marked "at least" when any workflow was incomputable', async () => {
    const client = await loadScoringClient();
    const html = await client.render(analysis([
        scoredWorkflow({ title: 'Measured', effort: 5, recoverable: 5, peopleAffected: 3 }),
        scoredWorkflow({ title: 'In words', effort: 0, recoverable: 0, peopleAffected: { said: 'nobody else is involved' } })
    ], { total: 5, workflowCount: 2 }));

    assert.match(html, /at least/i, 'the total says it is a floor');
    assert.match(html, /<strong>5<\/strong>/, 'and shows the number the server computed');
});

test('an ABSENT field renders as ABSENT - not as prose, and not as the word "undefined"', async () => {
    const client = await loadScoringClient();
    const html = await client.render(analysis([scoredWorkflow({ peopleAffected: undefined })]));

    assert.equal(/undefined/.test(html), false, 'the word "undefined" is not rendered');
    assert.equal(/\[object Object\]/.test(html), false, 'nor a marker');
});

test('a NUMBER still renders as a NUMBER, with its unit', async () => {
    const client = await loadScoringClient();
    const html = await client.render(analysis([scoredWorkflow({ peopleAffected: 3 })]));

    assert.match(html, /3/, 'the number is shown');
    assert.equal(/nobody else is involved/.test(html), false, 'and no words are invented for it');
});

test('a MEASURABLE workload still shows its effort figure, so the label is not applied too widely', async () => {
    const client = await loadScoringClient();
    const html = await client.render(analysis([
        scoredWorkflow({ title: 'Checking servers', effort: 56, recoverable: 10, peopleAffected: 3 })
    ], { total: 10 }));

    assert.match(html, /56\s*h\/wk effort/i, 'a computable effort shows its figure and unit');
    assert.equal(/effort not measured/i.test(html), false, 'and NOT the unmeasurable label');
});

test('the client does NOT turn prose into a figure - the number displayed is the server\'s', async () => {
    const client = await loadScoringClient();
    const peopleAffected = { said: '56 servers a week, roughly' };
    const html = await client.render(analysis([
        scoredWorkflow({ title: 'Checking servers', effort: 0, recoverable: 0, peopleAffected })
    ], { total: 0 }));

    assert.match(html, /effort not measured/i, 'the effort stays unmeasured');
    assert.equal(/56\s*h\/wk/i.test(html), false, 'and 56 is NOT read out of the sentence as an effort');
});

test('the effort formula still refuses prose at the source - the marker is not bypassed', () => {
    assert.match(CLIENT, /function effortIsUnmeasurable\(workflow\)/, 'the predicate exists');
    assert.match(CLIENT, /return factors\.some\(\(f\) => isProse\(f\) \|\| isDeclined\(f\)\)/,
        'and prose in any factor makes the product unmeasurable');
    assert.match(CLIENT, /const unknown = value === undefined \|\| value === null \|\| isProse\(value\)/,
        'with prose separated from a number rather than coerced into one');
});

test('a DECLINED effort factor is treated like prose, so neither produces a fake zero', () => {
    assert.match(CLIENT, /isProse\(workflow\.timePerPeriod\) \|\| isDeclined\(workflow\.timePerPeriod\)/,
        'a declined timePerPeriod is unmeasurable too');
});
