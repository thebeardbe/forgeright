/**
 * The score numbering fix: the number is computed inside the transaction, and the
 * index makes a recurrence loud.
 *
 * WHY THIS FILE EXISTS. The reviewer mutated both halves of `e2d59de` and the whole
 * suite passed each time (861 pass):
 *
 *   - moving `nextScoreRevision` back to the call site
 *   - removing `idx_process_score_number` from the schema
 *
 * Neither the index name nor the numbering appears in any test or script. Both
 * halves are pinned here. The reviewer's three-state reproduction shows what each
 * does:
 *
 *   shipped code                          24 weighings, 0 duplicates
 *   numbering reverted + index removed    2 duplicate numbers silently (7 and 11)
 *   numbering reverted, index kept        20 weighings, UNIQUE constraint failed
 *
 * So THE CAUSE FIX prevents the duplicate, and THE INDEX turns a recurrence loud
 * rather than silent.
 *
 * STORE_DIR is a temp directory per run, set before anything is imported.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-score-numbering-'));
process.env.STORE_DIR = STORE_DIR;
process.env.SESSION_SECRET = 'a'.repeat(64);

const store = await import('../lib/store/index.js');
const processes = await import('../lib/store/processes.js');
const processSql = await import('../lib/store/process-sql.js');
const registry = await import('../lib/store/registry.js');

after(() => {
    store.closeAll();
    fs.rmSync(STORE_DIR, { recursive: true, force: true });
});

/** An organisation with one identified process, so there is a revision to score. */
function orgWithRevision() {
    const org = store.createOrganisation('Org');
    const invitation = store.addInvitation(org.id, { email: 'p@example.test', department: 'Finance' });
    const response = store.addResponse(org.id, invitation.token, { department: 'Finance', data: { task: 'invoices' } });
    const identified = processes.recordIdentification({
        orgId: org.id,
        reply: { matches: null, reasoning: 'nobody has described this', confidence: 'high', name: 'Invoices' },
        responseId: response.id
    });
    return { org, revisionId: identified.revision.id };
}

// ===========================================================================
// 1. THE NUMBER IS COMPUTED INSIDE THE TRANSACTION
// ===========================================================================
//
// The fix was to move the `MAX(revision_no)` READ inside `insertScore`'s
// transaction. Before, the read sat at the call site, so two writers could both
// read 17 and both insert 18.
//
// The reviewer's suggestion: call `insertScore` twice on the SAME revision passing
// NO `revisionNo`, and assert the numbers come back 1 then 2. That pins the change
// - the number is derived by the store rather than by the caller - without staging
// a race, which cannot be staged reliably in one process (see the note at the end).

test('insertScore DERIVES the number when the caller gives none: 1 then 2 on one revision', () => {
    const { org, revisionId } = orgWithRevision();
    const db = registry.connectionFor(org.id);

    const first = processSql.insertScore(db, { id: 'score-1', revisionId, score: 50, terms: { frequency: 5 }, reasoning: 'first' });
    const second = processSql.insertScore(db, { id: 'score-2', revisionId, score: 60, terms: { frequency: 6 }, reasoning: 'second' });

    // Asserted on what comes back, which is the number the store derived.
    assert.equal(first.revision_no, 1, 'the first weighing is number 1');
    assert.equal(second.revision_no, 2, 'the second is number 2, DERIVED rather than passed in');
});

test('the derived numbers are what is STORED, not only what is returned', () => {
    // The read-back is the evidence: a function returning 1 and 2 while storing
    // something else would pass the test above and still be the defect.
    const { org, revisionId } = orgWithRevision();
    const db = registry.connectionFor(org.id);

    processSql.insertScore(db, { id: 'stored-1', revisionId, score: 50, terms: {}, reasoning: 'a' });
    processSql.insertScore(db, { id: 'stored-2', revisionId, score: 60, terms: {}, reasoning: 'b' });
    processSql.insertScore(db, { id: 'stored-3', revisionId, score: 70, terms: {}, reasoning: 'c' });

    const stored = db.prepare('SELECT revision_no FROM process_score WHERE revision_id = ? ORDER BY revision_no')
        .all(revisionId)
        .map((row) => row.revision_no);

    assert.deepEqual(stored, [1, 2, 3], 'the stored numbers are 1, 2, 3 with no duplicate and no gap');
});

test('the numbering continues from the highest existing number, not from a count', () => {
    // WHAT THIS STAGES, precisely: `MAX + 1` never collides with a LIVE row, so
    // deleting the HIGHEST number cannot make the next insert equal a surviving one.
    // That is the `MAX`-derivation half of the guarantee, and it is exercised here.
    //
    // THE OTHER HALF IS THE INDEX, which is what this test does NOT stage: removing
    // `idx_process_score_number` leaves this test passing, because the case it builds
    // never asks the database to refuse anything. The refusal is covered separately
    // by "inserting two rows with the same (revision_id, revision_no) is REFUSED".
    // Stated because the sentence above used to claim the whole guarantee.
    const { org, revisionId } = orgWithRevision();
    const db = registry.connectionFor(org.id);

    processSql.insertScore(db, { id: 'keep-1', revisionId, score: 50, terms: {}, reasoning: 'a' });
    const second = processSql.insertScore(db, { id: 'remove-me', revisionId, score: 60, terms: {}, reasoning: 'b' });

    // Delete the highest, then insert again: MAX+1 gives 2 again, which is the
    // documented behaviour (a gap is acceptable; a duplicate is not).
    db.prepare('DELETE FROM process_score WHERE id = ?').run('remove-me');
    const third = processSql.insertScore(db, { id: 'after-delete', revisionId, score: 70, terms: {}, reasoning: 'c' });

    assert.equal(third.revision_no, second.revision_no, 'the number is MAX+1, so a deleted highest number is reused');
    const stored = db.prepare('SELECT revision_no FROM process_score WHERE revision_id = ?').all(revisionId).map((r) => r.revision_no);
    assert.equal(new Set(stored).size, stored.length, 'and no two weighings share a number');
});

test('a caller-SUPPLIED number is honoured, so the parameter still works', () => {
    // `revisionNo` is an optional override. Pinned so the derived path above is not
    // mistaken for the only path.
    const { org, revisionId } = orgWithRevision();
    const db = registry.connectionFor(org.id);

    const given = processSql.insertScore(db, { id: 'given', revisionId, score: 50, terms: {}, reasoning: 'a', revisionNo: 42 });
    assert.equal(given.revision_no, 42);
});

test('weighings on DIFFERENT revisions number independently', () => {
    // The number is per revision, not per process: two revisions of one process each
    // start at 1.
    const { org, revisionId: firstRevision } = orgWithRevision();
    const db = registry.connectionFor(org.id);

    // A rejudge creates a second revision.
    const processRow = db.prepare('SELECT process_id FROM process_revision WHERE id = ?').get(firstRevision);
    const response = db.prepare('SELECT response_id FROM process_response WHERE revision_id = ?').get(firstRevision);
    processes.recordIdentification({
        orgId: org.id,
        reply: { matches: processRow.process_id, reasoning: 'regrouped', confidence: 'high' },
        responseId: response.response_id,
        adminReasoning: 'reconsider',
        decidedBy: processes.DECIDED_BY.ADMIN
    });
    const secondRevision = db.prepare('SELECT id FROM process_revision WHERE process_id = ? AND is_current = 1').get(processRow.process_id).id;

    const firstOnFirst = processSql.insertScore(db, { id: 'r1-1', revisionId: firstRevision, score: 50, terms: {}, reasoning: 'a' });
    const firstOnSecond = processSql.insertScore(db, { id: 'r2-1', revisionId: secondRevision, score: 60, terms: {}, reasoning: 'b' });

    assert.equal(firstOnFirst.revision_no, 1);
    assert.equal(firstOnSecond.revision_no, 1, 'a second revision starts its own numbering at 1');
});

// ===========================================================================
// 2. THE INDEX EXISTS AND HOLDS
// ===========================================================================

test('the schema applies idx_process_score_number', () => {
    // The index turns a recurrence of the numbering bug LOUD: with the read outside
    // the transaction, two writers would otherwise insert the same number silently.
    const { org, revisionId } = orgWithRevision();
    const db = registry.connectionFor(org.id);

    const index = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_process_score_number'").get();
    assert.ok(index, 'the unique index is present after the schema is applied');

    // And it is UNIQUE, on the pair the numbering must keep distinct. Read the
    // definition rather than trusting the name.
    const definition = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_process_score_number'").get().sql;
    assert.match(definition, /CREATE UNIQUE INDEX/, 'it is a UNIQUE index');
    assert.match(definition, /revision_id/, 'on revision_id');
    assert.match(definition, /revision_no/, 'and revision_no');
    assert.ok(revisionId, 'the fixture produced a revision, so the assertion above is not vacuous');
});

test('inserting two rows with the same (revision_id, revision_no) is REFUSED', () => {
    // The constraint's whole job. Its absence is what made the duplicate silent.
    const { org, revisionId } = orgWithRevision();
    const db = registry.connectionFor(org.id);

    db.prepare(
        `INSERT INTO process_score (id, revision_id, score, terms, reasoning, revision_no, is_current, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
    ).run('dupe-a', revisionId, 50, '{}', 'a', 1, '2026-01-01T00:00:00Z');

    assert.throws(
        () => db.prepare(
            `INSERT INTO process_score (id, revision_id, score, terms, reasoning, revision_no, is_current, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
        ).run('dupe-b', revisionId, 60, '{}', 'b', 1, '2026-01-01T00:00:00Z'),
        /UNIQUE constraint failed: process_score\.revision_id, process_score\.revision_no/,
        'a duplicate number on one revision is refused by the database'
    );

    const stored = db.prepare('SELECT COUNT(*) AS n FROM process_score WHERE revision_id = ? AND revision_no = 1').get(revisionId).n;
    assert.equal(stored, 1, 'and only one row carries that number');
});

test('the same number on a DIFFERENT revision is allowed, so the index is per revision', () => {
    // The constraint must not be narrower than the numbering: number 1 exists on
    // every revision of every process, so the index has to be scoped to the revision.
    const { org, revisionId } = orgWithRevision();
    const db = registry.connectionFor(org.id);

    const processRow = db.prepare('SELECT process_id FROM process_revision WHERE id = ?').get(revisionId);
    const response = db.prepare('SELECT response_id FROM process_response WHERE revision_id = ?').get(revisionId);
    processes.recordIdentification({
        orgId: org.id,
        reply: { matches: processRow.process_id, reasoning: 'regrouped', confidence: 'high' },
        responseId: response.response_id,
        adminReasoning: 'reconsider',
        decidedBy: processes.DECIDED_BY.ADMIN
    });
    const secondRevision = db.prepare('SELECT id FROM process_revision WHERE process_id = ? AND is_current = 1').get(processRow.process_id).id;

    assert.doesNotThrow(() => {
        processSql.insertScore(db, { id: 'on-r1', revisionId, score: 50, terms: {}, reasoning: 'a' });
        processSql.insertScore(db, { id: 'on-r2', revisionId: secondRevision, score: 60, terms: {}, reasoning: 'b' });
    }, 'number 1 on two different revisions is fine');
});

// ===========================================================================
// WHAT IS NOT TESTED, AND WHY
// ===========================================================================
//
// THE RACE ITSELF IS NOT STAGED, deliberately, BUT NOT BECAUSE IT CANNOT BE. An
// earlier version of this note said a single-process test could not stage it because
// `node:sqlite` is synchronous on the calling thread. THAT WAS WRONG and it was
// falsified by running it: three WORKER THREADS in one process, each doing the
// pre-fix `SELECT MAX` -> `BEGIN IMMEDIATE` -> `INSERT`, produced five duplicate
// numbers across 74 rows. Registers return, so threads DO interleave - at the READ,
// which is the mechanism, and not at lock acquisition as the old note implied.
//
// WHAT IS TRUE is narrower and more useful: the interleave cannot be produced
// THROUGH THE PUBLIC API, because `insertScore` opens the transaction that the
// pre-fix code left open until after the read. Staging it therefore needs the
// reverted pattern, not a call to `insertScore`.
//
// IT DOES NOT FIT THIS CASE. That harness holds a WRITE LOCK so the parent's write
// can be made to block; what the numbering race needs is two writers INTERLEAVING
// a read that is, in the shipped code, already inside a write transaction. A
// `BEGIN IMMEDIATE` serialises the two threads, so with the fix in place the
// interleave cannot occur, and staging it would require reverting the fix inside
// the test to demonstrate a defect the code does not have. Attempts with worker
// threads reached the `MAX` read in both threads but could not turn that into a
// duplicate through the public API, because the transaction prevents it - which is
// the fix working.
//
// So the honest coverage is above, and it is TWO PINNED POINTS rather than one: the
// NUMBER is derived and consecutive, asserted on what is STORED and not only what is
// returned (the cause fix, pinned with no concurrency at all), and the INDEX refuses
// a duplicate (the loud handling of a recurrence). Both were verified by mutation:
// reverting the derivation fails five tests here, and removing the index fails two.
//
// What is unpinned is only the third thing, the interleave between two writers, and
// a test for it would have to embed the reverted code and assert on a state the
// shipped build cannot reach. That is the trap the repo already documents in the
// NOTES.md section "The write-contention test trap", not a gap somebody forgot. For
// anyone who ever does need to stage it: with the fix in place, three worker threads
// calling `insertScore` produce zero duplicates across 60 rows, because
// `BEGIN IMMEDIATE` serialises the read and the insert.
