/**
 * The duplicate-process fix: workflow identity, the identity rule, and the two client fixes.
 *
 * WHAT WAS WRONG. A complete interview against the real provider produced THREE workflows for ONE
 * process. The server derives a process `id` from its `task`, and THE MODEL REWORDS THE TASK
 * BETWEEN TURNS - so "Going through customer complaints that came in overnight...", then "Going
 * through overnight customer complaints...", then "Triaging overnight customer complaints..." each
 * looked like a NEW process. They accumulated, and the participant's visible total was computed
 * across all three: the owner saw 385 h/wk from one run and 25.5 h/wk from another, both artifacts
 * of how many times the model reworded itself.
 *
 * THE RULE IS AN EXACT STEP-NAME CO-TEST with no similarity threshold - that was measured and
 * deliberately rejected. This file tests it by driving the REAL client in a sandbox, so the
 * behaviour is what is asserted rather than a re-implementation of the rule.
 *
 * NO PRODUCTION CODE IS TOUCHED. `data/demo/` and the seed are unchanged: the committed demo
 * scores are 68, 58, 58, 58, 58, 38, 38 and every demo response holds ONE flat workflow with an
 * explicit id, which `withWorkflowIdentity` passes through untouched.
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
// they are exercised the way a participant produces them: by loading the real client and sending
// turns. The recorded `/api/response` POSTs are what the assertions read, which is the payload the
// server would actually store.

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
    // THE STABILITY PROPERTY, and the reason the defect existed: an id that changes between turns
    // makes one process look like several. Two separate calls, as two turns would be.
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
    // MAX_TITLE_LENGTH is 80 and the ellipsis is appended after the clip, so 82 is the ceiling
    // rather than 80 - asserted against the real bound rather than an assumed one.
    assert.ok(title.length <= 82, `the title is shortened (got ${title.length})`);
    assert.match(title, /\.\.\.$/, 'and says it was shortened rather than stopping mid-word');
    assert.equal(title.endsWith(' ...'), false, 'the ellipsis is not preceded by a stray space');
});

// ===========================================================================
// 2. reconcileWorkflowIdentity - THE RULE AND ITS GUARDS
// ===========================================================================

test('a REWORDED task with a SHARED STEP reattaches the round\'s id - the defect itself', async () => {
    // The real case: the model rewords the task, the server derives a new id, and the step the
    // participant described is the same. Without this the two accumulate.
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
    // THE HARMFUL DIRECTION. A model starting a genuinely new process, with its own steps, must
    // keep its own id - merging it would DISCARD a participant's answers.
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

test('a reply with NO steps is DECLINED, not merged - the case the first attempt got wrong', async () => {
    // THE FIX'S OWN FIRST ATTEMPT WAS WRONG HERE: it replaced the id, which destroyed a genuinely
    // new process (caught by test/interview-fixes.test.js). A reply carrying no steps is not
    // evidence of anything, so it is left exactly as the model sent it.
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
    // REWRITTEN. It encoded the contract that was replaced - "exactly one on each side" - on the
    // reasoning that "step sharing is not evidence enough to say WHICH one is being reworded". An
    // EXACT STEP-NAME MATCH is exactly that evidence, so the guards were the defect: a real reply
    // carries TWO entries, both guards blocked, and the rule was DEAD CODE on every interview.
    //
    // THE TWO CASES BELOW ARE THE BUILDER'S, and both now give the correct answer: a multi-held
    // reply resolves against whichever held process it shares a step with, and a multi-entry reply
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
    // TWO entries, not one: p2 resolved to p1 and p3 kept its own id.
    assert.equal(afterIncoming.length, 2, 'two processes in the reply stay two');
    assert.deepEqual(afterIncoming.map((w) => w.id).sort(), ['p1', 'p3'], 'p2 became p1; p3 is untouched');
});

test('A TWO-ENTRY REPLY IS RESOLVED - the shape a real reply has, which no test covered', async () => {
    // THE TEST THAT WOULD HAVE FAILED AGAINST THE OLD GUARD, and the reason this survived four
    // review rounds: every test in this file drove ONE-entry replies, and both old guards required
    // exactly one. A real reply carries two - the stale carry-forward beside the current wording -
    // so the rule returned untouched every turn and the duplicate was never seen.
    //
    // ASSERTED ON A PAYLOAD OF THE SHAPE THE HARNESS ACTUALLY PRODUCES: two entries, no step
    // shared with `held` (a first turn), sharing a step WITH EACH OTHER. Resolving against `held`
    // alone cannot see this, because neither entry is held.
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
    // The winner is chosen by `measurableCount`, so which entry comes first must not change which
    // one survives - otherwise the reply's own ordering would decide a participant's record.
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
    // A CHARACTERISED LIMIT rather than a claim: the normalisation is `trim().toLowerCase()`, which
    // does NOT collapse internal runs of whitespace, so `"Open  the invoice"` (two spaces) does not
    // match `"Open the invoice"` (one). A model that doubles a space inside a step name therefore
    // produces a second process - the accepted direction (a split is visible; a merge discards
    // answers), but worth knowing precisely rather than assuming the comparison is looser than it is.
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
    // Each entry resolves against its own held process, so a multi-held round must not be collapsed
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
    // THE CASE THAT MATTERS MOST FOR `carriesNothing`. The prompt tells the model that a newly named
    // process "STARTS THE CONVERSATION AGAIN... as a fresh matrix from its `task` and `trigger`
    // onward", so it arrives EXACTLY like an empty entry: task and trigger, no steps. Used as a
    // DROP predicate it discarded that process and could hand `/api/score` an empty array - which
    // is why that attempt was reverted. It is only safe BESIDE a richer sibling, so a LONE empty
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
// 3c. THE REAL PAYLOADS - read from disk, not hand-built
// ===========================================================================
//
// THIS CHAIN HAS PRODUCED FIVE DEFECTS AND FOUR WERE FOUND BY FIXTURES THAT DID NOT MATCH THE
// ARTEFACT. So the two payloads that exposed this one are read from the host rather than re-created
// from a description. They live OUTSIDE the repo, so the tests skip with a clear message when they
// are absent rather than failing on a machine that does not have them.

/** Reads the phone-bills reply, a bare JSON array of workflows. Returns null when absent. */
function readBills() {
    try {
        return JSON.parse(fs.readFileSync('/tmp/bills.json', 'utf8'));
    } catch {
        return null;
    }
}

/**
 * Reads the fuel-card round, a bare JSON array of workflows. Returns null when absent.
 *
 * PINNED AS A FILE RATHER THAN READ FROM THE DATABASE, and that is a correction. The first
 * version opened a COPY of the round's store, which was right about not writing beside the
 * original and wrong about stability: the store is live while a container holds it, and a
 * read taken during a checkpoint saw a re-seeded state, so the case skipped on a host that
 * still had the payload. A response payload does not change once the round is closed, so
 * extracting it is the stable form - and it is the same form `readBills` already uses.
 *
 * @returns {Array<object>|null}
 */
function readFuelCard() {
    try {
        return JSON.parse(fs.readFileSync('/tmp/fuelcard.json', 'utf8'));
    } catch {
        return null;
    }
}

test('the REAL phone-bills reply folds to ONE entry, keeping the richer one and its content', async (t) => {
    const workflows = readBills();
    if (workflows === null) { t.skip('/tmp/bills.json is not present on this host'); return; }

    // THE PAYLOAD: 2 entries, both 5 steps, 3 shared step names, one without `minutesPerInstance`.
    assert.equal(workflows.length, 2, 'the artefact holds two entries');
    assert.equal(workflows.filter((w) => w.minutesPerInstance === undefined).length, 1,
        'and one of them lacks minutesPerInstance - the richer/sparser pair');

    const client = await loadClient({ replies: [{ status: 'complete', content: 'x', audit: { workflows } }] });
    await client.send('go');

    const saved = client.posts.at(-1).data.workflows;
    assert.equal(saved.length, 1, 'the two entries fold to ONE');
    // BOTH THE ID AND THE CONTENT, because checking the id alone passes on a wrong result.
    assert.equal(saved[0].id, 'checking-the-company-mobile-phone-bills-against-the-handset',
        'and the RICHER entry\'s id is kept');
    assert.equal(saved[0].minutesPerInstance, 240, 'with its content, not a step-less stub');
    assert.equal(saved[0].steps.length, 5, 'and its five steps');
    assert.match(client.warnings.join(' '), /described ONE process twice/, 'and the fold is announced');
});

test('the REAL fuel-card round folds a step-less entry into the 7-step one', async (t) => {
    const workflows = readFuelCard();
    if (workflows === null) { t.skip('/tmp/fuelcard.json is not present on this host'); return; }

    // THE PAYLOAD: a 4-key step-less entry beside a 19-key 7-step one - the BY-ABSENCE case.
    assert.equal(workflows.length, 2, 'the artefact holds two entries');
    assert.equal(workflows.filter((w) => !Array.isArray(w.steps) || w.steps.length === 0).length, 1,
        'and exactly one carries no steps');

    const client = await loadClient({ replies: [{ status: 'complete', content: 'x', audit: { workflows } }] });
    await client.send('go');

    const saved = client.posts.at(-1).data.workflows;
    assert.equal(saved.length, 1, 'the step-less entry is folded away');
    assert.equal(saved[0].steps.length, 7, 'keeping the entry WITH the steps');
    assert.equal(Object.keys(saved[0]).length, 19, 'and its full set of fields, not the 4-key stub');
    assert.match(client.warnings.join(' '), /described ONE process twice/, 'and it is announced, not silent');
});

test('the by-absence fold, on the SHAPE the fuel-card round had: a step-less entry beside a rich one', async () => {
    // THE SAME CASE AS THE ARTEFACT, built here because the host file is mutable (see above). A
    // step-less 4-key entry beside a 19-key 7-step one, which is what the fuel-card round held.
    const stepLess = { id: 'stale-wording', title: 'Stale', task: 'Reconciling fuel-card statements', trigger: 'the statements arrive' };
    const rich = {
        id: 'fuel-card-full', title: 'Reconciling fuel-card statements', task: 'Reconciling fuel-card statements', trigger: 'the statements arrive',
        steps: Array.from({ length: 7 }, (_, i) => STEP(`Fuel step ${i}`)), frequencyPerWeek: 5, timePerPeriod: { hours: 2, period: 'week' },
        minutesPerInstance: 20, peopleAffected: 2, handoffTo: ['Finance']
    };

    const client = await loadClient({ replies: [{ status: 'complete', content: 'x', audit: { workflows: [stepLess, rich] } }] });
    await client.send('go');

    const saved = client.posts.at(-1).data.workflows;
    assert.equal(saved.length, 1, 'the step-less entry folds into the rich one');
    assert.equal(saved[0].steps.length, 7, 'the entry WITH the steps is kept');
    assert.equal(saved[0].minutesPerInstance, 20, 'and its content, not the step-less stub');
    assert.match(client.warnings.join(' '), /described ONE process twice/, 'and the fold is announced');
});

// ===========================================================================
// 4. THE `exhausted` CARRY-FORWARD - the answer-saving order
// ===========================================================================

test('an EXHAUSTED turn CARRIES a previously-held process forward, saved AND scored', async () => {
    // THE REPAIR OF A FINDING I REPORTED, and the name now says the requirement rather than the bug.
    //
    // WHAT WAS WRONG. `toSave = isComplete ? narrowed.payload : reconciled` - the CARRY-FORWARD
    // (`narrowed`, which is `mergeForwardDroppedProcesses`) was applied only when `isComplete` was
    // true. An exhausted reply arrives as `status: 'asking'` (the evidence cap in `ai/audit-core.js`
    // returns `status: 'asking', exhausted: true`), so `isComplete` was FALSE on an exhausted turn
    // and the carried-forward payload was DISCARDED: a process the round already held was dropped
    // from what was saved and scored, with no warning, because `mergeForwardDroppedProcesses`'s
    // drop was never applied.
    //
    // IT IS NOW `const toSave = narrowed.payload;` with NO GATE - a turn that saves is a turn whose
    // drop is recorded, and the three callers below decide the round's fate. Gating on `isComplete`
    // conflated "do not lose the answers" with "the round is over", which are different questions.
    //
    // THE COMPLETE-TURN CONTROL IS KEPT: both paths must now behave the same way, so the pair still
    // fails if either stops carrying forward.
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

    // THE HELD PROCESS IS CARRIED FORWARD ON AN EXHAUSTED TURN, so it is not lost when the round
    // ends because the questions ran out rather than because the model said it was done.
    assert.deepEqual(exhaustedTurn.posts.at(-1).data.workflows.map((w) => w.id), ['proc-full', 'proc-stub'],
        'an EXHAUSTED turn carries the held process forward when it saves');

    // AND IT IS SCORED THAT WAY TOO, so the participant's visible total includes the held process
    // rather than a total built from the stub alone.
    assert.deepEqual(exhaustedTurn.scored.at(-1).audit.workflows.map((w) => w.id), ['proc-full', 'proc-stub'],
        'and the scored payload includes the held process');

    // THE CONTROL: a complete turn behaves the same way, so the two paths agree.
    assert.deepEqual(completeTurn.posts.at(-1).data.workflows.map((w) => w.id), ['proc-full', 'proc-stub'],
        'a COMPLETE turn carries it forward too, so the two paths agree');
});

test('the exhausted turn IS saved as finalised, so the round ends', async () => {
    // The companion fact: `submitted_at` must be set for an exhausted round, since staying open is
    // the trap. Asserted separately, because it is a different property from the carry-forward.
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
    // THE SCORING SITE. Scoring the raw reply showed a total built from a stub while the full
    // process sat carried-forward beside it in the same round, so what is scored must be the
    // carried-forward payload rather than the reply.
    //
    // ITS NAME SAID "BOTH" WHILE IT ONLY EXERCISED THE COMPLETE BRANCH, which is exactly how the
    // exhausted branch's own defect survived: a test whose name claims coverage it does not have
    // is worse than no test, because it stops anybody looking. Both branches are driven here.
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

    // THE EXHAUSTED BRANCH, which is the one that was broken.
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

    // AND THE SAVED PAYLOAD MATCHES THE SCORED ONE, so the visible total cannot disagree with what
    // was stored - which is the defect this pair of assertions exists to prevent.
    for (const client of [exhausted, complete]) {
        assert.deepEqual(lastPostedWorkflows(client).map((w) => w.id), ['proc-full', 'proc-new'],
            'what was saved and what was scored carry the same processes');
    }
});

// ===========================================================================
// 4. THE END-TO-END SHAPE OF THE DEFECT - one process, reworded three times
// ===========================================================================

test('the reviewer\'s real case: three rewordings of ONE process end as ONE process', async () => {
    // The payload the real provider produced, reproduced: the task reworded between turns with the
    // participant's steps shared across them. Without the fix this is three workflows and a total
    // computed across all of them (the 385 h/wk versus 25.5 h/wk the owner saw).
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

    // And the visible total is computed from that one process, not three.
    const scoredIds = new Set(client.scored.at(-1)?.audit?.workflows?.map((w) => w.id) ?? []);
    assert.equal(scoredIds.size <= 1, true, 'the score is computed over the single process');
});
