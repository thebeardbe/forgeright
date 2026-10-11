/**
 * Tests for the storage layer (lib/store/*).
 *
 * Derived from the stated contract, not from the implementation. Expected values
 * are literals or plainly-derived values; none is computed by calling the code
 * under test.
 *
 * STORE_DIR is set to a fresh temp directory BEFORE the store module is
 * imported, because registry.js reads it into the path helpers. Every test run
 * gets its own directory, so data/store/ is never touched. closeAll() runs in a
 * cleanup hook so no connection is left open, and the temp tree is removed.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-store-test-'));
process.env.STORE_DIR = STORE_DIR;

const store = await import('../lib/store/index.js');
// registry.js owns the connection lifecycle, so it is the only way to read a
// pragma back from the connection the store actually uses.
const registry = await import('../lib/store/registry.js');

after(() => {
    store.closeAll();
    fs.rmSync(STORE_DIR, { recursive: true, force: true });
});

/** A fresh organisation for a test that needs one and does not care about its id. */
function newOrg(name = 'Acme Ltd') {
    return store.createOrganisation(name);
}

/** An invitation with the given email and department. */
function invite(orgId, email = 'person@example.com', department = 'Finance') {
    return store.addInvitation(orgId, { email, department });
}

// ===========================================================================
// 1. ISOLATION
// ===========================================================================

test('two organisations get two different database files', () => {
    const a = newOrg('Org A');
    const b = newOrg('Org B');

    const pathA = store.orgDbPath(a.id);
    const pathB = store.orgDbPath(b.id);

    assert.notEqual(pathA, pathB);
    assert.ok(fs.existsSync(pathA), 'the first organisation must have a file on disk');
    assert.ok(fs.existsSync(pathB), 'the second organisation must have a file on disk');
});

test('each file lives inside <STORE_DIR>/orgs and is named <orgId>.db', () => {
    const org = newOrg('Path check');
    const expected = path.join(STORE_DIR, 'orgs', `${org.id}.db`);
    assert.equal(store.orgDbPath(org.id), expected);
});

test('storeDir reflects the STORE_DIR this suite set', () => {
    assert.equal(store.storeDir(), STORE_DIR);
});

test('a response written to one organisation is invisible to another', () => {
    const a = newOrg('Org A');
    const b = newOrg('Org B');
    const invA = invite(a.id, 'a@orga.example');
    const invB = invite(b.id, 'b@orgb.example');

    store.addResponse(a.id, invA.token, { department: 'Finance', data: { secret: 'belongs to A' } });

    // B has no responses of its own.
    assert.deepEqual(store.getResponsesForAnalysis(b.id), []);
    assert.deepEqual(store.getResponsesByToken(b.id, invB.token), []);

    // A sees exactly its own.
    const analysisA = store.getResponsesForAnalysis(a.id);
    assert.equal(analysisA.length, 1);
    assert.equal(analysisA[0].data.secret, 'belongs to A');
});

test('a token from one organisation returns nothing against another', () => {
    const a = newOrg('Org A');
    const b = newOrg('Org B');
    const invA = invite(a.id, 'a@orga.example');
    const invB = invite(b.id, 'b@orgb.example');

    // A real token, but for the wrong organisation: no rows, no throw.
    assert.deepEqual(store.getResponsesByToken(a.id, invB.token), []);
    assert.deepEqual(store.getResponsesByToken(b.id, invA.token), []);
});

test('a token from one organisation cannot write into another', () => {
    const a = newOrg('Org A');
    const b = newOrg('Org B');
    const invB = invite(b.id, 'b@orgb.example');

    // The token belongs to B; writing it against A must be refused, not silently
    // attached to A.
    // The message is client-facing copy and must not be pinned verbatim; the
    // property is that the write is refused and nothing lands in A.
    assert.throws(
        () => store.addResponse(a.id, invB.token, { department: 'Finance', data: { x: 1 } }),
        /resolves to no invitation/
    );
    assert.deepEqual(store.getResponsesForAnalysis(a.id), [], 'nothing may have been written to A');
});

test('invitationForToken with another organisation\'s token returns null and touches nothing', () => {
    const a = newOrg('Org A');
    const b = newOrg('Org B');
    const invA = invite(a.id, 'a@orga.example');
    const invB = invite(b.id, 'b@orgb.example');

    assert.equal(store.invitationForToken(a.id, invB.token), null);

    // Neither invitation was opened: the wrong-org attempt must not record a visit.
    const listA = store.listInvitations(a.id);
    const listB = store.listInvitations(b.id);
    assert.equal(listA[0].opened_at, null);
    assert.equal(listB[0].opened_at, null);
    assert.equal(invA.token === invB.token, false);
});

test('listInvitations never shows another organisation\'s people', () => {
    const a = newOrg('Org A');
    const b = newOrg('Org B');
    invite(a.id, 'only-in-a@example.com');
    invite(b.id, 'only-in-b@example.com');

    const emailsA = store.listInvitations(a.id).map((row) => row.email);
    const emailsB = store.listInvitations(b.id).map((row) => row.email);

    assert.deepEqual(emailsA, ['only-in-a@example.com']);
    assert.deepEqual(emailsB, ['only-in-b@example.com']);
});

test('getOrganisation would return only that organisation\'s row', () => {
    const a = newOrg('Org A unique name');
    const b = newOrg('Org B unique name');

    assert.equal(store.getOrganisation(a.id).name, 'Org A unique name');
    assert.equal(store.getOrganisation(b.id).name, 'Org B unique name');
});

test('an update naming one organisation cannot touch a response id from another', () => {
    const a = newOrg('Org A');
    const b = newOrg('Org B');
    const invA = invite(a.id, 'a@orga.example');
    const invB = invite(b.id, 'b@orgb.example');

    const rowA = store.addResponse(a.id, invA.token, { department: 'Finance', data: { owner: 'A' } });
    const rowB = store.addResponse(b.id, invB.token, { department: 'Finance', data: { owner: 'B' } });

    // B's token, editing A's response id. The update is refused and A is untouched.
    assert.throws(
        () => store.updateResponse(b.id, invB.token, rowA.id, { owner: 'hijacked' }),
        /does not belong to the invitation/
    );
    assert.deepEqual(store.getResponsesByToken(a.id, invA.token)[0].data, { owner: 'A' });

    // A's token, editing B's response id. A's token is unknown in B, so this is
    // refused as an unresolvable token. The message is copy and not pinned.
    assert.throws(
        () => store.updateResponse(b.id, invA.token, rowB.id, { owner: 'hijacked' }),
        /resolves to no invitation/
    );
    assert.deepEqual(store.getResponsesByToken(b.id, invB.token)[0].data, { owner: 'B' });
});

test('getResponsesForAnalysis would return only that organisation\'s rows, never a union', () => {
    const a = newOrg('Org A');
    const b = newOrg('Org B');
    const invA = invite(a.id, 'a@orga.example');
    const invB = invite(b.id, 'b@orgb.example');

    store.addResponse(a.id, invA.token, { department: 'Finance', data: { tag: 'A' } });
    store.addResponse(b.id, invB.token, { department: 'Finance', data: { tag: 'B' } });

    assert.deepEqual(store.getResponsesForAnalysis(a.id).map((r) => r.data.tag), ['A']);
    assert.deepEqual(store.getResponsesForAnalysis(b.id).map((r) => r.data.tag), ['B']);
});

test('listOrganisationIds does not reveal one organisation through another\'s interface', () => {
    // listOrganisationIds takes no org id: it is the one enumeration the registry
    // offers. Assert it names only files that validate as ids, so a stray file
    // cannot masquerade as an organisation.
    const org = newOrg('Enumerated');
    const ids = store.listOrganisationIds();
    for (const id of ids) assert.match(id, /^[a-z0-9][a-z0-9-]{0,63}$/);
    assert.ok(ids.includes(org.id));
});

// ===========================================================================
// 2. PATH SAFETY
// ===========================================================================

// Ids that must be refused, because each is a way to build a path outside the
// orgs directory or to name a file that is not an organisation.
const UNSAFE_ORG_IDS = [
    '../evil',
    '..',
    '.',
    '../../etc/passwd',
    '/etc/passwd',
    '/absolute',
    'a/b',
    'a\\b',
    'a\u0000b',
    'a/../b',
    '%2e%2e',
    '',
    ' ',
    'UPPER',
    'Mixed-Case',
    'a.b',
    'a b',
    '-leading-hyphen',
    'org_1',
    'a'.repeat(65)
];

for (const id of UNSAFE_ORG_IDS) {
    test(`an unsafe organisation id is refused: ${JSON.stringify(id)}`, () => {
        assert.throws(() => store.orgDbPath(id), /Unsafe organisation id/);
    });
}

test('a non-string organisation id is refused', () => {
    for (const id of [42, null, undefined, {}, [], true, Symbol('x')]) {
        assert.throws(() => store.orgDbPath(id), /Unsafe organisation id/);
    }
});

test('a well-formed id is accepted at the boundary of the length limit', () => {
    const exactly64 = 'a'.repeat(64);
    assert.equal(store.orgDbPath(exactly64), path.join(STORE_DIR, 'orgs', `${exactly64}.db`));

    const sixtyFive = 'a'.repeat(65);
    assert.throws(() => store.orgDbPath(sixtyFive), /Unsafe organisation id/);
});

test('an accepted id never resolves outside the orgs directory', () => {
    const orgsDir = path.join(STORE_DIR, 'orgs');
    for (const id of ['a', '0', 'a-b-c', 'a'.repeat(64), '0-1-2']) {
        assert.equal(path.dirname(store.orgDbPath(id)), orgsDir);
    }
});

// The lexical check above proves only that the NAME is contained. It passes for
// a symlink, because the symlink's path is inside the directory. That is the
// failure mode: a test that restates the implementation. The tests below assert
// the REQUIREMENT instead: no org id can cause a read of another organisation's
// rows, whatever the filesystem contains.

test('a symlinked org file cannot serve another organisation\'s data', () => {
    const orgsDir = path.join(STORE_DIR, 'orgs');
    const victim = newOrg('Victim of a symlink');
    const victimInvite = invite(victim.id, 'victim@example.com');
    store.addResponse(victim.id, victimInvite.token, { department: 'Finance', data: { secret: 'VICTIM-DATA' } });

    // The attacker id is legal by the id pattern, so validation alone lets it
    // through. The only defence is looking at the file, not the name.
    const attackerId = 'attacker01';
    const symlinkPath = path.join(orgsDir, `${attackerId}.db`);
    fs.symlinkSync(store.orgDbPath(victim.id), symlinkPath);

    // Every read path must refuse, not return the victim's rows.
    assert.throws(() => store.getResponsesForAnalysis(attackerId), /symlink|Refusing/i);
    assert.throws(() => store.getResponsesByToken(attackerId, victimInvite.token), /symlink|Refusing/i);
    assert.throws(() => store.listInvitations(attackerId), /symlink|Refusing/i);
    assert.throws(() => store.getOrganisation(attackerId), /symlink|Refusing/i);

    // And a write through the attacker id must not land in the victim's file.
    assert.throws(
        () => store.addInvitation(attackerId, { email: 'attacker@example.com', department: 'Finance' }),
        /symlink|Refusing/i
    );
});

test('the attacker id does not become a usable tenant through a symlink', () => {
    const victim = newOrg('Symlink victim two');
    const attackerId = 'attacker02';
    fs.symlinkSync(store.orgDbPath(victim.id), store.orgDbPath(attackerId));

    // A write that pretends to be a normal operation must be refused, not
    // silently redirected into the victim's file.
    assert.throws(() => store.addResponse(attackerId, 'any-token', { department: 'Finance', data: { x: 1 } }), /symlink|Refusing/i);
    assert.throws(() => store.finishOrganisation(attackerId), /symlink|Refusing/i);
    assert.throws(() => store.addInvitation(attackerId, { email: 'a@b.com', department: 'Finance' }), /symlink|Refusing/i);

    // The victim's own data is still reachable through the victim id, so the
    // refusal did not damage the legitimate tenant.
    const victimInvite = store.addInvitation(victim.id, { email: 'ok@example.com', department: 'Finance' });
    assert.equal(typeof victimInvite.token, 'string');
});

test('a symlink in the orgs directory is not listed as a usable organisation', () => {
    const victim = newOrg('Symlink listing victim');
    const attackerId = 'attacker03';
    fs.symlinkSync(store.orgDbPath(victim.id), store.orgDbPath(attackerId));

    // A symlink named like an organisation must not be counted as a tenant in
    // the admin overview, and must not be openable.
    assert.equal(store.listOrganisationIds().includes(attackerId), false, 'a symlink must not be listed as a tenant');
    assert.ok(store.listOrganisationIds().includes(victim.id), 'the victim is still a real tenant');
    assert.throws(() => store.getOrganisation(attackerId), /symlink|Refusing/i);
});

test('a symlinked orgs directory cannot silently redirect a write elsewhere', () => {
    // The orgs directory is resolved on first use. If it is swapped for a
    // symlink afterwards, a write must not follow the redirect to a location
    // outside the store.
    const storeDir = store.storeDir();
    const orgsDir = path.join(storeDir, 'orgs');

    // Make sure the directory has been resolved by the store at least once.
    newOrg('Resolve the orgs directory');

    // Swap the real directory for a symlink to an attacker-controlled location.
    const elsewhere = path.join(storeDir, 'elsewhere');
    fs.mkdirSync(elsewhere, { recursive: true });
    const saved = fs.readdirSync(orgsDir);
    fs.rmSync(orgsDir, { recursive: true, force: true });
    fs.symlinkSync(elsewhere, orgsDir);

    try {
        let created;
        try {
            created = newOrg('Redirected write attempt');
        } catch (err) {
            // Refusing outright is the safe outcome; nothing to assert further.
            return;
        }

        // If a write was allowed, it must NOT have landed in the redirect target.
        const landed = fs.readdirSync(elsewhere).filter((n) => n.startsWith(created.id));
        assert.deepEqual(landed, [], 'a write must not follow a swapped orgs symlink outside the store');
    } finally {
        // Restore the directory so later tests see a clean store.
        fs.rmSync(orgsDir, { force: true });
        fs.mkdirSync(orgsDir, { recursive: true });
        for (const name of saved) {
            try { fs.renameSync(path.join(elsewhere, name), path.join(orgsDir, name)); } catch { /* already gone */ }
        }
        fs.rmSync(elsewhere, { recursive: true, force: true });
    }
});

test('an unsafe id is refused before any file is touched', () => {
    const dir = path.join(STORE_DIR, 'orgs');
    const before = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;

    assert.throws(() => store.orgDbPath('../evil'), /Unsafe organisation id/);

    const after = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
    assert.equal(after, before, 'a refused id must not create a file');
    assert.equal(
        fs.existsSync(path.join(STORE_DIR, 'evil.db')),
        false,
        'nothing may appear outside the orgs directory'
    );
});

// ===========================================================================
// 3. THE ATTRIBUTION GUARANTEE
// ===========================================================================

test('getResponsesForAnalysis returns no invitation id, no email, and no token', () => {
    const org = newOrg('Attribution org');
    const inv = invite(org.id, 'someone@example.com');
    store.addResponse(org.id, inv.token, { department: 'Finance', data: { note: 'anonymous' } });

    const rows = store.getResponsesForAnalysis(org.id);
    assert.equal(rows.length, 1);

    const keys = Object.keys(rows[0]);
    assert.ok(!keys.includes('invitation_id'), 'invitation_id must not be present');
    assert.ok(!keys.includes('invitationId'), 'invitationId must not be present');
    assert.ok(!keys.includes('email'), 'email must not be present');
    assert.ok(!keys.includes('token'), 'token must not be present');
});

test('no analysing row carries the invitation id as a value under any key', () => {
    // Inverted check: the invitation id exists, and must appear nowhere in the
    // serialised analysis output, not merely under its own key name.
    const org = newOrg('Attribution shapes');
    const inv = invite(org.id, 'shapes@example.com');
    store.addResponse(org.id, inv.token, { department: 'Finance', data: { note: 'x' } });

    const serialised = JSON.stringify(store.getResponsesForAnalysis(org.id));
    assert.ok(!serialised.includes(inv.id), 'the invitation id must not appear anywhere in the analysis output');
    assert.ok(!serialised.includes(inv.token), 'the token must not appear anywhere in the analysis output');
    assert.ok(!serialised.includes('shapes@example.com'), 'the email must not appear anywhere in the analysis output');
});

test('the attribution guarantee holds across several participants and several responses', () => {
    const org = newOrg('Crowd');
    const people = [];
    for (let i = 0; i < 5; i += 1) {
        const inv = invite(org.id, `person${i}@example.com`, `Dept ${i}`);
        people.push(inv);
        store.addResponse(org.id, inv.token, { department: `Dept ${i}`, data: { round: 1, i } });
        store.addResponse(org.id, inv.token, { department: `Dept ${i}`, data: { round: 2, i } });
    }

    const rows = store.getResponsesForAnalysis(org.id);
    assert.equal(rows.length, 10, 'every response is returned');

    const serialised = JSON.stringify(rows);
    for (const inv of people) {
        assert.ok(!serialised.includes(inv.id), `invitation id ${inv.id} leaked into the analysis output`);
        assert.ok(!serialised.includes(inv.token), 'a token leaked into the analysis output');
    }
    for (let i = 0; i < 5; i += 1) {
        assert.ok(!serialised.includes(`person${i}@example.com`), 'an email leaked into the analysis output');
    }
});

test('the analysis shape is stable: data, department, id and timestamps only', () => {
    const org = newOrg('Shape');
    const inv = invite(org.id, 'shape@example.com');
    store.addResponse(org.id, inv.token, { department: 'Finance', data: { a: 1 } });

    const row = store.getResponsesForAnalysis(org.id)[0];
    assert.deepEqual(
        Object.keys(row).sort(),
        ['created_at', 'data', 'department', 'id', 'submitted_at', 'unreadable', 'updated_at']
    );
    assert.equal(row.department, 'Finance');
    assert.deepEqual(row.data, { a: 1 });
});

test('getResponsesForAnalysis returns an empty array, not null, for a fresh organisation', () => {
    const org = newOrg('Empty');
    assert.deepEqual(store.getResponsesForAnalysis(org.id), []);
});

// ===========================================================================
// 4. THE FINISH RULE
// ===========================================================================

test('a fresh organisation is not finished', () => {
    const org = newOrg('Open for business');
    assert.equal(org.finished_at, null);
    assert.equal(store.isOrganisationFinished(org.id), false);
});

test('finishOrganisation sets a timestamp and flips isOrganisationFinished', () => {
    const org = newOrg('To close');
    const finished = store.finishOrganisation(org.id);

    assert.equal(typeof finished.finished_at, 'string');
    assert.ok(finished.finished_at.length > 0);
    assert.equal(store.isOrganisationFinished(org.id), true);
});

test('adding a response after finishing throws', () => {
    const org = newOrg('Closed for writes');
    const inv = invite(org.id);
    store.finishOrganisation(org.id);

    assert.throws(
        () => store.addResponse(org.id, inv.token, { department: 'Finance', data: { x: 1 } }),
        /finished/
    );
});

test('editing a response after finishing throws', () => {
    const org = newOrg('Closed for edits');
    const inv = invite(org.id);
    const created = store.addResponse(org.id, inv.token, { department: 'Finance', data: { round: 1 } });
    store.finishOrganisation(org.id);

    assert.throws(
        () => store.updateResponse(org.id, inv.token, created.id, { round: 1, edited: true }),
        /finished/
    );
});

test('reading still works after finishing', () => {
    const org = newOrg('Readable when closed');
    const inv = invite(org.id);
    store.addResponse(org.id, inv.token, { department: 'Finance', data: { keep: true } });
    store.finishOrganisation(org.id);

    const byToken = store.getResponsesByToken(org.id, inv.token);
    assert.equal(byToken.length, 1);
    assert.deepEqual(byToken[0].data, { keep: true });

    const analysis = store.getResponsesForAnalysis(org.id);
    assert.equal(analysis.length, 1);
    assert.deepEqual(analysis[0].data, { keep: true });
});

test('finishing twice keeps the first timestamp and does not throw', () => {
    const org = newOrg('Closed twice');
    const first = store.finishOrganisation(org.id);
    const second = store.finishOrganisation(org.id);

    assert.equal(second.finished_at, first.finished_at, 'the first close wins');
    assert.equal(store.isOrganisationFinished(org.id), true);
});

test('finishing an organisation that does not exist throws', () => {
    assert.throws(
        () => store.finishOrganisation('a0000000-0000-4000-8000-000000000000'),
        /does not exist/
    );
});

test('a response added before finishing survives the close unchanged', () => {
    const org = newOrg('Preserve');
    const inv = invite(org.id);
    const before = store.addResponse(org.id, inv.token, { department: 'Finance', data: { original: true } });
    store.finishOrganisation(org.id);

    const after = store.getResponsesByToken(org.id, inv.token)[0];
    assert.equal(after.id, before.id);
    assert.deepEqual(after.data, { original: true });
});

// ===========================================================================
// 5. RESUME AND EDITING
// ===========================================================================

test('a token returns only its own responses', () => {
    const org = newOrg('Two participants');
    const first = invite(org.id, 'first@example.com');
    const second = invite(org.id, 'second@example.com');

    store.addResponse(org.id, first.token, { department: 'Finance', data: { owner: 'first' } });
    store.addResponse(org.id, second.token, { department: 'Finance', data: { owner: 'second' } });

    const firstRows = store.getResponsesByToken(org.id, first.token);
    assert.equal(firstRows.length, 1);
    assert.equal(firstRows[0].data.owner, 'first');

    const secondRows = store.getResponsesByToken(org.id, second.token);
    assert.equal(secondRows.length, 1);
    assert.equal(secondRows[0].data.owner, 'second');
});

test('a second round appends a new response rather than overwriting the first', () => {
    const org = newOrg('Two rounds');
    const inv = invite(org.id);

    const round1 = store.addResponse(org.id, inv.token, { department: 'Finance', data: { round: 1 } });
    const round2 = store.addResponse(org.id, inv.token, { department: 'Finance', data: { round: 2 } });

    assert.notEqual(round1.id, round2.id, 'each round has its own row id');

    const rows = store.getResponsesByToken(org.id, inv.token);
    assert.equal(rows.length, 2, 'both rounds are kept');
    assert.deepEqual(rows.map((r) => r.data.round).sort(), [1, 2]);
});

test('an update replaces the answers and moves updated_at', () => {
    const org = newOrg('Update own');
    const inv = invite(org.id);
    const created = store.addResponse(org.id, inv.token, { department: 'Finance', data: { round: 1 } });

    const updated = store.updateResponse(org.id, inv.token, created.id, { round: 1, corrected: true });

    assert.equal(updated.id, created.id);
    assert.deepEqual(updated.data, { round: 1, corrected: true });
    assert.ok(updated.updated_at >= created.updated_at, 'updated_at must not move backwards');
    assert.equal(updated.created_at, created.created_at, 'created_at must not change');
});

test('an update cannot touch a row that belongs to someone else, and says so without confirming the id', () => {
    const org = newOrg('Cross-editor');
    const mine = invite(org.id, 'mine@example.com');
    const theirs = invite(org.id, 'theirs@example.com');

    const theirRow = store.addResponse(org.id, theirs.token, { department: 'Finance', data: { owner: 'theirs' } });

    // Refused by throwing, not by a null the caller might forget to check.
    assert.throws(
        () => store.updateResponse(org.id, mine.token, theirRow.id, { owner: 'hijacked' }),
        /does not belong to the invitation/
    );

    const theirRowAfter = store.getResponsesByToken(org.id, theirs.token)[0];
    assert.deepEqual(theirRowAfter.data, { owner: 'theirs' }, 'the other participant\'s row is untouched');
});

test('an unknown response id is refused without confirming another participant\'s id exists', () => {
    // The refusal must not distinguish "no such id" from "not yours", so a
    // caller cannot probe for the existence of another participant's response.
    const org = newOrg('Probe resistance');
    const mine = invite(org.id, 'mine@example.com');
    const theirs = invite(org.id, 'theirs@example.com');
    const theirRow = store.addResponse(org.id, theirs.token, { department: 'Finance', data: { owner: 'theirs' } });

    let unknownError;
    let foreignError;
    try { store.updateResponse(org.id, mine.token, 'no-such-id', { x: 1 }); } catch (err) { unknownError = err; }
    try { store.updateResponse(org.id, mine.token, theirRow.id, { x: 1 }); } catch (err) { foreignError = err; }

    assert.ok(unknownError && foreignError, 'both refusals must throw');
    assert.equal(unknownError.message, foreignError.message, 'the two refusals must be indistinguishable');

    // Neither message may reveal whether the id exists, nor echo the id back.
    assert.ok(!unknownError.message.includes('no-such-id'), 'the message must not echo the id');
    assert.ok(!foreignError.message.includes(theirRow.id), 'the message must not echo the id');
    assert.ok(
        !/not found|no such|unknown|does not exist/i.test(unknownError.message),
        'the message must not say the id is absent'
    );
});

test('a wrong (non-empty) token returns nothing from the READ methods', () => {
    const org = newOrg('Unknown token');
    invite(org.id);

    assert.deepEqual(store.getResponsesByToken(org.id, 'no-such-token'), []);
    assert.equal(store.invitationForToken(org.id, 'no-such-token'), null);
});

// The read/write rule: reads return nothing for a token that yields no
// invitation, writes throw. A missing ?token= is a routine bad URL, not a 500 on
// a read path; a write with no valid credential is a caller error that must not
// be a null the caller forgets to check. The divergence is read versus write,
// not one spelling of a bad token versus another.

test('reads return nothing for an empty or non-string token, and never throw', () => {
    const org = newOrg('Unusable read token');
    const inv = invite(org.id);
    store.addResponse(org.id, inv.token, { department: 'Finance', data: { x: 1 } });

    for (const bad of ['', null, undefined]) {
        assert.deepEqual(store.getResponsesByToken(org.id, bad), [], `getResponsesByToken(${String(bad)}) must return []`);
        assert.equal(store.invitationForToken(org.id, bad), null, `invitationForToken(${String(bad)}) must return null`);
    }
});

test('writes throw for an empty or non-string token', () => {
    const org = newOrg('Unusable write token');
    const inv = invite(org.id);
    const row = store.addResponse(org.id, inv.token, { department: 'Finance', data: { x: 1 } });

    for (const bad of ['', null, undefined]) {
        assert.throws(
            () => store.addResponse(org.id, bad, { department: 'Finance', data: { x: 1 } }),
            /requires a participant token/,
            `addResponse(${String(bad)}) must throw`
        );
        assert.throws(
            () => store.updateResponse(org.id, bad, row.id, { x: 2 }),
            /requires a participant token/,
            `updateResponse(${String(bad)}) must throw`
        );
    }
});

test('writes throw for a well-formed but UNKNOWN token', () => {
    // Both writes behave the same way for an unknown token, so a caller does not
    // have to remember which of the two returns null. The message is not pinned
    // verbatim: it names a likely cause and may be reworded.
    const org = newOrg('Unknown write token');
    const inv = invite(org.id);
    const row = store.addResponse(org.id, inv.token, { department: 'Finance', data: { x: 1 } });

    assert.throws(
        () => store.addResponse(org.id, 'no-such-token', { department: 'Finance', data: { x: 1 } }),
        /resolves to no invitation/
    );
    assert.throws(
        () => store.updateResponse(org.id, 'no-such-token', row.id, { x: 2 }),
        /resolves to no invitation/
    );
});

test('a refused write leaves nothing behind', () => {
    const org = newOrg('Refused write');
    invite(org.id);

    assert.throws(() => store.addResponse(org.id, 'no-such-token', { department: 'Finance', data: { x: 1 } }));
    assert.deepEqual(store.getResponsesForAnalysis(org.id), [], 'a refused write must not insert a row');
});

test('invitationForToken records the first open and does not move it', () => {
    const org = newOrg('Opened');
    const inv = invite(org.id, 'opened@example.com');

    // The old markInvitationOpened became invitationForToken: it resolves the
    // token AND records the visit, so the property it pinned lives here now.
    const first = store.invitationForToken(org.id, inv.token);
    assert.equal(typeof first.opened_at, 'string');
    assert.equal(typeof first.last_seen_at, 'string');
    assert.equal('token' in first, false, 'the returned invitation must not carry the token');

    // A second open keeps the original opened_at (COALESCE), so the admin view
    // does not report the most recent visit as the opening.
    const second = store.invitationForToken(org.id, inv.token);
    assert.equal(second.opened_at, first.opened_at);
    assert.ok(second.last_seen_at >= first.last_seen_at, 'last_seen_at advances on the later visit');
});

test('getResponsesByToken parses the stored JSON back to an object', () => {
    const org = newOrg('Round trip');
    const inv = invite(org.id);
    store.addResponse(org.id, inv.token, { department: 'Finance', data: { nested: { a: [1, 2, 3] }, s: 'text' } });

    const row = store.getResponsesByToken(org.id, inv.token)[0];
    assert.deepEqual(row.data, { nested: { a: [1, 2, 3] }, s: 'text' });
    assert.equal(row.unreadable, false);
});

// ===========================================================================
// 6. TOKENS
// ===========================================================================

test('a generated token is 43 base64url characters', () => {
    const token = store.generateToken();
    assert.equal(token.length, 43);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
});

test('many generated tokens are all distinct', () => {
    const seen = new Set();
    for (let i = 0; i < 500; i += 1) seen.add(store.generateToken());
    assert.equal(seen.size, 500, 'a collision in 500 CSPRNG tokens would mean the generator is broken');
});

test('invitation tokens are also 43 base64url characters', () => {
    const org = newOrg('Token shape');
    const inv = invite(org.id);
    assert.equal(inv.token.length, 43);
    assert.match(inv.token, /^[A-Za-z0-9_-]{43}$/);
});

test('hashToken returns 64 lowercase hex characters', () => {
    const hash = store.hashToken('some-token');
    assert.equal(hash.length, 64);
    assert.match(hash, /^[0-9a-f]{64}$/);
});

test('hashToken is deterministic and rejects empty input', () => {
    assert.equal(store.hashToken('abc'), store.hashToken('abc'));
    assert.notEqual(store.hashToken('abc'), store.hashToken('abd'));
    assert.throws(() => store.hashToken(''), /non-empty/);
    assert.throws(() => store.hashToken(null), /non-empty/);
});

test('the stored token is the hash, never the raw value', () => {
    const org = newOrg('Stored hash');
    const inv = invite(org.id, 'hash@example.com');
    store.closeAll();

    const db = new DatabaseSync(store.orgDbPath(org.id));
    const row = db.prepare('SELECT token_hash FROM participant_tokens WHERE invitation_id = ?').get(inv.id);
    db.close();

    assert.ok(row, 'a token row exists for the invitation');
    assert.notEqual(row.token_hash, inv.token, 'the raw token must not be stored');
    assert.equal(row.token_hash, store.hashToken(inv.token), 'the stored value must be the hash of the token');
    assert.match(row.token_hash, /^[0-9a-f]{64}$/);
});

test('the raw token appears nowhere in the database file', () => {
    // Stronger than reading one column back: scan the bytes. A raw token written
    // into any table, index or free page would show up here, and the login link
    // is a credential, so nothing usable may be recoverable from the file.
    const org = newOrg('File scan');
    const inv = invite(org.id, 'scan@example.com');
    store.addResponse(org.id, inv.token, { department: 'Finance', data: { x: 1 } });
    store.closeAll();

    const bytes = fs.readFileSync(store.orgDbPath(org.id));
    assert.equal(bytes.includes(Buffer.from(inv.token)), false, 'the bearer value must not be in the file');
});

test('several tokens may be live for one invitation, and each resolves', () => {
    // The capability the single-column model could not express: "Send a link"
    // adds a working link without retiring the one already held.
    const org = newOrg('Several live tokens');
    const inv = invite(org.id, 'several@example.com');

    const second = store.issueAdditionalLink(org.id, inv.id);

    assert.notEqual(second, inv.token, 'a fresh token is issued');
    assert.notEqual(store.invitationForToken(org.id, inv.token), null, 'the first token is still live');
    assert.notEqual(store.invitationForToken(org.id, second), null, 'the second token is live too');
});

test('an additional link leaves earlier tokens live', () => {
    // "Send a link" must not break a link the participant already holds: a second
    // mail is not a reason to invalidate the first.
    const org = newOrg('Send a link');
    const inv = invite(org.id);
    store.addResponse(org.id, inv.token, { department: 'Finance', data: { keep: true } });

    const second = store.issueAdditionalLink(org.id, inv.id);

    assert.deepEqual(store.getResponsesByToken(org.id, inv.token).map((r) => r.data), [{ keep: true }]);
    assert.deepEqual(store.getResponsesByToken(org.id, second).map((r) => r.data), [{ keep: true }]);
});

test('a reset revokes every token and issues one replacement', () => {
    const org = newOrg('Reset revokes all');
    const inv = invite(org.id);
    const second = store.issueAdditionalLink(org.id, inv.id);

    const replacement = store.resetAccess(org.id, inv.id);

    assert.equal(store.invitationForToken(org.id, inv.token), null, 'the first token is revoked');
    assert.equal(store.invitationForToken(org.id, second), null, 'the second token is revoked');
    assert.notEqual(store.invitationForToken(org.id, replacement), null, 'the replacement resolves');
});

test('a reset leaves existing responses attached to the invitation', () => {
    // THE PROPERTY invitation.id EXISTS FOR, and the most valuable test here: a
    // bug in this silently loses a participant's work rather than failing loudly.
    // End to end: answer on the old token, reset, and reach the same answers on
    // the new one.
    const org = newOrg('Reset keeps answers');
    const inv = invite(org.id);
    store.addResponse(org.id, inv.token, { department: 'Finance', data: { answer: 'my work' } });

    const replacement = store.resetAccess(org.id, inv.id);

    const viaNewToken = store.getResponsesByToken(org.id, replacement);
    assert.deepEqual(viaNewToken.map((r) => r.data), [{ answer: 'my work' }], 'the answers survived the reset');
    // The old token no longer reads them, but the work itself is still there.
    assert.deepEqual(store.getResponsesByToken(org.id, inv.token), []);
    assert.equal(store.getResponsesForAnalysis(org.id).length, 1, 'the answer is still in the organisation');
});

test('an expired token is refused by both read paths', () => {
    const org = newOrg('Expired token');
    const inv = invite(org.id);
    store.addResponse(org.id, inv.token, { department: 'Finance', data: { x: 1 } });
    store.closeAll();

    const db = new DatabaseSync(store.orgDbPath(org.id));
    db.prepare('UPDATE participant_tokens SET expires_at = ? WHERE invitation_id = ?')
        .run(new Date(Date.now() - 1000).toISOString(), inv.id);
    db.close();

    assert.equal(store.invitationForToken(org.id, inv.token), null);
    assert.deepEqual(store.getResponsesByToken(org.id, inv.token), []);
});

test('a revoked token is refused by both read paths', () => {
    const org = newOrg('Revoked token');
    const inv = invite(org.id);
    store.addResponse(org.id, inv.token, { department: 'Finance', data: { x: 1 } });

    // A reset revokes the old token; it must stop resolving immediately.
    assert.notEqual(store.invitationForToken(org.id, inv.token), null, 'live before the reset');
    store.resetAccess(org.id, inv.id);

    assert.equal(store.invitationForToken(org.id, inv.token), null);
    assert.deepEqual(store.getResponsesByToken(org.id, inv.token), []);
});

test('the console lists how many tokens are live and which are revoked', () => {
    const org = newOrg('Token listing');
    const inv = invite(org.id);
    store.issueAdditionalLink(org.id, inv.id);

    const live = store.listTokensForInvitation(org.id, inv.id);
    assert.equal(live.length, 2);
    assert.equal(live.filter((t) => t.live).length, 2, 'both are live before a reset');
    assert.equal(JSON.stringify(live).includes('token_hash'), false, 'a hash must never be listed');

    store.resetAccess(org.id, inv.id);
    const after = store.listTokensForInvitation(org.id, inv.id);
    assert.equal(after.length, 3, 'the reset keeps the revoked rows for the audit trail');
    assert.equal(after.filter((t) => t.live).length, 1, 'exactly one is live after the reset');
    assert.equal(JSON.stringify(after).includes('token_hash'), false, 'a hash must never be listed');
});

test('the raw token does not appear anywhere in the database file', () => {
    const org = newOrg('File scan');
    const inv = invite(org.id, 'scan@example.com');
    store.addResponse(org.id, inv.token, { department: 'Finance', data: { x: 1 } });
    store.closeAll();

    const bytes = fs.readFileSync(store.orgDbPath(org.id));
    assert.equal(bytes.includes(Buffer.from(inv.token)), false, 'the bearer value must not be in the file');
});

// ===========================================================================
// 7. FAILURE BEHAVIOUR
// ===========================================================================

test('createOrganisation requires a non-empty name', () => {
    for (const name of ['', '   ', '\t\n', null, undefined, 42, {}]) {
        assert.throws(() => store.createOrganisation(name), /non-empty name/);
    }
});

test('createOrganisation returns the row it created', () => {
    const org = store.createOrganisation('Named org');
    assert.equal(org.name, 'Named org');
    assert.equal(org.finished_at, null);
    assert.equal(typeof org.created_at, 'string');
    assert.match(org.id, /^[a-z0-9][a-z0-9-]{0,63}$/);
});

test('two organisations have distinct generated ids', () => {
    const a = newOrg('A');
    const b = newOrg('B');
    assert.notEqual(a.id, b.id);
});

test('addInvitation requires a non-empty email and department', () => {
    const org = newOrg('Invite validation');
    assert.throws(() => store.addInvitation(org.id, { email: '', department: 'Finance' }), /non-empty email/);
    assert.throws(() => store.addInvitation(org.id, { email: '   ', department: 'Finance' }), /non-empty email/);
    assert.throws(() => store.addInvitation(org.id, { email: 'a@b.com', department: '' }), /non-empty department/);
    assert.throws(() => store.addInvitation(org.id, {}), /non-empty email/);
    assert.throws(() => store.addInvitation(org.id), /non-empty email/);
    assert.throws(() => store.addInvitation(org.id, { email: 42, department: 'Finance' }), /non-empty email/);
});

test('addInvitation to an unknown organisation throws', () => {
    assert.throws(
        () => store.addInvitation('a0000000-0000-4000-8000-000000000000', { email: 'a@b.com', department: 'Finance' }),
        /does not exist/
    );
});

test('addInvitation returns the token exactly once, alongside the invitation', () => {
    const org = newOrg('Token once');
    const inv = invite(org.id, 'once@example.com');
    assert.equal(typeof inv.token, 'string');
    assert.equal(inv.email, 'once@example.com');
    assert.equal(inv.department, 'Finance');
    assert.equal(inv.opened_at, null);
});

test('addResponse requires a department and data', () => {
    const org = newOrg('Response validation');
    const inv = invite(org.id);

    assert.throws(() => store.addResponse(org.id, inv.token, { data: { x: 1 } }), /non-empty department/);
    assert.throws(() => store.addResponse(org.id, inv.token, { department: '', data: { x: 1 } }), /non-empty department/);
    assert.throws(() => store.addResponse(org.id, inv.token, { department: 'Finance' }), /requires data/);
    assert.throws(() => store.addResponse(org.id, inv.token, { department: 'Finance', data: undefined }), /requires data/);
});

test('data that cannot be serialised to JSON fails loudly', () => {
    const org = newOrg('Serialisation');
    const inv = invite(org.id);
    const circular = {};
    circular.self = circular;

    assert.throws(
        () => store.addResponse(org.id, inv.token, { department: 'Finance', data: circular }),
        /could not be serialised/
    );
});

test('a response whose stored JSON is corrupt is reported as unreadable, not as absent', () => {
    const org = newOrg('Corrupt row');
    const inv = invite(org.id);
    const created = store.addResponse(org.id, inv.token, { department: 'Finance', data: { x: 1 } });
    store.closeAll();

    // Damage the stored blob directly, the way a partial write or a bad migration would.
    const db = new DatabaseSync(store.orgDbPath(org.id));
    db.prepare('UPDATE response SET data = ? WHERE id = ?').run('{ this is not json', created.id);
    db.close();

    const row = store.getResponsesByToken(org.id, inv.token)[0];
    assert.equal(row.id, created.id, 'the row must still be returned, not dropped');
    assert.equal(row.data, null);
    assert.equal(row.unreadable, true, 'an unreadable answer is not the same as no answer');
});

test('an unknown organisation is reported as null, not as an error, for reads', () => {
    assert.equal(store.getOrganisation('a0000000-0000-4000-8000-000000000000'), null);
    assert.equal(store.isOrganisationFinished('a0000000-0000-4000-8000-000000000000'), false);
});

test('a read for an unknown organisation returns nothing and does NOT create a file', () => {
    // The defect: a read for an id belonging to no organisation used to open a
    // path, which CREATES the file, conjuring an empty tenant. A stale cookie
    // then got a clean-looking empty organisation, and listOrganisationIds()
    // could no longer tell a real organisation from one invented by a bad
    // request.
    const orgsDir = path.join(STORE_DIR, 'orgs');
    const filesBefore = fs.readdirSync(orgsDir).filter((n) => n.endsWith('.db'));

    const unknown = 'a0000000-0000-4000-8000-000000000002';
    assert.throws(() => store.getResponsesForAnalysis(unknown), /does not exist/);
    assert.throws(() => store.listInvitations(unknown), /does not exist/);
    assert.throws(() => store.getResponsesByToken(unknown, 'any-token'), /does not exist/);

    const filesAfter = fs.readdirSync(orgsDir).filter((n) => n.endsWith('.db'));
    assert.deepEqual(filesAfter, filesBefore, 'a read must not create a database file');
    assert.equal(fs.existsSync(path.join(orgsDir, `${unknown}.db`)), false);

    // The phantom must not become a tenant the admin is shown.
    assert.equal(store.listOrganisationIds().includes(unknown), false);
});

test('a read for an unknown organisation does not make the id a usable tenant afterwards', () => {
    // Even after a failed read, the id must stay unusable by every route.
    const unknown = 'b0000000-0000-4000-8000-000000000003';
    assert.throws(() => store.getResponsesForAnalysis(unknown));

    assert.equal(store.getOrganisation(unknown), null);
    assert.equal(store.isOrganisationFinished(unknown), false);
    assert.throws(() => store.addInvitation(unknown, { email: 'a@b.com', department: 'Finance' }));
    assert.throws(() => store.finishOrganisation(unknown));
});

test('listOrganisationIds lists every created organisation and nothing else', () => {
    const org = newOrg('Listed');
    const ids = store.listOrganisationIds();
    assert.ok(ids.includes(org.id), 'a created organisation must be listed');
    assert.deepEqual(ids, [...ids].sort(), 'the list is sorted');
    assert.ok(!ids.includes('not-an-organisation'), 'a bogus id is not listed');
});

test('a corrupt schema version is refused rather than read with the wrong queries', () => {
    const org = newOrg('Version check');
    store.closeAll();

    const db = new DatabaseSync(store.orgDbPath(org.id));
    db.exec("UPDATE schema_meta SET value = '2' WHERE key = 'schema_version'");
    db.close();

    assert.throws(() => store.getOrganisation(org.id), /Schema version mismatch/);
});

// ===========================================================================
// CROSS-CUTTING: determinism and purity of ordering
// ===========================================================================

test('getResponsesForAnalysis is stable across repeated calls', () => {
    const org = newOrg('Stable reads');
    const inv = invite(org.id);
    store.addResponse(org.id, inv.token, { department: 'Finance', data: { a: 1 } });
    store.addResponse(org.id, inv.token, { department: 'Finance', data: { b: 2 } });

    assert.equal(
        JSON.stringify(store.getResponsesForAnalysis(org.id)),
        JSON.stringify(store.getResponsesForAnalysis(org.id))
    );
});

test('closeConnection reports whether a connection was open', () => {
    const org = newOrg('Close reporting');
    assert.equal(store.closeConnection(org.id), true, 'an open organisation closes');
    assert.equal(store.closeConnection(org.id), false, 'closing again reports nothing to close');
    // Re-opening after a close works and the data survives.
    assert.equal(store.getOrganisation(org.id).name, 'Close reporting');
});

// ===========================================================================
// 8. CONCURRENCY
// ===========================================================================
//
// The schema sets journal_mode = WAL, which is a deliberate choice for readers
// and writers coexisting. The interface exposes ONE cached connection per
// organisation (registry.js caches by org id and connectionFor is not exported),
// so two connections to the same file are opened here through node:sqlite
// directly. That is the same file, the same schema and the same pragmas the
// store applies; only the connection is independent.
//
// NOT covered here: two PROCESSES. They cannot be driven from this suite without
// a second entry point that opens the store, and the two-connection case already
// exercises the shared-file behaviour WAL is about. Named here so the gap is
// explicit rather than implied.

/** A second, independent connection to an organisation's file. */
function secondConnection(orgId) {
    const db = new DatabaseSync(store.orgDbPath(orgId));
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA journal_mode = WAL');
    return db;
}

test('the database runs in WAL mode', () => {
    const org = newOrg('WAL mode');
    const db = secondConnection(org.id);
    try {
        const mode = db.prepare('PRAGMA journal_mode').get().journal_mode;
        assert.equal(mode, 'wal', 'WAL is what lets a reader and a writer coexist');
    } finally {
        db.close();
    }
});

test('a write through the store is visible through a second connection', () => {
    const org = newOrg('Cross-connection read');
    const inv = invite(org.id);
    store.addResponse(org.id, inv.token, { department: 'Finance', data: { via: 'store' } });

    const db = secondConnection(org.id);
    try {
        const row = db.prepare('SELECT COUNT(*) AS n FROM response').get();
        assert.equal(row.n, 1, 'the second connection must see the committed row');
    } finally {
        db.close();
    }
});

test('a write through a second connection is visible through the store', () => {
    const org = newOrg('Cross-connection write');
    const inv = invite(org.id);
    store.addResponse(org.id, inv.token, { department: 'Finance', data: { order: 1 } });

    const db = secondConnection(org.id);
    try {
        const invitation = db.prepare('SELECT id FROM invitation').get();
        db.prepare(
            `INSERT INTO response (id, invitation_id, department, data, created_at, updated_at, submitted_at)
             VALUES (?, ?, ?, ?, ?, ?, NULL)`
        ).run('external-1', invitation.id, 'Finance', JSON.stringify({ via: 'second' }), '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    } finally {
        db.close();
    }

    const rows = store.getResponsesForAnalysis(org.id);
    assert.equal(rows.length, 2);
    const markers = rows.map((r) => (r.data.via === 'second' ? 'second' : 'order-1'));
    assert.deepEqual(markers.sort(), ['order-1', 'second']);
});

test('interleaved writes from two connections both land, with no loss', () => {
    const org = newOrg('Interleaved');
    const inv = invite(org.id);
    const db = secondConnection(org.id);
    const invitation = db.prepare('SELECT id FROM invitation').get();

    try {
        for (let i = 0; i < 5; i += 1) {
            store.addResponse(org.id, inv.token, { department: 'Finance', data: { seq: `store-${i}` } });
            db.prepare(
                `INSERT INTO response (id, invitation_id, department, data, created_at, updated_at, submitted_at)
                 VALUES (?, ?, ?, ?, ?, ?, NULL)`
            ).run(`db2-${i}`, invitation.id, 'Finance', JSON.stringify({ seq: `db2-${i}` }), '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
        }
    } finally {
        db.close();
    }

    const rows = store.getResponsesForAnalysis(org.id);
    assert.equal(rows.length, 10, 'every interleaved write must be present');
    assert.equal(new Set(rows.map((r) => r.data.seq)).size, 10, 'no write may be lost or overwritten');
});

test('two connections do not corrupt the file', () => {
    const org = newOrg('Integrity');
    const inv = invite(org.id);

    const db = secondConnection(org.id);
    const invitation = db.prepare('SELECT id FROM invitation').get();
    try {
        for (let i = 0; i < 10; i += 1) {
            store.addResponse(org.id, inv.token, { department: 'Finance', data: { i } });
            db.prepare(
                `INSERT INTO response (id, invitation_id, department, data, created_at, updated_at, submitted_at)
                 VALUES (?, ?, ?, ?, ?, ?, NULL)`
            ).run(`int-${i}`, invitation.id, 'Finance', '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
        }
        const check = db.prepare('PRAGMA integrity_check').get().integrity_check;
        assert.equal(check, 'ok', 'the file must remain intact after interleaved writes');
    } finally {
        db.close();
    }
});

test('a reader is not blocked while another connection holds a write transaction', () => {
    // This is the property WAL exists for: readers see the last committed
    // snapshot instead of waiting for the writer, and do not fail.
    const org = newOrg('Read during write');
    const inv = invite(org.id);
    store.addResponse(org.id, inv.token, { department: 'Finance', data: { before: true } });

    const db = secondConnection(org.id);
    db.exec('BEGIN IMMEDIATE');
    try {
        db.prepare("UPDATE response SET data = '{\"touched\":true}'").run();

        // A read through the store must succeed and see the pre-transaction state.
        const during = store.getResponsesForAnalysis(org.id);
        assert.equal(during.length, 1);
        assert.deepEqual(during[0].data, { before: true }, 'an uncommitted change must not be visible');
    } finally {
        db.exec('COMMIT');
        db.close();
    }

    assert.deepEqual(store.getResponsesForAnalysis(org.id)[0].data, { touched: true }, 'the commit is visible after it lands');
});

// Write contention. WAL permits one writer at a time, so a second writer must
// wait its turn rather than fail. The store sets a busy timeout on its
// connection; without it a participant submitting while another is mid-write
// gets an immediate "database is locked" and, in production, a 500.
//
// node:sqlite is synchronous on the calling thread, so a blocked call cannot be
// unblocked by a timer in the same thread. The lock is therefore held and
// released from a WORKER thread, which is the only way to exercise a real wait.

const LOCK_WORKER = new URL('./helpers/hold-write-lock.mjs', import.meta.url);

/**
 * Starts a worker that opens the organisation file, takes a write transaction,
 * and commits after `holdMs`. Never commits when `holdMs` is Infinity.
 *
 * @returns {Promise<import('node:worker_threads').Worker>} Resolves once the
 *   worker reports that it holds the lock.
 */
async function holdWriteLock(dbPath, holdMs) {
    const { Worker } = await import('node:worker_threads');
    const worker = new Worker(LOCK_WORKER, { workerData: { dbPath, holdMs } });
    await new Promise((resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
    });
    return worker;
}

test('a contending write waits for the lock and then succeeds', async () => {
    const org = newOrg('Write contention wait');
    const inv = invite(org.id);
    store.addResponse(org.id, inv.token, { department: 'Finance', data: { first: true } });

    // The worker holds the write lock for ~400ms, then commits and exits.
    const worker = await holdWriteLock(store.orgDbPath(org.id), 400);

    const started = Date.now();
    let error;
    try {
        store.addResponse(org.id, inv.token, { department: 'Finance', data: { second: true } });
    } catch (err) {
        error = err;
    }
    const elapsed = Date.now() - started;

    await new Promise((resolve) => worker.once('exit', resolve));

    assert.equal(error, undefined, `the write must not fail while the lock is held briefly: ${error && error.message}`);
    assert.ok(elapsed >= 200, `the write must have waited for the lock, but returned after ${elapsed}ms`);

    // Both writes are present: the wait did not lose the earlier one.
    const rows = store.getResponsesForAnalysis(org.id);
    assert.equal(rows.length, 2);
});

test('a genuine, unresolvable contention still surfaces as an error', async () => {
    // A lock held for far longer than any sane timeout must fail loudly, not
    // hang and not be swallowed. This is the guard on the fix: a busy timeout
    // that turned every contention into a silent success would be worse than
    // the immediate error it replaced.
    const org = newOrg('Write contention forever');
    const inv = invite(org.id);

    const worker = await holdWriteLock(store.orgDbPath(org.id), Infinity);
    try {
        assert.throws(
            () => store.addResponse(org.id, inv.token, { department: 'Finance', data: { never: true } }),
            /database is locked/,
            'a lock that is never released must still raise an error'
        );
    } finally {
        await worker.terminate();
    }

    // The refused write left nothing behind.
    assert.deepEqual(store.getResponsesForAnalysis(org.id), []);
});

// ===========================================================================
// 9. STORED-HASH BEHAVIOUR (observable, without importing below the interface)
// ===========================================================================
//
// tokens.js exports tokenHashesMatch and normaliseStoredHash, but neither is on
// the store interface. Rather than importing below it, these tests damage the
// stored hash directly in the database file and observe what the public methods
// do, which is the same black-box technique used for the corrupt-JSON case.

test('a token resolves while the stored hash is exactly what the code writes', () => {
    const org = newOrg('Correct hash');
    const inv = invite(org.id, 'correct@example.com');
    store.addResponse(org.id, inv.token, { department: 'Finance', data: { x: 1 } });

    // Both read paths resolve the token.
    assert.equal(store.getResponsesByToken(org.id, inv.token).length, 1);
    assert.notEqual(store.invitationForToken(org.id, inv.token), null);
});

test('a malformed stored hash does not authenticate the token', () => {
    const org = newOrg('Malformed hash');
    const inv = invite(org.id);
    store.addResponse(org.id, inv.token, { department: 'Finance', data: { x: 1 } });
    store.closeAll();

    const db = new DatabaseSync(store.orgDbPath(org.id));
    db.prepare('UPDATE participant_tokens SET token_hash = ? WHERE invitation_id = ?').run('not-a-valid-hash', inv.id);
    db.close();

    // The token no longer resolves, and nothing throws on the read path.
    assert.deepEqual(store.getResponsesByToken(org.id, inv.token), []);
    assert.equal(store.invitationForToken(org.id, inv.token), null);

    // A corrupt credential must not break the rest of the organisation.
    assert.equal(store.listInvitations(org.id).length, 1);
    assert.equal(store.getResponsesForAnalysis(org.id).length, 1);
});

test('a truncated stored hash does not authenticate the token', () => {
    const org = newOrg('Truncated hash');
    const inv = invite(org.id);
    store.closeAll();

    const db = new DatabaseSync(store.orgDbPath(org.id));
    db.prepare('UPDATE participant_tokens SET token_hash = ? WHERE invitation_id = ?')
        .run(store.hashToken(inv.token).slice(0, 32), inv.id);
    db.close();

    assert.deepEqual(store.getResponsesByToken(org.id, inv.token), []);
});

// The stored hash is compared as exact text against the lowercase hash of the
// presented token (`WHERE token_hash = ?`). An uppercase row is therefore never
// selected and behaves like a missing invitation: the credential fails closed.
// There is deliberately no normalisation, because it could only run after the row
// was found, where it could not change the outcome, and normalising in the query
// (lower(token_hash) = ?) would lose the index. This test pins the consequence:
// an uppercase row does not resolve.
test('an uppercase stored hash does not resolve, and fails closed', () => {
    const org = newOrg('Uppercase hash');
    const inv = invite(org.id);
    store.addResponse(org.id, inv.token, { department: 'Finance', data: { x: 1 } });
    store.closeAll();

    const db = new DatabaseSync(store.orgDbPath(org.id));
    const stored = db.prepare('SELECT token_hash FROM participant_tokens WHERE invitation_id = ?').get(inv.id).token_hash;
    assert.match(stored, /^[0-9a-f]{64}$/, 'the code writes lowercase hex');
    db.prepare('UPDATE participant_tokens SET token_hash = ? WHERE invitation_id = ?').run(stored.toUpperCase(), inv.id);
    db.close();

    assert.deepEqual(store.getResponsesByToken(org.id, inv.token), [], 'the uppercase row is not matched');
    assert.equal(store.invitationForToken(org.id, inv.token), null);
});

// ===========================================================================
// 10. CONFIGURATION: THE BUSY TIMEOUT
// ===========================================================================
//
// busyTimeoutMs is read from STORE_BUSY_TIMEOUT_MS when a connection is opened.
// Getting it wrong is invisible until contention, which is why it is tested
// directly rather than only through a contended write.
//
// The defect this covers: `Number('')` is 0, so an EMPTY variable - the usual
// way to disable one in a .env or a container environment - silently set the
// wait to zero and reinstated the immediate "database is locked" failure the
// setting exists to prevent.
//
// busy-timeout.js is imported directly because the function is not re-exported
// through lib/store/index.js, which is a list of operations rather than of
// configuration readers. It is the module the task named for this behaviour.

const { busyTimeoutMs } = await import('../lib/store/busy-timeout.js');

/** Runs `body` with STORE_BUSY_TIMEOUT_MS set, restoring the previous value. */
function withBusyTimeoutEnv(value, body) {
    const previous = process.env.STORE_BUSY_TIMEOUT_MS;
    if (value === undefined) delete process.env.STORE_BUSY_TIMEOUT_MS;
    else process.env.STORE_BUSY_TIMEOUT_MS = value;
    try {
        return body();
    } finally {
        if (previous === undefined) delete process.env.STORE_BUSY_TIMEOUT_MS;
        else process.env.STORE_BUSY_TIMEOUT_MS = previous;
    }
}

const DEFAULT_BUSY_TIMEOUT_MS = 2000;
const MAX_BUSY_TIMEOUT_MS = 60000;

test('an unset busy timeout uses the default', () => {
    assert.equal(withBusyTimeoutEnv(undefined, busyTimeoutMs), DEFAULT_BUSY_TIMEOUT_MS);
});

test('an EMPTY busy timeout uses the default, NOT zero', () => {
    // Number('') is 0. Treating an empty variable as zero would set no wait at
    // all, which is the exact bug the timeout was added to fix.
    assert.equal(withBusyTimeoutEnv('', busyTimeoutMs), DEFAULT_BUSY_TIMEOUT_MS);
});

test('a whitespace-only busy timeout uses the default, NOT zero', () => {
    for (const value of [' ', '\t', '\n', '   \t  ']) {
        assert.equal(withBusyTimeoutEnv(value, busyTimeoutMs), DEFAULT_BUSY_TIMEOUT_MS, `value ${JSON.stringify(value)}`);
    }
});

test('an explicit busy timeout is used as given', () => {
    assert.equal(withBusyTimeoutEnv('500', busyTimeoutMs), 500);
    assert.equal(withBusyTimeoutEnv('1500', busyTimeoutMs), 1500);
    assert.equal(withBusyTimeoutEnv('0', busyTimeoutMs), 0, 'an explicit zero is honoured, unlike an empty string');
});

test('a busy timeout above the maximum is clamped', () => {
    assert.equal(withBusyTimeoutEnv('999999999', busyTimeoutMs), MAX_BUSY_TIMEOUT_MS);
    assert.equal(withBusyTimeoutEnv(String(MAX_BUSY_TIMEOUT_MS + 1), busyTimeoutMs), MAX_BUSY_TIMEOUT_MS);
});

test('a busy timeout exactly at the maximum is not clamped', () => {
    assert.equal(withBusyTimeoutEnv(String(MAX_BUSY_TIMEOUT_MS), busyTimeoutMs), MAX_BUSY_TIMEOUT_MS);
    assert.equal(withBusyTimeoutEnv(String(MAX_BUSY_TIMEOUT_MS - 1), busyTimeoutMs), MAX_BUSY_TIMEOUT_MS - 1);
});

test('a negative or non-numeric busy timeout falls back to the default', () => {
    for (const value of ['-1', '-100', 'abc', '1e999', 'NaN']) {
        assert.equal(withBusyTimeoutEnv(value, busyTimeoutMs), DEFAULT_BUSY_TIMEOUT_MS, `value ${JSON.stringify(value)}`);
    }
});

test('the busy timeout is applied to a real connection', () => {
    // The function returning 1234 is not enough; the pragma must actually be set
    // on the connection the store opens for an organisation. connectionFor is
    // read from registry.js, which owns the connection lifecycle, so this checks
    // the connection the store really hands to its own methods.
    const previous = process.env.STORE_BUSY_TIMEOUT_MS;
    process.env.STORE_BUSY_TIMEOUT_MS = '1234';
    try {
        store.closeAll();
        const org = newOrg('Busy timeout applied');
        const db = registry.connectionFor(org.id);
        assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 1234);
    } finally {
        if (previous === undefined) delete process.env.STORE_BUSY_TIMEOUT_MS;
        else process.env.STORE_BUSY_TIMEOUT_MS = previous;
        store.closeAll();
    }
});

test('the default busy timeout is applied when the variable is unset', () => {
    const previous = process.env.STORE_BUSY_TIMEOUT_MS;
    delete process.env.STORE_BUSY_TIMEOUT_MS;
    try {
        store.closeAll();
        const org = newOrg('Default busy timeout');
        const db = registry.connectionFor(org.id);
        assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, DEFAULT_BUSY_TIMEOUT_MS);
    } finally {
        if (previous !== undefined) process.env.STORE_BUSY_TIMEOUT_MS = previous;
        store.closeAll();
    }
});

// ===========================================================================
// 11. TOKEN HASH COMPARISON: THE EXACT-FORM CONTRACT
// ===========================================================================
//
// tokenHashesMatch is defined in tokens.js and is not re-exported through the
// index, so it is imported from the module the task named. The contract chosen
// (read after the builder landed it): the comparison is EXACT and lowercase hex
// is the only accepted form. That is a deliberate tightening, not an oversight:
// the end-to-end lookup fails closed on an uppercase row because the SELECT
// binds a lowercase hash, and this function now agrees with it rather than
// accepting a form hashToken never writes.

const { tokenHashesMatch } = await import('../lib/store/tokens.js');

test('tokenHashesMatch accepts two identical lowercase hashes', () => {
    const hash = store.hashToken('a-token');
    assert.equal(tokenHashesMatch(hash, hash), true);
});

test('tokenHashesMatch rejects an uppercase hash', () => {
    // Contradicting the old comment, which claimed an uppercase copy of the same
    // hash would match. The chosen contract is exact, so it must not.
    const hash = store.hashToken('a-token');
    assert.equal(tokenHashesMatch(hash, hash.toUpperCase()), false, 'uppercase on the right must not match');
    assert.equal(tokenHashesMatch(hash.toUpperCase(), hash), false, 'uppercase on the left must not match');
});

test('tokenHashesMatch rejects anything that is not 64 lowercase hex', () => {
    const hash = store.hashToken('a-token');
    assert.equal(tokenHashesMatch(hash, hash.slice(0, 63)), false, 'a short hash');
    assert.equal(tokenHashesMatch(hash, `${hash}0`), false, 'a long hash');
    assert.equal(tokenHashesMatch(hash, 'z'.repeat(64)), false, 'non-hex characters');
    assert.equal(tokenHashesMatch(hash, ''), false, 'empty');
    assert.equal(tokenHashesMatch(hash, null), false, 'null');
    assert.equal(tokenHashesMatch(hash, undefined), false, 'undefined');
    assert.equal(tokenHashesMatch(hash, 42), false, 'a number');
});

test('tokenHashesMatch does not throw on malformed input', () => {
    // The hex guard exists so a malformed value cannot throw out of the compare.
    for (const bad of [null, undefined, 42, {}, [], 'not-hex', 'f'.repeat(63)]) {
        assert.doesNotThrow(() => tokenHashesMatch('a'.repeat(64), bad));
    }
});

test('an uppercase stored hash fails closed end to end, and the outcome matches tokenHashesMatch', () => {
    // The observable consequence, through the interface: an uppercase row does
    // not authenticate. Both layers agree, which is the point of the tightening.
    const org = newOrg('Uppercase end to end');
    const inv = invite(org.id);
    store.addResponse(org.id, inv.token, { department: 'Finance', data: { x: 1 } });
    store.closeAll();

    const db = new DatabaseSync(store.orgDbPath(org.id));
    const stored = db.prepare('SELECT token_hash FROM participant_tokens WHERE invitation_id = ?').get(inv.id).token_hash;
    db.prepare('UPDATE participant_tokens SET token_hash = ? WHERE invitation_id = ?').run(stored.toUpperCase(), inv.id);
    db.close();

    assert.equal(tokenHashesMatch(stored.toUpperCase(), store.hashToken(inv.token)), false, 'the comparator refuses the form');
    assert.deepEqual(store.getResponsesByToken(org.id, inv.token), [], 'and the lookup finds nothing');
});

// ===========================================================================
// 12. WRITE TIMING: WHICH LOCK ERRORS ARE REPORTED
// ===========================================================================
//
// timedWrite wraps the two write operations. The defect this covers: the
// diagnostic matched the exact string "database is locked", so the other
// spellings SQLite emits - "database table is locked", different capitalisation,
// and the driver's numeric code - were not reported, which means the one thing
// this module exists to report was missed for those forms.
//
// write-timing.js is imported directly, because timedWrite is not re-exported
// through lib/store/index.js. It is the module the task named for this behaviour.

const { timedWrite } = await import('../lib/store/write-timing.js');

/** Runs timedWrite and captures console.warn/console.error output. */
function runTimedWrite(write) {
    const warned = [];
    const errored = [];
    const originalWarn = console.warn;
    const originalError = console.error;
    console.warn = (...args) => warned.push(args.join(' '));
    console.error = (...args) => errored.push(args.join(' '));
    let returned;
    let thrown;
    try {
        returned = timedWrite('org-1', 'addResponse', write);
    } catch (err) {
        thrown = err;
    } finally {
        console.warn = originalWarn;
        console.error = originalError;
    }
    return { returned, thrown, warned, errored };
}

test('timedWrite returns the write result and never swallows a success', () => {
    const { returned, thrown, errored } = runTimedWrite(() => 'the-result');
    assert.equal(returned, 'the-result');
    assert.equal(thrown, undefined);
    assert.deepEqual(errored, []);
});

test('timedWrite reports every lock-error spelling SQLite emits', () => {
    const spellings = [
        'database is locked',
        'database table is locked',
        'Database is locked',
        'DATABASE IS LOCKED',
        'SQLITE_BUSY: database is locked'
    ];
    for (const message of spellings) {
        const { errored, thrown } = runTimedWrite(() => { throw new Error(message); });
        assert.equal(thrown.message, message, 'the error must still be rethrown');
        assert.ok(
            errored.some((line) => line.includes('gave up after')),
            `a lock error with message ${JSON.stringify(message)} must be reported, got: ${JSON.stringify(errored)}`
        );
    }
});

test('timedWrite reports a lock error surfaced by numeric code without a recognisable message', () => {
    for (const errcode of [5, 6]) {
        const err = new Error('something else entirely');
        err.errcode = errcode;
        const { errored } = runTimedWrite(() => { throw err; });
        assert.ok(
            errored.some((line) => line.includes('gave up after')),
            `errcode ${errcode} (SQLITE_BUSY/LOCKED) must be reported`
        );
    }
});

test('timedWrite rethrows a non-lock error without reporting it as contention', () => {
    const { errored, thrown } = runTimedWrite(() => { throw new Error('disk I/O error'); });
    assert.equal(thrown.message, 'disk I/O error', 'the failure must surface, not disappear');
    assert.deepEqual(errored, [], 'a non-lock error must not be described as lock contention');
});

test('timedWrite does not report a fast success as having waited for a lock', () => {
    const { warned } = runTimedWrite(() => 'quick');
    assert.ok(
        !warned.some((line) => line.includes('waited')),
        'a fast write must not be logged as contention'
    );
});
