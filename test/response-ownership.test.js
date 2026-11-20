/**
 * The SQL layer's two refusal contracts: which response rows belong to an invitation, and that a
 * finalise or an edit of a foreign id refuses without writing.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-ownership-'));
process.env.STORE_DIR = STORE_DIR;
process.env.SESSION_SECRET = 'o'.repeat(64);

const store = await import('../lib/store/index.js');
const sqlite = await import('../lib/store/sqlite.js');
const registry = await import('../lib/store/registry.js');

after(() => {
    store.closeAll();
    fs.rmSync(STORE_DIR, { recursive: true, force: true });
});

/** Two invitations in one organisation, so a foreign id is a real neighbour rather than a stranger. */
function twoInvitations() {
    const org = store.createOrganisation('Ownership org');
    const first = store.addInvitation(org.id, { email: 'first@example.test', department: 'Finance' });
    const second = store.addInvitation(org.id, { email: 'second@example.test', department: 'Ops' });
    const db = registry.connectionFor(org.id);
    const idOf = (inv) => db.prepare('SELECT id FROM invitation WHERE email = ?').get(inv.email).id;
    return { org, db, first, second, firstId: idOf(first), secondId: idOf(second) };
}

/** Inserts an open round for one invitation, straight at the SQL layer. */
function openRound(db, id, invitationId) {
    return sqlite.insertResponse(db, {
        id, invitationId, department: 'Finance', data: { marker: id }, transcript: null
    });
}

// ===========================================================================
// responseBelongsToInvitation
// ===========================================================================

test('responseBelongsToInvitation is true only for the pair that owns the row', () => {
    const { db, firstId, secondId } = twoInvitations();
    openRound(db, 'adjacent', firstId);

    assert.equal(sqlite.responseBelongsToInvitation(db, 'adjacent', firstId), true,
        'its own invitation: true');
    assert.equal(sqlite.responseBelongsToInvitation(db, 'adjacent', secondId), false,
        'a neighbouring invitation: false');
    assert.equal(sqlite.responseBelongsToInvitation(db, 'no-such-row', firstId), false,
        'an id that does not exist: false');
});

test('responseExists and responseBelongsToInvitation differ on exactly the foreign case', () => {
    // The distinction the two predicates exist for: the row is real, but not yours.
    const { db, firstId, secondId } = twoInvitations();
    openRound(db, 'adjacent', firstId);

    const cases = [
        { label: 'own row', id: 'adjacent', invId: firstId },
        { label: 'foreign row', id: 'adjacent', invId: secondId },
        { label: 'missing row', id: 'absent', invId: firstId }
    ];

    const disagreements = cases.filter(({ id, invId }) =>
        sqlite.responseExists(db, id) !== sqlite.responseBelongsToInvitation(db, id, invId));

    assert.deepEqual(disagreements.map((c) => c.label), ['foreign row'],
        'the predicates disagree on the foreign row and agree everywhere else');
});

test('responseBelongsToInvitation returns the same false for a foreign row and a missing one', () => {
    // The two must be indistinguishable, or a caller could probe for another invitation's ids.
    const { db, firstId, secondId } = twoInvitations();
    openRound(db, 'adjacent', secondId);

    const foreign = sqlite.responseBelongsToInvitation(db, 'adjacent', firstId);
    const missing = sqlite.responseBelongsToInvitation(db, 'absent', firstId);

    assert.equal(foreign, false);
    assert.equal(missing, false);
    assert.equal(foreign, missing, 'no caller can tell a real-but-foreign id from an absent one');
});

// ===========================================================================
// markResponseSubmitted: the three cases
// ===========================================================================

test('case (a) the correct id and invitation sets submitted_at and returns the row', () => {
    const { db, firstId } = twoInvitations();
    openRound(db, 'mine', firstId);

    const saved = sqlite.markResponseSubmitted(db, 'mine', firstId);

    assert.notEqual(saved, null, 'the row comes back');
    assert.equal(saved.id, 'mine');
    assert.equal(typeof saved.submitted_at, 'string', 'submitted_at is set');
    assert.equal(sqlite.selectResponseById(db, 'mine').submitted_at, saved.submitted_at,
        'and the stored row carries the same instant');
});

test('case (c) a FOREIGN id returns null and leaves the target row untouched', () => {
    const { db, firstId, secondId } = twoInvitations();
    openRound(db, 'neighbour', secondId);

    const saved = sqlite.markResponseSubmitted(db, 'neighbour', firstId);

    assert.equal(saved, null, 'the other invitation\'s row is not returned');
    assert.equal(sqlite.selectResponseById(db, 'neighbour').submitted_at, null,
        'and the target row is still open: a null return that still wrote would be worse than the bug');
});

test('case (c) holds for the reverse pair, so it is the ownership test and not argument order', () => {
    const { db, firstId, secondId } = twoInvitations();
    openRound(db, 'neighbour', firstId);

    assert.equal(sqlite.markResponseSubmitted(db, 'neighbour', secondId), null);
    assert.equal(sqlite.selectResponseById(db, 'neighbour').submitted_at, null, 'untouched');
});

test('an id that does not exist returns null rather than throwing', () => {
    const { db, firstId } = twoInvitations();

    assert.equal(sqlite.markResponseSubmitted(db, 'no-such-row', firstId), null);
});

test('a foreign id leaves the row\'s updated_at alone too, not only submitted_at', () => {
    const { db, firstId, secondId } = twoInvitations();
    openRound(db, 'neighbour', secondId);
    const before = sqlite.selectResponseById(db, 'neighbour');

    sqlite.markResponseSubmitted(db, 'neighbour', firstId);

    const afterCall = sqlite.selectResponseById(db, 'neighbour');
    assert.equal(afterCall.submitted_at, before.submitted_at);
    assert.equal(afterCall.updated_at, before.updated_at, 'a refused call writes nothing at all');
});

// ===========================================================================
// The two writers agree
// ===========================================================================

test('updateResponseData and markResponseSubmitted refuse the SAME foreign id', () => {
    // The inconsistency this pins: one writer refused a foreign id while the other returned the row.
    const { db, firstId, secondId } = twoInvitations();
    openRound(db, 'neighbour', secondId);

    assert.equal(sqlite.updateResponseData(db, 'neighbour', firstId, { x: 1 }), null,
        'the edit refuses');
    assert.equal(sqlite.markResponseSubmitted(db, 'neighbour', firstId), null,
        'and so does the finalise');
});

test('neither writer refuses an id that IS this invitation\'s', () => {
    // The control: without it, both functions could refuse everything and still agree.
    const { db, firstId } = twoInvitations();
    openRound(db, 'mine', firstId);

    assert.notEqual(sqlite.updateResponseData(db, 'mine', firstId, { x: 1 }), null, 'the edit succeeds');
    assert.notEqual(sqlite.markResponseSubmitted(db, 'mine', firstId), null, 'and so does the finalise');
});

test('a refused edit and a refused finalise leave the same row byte-identical', () => {
    const { db, firstId, secondId } = twoInvitations();
    openRound(db, 'neighbour', secondId);
    const before = sqlite.selectResponseById(db, 'neighbour');

    sqlite.updateResponseData(db, 'neighbour', firstId, { hijacked: true });
    sqlite.markResponseSubmitted(db, 'neighbour', firstId);

    assert.deepEqual(sqlite.selectResponseById(db, 'neighbour'), before, 'nothing changed');
});

// ===========================================================================
// Hostile arguments
// ===========================================================================

test('a hostile or empty id is refused by both predicates and both writers', () => {
    const { db, firstId, secondId } = twoInvitations();
    openRound(db, 'neighbour', secondId);

    const hostile = ['', 'neighbour\' OR 1=1 --', '../../etc/passwd', 'neighbour '];
    for (const id of hostile) {
        assert.equal(sqlite.responseBelongsToInvitation(db, id, firstId), false, `${JSON.stringify(id)} does not belong`);
        assert.equal(sqlite.markResponseSubmitted(db, id, firstId), null, `${JSON.stringify(id)} finalises nothing`);
        assert.equal(sqlite.updateResponseData(db, id, firstId, { x: 1 }), null, `${JSON.stringify(id)} edits nothing`);
    }

    assert.equal(sqlite.selectResponseById(db, 'neighbour').submitted_at, null, 'the real row is untouched');
});

test('a null id or invitation is refused rather than matching a row', () => {
    const { db, firstId } = twoInvitations();
    openRound(db, 'mine', firstId);

    assert.equal(sqlite.responseBelongsToInvitation(db, null, firstId), false);
    assert.equal(sqlite.responseBelongsToInvitation(db, 'mine', null), false);
    assert.equal(sqlite.markResponseSubmitted(db, null, firstId), null);
    assert.equal(sqlite.markResponseSubmitted(db, 'mine', null), null);
    assert.equal(sqlite.selectResponseById(db, 'mine').submitted_at, null, 'the row stays open');
});

test('a finalise with the row already closed is a success, not a refusal', () => {
    // The one case where changes === 0 is NOT a foreign id: an already-submitted row of this
    // invitation still comes back, because that is a success the caller answers with.
    const { db, firstId } = twoInvitations();
    openRound(db, 'mine', firstId);
    const first = sqlite.markResponseSubmitted(db, 'mine', firstId);

    const second = sqlite.markResponseSubmitted(db, 'mine', firstId);

    assert.notEqual(second, null, 'the row is returned, not null');
    assert.equal(second.submitted_at, first.submitted_at, 'and the instant is unchanged');
});

test('the store API refuses a foreign id on UPDATE rather than returning null', () => {
    // The layer above maps the SQL refusal to a throw; this pins where the boundary sits.
    const { org, first, second } = twoInvitations();
    const theirs = store.addResponse(org.id, second.token, { department: 'Ops', data: { owner: 'second' } });

    let error = null;
    try {
        store.updateResponse(org.id, first.token, theirs.id, { hijacked: true });
    } catch (err) {
        error = err;
    }

    assert.notEqual(error, null, 'a foreign id throws at the store API');
    assert.equal(store.getResponsesByToken(org.id, second.token)[0].data.owner, 'second', 'and the row is unchanged');
});
