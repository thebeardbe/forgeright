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

test('the rule requires EXACTLY ONE on each side - several held, several incoming, both declined', async () => {
    // With several held, position and step sharing are not evidence enough to say WHICH one is
    // being reworded, so the rule applies only when the round holds exactly one process.
    const twoHeld = await loadClient({
        replies: [
            { status: 'complete', content: 'a', audit: { workflows: [{ id: 'p1', title: '1', steps: [STEP('S')] }, { id: 'p2', title: '2', steps: [STEP('T')] }] } },
            { status: 'complete', content: 'b', audit: { workflows: [{ id: 'p3', title: '3', steps: [STEP('S')] }] } }
        ]
    });
    await twoHeld.send('one');
    await twoHeld.send('two');
    assert.equal(/reworded the process/.test(twoHeld.warnings.join(' ')), false, 'several held: declined');

    const twoIncoming = await loadClient({
        replies: [
            { status: 'complete', content: 'a', audit: { workflows: [{ id: 'p1', title: '1', steps: [STEP('S')] }] } },
            { status: 'complete', content: 'b', audit: { workflows: [{ id: 'p2', title: '2', steps: [STEP('S')] }, { id: 'p3', title: '3', steps: [STEP('T')] }] } }
        ]
    });
    await twoIncoming.send('one');
    await twoIncoming.send('two');
    assert.equal(/reworded the process/.test(twoIncoming.warnings.join(' ')), false, 'several incoming: declined');
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
// 3. THE `exhausted` CARRY-FORWARD - the answer-saving order
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
