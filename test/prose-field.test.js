/**
 * A FIELD ANSWERED IN WORDS - on the participant's own card, and in the score they are shown.
 *
 * THE SHAPE THIS GUARDS. A field can arrive as
 * `{ "peopleAffected": { "said": "nobody else is involved" } }`, and the card renders
 *
 *   "[object Object] people"   and   "0 h/wk effort"
 *
 * The FIRST is a marker being stringified instead of read. The SECOND is the damaging one: the
 * effort formula multiplies three factors, prose makes one unreadable as a number, so the product
 * is 0 - and printing `0 h/wk effort` says the work takes NO TIME, for a participant who had just
 * described checking 56 servers a week.
 *
 * THREE THINGS ARE ASSERTED, and the boundary between them is the point:
 *
 *   a PROSE field      -> the participant's words, and "effort not measured" rather than a zero
 *   an ABSENT field    -> still rendered as absent, NOT as prose and not as words
 *   a NUMBER field     -> still rendered as a number with its unit
 *
 * THE SCORING IS UNCHANGED AND MUST STAY UNCHANGED. It still cannot multiply a sentence: the score
 * stays a real zero and only the LABEL changes. A test that made the client read prose as a figure
 * would be testing the guess the marker exists to avoid, so the last test here pins the opposite -
 * the number the server sent is what is displayed.
 *
 * HOW IT IS DRIVEN. `renderAnalysis` lives inside `public/js/audit.js` and is not exported, so the
 * real client is loaded into a `node:vm` sandbox and a `/api/score` result is delivered through the
 * sandbox's `fetch`. The rendered HTML is read from the element the client writes it to, so this is
 * the client's own output rather than a re-implementation of its formatting.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const CLIENT = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'js', 'audit.js'), 'utf8');

/**
 * Loads the real client and returns a driver that scores a result and reads the rendered HTML.
 *
 * The flow mirrors a real interview: a completed turn is saved, then `/api/score` answers with the
 * analysis, which `renderAnalysis` writes into the results element.
 */
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

    // The strings the client renders with, for one language, through the SAME accessor the server
    // uses (`res.locals.strings = stringsFor(lang)`). Reading the whole `STRINGS` map by mistake is
    // what made every heading render as "undefined" on the first run of this file.
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
        /** Scores `result` and returns everything the client rendered into the page. */
        async render(result) {
            analysisResult = result;
            el('input').value = 'go';
            for (const fn of el('send-btn').handlers.click || []) await fn();
            // The client writes the analysis into its results element; read every element's HTML so
            // the assertion does not depend on which container the version under test chose.
            return Object.values(elements).map((e) => e.innerHTML).join('\n');
        }
    };
}

/** A scored workflow as the SERVER sends it, with `effortHoursPerWeek` already computed. */
function scoredWorkflow({ title = 'Checking servers', effort = 0, recoverable = 0, peopleAffected, judgementScore = 3 } = {}) {
    // `judgementScore` IS ALWAYS SENT BY THE SERVER (`lib/scoring.js` derives it per workflow), so it
    // is present in this fixture. Omitting it renders "judgement undefined/5" - which is what made
    // the absent-field test fail on a fixture gap rather than on a rendering defect.
    return { title, effortHoursPerWeek: effort, recoverableHoursPerWeek: recoverable, peopleAffected, judgementScore };
}

/**
 * A `/api/score` result wrapping the given workflows.
 *
 * THE WORKFLOWS GO IN `buckets`, because that is where the client renders each card from:
 * `bucketHtml` reads `result.buckets.do_first` (recoverable mode) and `do_later` / `judgement_bound`
 * (effort mode). Putting them only in `scored` renders the total and NO cards, which is how the
 * first version of this file came to assert against an empty render.
 */
function analysis(scored, { total = 0, workflowCount = scored.length, bucket = 'do_later' } = {}) {
    const buckets = { do_first: [], do_later: [], judgement_bound: [] };
    buckets[bucket] = scored;
    return { scored, buckets, conflicts: [], totalRecoverableHoursPerWeek: total, workflowCount };
}

// ===========================================================================
// 1. THE PROSE FIELD - the participant's words, and no invented figure
// ===========================================================================

test('a PROSE `peopleAffected` renders the participant\'s WORDS, not [object Object]', async () => {
    // THE FIRST SYMPTOM: the marker was stringified. `fieldText` reads `value.said`, so the word the
    // participant used is what appears.
    const client = await loadScoringClient();
    const html = await client.render(analysis([scoredWorkflow({ peopleAffected: { said: 'nobody else is involved' } })]));

    assert.match(html, /nobody else is involved/, 'the participant\'s own words are shown');
    assert.equal(/\[object Object\]/.test(html), false, 'and the marker is NOT stringified');
});

test('the prose words are shown WITHOUT a unit, because a sentence is not "56 servers/wk"', () => {
    // The same rule stated at the source level: a value in words carries no unit, so `metaPart`
    // escapes it and appends nothing. Asserted on the client's own code, since the rendered gap
    // between "the words" and "the words" + a suffix is what this protects.
    assert.match(CLIENT, /const unknown = value === undefined \|\| value === null \|\| isProse\(value\) \|\| isDeclined\(value\)/,
        'prose is treated as "unknown, in words"');
    assert.match(CLIENT, /unknown\s*\n?\s*\?\s*'<em>' \+ escapeHtml\(text\) \+ '<\/em>'/,
        'and rendered as words rather than with a numeric suffix');
});

test('a PROSE effort factor shows "effort not measured" INSTEAD OF a zero', async () => {
    // THE DAMAGING SYMPTOM. The product of three factors is 0 because one is a sentence, and
    // printing `0 h/wk effort` says the work takes no time. The label changes; the score does not.
    const client = await loadScoringClient();
    const html = await client.render(analysis([
        scoredWorkflow({ title: 'Checking servers', effort: 0, recoverable: 0, peopleAffected: { said: 'nobody else is involved' } })
    ], { total: 0 }));

    assert.match(html, /effort not measured/i, 'the unmeasurable effort says so');
    assert.equal(/0\s*h\/wk effort/i.test(html), false, 'and a bare "0 h/wk effort" is NOT printed');
});

test('the TOTAL is marked "at least" when any workflow was incomputable', async () => {
    // The sum is over the workflows whose factors were all figures, so it is CORRECT as far as it
    // goes - but presenting it bare reads as the whole answer.
    const client = await loadScoringClient();
    const html = await client.render(analysis([
        scoredWorkflow({ title: 'Measured', effort: 5, recoverable: 5, peopleAffected: 3 }),
        scoredWorkflow({ title: 'In words', effort: 0, recoverable: 0, peopleAffected: { said: 'nobody else is involved' } })
    ], { total: 5, workflowCount: 2 }));

    assert.match(html, /at least/i, 'the total says it is a floor');
    assert.match(html, /<strong>5<\/strong>/, 'and shows the number the server computed');
});

// ===========================================================================
// 2. THE BOUNDARIES - absent is absent, a number is a number
// ===========================================================================

test('an ABSENT field renders as ABSENT - not as prose, and not as the word "undefined"', async () => {
    // THE BOUNDARY THAT MATTERS MOST. `fieldText` must not turn a missing field into anything that
    // reads like an answer: the whole point of distinguishing prose from absence is that a reader
    // can tell "they said something in words" from "nobody asked".
    const client = await loadScoringClient();
    const html = await client.render(analysis([scoredWorkflow({ peopleAffected: undefined })]));

    assert.equal(/undefined/.test(html), false, 'the word "undefined" is not rendered');
    assert.equal(/\[object Object\]/.test(html), false, 'nor a marker');
});

test('a NUMBER still renders as a NUMBER, with its unit', async () => {
    // The other boundary: not every value is prose-ish. A count the participant gave as a figure is
    // still a figure.
    const client = await loadScoringClient();
    const html = await client.render(analysis([scoredWorkflow({ peopleAffected: 3 })]));

    assert.match(html, /3/, 'the number is shown');
    assert.equal(/nobody else is involved/.test(html), false, 'and no words are invented for it');
});

test('a MEASURABLE workload still shows its effort figure, so the label is not applied too widely', async () => {
    // The control for the "effort not measured" test: when every factor is a figure the real number
    // is printed. Without this, a fix that printed the label for everything would pass.
    const client = await loadScoringClient();
    const html = await client.render(analysis([
        scoredWorkflow({ title: 'Checking servers', effort: 56, recoverable: 10, peopleAffected: 3 })
    ], { total: 10 }));

    assert.match(html, /56\s*h\/wk effort/i, 'a computable effort shows its figure and unit');
    assert.equal(/effort not measured/i.test(html), false, 'and NOT the unmeasurable label');
});

// ===========================================================================
// 3. THE SCORING IS UNCHANGED - it still cannot multiply a sentence
// ===========================================================================

test('the client does NOT turn prose into a figure - the number displayed is the server\'s', async () => {
    // THE GUESS THE MARKER EXISTS TO PREVENT. The server computes the score and cannot multiply a
    // sentence, so it sends 0; the client must display that 0 (labelled) rather than invent one. A
    // test that made the client read `{ said: "56 a week" }` as 56 would be testing the inference
    // the marker was added to avoid.
    const client = await loadScoringClient();
    const peopleAffected = { said: '56 servers a week, roughly' };
    const html = await client.render(analysis([
        scoredWorkflow({ title: 'Checking servers', effort: 0, recoverable: 0, peopleAffected })
    ], { total: 0 }));

    // The words may be shown (that is the prose rendering), but no EFFORT FIGURE may be derived.
    assert.match(html, /effort not measured/i, 'the effort stays unmeasured');
    assert.equal(/56\s*h\/wk/i.test(html), false, 'and 56 is NOT read out of the sentence as an effort');
});

test('the effort formula still refuses prose at the source - the marker is not bypassed', () => {
    // The rule in the client's own terms: a prose factor makes the product incomputable, which is
    // what forces the "not measured" label rather than a zero.
    assert.match(CLIENT, /function effortIsUnmeasurable\(workflow\)/, 'the predicate exists');
    assert.match(CLIENT, /return factors\.some\(\(f\) => isProse\(f\) \|\| isDeclined\(f\)\)/,
        'and prose in any factor makes the product unmeasurable');
    assert.match(CLIENT, /const unknown = value === undefined \|\| value === null \|\| isProse\(value\)/,
        'with prose separated from a number rather than coerced into one');
});

test('a DECLINED effort factor is treated like prose, so neither produces a fake zero', () => {
    // The two markers are different states and the same outcome here: either means no number
    // exists, so the label applies to both rather than only to prose.
    assert.match(CLIENT, /isProse\(workflow\.timePerPeriod\) \|\| isDeclined\(workflow\.timePerPeriod\)/,
        'a declined timePerPeriod is unmeasurable too');
});
