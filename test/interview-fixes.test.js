
import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');

const { parseModelResponse, validateWorkflows } = await import('../ai/audit-core.js');
const matrix = await import('../ai/matrix.js');

const PROMPTS_DIR = path.join(PROJECT_ROOT, 'data', 'prompts', 'cartiere_audit');

function completeInterviewProcess(overrides = {}) {
    const process = {};
    for (const field of matrix.PROCESS_FIELDS) {
        if (field === 'steps') continue;
        if (['handoffTo', 'waitsFor', 'dependsOn', 'systems', 'touchedDepartments'].includes(field)) process[field] = ['x'];
        else if (['mistakesPerPeriod', 'peopleAffected'].includes(field)) process[field] = 2;
        else process[field] = `a value for ${field}`;
    }
    process.steps = [Object.fromEntries(matrix.STEP_FIELDS.map((f) => [f, f === 'needsReasoning' ? false : 'a value']))];
    process.frequencyPerWeek = 3;
    return { ...process, ...overrides };
}

// ===========================================================================
// 1. THE SHAPE THAT ARRIVED IS THE SHAPE VALIDATED
// ===========================================================================
//
// The interview shape (`processes`) carries NEITHER `id` NOR `title`, so judging it by the final
// payload's rules rejects a finished interview.

test('an interview completion with the interview shape COMPLETES, even without id and title', () => {
    const process = completeInterviewProcess();
    assert.equal('id' in process, false, 'the fixture genuinely has no id, like a real reply');
    assert.equal('title' in process, false, 'nor a title');

    const result = parseModelResponse(JSON.stringify({
        status: 'complete',
        content: 'done',
        processes: [process],
        have: [...matrix.ALL_PROCESS_FIELD_NAMES],
        missing: []
    }));

    assert.equal(result.status, 'complete', 'the interview is not killed for lacking id or title');
});

test('a FINAL payload is still held to the strict id/title rules', () => {
    const check = validateWorkflows([{ id: 'w1' }]);
    assert.equal(check.ok, false);
    assert.match(check.reason, /no title/);

    const noId = validateWorkflows([{ title: 'A' }]);
    assert.equal(noId.ok, false);
    assert.match(noId.reason, /no id/);
});

test('an interview reply with a malformed process entry CONTINUES rather than erroring', () => {
    // The matrix gate runs BEFORE the unreadable-entry check, so a non-object entry is downgraded
    // to `asking` and the unreadable check is never reached.
    const result = parseModelResponse(JSON.stringify({
        status: 'complete',
        content: 'done',
        processes: [completeInterviewProcess(), 'not an object']
    }));

    assert.equal(result.status, 'asking', 'the interview continues rather than ending');
    assert.ok(result.missing.length > 0, 'and it names what is still needed');
});

test('an empty audit.workflows ALONE is refused', () => {
    const result = parseModelResponse(JSON.stringify({
        status: 'complete',
        content: 'done',
        audit: { workflows: [] }
    }));

    assert.equal(result.status, 'error', 'an empty audit with nothing better is refused');
});

test('an empty audit.workflows BESIDE good processes is merely stale, and processes win', () => {
    const result = parseModelResponse(JSON.stringify({
        status: 'complete',
        content: 'done',
        processes: [completeInterviewProcess()],
        audit: { workflows: [] },
        have: [...matrix.ALL_PROCESS_FIELD_NAMES],
        missing: []
    }));

    assert.equal(result.status, 'complete', 'the stale empty audit is not fatal');
    assert.equal(result.audit.workflows.length, 1, 'and the processes are what the client receives');
});

test('the two empty-audit cases are DIFFERENT, asserted together', () => {
    const alone = parseModelResponse(JSON.stringify({ status: 'complete', content: 'd', audit: { workflows: [] } }));
    const beside = parseModelResponse(JSON.stringify({
        status: 'complete', content: 'd', processes: [completeInterviewProcess()], audit: { workflows: [] },
        have: [...matrix.ALL_PROCESS_FIELD_NAMES], missing: []
    }));

    assert.equal(alone.status, 'error');
    assert.equal(beside.status, 'complete');
});

test('a bad audit.workflows beside good processes is ALSO superseded, not fatal', () => {
    const result = parseModelResponse(JSON.stringify({
        status: 'complete',
        content: 'done',
        processes: [completeInterviewProcess()],
        audit: { workflows: 'nope' },
        have: [...matrix.ALL_PROCESS_FIELD_NAMES],
        missing: []
    }));

    assert.equal(result.status, 'complete', 'the processes are authoritative');
    assert.equal(result.audit.workflows.length, 1);
});

// ===========================================================================
// 2. THE CLOSING QUESTION IS GATED ON `missing`
// ===========================================================================
//
// Ungated, the closing sentence is asked whenever a process feels finished.

test('the English prompt gates the closing question on missing being empty', () => {
    const prompt = fs.readFileSync(path.join(PROMPTS_DIR, 'prompt_en.md'), 'utf8');

    assert.match(prompt, /is there another process you would like to improve\?/i, 'the closing question is stated');
    assert.match(prompt, /ONLY WHEN `missing` IS EMPTY/i, 'the rule names the condition');
    assert.match(prompt, /Its only permitted use is in a reply whose `missing`\s+is empty/i, 'and restates it as the sole condition');
});

test('the Dutch prompt gates the closing question too', () => {
    const prompt = fs.readFileSync(path.join(PROMPTS_DIR, 'prompt_nl.md'), 'utf8');
    assert.match(prompt, /nog een proces dat je zou willen verbeteren\?/i, 'the closing question is stated in Dutch');
    const gate = prompt.match(/[^\n]*missing[^\n]*/i);
    assert.ok(gate, 'and tied to `missing`');
});

test('the OLD unconditional wording is gone from both prompts', () => {
    for (const file of ['prompt_en.md', 'prompt_nl.md']) {
        const prompt = fs.readFileSync(path.join(PROMPTS_DIR, file), 'utf8');
        assert.equal(
            /ask[^\n]*is there another process you would like to improve\?[^\n]*period/i.test(prompt),
            false,
            `${file} must not ask the closing question unconditionally`
        );
    }
});

// ===========================================================================
// 3. THE FRESH-START RULE IS CONDITIONAL ON THE PARTICIPANT
// ===========================================================================
//
// The rule must trigger on the PARTICIPANT confirming: a wrong belief discards the finished
// process's fields.

test('the English fresh-start rule is conditional on the participant confirming', () => {
    const prompt = fs.readFileSync(path.join(PROMPTS_DIR, 'prompt_en.md'), 'utf8');

    assert.match(prompt, /STARTS THE CONVERSATION AGAIN/, 'the rule is present');
    assert.match(
        prompt,
        /DROP THE FINISHED PROCESS ONLY WHEN THE PARTICIPANT HAS CONFIRMED/i,
        'and it is conditioned on the participant confirming, not on the model believing'
    );
    assert.match(prompt, /A wrong belief about completion must cost\s+nothing/i, 'the cost of dropping early is stated');
});

test('the Dutch fresh-start rule is conditional too', () => {
    const prompt = fs.readFileSync(path.join(PROMPTS_DIR, 'prompt_nl.md'), 'utf8');
    assert.match(prompt, /BEGINT HET GESPREK OPNIEUW/, 'the rule is present in Dutch');
    assert.equal(/alongside the first/i.test(prompt), false, 'and the accumulation rule is gone');
});

test('neither prompt drops a finished process on the model\'s own belief alone', () => {
    for (const file of ['prompt_en.md', 'prompt_nl.md']) {
        const prompt = fs.readFileSync(path.join(PROMPTS_DIR, file), 'utf8');
        assert.equal(
            /(you think|when you believe|if you think)[^\n]*(finished|complete)[^\n]*(start|drop|begin)/i.test(prompt),
            false,
            `${file} must not trigger the fresh start on the model's own belief`
        );
    }
});

// ===========================================================================
// 4. A COMPLETION CLAIM CANNOT NARROW THE PAYLOAD — THE BROWSER HALF
// ===========================================================================
//
// Driven through the REAL client script in a sandbox: a completion reply that DROPS a process the
// round already had must still POST it.

async function loadClient({ replies }) {
    const { createContext, runInContext } = await import('node:vm');
    const source = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'js', 'audit.js'), 'utf8');

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

    const posts = [];
    const emptyResult = { scored: [], buckets: { do_first: [], do_later: [], judgement_bound: [] }, conflicts: [], totalRecoverableHoursPerWeek: 0, workflowCount: 0 };
    let replyIndex = 0;

    const fetch = async (url, options) => {
        if (url.includes('/api/chat')) {
            return { ok: true, status: 200, json: async () => ({ ...(replies[replyIndex++] ?? { status: 'asking', content: 'next' }) }) };
        }
        if (url.includes('/api/response')) {
            posts.push(JSON.parse(options.body));
            return { ok: true, status: 200, json: async () => emptyResult };
        }
        return { ok: true, status: 200, json: async () => emptyResult };
    };

    const window = {
        AUDIT_CONFIG: { strings: {}, participantToken: 'token', lang: 'en', toolId: 't', basePath: '' },
        location: { href: '' },
        alert() {}
    };

    runInContext(source, createContext({
        window, document, fetch, console: { log() {}, warn() {}, error() {} },
        URLSearchParams, JSON, Math, Date, Object, Array, String, Number, encodeURIComponent, setTimeout, clearTimeout
    }));

    for (const fn of documentListeners.DOMContentLoaded || []) await fn();

    return {
        posts,
        send: async (message) => {
            el('input').value = message;
            for (const fn of el('send-btn').handlers.click || []) await fn();
        }
    };
}

test('a completion reply that DROPS a process still POSTS it, carried forward', async () => {
    // The last POST must still carry proc-1, or its answers are gone.
    const client = await loadClient({
        replies: [
            { status: 'asking', content: 'What is the task?' },
            { status: 'complete', content: 'done', audit: { workflows: [{ id: 'proc-1', title: 'One' }] } },
            { status: 'asking', content: 'Another process?' },
            { status: 'complete', content: 'done2', audit: { workflows: [{ id: 'proc-2', title: 'Two' }] } }
        ]
    });

    await client.send('I enter invoices');
    await client.send('done');
    await client.send('another');
    await client.send('done2');

    const completionPosts = client.posts.filter((p) => p.complete);
    assert.equal(completionPosts.length, 2, 'two completion turns were saved');

    const lastIds = completionPosts.at(-1).data.workflows.map((w) => w.id);
    assert.ok(lastIds.includes('proc-2'), 'the new process is present');
    assert.ok(lastIds.includes('proc-1'), 'AND the dropped one is carried forward, not lost');
});

test('the narrowing is NOT triggered when no process was dropped', async () => {
    const client = await loadClient({
        replies: [
            { status: 'complete', content: 'done', audit: { workflows: [{ id: 'proc-1', title: 'One' }, { id: 'proc-2', title: 'Two' }] } }
        ]
    });

    await client.send('both at once');

    const completionPosts = client.posts.filter((p) => p.complete);
    assert.equal(completionPosts.length, 1);
    assert.deepEqual(completionPosts[0].data.workflows.map((w) => w.id), ['proc-1', 'proc-2'], 'no duplicate carried forward');
});

test('a NON-completion reply is saved as it arrived, without carrying anything forward', async () => {
    // Carrying forward is a completion-claim guard: nothing is MERGED IN on an ordinary turn.
    const client = await loadClient({
        replies: [
            { status: 'complete', content: 'done', audit: { workflows: [{ id: 'proc-1', title: 'One' }] } },
            { status: 'asking', content: 'go on' }
        ]
    });

    await client.send('first');
    await client.send('next');

    const openPosts = client.posts.filter((p) => p.complete === false);
    assert.equal(openPosts.length, 1, 'the asking turn was saved');
    assert.ok(
        openPosts[0].data === null || openPosts[0].data === undefined,
        'an asking turn carries no carried-forward payload'
    );
});

// ===========================================================================
// 5. THE stepsStillNeed GUARD IS RECURSIVE
// ===========================================================================
//
// A model-supplied value must not survive at ANY depth: deleting it at the top level leaves it
// inside `processes`.

test('a model-supplied stepsStillNeed is removed at the TOP level', () => {
    const result = parseModelResponse(JSON.stringify({
        status: 'asking', content: 'q', processes: [completeInterviewProcess()], stepsStillNeed: ['top-level']
    }));

    assert.notDeepEqual(result.stepsStillNeed, ['top-level'], 'the model value does not survive');
    assert.deepEqual(result.stepsStillNeed, [], 'the computed value is used instead');
});

test('a model-supplied stepsStillNeed is removed INSIDE a process', () => {
    const result = parseModelResponse(JSON.stringify({
        status: 'asking', content: 'q',
        processes: [completeInterviewProcess({ stepsStillNeed: ['in-process'] })]
    }));

    assertOkNoFieldAtAnyDepth(result, 'the field is gone from the process object');
});

test('a model-supplied stepsStillNeed is removed INSIDE a step, and DEEPER', () => {
    const process = completeInterviewProcess();
    process.steps[0].stepsStillNeed = ['in-step'];
    process.steps[0].nested = { deeper: { stepsStillNeed: ['deeper'] }, list: [{ stepsStillNeed: ['in-array'] }] };

    const result = parseModelResponse(JSON.stringify({ status: 'asking', content: 'q', processes: [process] }));

    assertOkNoFieldAtAnyDepth(result, 'the field is gone at every depth');
});

test('the guard leaves the SERVER-COMPUTED value on the result', () => {
    const process = completeInterviewProcess();
    delete process.steps[0].needsReasoning;

    const result = parseModelResponse(JSON.stringify({
        status: 'asking', content: 'q', processes: [process], stepsStillNeed: ['model-claim']
    }));

    assert.deepEqual(result.stepsStillNeed, ['needsReasoning'], 'the computed list is present');
});

/** No object carries `stepsStillNeed` except the result root, where the server places it. */
function assertOkNoFieldAtAnyDepth(result, message) {
    const carrying = [];
    const walk = (value, path) => {
        if (value === null || typeof value !== 'object') return;
        if (!Array.isArray(value) && Object.hasOwn(value, 'stepsStillNeed')) carrying.push(path);
        for (const key of Object.keys(value)) walk(value[key], `${path}.${key}`);
    };
    walk(result, 'root');
    assert.deepEqual(carrying, ['root'], `${message} (found at: ${carrying.join(', ') || 'nowhere'})`);
}

test('the answers view has a partial marker, distinct from the identified one', () => {
    const view = fs.readFileSync(path.join(PROJECT_ROOT, 'views', 'admin-answers.ejs'), 'utf8');

    assert.match(view, /submitted_at\s*===\s*null|!response\.submitted_at/, 'the view tests submitted_at');
    assert.match(view, /partial/i, 'and names it as partial');
});

test('each of the three language blocks carries the partial label consistently', async () => {
    const { stringsFor } = await import('../lib/strings.js');

    const langs = ['nl', 'en', 'fr'];
    const keySets = langs.map((lang) => ({ lang, keys: Object.keys(stringsFor(lang)).sort() }));
    for (const { lang, keys } of keySets) {
        assert.deepEqual(keys, keySets[0].keys, `${lang} must have the same keys as en`);
    }
});
