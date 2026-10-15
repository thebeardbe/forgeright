/**
 * The duplicate-process fix: workflow identity, the identity rule, and the two client fixes.
 *
 * THE FAILURE IT GUARDS. The server derives a process `id` from its `task`, and THE MODEL REWORDS
 * THE TASK BETWEEN TURNS, so three rewordings of one process each look NEW and accumulate. The
 * participant's visible total is then computed across all of them.
 *
 * THE RULE IS AN EXACT STEP-NAME CO-TEST with no similarity threshold, tested by driving the REAL
 * client in a sandbox rather than re-implementing the rule.
 *
 * NO PRODUCTION CODE IS TOUCHED. `data/demo/` and the seed are unchanged: every demo response holds
 * ONE flat workflow with an explicit id, which `withWorkflowIdentity` passes through untouched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');

const { slugForTask, titleForTask, withWorkflowIdentity } = await import('../ai/workflow-identity.js');

// ===========================================================================
// THE CLIENT SANDBOX - the real `public/js/audit.js`, driven through real turns
// ===========================================================================
//
// The identity rule and the carry-forward live inside `public/js/audit.js` and are not exported, so
// they are exercised through the real client and its recorded `/api/response` POSTs - the payload
// the server would actually store.

/** Loads `public/js/audit.js` in a sandbox and returns a driver plus the recorded POSTs. */
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
    const warnings = [];
    const scored = [];
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
        if (url.includes('/api/score')) {
            scored.push(JSON.parse(options.body));
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
        window, document, fetch,
        console: { log() {}, warn: (...args) => warnings.push(args.join(' ')), error() {} },
        URLSearchParams, JSON, Math, Date, Object, Array, String, Number, encodeURIComponent, setTimeout, clearTimeout
    }));

    for (const fn of documentListeners.DOMContentLoaded || []) await fn();

    return {
        posts,
        warnings,
        scored,
        send: async (message) => {
            el('input').value = message;
            for (const fn of el('send-btn').handlers.click || []) await fn();
        }
    };
}

/** The last non-empty workflows array the client POSTed. */
function lastPostedWorkflows(client) {
    const withWorkflows = client.posts.filter((p) => p.data && Array.isArray(p.data.workflows) && p.data.workflows.length > 0);
    return withWorkflows.at(-1)?.data.workflows ?? [];
}

const STEP = (name) => ({ name, whatHappens: `${name} happens`, decidedHow: 'a rule', needsReasoning: false });

// ===========================================================================
// 1. ai/workflow-identity.js - STABILITY IS THE PROPERTY
// ===========================================================================

test('the SAME task produces the SAME id on consecutive turns', () => {
    // THE STABILITY PROPERTY: an id that changes between turns makes one process look like several.
    // Two separate calls, as two turns would be.
    const first = withWorkflowIdentity([{ task: 'Triaging overnight complaints' }]);
    const second = withWorkflowIdentity([{ task: 'Triaging overnight complaints' }]);

    assert.equal(first[0].id, second[0].id, 'the id does not change between calls');
    assert.equal(first[0].id, 'triaging-overnight-complaints', 'and it is the slug of the task');
});

test('two SAME-TASK processes in ONE payload get DISTINCT ids', () => {
    // `findConflictGroups` keys a union-find on `id`, so two entries sharing one would be treated
    // as a single process and merged into one conflict group - which is why uniqueness is enforced
    // within the payload rather than only across turns.
    const workflows = withWorkflowIdentity([{ task: 'Same task' }, { task: 'Same task' }, { task: 'Same task' }]);

    assert.deepEqual(workflows.map((w) => w.id), ['same-task', 'same-task-2', 'same-task-3']);
    assert.equal(new Set(workflows.map((w) => w.id)).size, 3, 'the three ids are distinct');
});

test('an explicit id and title WIN, always - the demo seed is not rewritten', () => {
    // The demo seed writes its own id and title, and overwriting them would change what the demo
    // scores. A present, non-blank value passes through untouched.
    const workflows = withWorkflowIdentity([{ id: 'example-ltd-demo-process', title: 'Invoice intake', task: 'ignored' }]);

    assert.equal(workflows[0].id, 'example-ltd-demo-process', 'the explicit id is kept');
    assert.equal(workflows[0].title, 'Invoice intake', 'and the explicit title');
});

test('a generated id cannot collide with an explicit one carried beside it', () => {
    // The explicit id is claimed through the same counter, so a slug derived from a task cannot be
    // handed the same key.
    const workflows = withWorkflowIdentity([
        { id: 'shared-task', title: 'T', task: 'x' },
        { task: 'Shared task' }
    ]);

    assert.equal(workflows[0].id, 'shared-task');
    assert.notEqual(workflows[1].id, 'shared-task', 'the generated id moves around the taken one');
});

test('the input is NOT mutated, so a later reader of the original is unaffected', () => {
    const input = [{ task: 'Triaging overnight complaints' }];
    const out = withWorkflowIdentity(input);

    assert.notEqual(out, input, 'a new array is returned');
    assert.equal(input[0].id, undefined, 'and the caller\'s object is left alone');
    assert.equal(out[0].id, 'triaging-overnight-complaints');
});

test('a task with no surviving characters falls back rather than producing an empty id', () => {
    // `validateWorkflows` refuses an empty id, so the fallback is what stops the scorer rejecting
    // the payload over a non-Latin task.
    assert.equal(slugForTask('日本語'), 'process', 'non-Latin falls back');
    assert.equal(slugForTask(''), 'process', 'empty falls back');
    assert.equal(slugForTask(undefined), 'process', 'absent falls back');
    assert.equal(slugForTask('Réception des factures'), 'reception-des-factures', 'accents reduce to base letters');
});

test('the title is the task, shortened at a word boundary with a visible ellipsis', () => {
    assert.equal(titleForTask('Short task'), 'Short task');
    assert.equal(titleForTask('   '), 'Untitled process', 'blank falls back');

    const long = 'Triaging overnight customer complaints and deciding which ones need a person to look at them';
    const title = titleForTask(long);
    assert.ok(title.length <= 82, `the title is shortened (got ${title.length})`);
    assert.match(title, /\.\.\.$/, 'and says it was shortened rather than stopping mid-word');
    assert.equal(title.endsWith(' ...'), false, 'the ellipsis is not preceded by a stray space');
});

// ===========================================================================
// 2. reconcileWorkflowIdentity - THE RULE AND ITS GUARDS
// ===========================================================================

test('a REWORDED task with a SHARED STEP reattaches the round\'s id', async () => {
    const client = await loadClient({
        replies: [
            { status: 'complete', content: 'done', audit: { workflows: [{ id: 'going-through-complaints', title: 'A', steps: [STEP('Open the complaint')] }] } },
            { status: 'complete', content: 'done', audit: { workflows: [{ id: 'triaging-complaints', title: 'B', steps: [STEP('Open the complaint')] }] } }
        ]
    });

    await client.send('one');
    await client.send('two');

    const ids = lastPostedWorkflows(client).map((w) => w.id);
    assert.deepEqual(ids, ['going-through-complaints'],
        'the reworded process is kept under the round\'s id, so it does not appear twice');
});

test('the case the fix must NOT catch: a DIFFERENT process that shares no step is NOT merged', async () => {
    // Merging a genuinely new process would DISCARD a participant's answers.
    const client = await loadClient({
        replies: [
            { status: 'complete', content: 'done', audit: { workflows: [{ id: 'proc-one', title: 'One', steps: [STEP('Open the invoice')] }] } },
            { status: 'complete', content: 'done', audit: { workflows: [{ id: 'proc-two', title: 'Two', steps: [STEP('Answer the phone')] }] } }
        ]
    });

    await client.send('one');
    await client.send('two');

    const ids = lastPostedWorkflows(client).map((w) => w.id);
    assert.ok(ids.includes('proc-two'), 'the new process keeps its own id');
    assert.ok(ids.includes('proc-one'), 'and the first is carried forward rather than replaced');
});

test('a reply with NO steps is DECLINED, not merged', async () => {
    // A reply carrying no steps is not evidence of anything, so it is left exactly as the model
    // sent it.
    const client = await loadClient({
        replies: [
            { status: 'complete', content: 'done', audit: { workflows: [{ id: 'proc-one', title: 'One', steps: [STEP('Open the invoice')] }] } },
            { status: 'complete', content: 'done', audit: { workflows: [{ id: 'proc-two', title: 'Two' }] } }
        ]
    });

    await client.send('one');
    await client.send('two');

    const ids = lastPostedWorkflows(client).map((w) => w.id);
    assert.ok(ids.includes('proc-two'), 'the stepless reply keeps its own id');
    assert.equal(/reworded the process/.test(client.warnings.join(' ')), false,
        'and no merge was announced');
});

test('a reply that ALREADY matches is left alone, with nothing announced', async () => {
    const client = await loadClient({
        replies: [
            { status: 'complete', content: 'done', audit: { workflows: [{ id: 'proc-one', title: 'One', steps: [STEP('Open the invoice')] }] } },
            { status: 'complete', content: 'done', audit: { workflows: [{ id: 'proc-one', title: 'One', steps: [STEP('Open the invoice')] }] } }
        ]
    });

    await client.send('one');
    await client.send('two');

    assert.equal(/reworded the process/.test(client.warnings.join(' ')), false, 'no merge was announced');
    assert.deepEqual(lastPostedWorkflows(client).map((w) => w.id), ['proc-one']);
});

test('a merge is LOUD - the console.warn fires, because a silent merge is worse than a split', async () => {
    // THE STATED TRADE-OFF. A merge fuses two processes and discards one; a split leaves a visible
    // extra the console reports. So when the rule DOES fire, it says so.
    const client = await loadClient({
        replies: [
            { status: 'complete', content: 'done', audit: { workflows: [{ id: 'proc-one', title: 'One', steps: [STEP('Open the invoice')] }] } },
            { status: 'complete', content: 'done', audit: { workflows: [{ id: 'proc-reworded', title: 'One again', steps: [STEP('Open the invoice')] }] } }
        ]
    });

    await client.send('one');
    await client.send('two');

    const logged = client.warnings.join(' ');
    assert.match(logged, /reworded the process/, 'the merge is announced');
    assert.match(logged, /proc-one/, 'and names the id the round kept');
});

test('the rule runs on a MULTI-ENTRY reply - several held, several incoming, both resolved', async () => {
    // An EXACT STEP-NAME MATCH says WHICH held process is being reworded: a multi-held reply
    // resolves against whichever held process it shares a step with, and a multi-entry reply
    // resolves each entry on its own.

    // SEVERAL HELD, ONE INCOMING: p3 shares step S with p1, so it takes p1's id.
    const severalHeld = await loadClient({
        replies: [
            { status: 'complete', content: 'a', audit: { workflows: [{ id: 'p1', title: '1', steps: [STEP('S')] }, { id: 'p2', title: '2', steps: [STEP('T')] }] } },
            { status: 'complete', content: 'b', audit: { workflows: [{ id: 'p3', title: '3', steps: [STEP('S')] }] } }
        ]
    });
    await severalHeld.send('one');
    await severalHeld.send('two');

    assert.match(severalHeld.warnings.join(' '), /reworded the process/, 'several held: the match FIRES');
    // p3 takes p1's identity, and p2 is carried forward beside it, so the round still holds both.
    const afterSeveralHeld = severalHeld.posts.at(-1).data.workflows.map((w) => w.id).sort();
    assert.deepEqual(afterSeveralHeld, ['p1', 'p2'], 'p3 becomes p1, and p2 is untouched');

    // ONE HELD, SEVERAL INCOMING: p2 shares step S with the held p1 and takes its id; p3 shares
    // nothing with either and is KEPT as its own process.
    const severalIncoming = await loadClient({
        replies: [
            { status: 'complete', content: 'a', audit: { workflows: [{ id: 'p1', title: '1', steps: [STEP('S')] }] } },
            { status: 'complete', content: 'b', audit: { workflows: [{ id: 'p2', title: '2', steps: [STEP('S')] }, { id: 'p3', title: '3', steps: [STEP('T')] }] } }
        ]
    });
    await severalIncoming.send('one');
    await severalIncoming.send('two');

    assert.match(severalIncoming.warnings.join(' '), /reworded the process/, 'several incoming: the match fires');
    const afterIncoming = severalIncoming.posts.at(-1).data.workflows;
    assert.equal(afterIncoming.length, 2, 'two processes in the reply stay two');
    assert.deepEqual(afterIncoming.map((w) => w.id).sort(), ['p1', 'p3'], 'p2 became p1; p3 is untouched');
});

test('A TWO-ENTRY REPLY IS RESOLVED - the shape a real reply has, which no test covered', async () => {
    // A real reply carries TWO entries - the stale carry-forward beside the current wording - so a
    // rule that required exactly one on each side returns untouched every turn. Here two entries
    // share a step WITH EACH OTHER and neither is held.
    const client = await loadClient({
        replies: [{
            status: 'complete', content: 'x',
            audit: {
                workflows: [
                    { id: 'first', title: 'First', steps: [STEP('Open the bill'), STEP('Check the lines')] },
                    { id: 'second', title: 'Second', steps: [STEP('Check the lines'), STEP('Total the charges')] }
                ]
            }
        }]
    });
    await client.send('go');

    const saved = client.posts.at(-1).data.workflows;
    assert.equal(saved.length, 1, 'the two entries sharing a step name become ONE - the old guard left both');
    assert.match(client.warnings.join(' '), /described ONE process twice/, 'and the fold is announced');
});

test('the order is IRRELEVANT: the same pair either way keeps the same winner', async () => {
    // The winner must not depend on which entry comes first, or the reply's own ordering decides a
    // participant's record.
    const rich = { id: 'rich', title: 'Rich', steps: [STEP('Check the lines'), STEP('Total the charges')], frequencyPerWeek: 5, minutesPerInstance: 12 };
    const sparse = { id: 'sparse', title: 'Sparse', steps: [STEP('Check the lines')] };

    const forward = await loadClient({ replies: [{ status: 'complete', content: 'x', audit: { workflows: [rich, sparse] } }] });
    await forward.send('go');
    const backward = await loadClient({ replies: [{ status: 'complete', content: 'x', audit: { workflows: [sparse, rich] } }] });
    await backward.send('go');

    for (const [label, client] of [['rich first', forward], ['sparse first', backward]]) {
        const saved = client.posts.at(-1).data.workflows;
        assert.equal(saved.length, 1, `${label}: one entry survives`);
        assert.equal(saved[0].steps.length, 2, `${label}: the RICHER entry is kept, whichever order it arrived in`);
        assert.equal(saved[0].minutesPerInstance, 12, `${label}: with its content, not only its id`);
    }
});

test('the step-name comparison TRIMS and CASE-FOLDS, so case and padding do not defeat it', async () => {
    // What the normalisation does: `stepNamesOf` maps each name through `.trim().toLowerCase()`.
    // Case and surrounding whitespace are therefore ignored.
    const client = await loadClient({
        replies: [
            { status: 'complete', content: 'done', audit: { workflows: [{ id: 'proc-one', title: 'One', steps: [STEP('Open the invoice')] }] } },
            { status: 'complete', content: 'done', audit: { workflows: [{ id: 'proc-two', title: 'Two', steps: [STEP('  OPEN THE INVOICE  ')] }] } }
        ]
    });

    await client.send('one');
    await client.send('two');
    assert.match(client.warnings.join(' '), /reworded the process/,
        'leading/trailing whitespace and case are ignored');
});

test('KNOWN LIMIT: INTERNAL whitespace is not collapsed, so a doubled space defeats the match', async () => {
    // The normalisation is `trim().toLowerCase()`, which does NOT collapse internal runs of
    // whitespace, so `"Open  the invoice"` (two spaces) does not match `"Open the invoice"`. A model
    // doubling a space inside a step name therefore produces a second process - the accepted
    // direction, but worth knowing precisely.
    const client = await loadClient({
        replies: [
            { status: 'complete', content: 'done', audit: { workflows: [{ id: 'proc-one', title: 'One', steps: [STEP('Open the invoice')] }] } },
            { status: 'complete', content: 'done', audit: { workflows: [{ id: 'proc-two', title: 'Two', steps: [STEP('Open  the invoice')] }] } }
        ]
    });

    await client.send('one');
    await client.send('two');
    assert.equal(/reworded the process/.test(client.warnings.join(' ')), false,
        'KNOWN LIMIT: a doubled space inside the name does not match, so nothing is merged');
    const ids = lastPostedWorkflows(client).map((w) => w.id);
    assert.ok(ids.includes('proc-two'), 'and the variant keeps its own id, appearing as a second process');
});

test('KNOWN LIMIT: a rewording that renames EVERY step still duplicates', async () => {
    // THE BOUNDARY THE RULE CANNOT COVER, characterised rather than pretended away. The rule is an
    // exact co-test, so a variant whose steps are all renamed shares nothing and is left as the
    // model sent it - it WILL appear as a second process. That is the accepted direction: a split
    // leaves a visible extra the console reports, while a merge discards answers.
    const client = await loadClient({
        replies: [
            { status: 'complete', content: 'done', audit: { workflows: [{ id: 'proc-one', title: 'One', steps: [STEP('Open the complaint')] }] } },
            { status: 'complete', content: 'done', audit: { workflows: [{ id: 'proc-two', title: 'Two', steps: [STEP('Begin reviewing the ticket')] }] } }
        ]
    });

    await client.send('one');
    await client.send('two');

    const ids = lastPostedWorkflows(client).map((w) => w.id);
    assert.ok(ids.includes('proc-two'), 'KNOWN LIMIT: the fully-renamed variant keeps its own id');
    assert.ok(ids.includes('proc-one'), 'and the original is carried forward beside it');
    assert.equal(/reworded the process/.test(client.warnings.join(' ')), false, 'nothing was merged');
});

// ===========================================================================
// 3b. THE CASES THAT MUST **NOT** MERGE - the direction that matters most
// ===========================================================================
//
// Fusing two genuinely different processes DISCARDS a participant's work, which is the harm the
// whole rule exists to avoid. Every case below must leave the entries as they arrived.

test('two DIFFERENT processes sharing no step name stay TWO', async () => {
    // The core harm. Neither shares a step with the other, and neither carries nothing, so neither
    // form of the claim applies - the rule must keep both.
    const client = await loadClient({
        replies: [{
            status: 'complete', content: 'x',
            audit: {
                workflows: [
                    { id: 'invoices', title: 'Invoices', steps: [STEP('Open the invoice'), STEP('Book it')] },
                    { id: 'phones', title: 'Phones', steps: [STEP('Answer the call'), STEP('Log the issue')] }
                ]
            }
        }]
    });
    await client.send('go');

    const saved = client.posts.at(-1).data.workflows;
    assert.equal(saved.length, 2, 'two different processes stay two');
    assert.deepEqual(saved.map((w) => w.id).sort(), ['invoices', 'phones']);
    assert.equal(/described ONE process twice/.test(client.warnings.join(' ')), false, 'and nothing is folded');
});

test('two processes each matching a DIFFERENT held process stay TWO', async () => {
    // Each entry resolves against its own held process, so a multi-held round is not collapsed
    // into whichever one matched first.
    const client = await loadClient({
        replies: [
            { status: 'complete', content: 'a', audit: { workflows: [
                { id: 'held-invoices', title: 'Invoices', steps: [STEP('Open the invoice')] },
                { id: 'held-phones', title: 'Phones', steps: [STEP('Answer the call')] }
            ] } },
            { status: 'complete', content: 'b', audit: { workflows: [
                { id: 'reworded-invoices', title: 'Invoices again', steps: [STEP('Open the invoice')] },
                { id: 'reworded-phones', title: 'Phones again', steps: [STEP('Answer the call')] }
            ] } }
        ]
    });
    await client.send('one');
    await client.send('two');

    const saved = client.posts.at(-1).data.workflows;
    const ids = saved.map((w) => w.id).sort();
    assert.ok(ids.includes('held-invoices'), 'the invoices entry resolved to its held id');
    assert.ok(ids.includes('held-phones'), 'and the phones entry to ITS held id');
    assert.equal(saved.length, 2, 'each matched a different held process, so the round still holds both');
});

test('a NEWLY NAMED process ALONE is kept - the case that killed the reverted filter', async () => {
    // The prompt tells the model that a newly named process "STARTS THE CONVERSATION AGAIN... as a
    // fresh matrix from its `task` and `trigger` onward", so it arrives EXACTLY like an empty entry:
    // task and trigger, no steps. Used as a DROP predicate it discards that process, so a LONE empty
    // entry must survive untouched.
    const client = await loadClient({
        replies: [
            { status: 'complete', content: 'a', audit: { workflows: [{ id: 'first', title: 'First', steps: [STEP('Open the invoice')] }] } },
            { status: 'complete', content: 'b', audit: { workflows: [{ id: 'newly-named', title: 'A different job', task: 'A different job', trigger: 'the phone rings' }] } }
        ]
    });
    await client.send('one');
    await client.send('two');

    const saved = client.posts.at(-1).data.workflows;
    assert.ok(saved.map((w) => w.id).includes('newly-named'),
        'the step-less newly-named process is KEPT, not discarded');
    assert.equal(/described ONE process twice/.test(client.warnings.join(' ')), false,
        'and it was not folded into the richer sibling');
});

// ===========================================================================
// 3c. THE REAL PAYLOADS, AGAINST THE CURRENT CONTRACT
// ===========================================================================
//
// `reconcileWorkflowIdentity` has ONE arm: an exactly equal step name, which the participant
// actually said twice. An entry carrying nothing is NOT folded into a richer sibling, because no
// discriminator separates a stale carry-forward beside its own process from a newly named process
// beside an unrelated one - they are the SAME SHAPE - so folding it would SILENTLY DISCARD A
// PROCESS THE PARTICIPANT HAD JUST NAMED.
//
// The two step-less artefacts (`fuelcard.json`, `onerow.json`) therefore stay as they arrive, and
// these tests assert it so that re-adding an absence-based arm turns them red on purpose.
//
// ASSERT THE OUTCOME, NOT THE LOG WORDING: a log line's phrasing is as brittle here as a
// source-text match.

/** Reads one of the host artefacts, a bare JSON array of workflows. Returns null when absent. */
function readArtefact(file) {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

const ARTEFACTS = {
    bills: { file: '/tmp/bills.json', inSize: 2, keptKeys: 19, keptSteps: 5 },
    fuelcard: { file: '/tmp/fuelcard.json', inSize: 2, keptKeys: 19, keptSteps: 7 },
    onerow: { file: '/tmp/onerow.json', inSize: 3, keptKeys: 8, keptSteps: 5 }
};

/** Whether ANY fold warning fired, whichever arm caused it. */
const foldedAnything = (warnings) => warnings.some((w) => /described ONE process twice|earlier wording forward with no steps/.test(w));

/** Drives one payload through the client and returns the workflows that were saved. */
async function savedWorkflows(workflows) {
    const client = await loadClient({ replies: [{ status: 'complete', content: 'x', audit: { workflows } }] });
    await client.send('go');
    return { saved: client.posts.at(-1).data.workflows, warnings: client.warnings };
}

/** Sorts by id, so an assertion does not depend on the order the fold happened to emit. */
const idsOf = (workflows) => workflows.map((w) => w.id).sort();

test('the REAL phone-bills reply folds to ONE entry on its three shared step names', async (t) => {
    const workflows = readArtefact(ARTEFACTS.bills.file);
    if (workflows === null) { t.skip(`${ARTEFACTS.bills.file} is not present on this host`); return; }

    // THE PAYLOAD: 2 entries, both 5 steps, 3 SHARED step names, one without `minutesPerInstance`.
    // This is the POSITIVE arm's case - the entries agree on steps the participant actually named.
    assert.equal(workflows.length, 2, 'the artefact holds two entries');
    assert.equal(workflows.filter((w) => w.minutesPerInstance === undefined).length, 1,
        'and one of them lacks minutesPerInstance - the richer/sparser pair');

    const { saved, warnings } = await savedWorkflows(workflows);

    assert.equal(saved.length, 1, 'the two entries fold to ONE');
    // BOTH THE ID AND THE CONTENT, because checking the id alone passes on a wrong result.
    assert.equal(saved[0].id, 'checking-the-company-mobile-phone-bills-against-the-handset',
        'and the RICHER entry\'s id is kept');
    assert.equal(saved[0].minutesPerInstance, 240, 'with its content, not the sparser entry');
    assert.equal(saved[0].steps.length, 5, 'and its five steps');
    assert.equal(foldedAnything(warnings), true, 'and a fold was announced, not silent');
});

test('the REAL fuel-card reply is LEFT ALONE - its stub carries no steps to co-test on', async (t) => {
    const workflows = readArtefact(ARTEFACTS.fuelcard.file);
    if (workflows === null) { t.skip(`${ARTEFACTS.fuelcard.file} is not present on this host`); return; }

    // THE COUNT IS THE ASSERTION. "Absence alone is not enough evidence" is a record of what was
    // measured, not a law: a future rule that finds better evidence while still KEEPING a
    // newly-named process will turn this red while being correct. The reasoning lives in the
    // by-absence note in `ai/audit.js`, with its four-versus-two word-overlap measurement.
    assert.equal(workflows.length, 2, 'the artefact holds two entries');
    assert.equal(workflows.filter((w) => !Array.isArray(w.steps) || w.steps.length === 0).length, 1,
        'and exactly one carries no steps');

    const { saved, warnings } = await savedWorkflows(workflows);

    assert.equal(saved.length, 2, 'the stub survives: absence alone does not fold it (see the note on the removed arm in ai/audit.js, and its four-versus-two word-overlap measurement)');
    assert.equal(saved.filter((w) => (w.steps || []).length === 7).length, 1, 'the rich entry is untouched');
    assert.equal(saved.filter((w) => (w.steps || []).length === 0).length, 1, 'and the stub survives');
    assert.equal(foldedAnything(warnings), false, 'and no fold is announced, because none was made');
});

test('the NEW artefact: TWO step-less stubs beside one rich entry are ALL KEPT', async (t) => {
    const workflows = readArtefact(ARTEFACTS.onerow.file);
    if (workflows === null) { t.skip(`${ARTEFACTS.onerow.file} is not present on this host`); return; }

    // The same shape as the fuel-card case with one more stub: what an absence-based arm would fold.
    assert.equal(workflows.length, 3, 'the artefact holds three entries');
    assert.equal(workflows.filter((w) => !Array.isArray(w.steps) || w.steps.length === 0).length, 2,
        'two of them carry no steps');

    const { saved, warnings } = await savedWorkflows(workflows);

    assert.equal(saved.length, 3, 'all three survive: nothing here folds on absence (see the note on the removed arm in ai/audit.js)');
    assert.equal(idsOf(saved).length, 3, 'three distinct entries');
    assert.equal(saved.filter((w) => (w.steps || []).length === 5).length, 1, 'the rich entry is among them');
    assert.equal(foldedAnything(warnings), false, 'and no fold is announced, because none was made');
});

test('EVERY PERMUTATION of each artefact gives the same result', async (t) => {
    // The model does not send entries in a fixed order, so the result must not depend on it.
    const permutations = (items) => {
        if (items.length <= 1) return [items];
        const out = [];
        items.forEach((item, i) => {
            permutations([...items.slice(0, i), ...items.slice(i + 1)]).forEach((rest) => out.push([item, ...rest]));
        });
        return out;
    };

    const expectedOut = { bills: 1, fuelcard: 2, onerow: 3 };
    for (const [name, spec] of Object.entries(ARTEFACTS)) {
        const workflows = readArtefact(spec.file);
        if (workflows === null) { t.skip(`${spec.file} is not present on this host`); continue; }

        for (const order of permutations(workflows)) {
            const { saved } = await savedWorkflows(order);
            const label = `${name} in order [${order.map((w) => String(w.id).slice(0, 10)).join('|')}]`;
            assert.equal(saved.length, expectedOut[name], `${label}: the same number of entries out`);
            if (expectedOut[name] === 1) {
                assert.equal(saved[0].steps.length, spec.keptSteps, `${label}: the same winner`);
                assert.equal(Object.keys(saved[0]).length, spec.keptKeys, `${label}: with the same content`);
            } else {
                assert.deepEqual(idsOf(saved), idsOf(workflows), `${label}: the same entries, order-independent`);
            }
        }
    }
});

test('the CHAIN case: a~b and b~c, in EVERY order - pass 2 is a SINGLE pass, not a fixed point', async () => {
    // `a` shares S with `b`, `c` shares T with `b`, and `a` and `c` share nothing - so the three are
    // one process and the order should not matter. The pass-2 COMMENT claims it is "repeated to a
    // fixed point"; the body is a single `for` loop, so it is not, and the orders that place the
    // bridge entry LAST leave two entries standing.
    //
    // ASSERTED AS MEASURED, so a real fixed point turns this red on purpose rather than passing.
    const a = { id: 'a', title: 'a', steps: [STEP('S')] };
    const b = { id: 'b', title: 'b', steps: [STEP('S'), STEP('T')] };
    const c = { id: 'c', title: 'c', steps: [STEP('T')] };
    const orders = [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]];
    const lateBridge = ['a,c,b', 'c,a,b'];

    for (const order of orders) {
        const { saved } = await savedWorkflows(order);
        const label = `order [${order.map((w) => w.id).join(',')}]`;
        const expected = lateBridge.includes(order.map((w) => w.id).join(',')) ? 2 : 1;
        assert.equal(saved.length, expected,
            `${label}: ${expected} entr${expected === 1 ? 'y' : 'ies'} out`);
        // The richest entry is `b`, the one carrying both steps, in every order.
        assert.equal(saved.find((w) => w.steps.length === 2).id, 'b', `${label}: the 2-step entry is kept`);
    }
});

test('FINDING: the chain is NOT collapsed in every order - pass 2 is not repeated to a fixed point', async () => {
    // MEASURED: the chain collapses only when the BRIDGE ENTRY COMES EARLY. With `a~b` (step S) and
    // `b~c` (step T), order [a, c, b] folds `b` into `a` and never re-compares `c`, so TWO remain.
    // ASSERTED AS TODAY'S BEHAVIOUR, so a real fixed point turns this red on purpose.
    const a = { id: 'a', title: 'a', steps: [STEP('S')] };
    const b = { id: 'b', title: 'b', steps: [STEP('S'), STEP('T')] };
    const c = { id: 'c', title: 'c', steps: [STEP('T')] };

    const earlyBridge = await savedWorkflows([a, b, c]);
    const lateBridge = await savedWorkflows([a, c, b]);

    assert.equal(earlyBridge.saved.length, 1, 'with the bridge early, the chain folds to one');
    assert.equal(lateBridge.saved.length, 2,
        'FINDING: with the bridge last it stays two - the pass is not repeated to a fixed point');
    assert.deepEqual(lateBridge.saved.map((w) => w.id).sort(), ['b', 'c'],
        'FINDING: the second entry survives because nothing re-compared it');
});

test('TWO EMPTY ENTRIES ALONE are BOTH KEPT', async () => {
    // Folding them would infer identity from PURE ABSENCE.
    const e1 = { id: 'e1', title: '1', task: 'a process the participant just named', trigger: 'the phone rings' };
    const e2 = { id: 'e2', title: '2', task: 'another name', trigger: 'a mail arrives' };

    const { saved, warnings } = await savedWorkflows([e1, e2]);
    assert.equal(saved.length, 2, 'two empty entries alone stay two');
    assert.deepEqual(saved.map((w) => w.id), ['e1', 'e2'], 'in the order they arrived');
    assert.equal(foldedAnything(warnings), false, 'and NOTHING was folded');
});

test('a NEWLY NAMED process beside a finished one is KEPT', async () => {
    // THE CASE AN ABSENCE-BASED ARM GETS WRONG: a participant
    // names a second process, the prompt starts "a fresh matrix from its `task` and `trigger`
    // onward" so it arrives step-less, and an absence-based fold would swallow it into the finished
    // sibling - the new process gone, silently and unrecoverably. It must be KEPT.
    const finished = { id: 'finished', title: 'Finished', steps: [STEP('Open the invoice')], frequencyPerWeek: 5 };
    const newlyNamed = { id: 'newly-named', title: 'Onboarding a new supplier', task: 'Onboarding a new supplier', trigger: 'a supplier is agreed' };

    const { saved } = await savedWorkflows([finished, newlyNamed]);
    assert.deepEqual(idsOf(saved), ['finished', 'newly-named'], 'both survive - the new process is NOT discarded');
});

// ===========================================================================
// 4. THE `exhausted` CARRY-FORWARD - the answer-saving order
// ===========================================================================

test('an EXHAUSTED turn CARRIES a previously-held process forward, saved AND scored', async () => {
    // An exhausted reply arrives as `status: 'asking'` with `exhausted: true`, so a payload chosen
    // on `isComplete` alone discards the carried-forward payload: a process the round already held
    // is dropped from what is saved and scored. The CARRY-FORWARD (`mergeForwardDroppedProcesses`)
    // must apply to BOTH paths, and the complete-turn control below keeps the pair honest.
    const STEP = (name) => ({ name, whatHappens: 'x', decidedHow: 'r', needsReasoning: false });

    const exhaustedTurn = await loadClient({
        replies: [
            { status: 'asking', content: 'q1', audit: { workflows: [{ id: 'proc-full', title: 'Full', steps: [STEP('Open the invoice')] }] } },
            { status: 'asking', content: 'stop', exhausted: true, audit: { workflows: [{ id: 'proc-stub', title: 'Stub', steps: [STEP('Answer the phone')] }] } }
        ]
    });
    await exhaustedTurn.send('a');
    await exhaustedTurn.send('b');

    const completeTurn = await loadClient({
        replies: [
            { status: 'asking', content: 'q1', audit: { workflows: [{ id: 'proc-full', title: 'Full', steps: [STEP('Open the invoice')] }] } },
            { status: 'complete', content: 'done', audit: { workflows: [{ id: 'proc-stub', title: 'Stub', steps: [STEP('Answer the phone')] }] } }
        ]
    });
    await completeTurn.send('a');
    await completeTurn.send('b');

    assert.deepEqual(exhaustedTurn.posts.at(-1).data.workflows.map((w) => w.id), ['proc-full', 'proc-stub'],
        'an EXHAUSTED turn carries the held process forward when it saves');

    assert.deepEqual(exhaustedTurn.scored.at(-1).audit.workflows.map((w) => w.id), ['proc-full', 'proc-stub'],
        'and the scored payload includes the held process');

    assert.deepEqual(completeTurn.posts.at(-1).data.workflows.map((w) => w.id), ['proc-full', 'proc-stub'],
        'a COMPLETE turn carries it forward too, so the two paths agree');
});

test('the exhausted turn IS saved as finalised, so the round ends', async () => {
    // `submitted_at` must be set for an exhausted round: staying open is the trap.
    const client = await loadClient({
        replies: [
            { status: 'asking', content: 'q', audit: { workflows: [{ id: 'proc-full', title: 'Full', steps: [STEP('Open the invoice')] }] } },
            { status: 'asking', content: 'stop', exhausted: true, audit: { workflows: [{ id: 'proc-full', title: 'Full', steps: [STEP('Open the invoice')] }] } }
        ]
    });

    await client.send('one');
    await client.send('two');

    assert.equal(client.posts.at(-1).complete, true, 'the exhausted turn finalises the round');
});

test('BOTH the exhausted and the complete branches score the carried-forward payload', async () => {
    // Both branches are driven here: a name claiming coverage the body does not have hides exactly
    // the defect this pair exists to catch.
    const STEP = (name) => ({ name, whatHappens: 'x', decidedHow: 'r', needsReasoning: false });

    /** Drives a round whose final turn drops the held process, and returns the client. */
    const roundEnding = async (finalReply) => {
        const client = await loadClient({
            replies: [
                { status: 'complete', content: 'a', audit: { workflows: [{ id: 'proc-full', title: 'Full', steps: [STEP('Open the invoice')], frequencyPerWeek: 5 }] } },
                finalReply
            ]
        });
        await client.send('one');
        await client.send('two');
        return client;
    };

    // THE EXHAUSTED BRANCH.
    const exhausted = await roundEnding({
        status: 'asking', content: 'stop', exhausted: true,
        audit: { workflows: [{ id: 'proc-new', title: 'New', steps: [STEP('Answer the phone')] }] }
    });
    assert.deepEqual(exhausted.scored.at(-1)?.audit?.workflows?.map((w) => w.id), ['proc-full', 'proc-new'],
        'the exhausted branch scores the carried-forward process beside the new one');

    // THE COMPLETE BRANCH.
    const complete = await roundEnding({
        status: 'complete', content: 'done',
        audit: { workflows: [{ id: 'proc-new', title: 'New', steps: [STEP('Answer the phone')] }] }
    });
    assert.deepEqual(complete.scored.at(-1)?.audit?.workflows?.map((w) => w.id), ['proc-full', 'proc-new'],
        'the complete branch scores the same set');

    for (const client of [exhausted, complete]) {
        assert.deepEqual(lastPostedWorkflows(client).map((w) => w.id), ['proc-full', 'proc-new'],
            'what was saved and what was scored carry the same processes');
    }
});

// ===========================================================================
// 4. THE END-TO-END SHAPE - one process, reworded three times
// ===========================================================================

test('three rewordings of ONE process end as ONE process', async () => {
    const client = await loadClient({
        replies: [
            { status: 'complete', content: 'a', audit: { workflows: [{ id: 'going-through-customer-complaints-that-came-in-overnight-and', title: 'A', steps: [STEP('Open the complaint')] }] } },
            { status: 'complete', content: 'b', audit: { workflows: [{ id: 'going-through-overnight-customer-complaints-and-deciding-whi', title: 'B', steps: [STEP('Open the complaint'), STEP('Check the order')] }] } },
            { status: 'complete', content: 'c', audit: { workflows: [{ id: 'triaging-overnight-customer-complaints-and-deciding-which-on', title: 'C', steps: [STEP('Open the complaint'), STEP('Check the order'), STEP('Book the fix')] }] } }
        ]
    });

    await client.send('one');
    await client.send('two');
    await client.send('three');

    // ONE process in the payload the server would store, under the round's original id.
    const saved = client.posts.at(-1).data.workflows;
    const uniqueIds = new Set(saved.map((w) => w.id));
    assert.equal(uniqueIds.size, 1, `the three rewordings are ONE process (got ${[...uniqueIds].join(', ')})`);

    const scoredIds = new Set(client.scored.at(-1)?.audit?.workflows?.map((w) => w.id) ?? []);
    assert.equal(scoredIds.size <= 1, true, 'the score is computed over the single process');
});
