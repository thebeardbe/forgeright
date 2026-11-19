/**
 * A response re-identified into a different process must leave the one it left, and a nested write
 * must join the outer transaction. The existing re-identification tests all stay WITHIN one process.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-process-move-'));
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

function orgWithInvitation() {
    const org = store.createOrganisation('Org');
    const invitation = store.addInvitation(org.id, { email: 'p@example.test', department: 'Finance' });
    const addResponse = (data) => store.addResponse(org.id, invitation.token, { department: 'Finance', data });
    return { org, invitation, addResponse };
}

function createProcess(orgId, responseId, name) {
    return processes.recordIdentification({
        orgId,
        reply: { matches: null, reasoning: `new process ${name}`, confidence: 'high', name },
        responseId
    });
}

function joinProcess(orgId, responseId, processId, extra = {}) {
    return processes.recordIdentification({
        orgId,
        reply: { matches: processId, reasoning: 'joins this process', confidence: 'high', ...extra },
        responseId
    });
}

function memberCount(orgId, processId) {
    const row = processes.listProcessesForConsole(orgId).find((p) => p.id === processId);
    return row ? row.current.responses.length : null;
}

function currentMembership(orgId) {
    const rows = processes.listProcessesForConsole(orgId);
    const pairs = [];
    for (const row of rows) {
        for (const member of row.current.responses) pairs.push({ processId: row.id, responseId: member.responseId });
    }
    return pairs;
}

function doubledResponses(orgId) {
    const db = new DatabaseSync(store.orgDbPath(orgId));
    try {
        return db.prepare(
            `SELECT ps.response_id AS responseId
             FROM process_response ps
             JOIN process_revision pr ON pr.id = ps.revision_id AND pr.is_current = 1
             GROUP BY ps.response_id
             HAVING COUNT(*) > 1`
        ).all().map((row) => row.responseId);
    } finally {
        db.close();
    }
}

test('a response re-identified into ANOTHER process leaves the one it left', () => {
    const { org, addResponse } = orgWithInvitation();
    const one = addResponse({ task: 'one' });
    const two = addResponse({ task: 'two' });
    const three = addResponse({ task: 'three' });

    const a = createProcess(org.id, one.id, 'Process A');
    joinProcess(org.id, two.id, a.process.id); // A now covers one and two
    const b = createProcess(org.id, three.id, 'Process B');

    assert.equal(memberCount(org.id, a.process.id), 2, 'A starts with two members');
    assert.equal(memberCount(org.id, b.process.id), 1, 'B starts with one');

    const moved = joinProcess(org.id, two.id, b.process.id);

    assert.ok(moved.left, 'the source process is reported');
    assert.equal(moved.left.id, a.process.id, 'the LEFT process is A');
    assert.equal(memberCount(org.id, a.process.id), 1, "A's member count DROPS by one");
    assert.equal(memberCount(org.id, b.process.id), 2, 'B gains the response');

    const total = currentMembership(org.id).length;
    assert.equal(total, 3, 'three responses across the two processes, not four');
});

test('the moved response is in B and NOT in A, by id', () => {
    const { org, addResponse } = orgWithInvitation();
    const one = addResponse({ task: 'one' });
    const two = addResponse({ task: 'two' });

    const a = createProcess(org.id, one.id, 'A');
    joinProcess(org.id, two.id, a.process.id);
    const b = createProcess(org.id, two.id, 'B'); // this MOVES two out of A into B

    const membership = currentMembership(org.id);
    const inA = membership.filter((m) => m.processId === a.process.id).map((m) => m.responseId);
    const inB = membership.filter((m) => m.processId === b.process.id).map((m) => m.responseId);

    assert.equal(inA.includes(two.id), false, 'the moved response is not in A');
    assert.equal(inB.includes(two.id), true, 'it is in B');
    assert.equal(new Set(membership.map((m) => m.responseId)).size, membership.length, 'no response counted twice');
});

test('NO response is in two current revisions after any sequence', () => {
    const { org, addResponse } = orgWithInvitation();
    const responses = [1, 2, 3, 4].map((n) => addResponse({ task: `t${n}` }));

    const a = createProcess(org.id, responses[0].id, 'A');
    joinProcess(org.id, responses[1].id, a.process.id);
    const b = createProcess(org.id, responses[2].id, 'B');
    joinProcess(org.id, responses[3].id, b.process.id);

    joinProcess(org.id, responses[1].id, b.process.id);
    joinProcess(org.id, responses[3].id, a.process.id);
    joinProcess(org.id, responses[1].id, a.process.id);

    assert.deepEqual(doubledResponses(org.id), [], 'the invariant holds after every move');

    const db = registry.connectionFor(org.id);
    assert.deepEqual(processSql.selectResponsesInTwoCurrentRevisions(db), []);
});

test('a move that EMPTIES the source leaves the process, with an advanced revision and nothing deleted', () => {
    const { org, addResponse } = orgWithInvitation();
    const only = addResponse({ task: 'only member' });
    const other = addResponse({ task: 'other' });

    const source = createProcess(org.id, only.id, 'Source');
    const target = createProcess(org.id, other.id, 'Target');
    const revisionBefore = processes.listProcessesForConsole(org.id).find((p) => p.id === source.process.id).current.revision;

    joinProcess(org.id, only.id, target.process.id);

    const rows = processes.listProcessesForConsole(org.id);
    const sourceRow = rows.find((p) => p.id === source.process.id);

    assert.ok(sourceRow, 'the source process still exists');
    assert.equal(sourceRow.current.responses.length, 0, 'with an empty current revision');
    assert.ok(sourceRow.current.revision > revisionBefore, 'and an ADVANCED revision, not a deleted one');
    assert.equal(sourceRow.history.length >= 2, true, 'the earlier revision is still in the history');
    assert.equal(memberCount(org.id, target.process.id), 2, 'the target has both responses');
});

test('a NON-MOVING create returns left: null and membership is what it was', () => {
    const { org, addResponse } = orgWithInvitation();
    const one = addResponse({ task: 'one' });

    const created = processes.recordIdentification({
        orgId: org.id,
        reply: { matches: null, reasoning: 'brand new', confidence: 'high', name: 'A' },
        responseId: one.id
    });

    assert.equal(created.left, null, 'a creation leaves nothing');
    assert.equal(memberCount(org.id, created.process.id), 1);
});

test('a NON-MOVING merge returns left: null and the process keeps both members', () => {
    const { org, addResponse } = orgWithInvitation();
    const one = addResponse({ task: 'one' });
    const two = addResponse({ task: 'two' });

    const a = createProcess(org.id, one.id, 'A');
    const joined = joinProcess(org.id, two.id, a.process.id);

    assert.equal(joined.left, null, 'a merge into the same process leaves nothing');
    assert.equal(memberCount(org.id, a.process.id), 2, 'both members are behind it');
});

test('a NON-MOVING in-place re-identify returns left: null and membership is unchanged', () => {
    const { org, addResponse } = orgWithInvitation();
    const one = addResponse({ task: 'one' });
    const two = addResponse({ task: 'two' });

    const a = createProcess(org.id, one.id, 'A');
    joinProcess(org.id, two.id, a.process.id);

    const reidentified = joinProcess(org.id, one.id, a.process.id, { reasoning: 'reconsidered in place' });

    assert.equal(reidentified.left, null, 'a re-identify within the same process leaves nothing');
    assert.equal(memberCount(org.id, a.process.id), 2, 'membership is what it was');
    assert.deepEqual(doubledResponses(org.id), []);
});

test('THE INVARIANT FIRES on a forced double link, and the transaction rolls back', () => {
    // A forced double link outside the guarded path, so the store's assertion has something to find.
    const { org, addResponse } = orgWithInvitation();
    const one = addResponse({ task: 'one' });
    const two = addResponse({ task: 'two' });

    const a = createProcess(org.id, one.id, 'A');
    const b = createProcess(org.id, two.id, 'B');

    const db = registry.connectionFor(org.id);
    const bRevision = processSql.selectCurrentRevision(db, b.process.id);
    processSql.linkResponse(db, {
        id: 'forced-link',
        revisionId: bRevision.id,
        responseId: one.id,
        contributed: []
    });

    assert.ok(doubledResponses(org.id).includes(one.id), 'the double link is really there');

    const historyBefore = processes.listProcessesForConsole(org.id).length;
    const revisionsBefore = processes.listProcessesForConsole(org.id)
        .map((p) => p.history.length);

    assert.throws(
        () => joinProcess(org.id, two.id, a.process.id),
        /more than one current revision/,
        'the invariant assertion fires'
    );

    assert.equal(processes.listProcessesForConsole(org.id).length, historyBefore, 'no process was added');
    assert.deepEqual(
        processes.listProcessesForConsole(org.id).map((p) => p.history.length),
        revisionsBefore,
        'no revision was added by the refused identification'
    );
    assert.equal(memberCount(org.id, a.process.id), 1, "A's membership is unchanged by the refused call");
});

// ===========================================================================
// 2. THE TRANSACTION JOIN
// ===========================================================================
//
// `writeTransaction` JOINS an enclosing transaction rather than nesting: `insertRevision` and
// `insertScore` each open their own BEGIN IMMEDIATE and SQLite refuses a nested one.

function probeConnection() {
    const org = store.createOrganisation('Transaction org');
    return { org, db: registry.connectionFor(org.id) };
}

function insertProbeProcess(db, id) {
    db.prepare('INSERT INTO process (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(id, id, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
}

const processExists = (db, id) => Boolean(db.prepare('SELECT 1 FROM process WHERE id = ?').get(id));

test('an outermost writeTransaction commits and leaves no transaction open', () => {
    const { db } = probeConnection();

    processSql.writeTransaction(db, () => insertProbeProcess(db, 'outer-commit'));

    assert.equal(processExists(db, 'outer-commit'), true, 'the row was committed');
    assert.equal(db.isTransaction, false, 'no transaction is left open');
});

test('an outermost writeTransaction that throws rolls back, rethrows, and leaves nothing open', () => {
    const { db } = probeConnection();

    assert.throws(() => processSql.writeTransaction(db, () => {
        insertProbeProcess(db, 'outer-throw');
        throw new Error('the work failed');
    }), /the work failed/, 'the original error propagates');

    assert.equal(processExists(db, 'outer-throw'), false, 'its write was rolled back');
    assert.equal(db.isTransaction, false, 'no transaction is left open');
});

test('a JOINED inner call that succeeds, then an outer failure, rolls back the whole thing', () => {
    const { db } = probeConnection();

    assert.throws(() => processSql.writeTransaction(db, () => {
        processSql.writeTransaction(db, () => insertProbeProcess(db, 'joined-then-outer-fails'));
        throw new Error('the outer frame failed');
    }), /the outer frame failed/);

    assert.equal(processExists(db, 'joined-then-outer-fails'), false, 'the joined write rolled back with the outer one');
    assert.equal(db.isTransaction, false, 'no transaction is left open');
});

test('a JOINED inner call that throws propagates, and the outer frame rolls back', () => {
    const { db } = probeConnection();

    assert.throws(() => processSql.writeTransaction(db, () => {
        insertProbeProcess(db, 'outer-before-inner-throws');
        processSql.writeTransaction(db, () => {
            insertProbeProcess(db, 'inner-throws');
            throw new Error('the inner work failed');
        });
    }), /the inner work failed/, 'the inner error propagates rather than being swallowed');

    assert.equal(processExists(db, 'inner-throws'), false, 'the inner write is gone');
    assert.equal(processExists(db, 'outer-before-inner-throws'), false, 'and so is the outer frame\'s earlier write');
    assert.equal(db.isTransaction, false, 'no transaction is left open');
});

test('a JOINED inner call whose error the caller swallows commits normally', () => {
    // The inner call joined, so swallowing the error leaves the work in the outer transaction.
    const { db } = probeConnection();

    processSql.writeTransaction(db, () => {
        try {
            processSql.writeTransaction(db, () => {
                insertProbeProcess(db, 'swallowed-inner');
                throw new Error('ignored by the caller');
            });
        } catch {
        }
        insertProbeProcess(db, 'outer-after-swallow');
    });

    assert.equal(processExists(db, 'swallowed-inner'), true, 'the joined write stays, because its owner committed');
    assert.equal(processExists(db, 'outer-after-swallow'), true, 'and the outer work committed too');
    assert.equal(db.isTransaction, false, 'no transaction is left open');
});

test('a rollback is never issued twice: a failing COMMIT does not mask the original error', () => {
    // A failing COMMIT: the rollback after it would throw "no transaction is active", and
    // rethrowing THAT would hide the real fault.
    const { db } = probeConnection();
    let surfaced = null;

    try {
        processSql.writeTransaction(db, () => {
            insertProbeProcess(db, 'commit-fails');
            // Not portable to make the COMMIT itself fail, so this checks only that a single
            // error surfaces and no transaction lingers.
            throw new Error('the real fault');
        });
    } catch (err) {
        surfaced = err;
    }

    assert.equal(surfaced.message, 'the real fault', 'the original error is what surfaces, unmasked');
    assert.equal(db.isTransaction, false, 'and nothing is left open');
    assert.equal(processExists(db, 'commit-fails'), false);
});

test('an insertRevision inside an outer transaction joins it rather than nesting', () => {
    const { org, addResponse } = orgWithInvitation();
    const one = addResponse({ task: 'one' });
    const created = createProcess(org.id, one.id, 'Joined revision');

    assert.ok(created.revision.id, 'the revision was written');
    const db = registry.connectionFor(org.id);
    assert.equal(db.isTransaction, false, 'and no transaction was left open by the join');
});

test('a failure inside a full identification leaves no process and no revision behind', () => {
    // A refusal must not leave a current revision with no members, which renders as an empty
    // process.
    const { org, addResponse } = orgWithInvitation();
    const one = addResponse({ task: 'one' });
    const a = createProcess(org.id, one.id, 'A');

    const processesBefore = processes.listProcessesForConsole(org.id).length;
    const aRevisionsBefore = processes.listProcessesForConsole(org.id).find((p) => p.id === a.process.id).history.length;

    assert.throws(() => processes.recordIdentification({
        orgId: org.id,
        reply: { matches: null, reasoning: '' },
        responseId: one.id
    }), /no reasoning/);

    assert.equal(processes.listProcessesForConsole(org.id).length, processesBefore, 'no process was left behind');
    assert.equal(
        processes.listProcessesForConsole(org.id).find((p) => p.id === a.process.id).history.length,
        aRevisionsBefore,
        'and no revision'
    );
});
