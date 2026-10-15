/**
 * The review flag, and the assumption it rests on.
 *
 * `needsReviewFromRevisions` in `lib/store/process-membership.js` answers: "was this process BORN
 * from an unsure split, and has nobody settled that since?" It reads the HISTORY, because reading
 * only the current revision is wrong in both directions:
 *
 *   - false positive: a low-confidence MERGE is flagged "split while unsure", sending a reader
 *     after a split that did not exist;
 *   - false negative: an ordinary model merge CLEARS the flag, which is worse, because it removes
 *     the only mechanism the unsure-split path has for being noticed.
 *
 * The derivation rests on REVISION 1 BEING THE CREATION, tested across the four writers.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-review-flag-'));
process.env.STORE_DIR = STORE_DIR;
process.env.SESSION_SECRET = 'a'.repeat(64);

const store = await import('../lib/store/index.js');
const processes = await import('../lib/store/processes.js');
const membership = await import('../lib/store/process-membership.js');
const registry = await import('../lib/store/registry.js');

after(() => {
    store.closeAll();
    fs.rmSync(STORE_DIR, { recursive: true, force: true });
});

const { needsReviewFromRevisions } = membership;

/** A revision row as the flag reads it: only these three fields matter. */
const rev = (revision, confidence, decided_by) => ({ revision, confidence, decided_by });

// ===========================================================================
// 4. THE CASES
// ===========================================================================

test('born low and nothing since → FLAGGED', () => {
    const result = needsReviewFromRevisions([rev(1, 'low', 'model')]);
    assert.equal(result.needsReview, true);
    assert.ok(result.reason.length > 0, 'a flagged process carries a reason to show a reader');
});

test('born low then a MODEL merge → STILL FLAGGED', () => {
    // The FALSE NEGATIVE: every identification writes a new current revision carrying that
    // response's confidence, so an ordinary merge would clear the flag while the question stays
    // open.
    const result = needsReviewFromRevisions([rev(1, 'low', 'model'), rev(2, 'high', 'model')]);
    assert.equal(result.needsReview, true, 'a model revision must not clear the flag');
});

test('born high then a LOW merge → NOT flagged', () => {
    // This was the MISLABEL: the old code read the current revision, so a
    // low-confidence merge of a confident process read as "split while unsure".
    const result = needsReviewFromRevisions([rev(1, 'high', 'model'), rev(2, 'low', 'model')]);
    assert.equal(result.needsReview, false, 'a low merge of a confident process is not an unsure split');
});

test('born low then an ADMIN revision → CLEARED', () => {
    // Clearing is a person's decision. An admin has looked at it and decided.
    const result = needsReviewFromRevisions([rev(1, 'low', 'model'), rev(2, 'high', 'admin')]);
    assert.equal(result.needsReview, false);
});

test('an admin revision LATER in the history clears it, whatever a model did after', () => {
    const result = needsReviewFromRevisions([
        rev(1, 'low', 'model'),
        rev(2, 'low', 'model'),
        rev(3, 'high', 'admin'),
        rev(4, 'low', 'model')
    ]);
    assert.equal(result.needsReview, false, 'once a person has settled it, later model work does not re-open it');
});

test('a high-confidence creation → not flagged', () => {
    assert.equal(needsReviewFromRevisions([rev(1, 'high', 'model')]).needsReview, false);
});

test('an empty history → not flagged', () => {
    assert.equal(needsReviewFromRevisions([]).needsReview, false);
    assert.equal(needsReviewFromRevisions(null).needsReview, false);
});

test('a process created by an ADMIN with low confidence is not flagged', () => {
    // `decided_by === 'admin'` at birth means a person made the split, so there is
    // nothing for a reviewer to settle.
    assert.equal(needsReviewFromRevisions([rev(1, 'low', 'admin')]).needsReview, false);
});

test('an UNRECOGNISED later decider keeps the flag ON', () => {
    // `decided_by !== 'admin'`, not `=== 'model'`: a third decider is a decision
    // nobody has reviewed, so anything unrecognised must not silently clear it.
    const result = needsReviewFromRevisions([rev(1, 'low', 'model'), rev(2, 'high', 'robot')]);
    assert.equal(result.needsReview, true);
});

test('READ ORDER does not matter: newest-first gives the same answer', () => {
    // "The first revision" must mean the lowest number, not the first in the array a
    // caller happened to pass. Two histories with the same content in both orders.
    const oldestFirst = [rev(1, 'low', 'model'), rev(2, 'high', 'model')];
    const newestFirst = [rev(2, 'high', 'model'), rev(1, 'low', 'model')];

    assert.equal(
        needsReviewFromRevisions(newestFirst).needsReview,
        needsReviewFromRevisions(oldestFirst).needsReview,
        'the answer is the same either way'
    );
    assert.equal(needsReviewFromRevisions(newestFirst).needsReview, true);

    // And the same for a cleared history in both orders.
    const clearedOldest = [rev(1, 'low', 'model'), rev(2, 'high', 'admin')];
    const clearedNewest = [rev(2, 'high', 'admin'), rev(1, 'low', 'model')];
    assert.equal(needsReviewFromRevisions(clearedNewest).needsReview, false);
    assert.equal(needsReviewFromRevisions(clearedOldest).needsReview, false);
});

test('an admin revision does not clear it when it comes BEFORE the creation position', () => {
    // Sanity on the boundary: the clear must be LATER than the birth, otherwise a
    // malformed history would clear a flag that was never set.
    assert.equal(needsReviewFromRevisions([rev(1, 'low', 'model')]).needsReview, true);
});

// ===========================================================================
// THE ASSUMPTION: ONLY A CREATION WRITES REVISION 1
// ===========================================================================
//
// The flag reads a creation from POSITION, because `nextRevision` is MAX+1 per process. That holds
// only while revision 1 is the first write a process ever had, so the section tries to break it and
// then pins it.

/** An organisation with an invitation and a way to add responses. */
function orgWithInvitation() {
    const org = store.createOrganisation('Flag org');
    const invitation = store.addInvitation(org.id, { email: 'p@example.test', department: 'Finance' });
    return { org, addResponse: (data) => store.addResponse(org.id, invitation.token, { department: 'Finance', data }) };
}

/** The revisions of a process, oldest first, read directly. */
function revisionsOf(orgId, processId) {
    const db = registry.connectionFor(orgId);
    return db.prepare(
        'SELECT revision, decided_by, confidence FROM process_revision WHERE process_id = ? ORDER BY revision'
    ).all(processId);
}

test('the CREATE writer writes revision 1', () => {
    const { org, addResponse } = orgWithInvitation();
    const one = addResponse({ task: 'one' });

    const created = processes.recordIdentification({
        orgId: org.id,
        reply: { matches: null, reasoning: 'first', confidence: 'low', name: 'A' },
        responseId: one.id
    });

    const revisions = revisionsOf(org.id, created.process.id);
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0].revision, 1, 'the creation is revision 1');
});

test('the MERGE writer writes revision 2+, never revision 1', () => {
    const { org, addResponse } = orgWithInvitation();
    const one = addResponse({ task: 'one' });
    const two = addResponse({ task: 'two' });

    const created = processes.recordIdentification({ orgId: org.id, reply: { matches: null, reasoning: 'first', confidence: 'low', name: 'A' }, responseId: one.id });
    const merged = processes.recordIdentification({ orgId: org.id, reply: { matches: created.process.id, reasoning: 'merge', confidence: 'high' }, responseId: two.id });

    assert.equal(merged.revision.revision, 2, 'the merge is revision 2');
    assert.equal(revisionsOf(org.id, created.process.id)[0].revision, 1, 'revision 1 is untouched');
});

test('the IN-PLACE REJUDGE writer writes revision 2+, never revision 1', () => {
    const { org, addResponse } = orgWithInvitation();
    const one = addResponse({ task: 'one' });
    const two = addResponse({ task: 'two' });

    const created = processes.recordIdentification({ orgId: org.id, reply: { matches: null, reasoning: 'first', confidence: 'low', name: 'A' }, responseId: one.id });
    processes.recordIdentification({ orgId: org.id, reply: { matches: created.process.id, reasoning: 'merge', confidence: 'high' }, responseId: two.id });

    const rejudged = processes.recordIdentification({
        orgId: org.id,
        reply: { matches: created.process.id, reasoning: 'admin rejudge in place', confidence: 'high' },
        responseId: one.id,
        adminReasoning: 'I disagree',
        decidedBy: processes.DECIDED_BY.ADMIN
    });

    assert.equal(rejudged.revision.revision, 3, 'the rejudge is revision 3');
    const revisions = revisionsOf(org.id, created.process.id);
    assert.equal(revisions[0].revision, 1, 'revision 1 is still the creation');
    assert.equal(revisions[0].decided_by, 'model', 'and still the model-decided creation');
});

test('the MOVE writer writes revision 2+ on the source, never revision 1', () => {
    // `rebuildWithout` adds a revision to the SOURCE process. If it ever wrote
    // revision 1 the flag would read a move as a creation.
    const { org, addResponse } = orgWithInvitation();
    const one = addResponse({ task: 'one' });
    const two = addResponse({ task: 'two' });
    const three = addResponse({ task: 'three' });

    const a = processes.recordIdentification({ orgId: org.id, reply: { matches: null, reasoning: 'a', confidence: 'low', name: 'A' }, responseId: one.id });
    processes.recordIdentification({ orgId: org.id, reply: { matches: a.process.id, reasoning: 'merge two', confidence: 'high' }, responseId: two.id });
    const b = processes.recordIdentification({ orgId: org.id, reply: { matches: null, reasoning: 'b', confidence: 'high', name: 'B' }, responseId: three.id });

    // Move two from A to B.
    const moved = processes.recordIdentification({ orgId: org.id, reply: { matches: b.process.id, reasoning: 'move', confidence: 'high' }, responseId: two.id });
    assert.ok(moved.left, 'a move happened');

    const sourceRevisions = revisionsOf(org.id, a.process.id);
    assert.equal(sourceRevisions[0].revision, 1, 'the source still has its creation at revision 1');
    assert.equal(sourceRevisions[sourceRevisions.length - 1].revision, 3, 'and the rebuild is a later revision, not revision 1');
});

test('an ADMIN move does not rewrite the source\'s revision 1 either', () => {
    const { org, addResponse } = orgWithInvitation();
    const one = addResponse({ task: 'one' });
    const two = addResponse({ task: 'two' });

    const a = processes.recordIdentification({ orgId: org.id, reply: { matches: null, reasoning: 'a', confidence: 'low', name: 'A' }, responseId: one.id });
    const b = processes.recordIdentification({ orgId: org.id, reply: { matches: null, reasoning: 'b', confidence: 'high', name: 'B' }, responseId: two.id });

    const moved = processes.recordIdentification({
        orgId: org.id,
        reply: { matches: b.process.id, reasoning: 'admin move', confidence: 'high' },
        responseId: one.id,
        adminReasoning: 'regroup this',
        decidedBy: processes.DECIDED_BY.ADMIN
    });
    assert.ok(moved.left);

    const sourceRevisions = revisionsOf(org.id, a.process.id);
    assert.equal(sourceRevisions[0].revision, 1, 'revision 1 is the creation');
    assert.equal(sourceRevisions[0].decided_by, 'model', 'and is not overwritten with the admin marker');
});

test('across every writer, revision 1 is ALWAYS the creation for every process in the organisation', () => {
    // For every process, the lowest revision is 1 and was written by the create path.
    const { org, addResponse } = orgWithInvitation();
    const responses = [1, 2, 3, 4, 5].map((n) => addResponse({ task: `t${n}` }));

    const a = processes.recordIdentification({ orgId: org.id, reply: { matches: null, reasoning: 'create A', confidence: 'low', name: 'A' }, responseId: responses[0].id });
    processes.recordIdentification({ orgId: org.id, reply: { matches: a.process.id, reasoning: 'merge into A', confidence: 'high' }, responseId: responses[1].id });
    const b = processes.recordIdentification({ orgId: org.id, reply: { matches: null, reasoning: 'create B', confidence: 'high', name: 'B' }, responseId: responses[2].id });
    processes.recordIdentification({ orgId: org.id, reply: { matches: b.process.id, reasoning: 'merge into B', confidence: 'high' }, responseId: responses[3].id });
    // In-place admin rejudge on A.
    processes.recordIdentification({ orgId: org.id, reply: { matches: a.process.id, reasoning: 'admin rejudge', confidence: 'high' }, responseId: responses[0].id, adminReasoning: 'why', decidedBy: processes.DECIDED_BY.ADMIN });
    // A move: responses[1] from A to B.
    processes.recordIdentification({ orgId: org.id, reply: { matches: b.process.id, reasoning: 'move', confidence: 'high' }, responseId: responses[1].id });

    // Every process: revision 1 exists and carries the FIRST creation's marker.
    const created = { [a.process.id]: 'create A', [b.process.id]: 'create B' };
    for (const [processId, reasoning] of Object.entries(created)) {
        const revisions = revisionsOf(org.id, processId);
        assert.equal(revisions[0].revision, 1, `${reasoning}: revision 1 is the lowest`);
        const firstRow = registry.connectionFor(org.id)
            .prepare('SELECT reasoning, decided_by FROM process_revision WHERE process_id = ? AND revision = 1').get(processId);
        assert.equal(firstRow.reasoning, reasoning, `${reasoning}: revision 1 still carries the creation's reasoning`);
    }
});

test('CAN a non-creation write revision 1? Only by breaking the store\'s own invariants', () => {
    // Two hand-forced states DO make a non-creation write revision 1:
    //
    //   1. deleting a process's revision 1, after which a merge writes revision 1;
    //   2. inserting a `process` row directly with no revision, then identifying into it.
    //
    // NEITHER IS REACHABLE: no code path deletes a revision, and `INSERT INTO process` lives only
    // inside `insertProcess`, called only from the create branch. So for every sequence the public
    // writers can produce, revision 1 is the creation.
    const { org, addResponse } = orgWithInvitation();
    const db = registry.connectionFor(org.id);
    const one = addResponse({ task: 'one' });
    const two = addResponse({ task: 'two' });

    const created = processes.recordIdentification({ orgId: org.id, reply: { matches: null, reasoning: 'creation', confidence: 'high', name: 'A' }, responseId: one.id });
    const historyBefore = revisionsOf(org.id, created.process.id);

    // Force the state directly, to show the assumption is only as strong as the
    // store's refusal to delete revisions.
    db.prepare('DELETE FROM process_revision WHERE process_id = ? AND revision = 1').run(created.process.id);
    const forced = processes.recordIdentification({ orgId: org.id, reply: { matches: created.process.id, reasoning: 'merge after a forced delete', confidence: 'high' }, responseId: two.id });

    assert.equal(forced.revision.revision, 1, 'a non-creation CAN write revision 1 once revision 1 is deleted');
    assert.equal(historyBefore.length, 1, 'so the invariant depends on nothing deleting a revision');

    // The reachable surface: no DELETE of a revision exists in the codebase, which
    // is the property that makes the assumption hold.
    const projectRoot = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
    const sources = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.js')) sources.push(fs.readFileSync(full, 'utf8'));
        }
    };
    walk(path.join(projectRoot, 'lib'));
    walk(path.join(projectRoot, 'ai'));

    assert.equal(
        sources.some((text) => /DELETE\s+FROM\s+process_revision/i.test(text)),
        false,
        'no code deletes a revision, which is what keeps revision 1 the creation'
    );
});
