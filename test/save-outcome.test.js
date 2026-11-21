/**
 * The save decision, in public/js/save-outcome.js.
 *
 * WHY THIS FILE EXISTS: the client made this decision inline, with no test, and it was wrong. A refused
 * save was logged to the console and told to nobody, so a participant's answer was discarded while the
 * page said it had been accepted. The first two tests below are the ones that catch that.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createContext, runInContext } from 'node:vm';

import { saveOutcome, saveFailed } from '../public/js/save-outcome.js';

// ===========================================================================
// 1. A 400 THAT EXPLAINS ITSELF IS A REFUSAL
// ===========================================================================

test('400 with an error string returns that text as a REFUSAL, not a generic failure', () => {
    // THE CASE THAT WAS SILENTLY SWALLOWED. The participant can act on this, so the text must survive
    // to the page: it names the field and the limit.
    const text = 'The description of the work is too long. Keep it under 4000 characters.';
    assert.deepEqual(saveOutcome(400, { error: text }), { ok: false, refusal: text });
});

test('the refusal is passed through character for character', () => {
    // It is displayed verbatim, so nothing may be trimmed, re-cased or truncated on the way.
    const text = '  Odd spacing, an apostrophe\'s question, and a <b>tag</b>  ';
    assert.equal(saveOutcome(400, { error: text }).refusal, text);
});

// ===========================================================================
// 2. A 400 THAT CANNOT EXPLAIN ITSELF IS A FAILURE
// ===========================================================================

test('400 with a body that is not JSON (null) returns failure, not a refusal', () => {
    // An unreadable body reaches here as null. A refusal with no words would show the participant an
    // empty box where the reason should be.
    assert.deepEqual(saveOutcome(400, null), { ok: false, failure: true });
});

test('400 with an empty object returns failure', () => {
    assert.deepEqual(saveOutcome(400, {}), { ok: false, failure: true });
});

test('400 with a non-string error returns failure', () => {
    for (const bad of [{ error: 42 }, { error: null }, { error: { nested: 'x' } }, { error: ['a'] }]) {
        assert.deepEqual(saveOutcome(400, bad), { ok: false, failure: true },
            `400 with ${JSON.stringify(bad)} must not be a refusal`);
    }
});

test('400 with an EMPTY error string returns failure', () => {
    // The boundary of the rule: an error that is a string but says nothing is not an explanation.
    assert.deepEqual(saveOutcome(400, { error: '' }), { ok: false, failure: true });
    assert.deepEqual(saveOutcome(400, { error: '   ' }), { ok: false, failure: true });
});

test('400 with a body that is a bare string returns failure', () => {
    // A server that answered with `"too long"` as the whole body did not give the field the page reads.
    assert.deepEqual(saveOutcome(400, 'too long'), { ok: false, failure: true });
});

// ===========================================================================
// 3. A SERVER FAULT IS A FAILURE, WHATEVER THE BODY SAYS
// ===========================================================================

test('500 and 502 return failure, even with an error string', () => {
    // A 5xx is our fault, not the participant's. Showing them "your answer is too long" because a
    // gateway 502'd would be a lie about whose problem it is.
    assert.deepEqual(saveOutcome(500, { error: 'Internal Server Error' }), { ok: false, failure: true });
    assert.deepEqual(saveOutcome(502, { error: 'Bad Gateway' }), { ok: false, failure: true });
});

test('every other status returns failure', () => {
    for (const status of [401, 403, 404, 409, 413, 418, 422, 429, 503, 0, -1, 199, 300, 301, 399]) {
        assert.deepEqual(saveOutcome(status, { error: 'text' }), { ok: false, failure: true },
            `${status} must be a failure`);
    }
});

// ===========================================================================
// 4. SUCCESS
// ===========================================================================

test('2xx returns ok, including 204 with no body', () => {
    assert.deepEqual(saveOutcome(200, { ok: true }), { ok: true });
    assert.deepEqual(saveOutcome(201, null), { ok: true });
    assert.deepEqual(saveOutcome(204, null), { ok: true }, 'a save that answers 204 has still saved');
});

test('the success boundary: 199 is not ok and 300 is not ok', () => {
    assert.deepEqual(saveOutcome(199, null), { ok: false, failure: true });
    assert.deepEqual(saveOutcome(299, null), { ok: true });
    assert.deepEqual(saveOutcome(300, null), { ok: false, failure: true });
});

// ===========================================================================
// 5. A FETCH THAT THREW
// ===========================================================================

test('a thrown fetch is a failure, and it has its own function', () => {
    // There is no status and no body when the request never completed, so it cannot go through
    // saveOutcome. It is beside it, so both ways a save can fail are answered by one module.
    assert.deepEqual(saveFailed(), { ok: false, failure: true });
});

// ===========================================================================
// 6. The shape the caller relies on
// ===========================================================================

test('every outcome is exactly one of the three shapes', () => {
    const outcomes = [
        saveOutcome(200, null),
        saveOutcome(400, { error: 'text' }),
        saveOutcome(400, null),
        saveOutcome(500, null),
        saveFailed()
    ];
    for (const outcome of outcomes) {
        if (outcome.ok) {
            assert.deepEqual(Object.keys(outcome), ['ok']);
        } else if (outcome.refusal !== undefined) {
            // A refusal must never be mistaken for a failure: the caller shows one and not the other.
            assert.equal(outcome.failure, undefined);
            assert.deepEqual(Object.keys(outcome).sort(), ['ok', 'refusal']);
        } else {
            assert.deepEqual(outcome, { ok: false, failure: true });
        }
    }
});

test('the module imports nothing, so it can be tested with no browser and no server', () => {
    // The reason this decision is in its own file. A module that reached for fetch or the DOM could
    // not be covered here, which is how the original defect survived a green suite.
    const source = fs.readFileSync(new URL('../public/js/save-outcome.js', import.meta.url), 'utf8');
    assert.equal(/^\s*import\s/m.test(source), false, 'no imports');
    assert.equal(/\bfetch\s*\(/.test(source), false, 'no network call');
    assert.equal(/\bdocument\b/.test(source), false, 'no DOM');
});

// ===========================================================================
// 7. THE CLASSIC-SCRIPT BUILD AGREES WITH THE MODULE
// ===========================================================================

test('the page build and the module give the SAME answer for every input', () => {
    // WHY A SECOND FILE EXISTS AT ALL: audit.js must stay a classic script, because
    // test/workflow-identity.test.js runs it in a node:vm context and drives 27 behavioural tests through
    // it. A classic script cannot import, and one file cannot be both a module and a classic script.
    //
    // A second copy of a rule is a risk ONLY if nothing compares them. This compares them, over every
    // status and body shape the rule distinguishes, so the mirror cannot drift unnoticed.
    const source = fs.readFileSync(
        new URL('../public/js/save-outcome.global.js', import.meta.url), 'utf8');
    const sandbox = { window: {} };
    runInContext(source, createContext(sandbox));
    const page = sandbox.window.saveOutcome;

    assert.equal(typeof page?.saveOutcome, 'function', 'the page build installs window.saveOutcome');
    assert.equal(typeof page?.saveFailed, 'function');

    const statuses = [200, 201, 204, 299, 300, 304, 400, 401, 403, 404, 409, 413, 418, 422, 429,
        500, 502, 503, 0, -1, 199, 999];
    const bodies = [null, {}, { error: 'text' }, { error: '' }, { error: '   ' }, { error: 42 },
        { error: null }, { error: { a: 1 } }, { error: ['a'] }, 'a bare string', 0, false];

    for (const status of statuses) {
        for (const body of bodies) {
            // JSON rather than deepEqual: a value built inside a node:vm context has that context's
            // prototypes, so deepEqual compares prototype chains across realms and always reports a
            // difference. JSON compares what the rule actually produces, which is what the page uses.
            assert.equal(
                JSON.stringify(page.saveOutcome(status, body)),
                JSON.stringify(saveOutcome(status, body)),
                `page build and module disagree on status ${status} with ${JSON.stringify(body)}`
            );
        }
    }

    assert.equal(JSON.stringify(page.saveFailed()), JSON.stringify(saveFailed()), 'and they agree on a thrown fetch');
});

// ===========================================================================
// 8. THE FALLBACK INSIDE audit.js AGREES TOO
// ===========================================================================

test('audit.js, loaded with NO save-outcome global, still decides the same way', async () => {
    // audit.js keeps a copy of the rule as a fallback, because two existing vm harnesses run it in a
    // context that never loaded save-outcome.global.js. A fallback that disagreed would be a defect
    // that only appears in those contexts, which is precisely the kind of difference nothing notices.
    //
    // This drives the file the way those harnesses do - a bare context, no global - and compares the
    // result of a real save attempt against the module.
    const source = fs.readFileSync(new URL('../public/js/audit.js', import.meta.url), 'utf8');

    const makeContext = (saveStatus, saveBody) => {
        const elements = {};
        const el = (id) => (elements[id] ||= {
            id, value: '', innerHTML: '', className: '', style: {}, disabled: false, handlers: {},
            textContent: '',
            classList: { _set: new Set(), add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); }, contains(c) { return this._set.has(c); } },
            addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); },
            appendChild() {}, removeChild() {}, remove() {}, focus() {}, scrollTop: 0, scrollHeight: 0,
            parentNode: null
        });
        const listeners = {};
        const saved = [];
        const document = {
            // Creates on demand, as the harness in test/workflow-identity.test.js does: audit.js reaches
            // for elements by id all over beginWithToken, and a null there throws before any save happens.
            getElementById: (id) => el(id),
            querySelector: () => null,
            querySelectorAll: () => [],
            createElement: () => el('tmp' + Math.random()),
            addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
            documentElement: el('html'), body: el('body'), activeElement: null, title: ''
        };
        const fetch = async (url) => {
            if (url.includes('/api/chat')) {
                return { ok: true, status: 200, json: async () => ({ status: 'asking', content: 'next', workflows: [{ id: 'w', task: 't', steps: [] }] }) };
            }
            if (url.includes('/api/response')) {
                saved.push(1);
                return {
                    ok: saveStatus >= 200 && saveStatus < 300,
                    status: saveStatus,
                    json: async () => saveBody()
                };
            }
            return { ok: true, status: 200, json: async () => ({}) };
        };
        const window = {
            AUDIT_CONFIG: { strings: {}, participantToken: 'token', lang: 'en', toolId: 't', basePath: '' },
            location: { href: '' }, alert() {}
        };
        return { elements, listeners, document, fetch, window, saved, el };
    };

    const run = async (saveStatus, saveBody) => {
        const ctx = makeContext(saveStatus, saveBody);
        runInContext(source, createContext({
            ...ctx,
            console: { log() {}, warn() {}, error() {} },
            URLSearchParams, JSON, Math, Date, Object, Array, String, Number, encodeURIComponent,
            setTimeout, clearTimeout
        }));
        for (const fn of ctx.listeners.DOMContentLoaded || []) await fn();
        ctx.el('input').value = 'an answer';
        for (const fn of ctx.el('send-btn').handlers.click || []) await fn();
        // The problem box is how the refusal surfaces; an empty box means a failure, not a refusal.
        const box = ctx.elements['save-problem'];
        return { saved: ctx.saved.length, refusedText: box && box.textContent ? box.textContent : null };
    };

    // A 400 that explains itself: the participant is shown the server's words.
    const refusalText = saveOutcome(400, { error: 'too long' }).refusal;
    const for400 = await run(400, () => ({ error: refusalText }));
    assert.equal(for400.saved, 1, 'the save was attempted');
    assert.equal(for400.refusedText, refusalText, 'audit.js shows the same refusal the module names');

    // A 500: not a refusal, so no refusal text is shown for it.
    const for500 = await run(500, () => ({ error: 'nope' }));
    assert.equal(for500.saved, 1);
    assert.notEqual(for500.refusedText, 'nope', 'a 500 is not reported as a refusal');

    // A 2xx: nothing is shown, and the save stands.
    const for200 = await run(200, () => ({}));
    assert.equal(for200.refusedText, null, 'a successful save shows no problem');
});
