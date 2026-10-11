/**
 * The schema refusal leaves the file byte-identical.
 *
 * WHY THIS FILE EXISTS. Commit 0708717 fixed a defect where the version assertion
 * ran AFTER `db.exec(schemaSql())`, so a refused open of an older file was
 * half-migrated first: `CREATE TABLE IF NOT EXISTS` added every table the old file
 * lacked, leaving it v6-SHAPED and stamped with its old version, and every later
 * open refused it again. Three commits touched fourteen source files and zero test
 * files, and reverting the fix passed the whole suite.
 *
 * MEASURED BY SHA-256 OF THE WHOLE FILE, not by size. The builder first claimed
 * size stayed identical; the reviewer showed that claim is conditionally
 * informative: it holds exactly when the file already contains the tables the
 * schema would add, and a MINIMAL file grew 12288 -> 139264 on the old code. The
 * minimal-file case is the one tested here, because it is where the defect was most
 * damaging and where the size claim was wrong.
 *
 * STORE_DIR is a temp directory per run, set before anything is imported.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-schema-refusal-'));
process.env.STORE_DIR = STORE_DIR;
process.env.SESSION_SECRET = 'a'.repeat(64);

const store = await import('../lib/store/index.js');

after(() => {
    store.closeAll();
    fs.rmSync(STORE_DIR, { recursive: true, force: true });
});

/** SHA-256 of a whole file: the reliable measure of "exactly as it was". */
const hashOf = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const orgsDir = () => path.join(STORE_DIR, 'orgs');
const fileFor = (orgId) => path.join(orgsDir(), `${orgId}.db`);

/** The table names in a file, read directly. */
function tablesIn(file) {
    const db = new DatabaseSync(file);
    try {
        return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
    } finally {
        db.close();
    }
}

/** The recorded schema version in a file, read directly. */
function stampedVersion(file) {
    const db = new DatabaseSync(file);
    try {
        return db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()?.value;
    } finally {
        db.close();
    }
}

// ===========================================================================
// A FULLY V6-SHAPED FILE, STAMPED v5
// ===========================================================================

test('a v6-shaped file stamped v5 is refused, and the file is byte-identical', () => {
    // The file already has every table the schema would add, so this is the case
    // where the SIZE happened to stay identical even under the old code: the
    // writing was happening, invisibly to a size check.
    fs.mkdirSync(orgsDir(), { recursive: true });
    const org = store.createOrganisation('Fully shaped');
    const file = fileFor(org.id);
    store.closeAll();

    // Re-stamp it as an older version, leaving the shape intact.
    const db = new DatabaseSync(file);
    db.exec("UPDATE schema_meta SET value = '5' WHERE key = 'schema_version'");
    db.close();

    const hashBefore = hashOf(file);
    const tablesBefore = tablesIn(file);

    assert.throws(() => store.getOrganisation(org.id), /schema version/i, 'the open is refused');

    assert.equal(hashOf(file), hashBefore, 'the whole file is byte-identical after a refused open');
    assert.deepEqual(tablesIn(file), tablesBefore, 'and its tables are unchanged');
    assert.equal(stampedVersion(file), '5', 'and the stamp is still the old version');
});

// ===========================================================================
// A MINIMAL v5 FILE — THE CASE THE SIZE CLAIM GOT WRONG
// ===========================================================================

test('a MINIMAL v5 file missing the v6 tables is refused, and NOTHING is written to it', () => {
    // THE CENTRAL CASE. A minimal file, holding only schema_meta stamped v5, is the
    // shape where the old defect was most damaging: the refused open ADDED every v6
    // table, leaving a file that was v6-SHAPED and stamped 5, so every later open
    // refused it again and an operator's "delete it to start fresh" destroyed a file
    // that had already been written to.
    fs.mkdirSync(orgsDir(), { recursive: true });
    const orgId = 'minimal-v5-file';
    const file = fileFor(orgId);

    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.exec("INSERT INTO schema_meta (key, value) VALUES ('schema_version', '5')");
    db.close();

    const hashBefore = hashOf(file);
    const sizeBefore = fs.statSync(file).size;
    assert.deepEqual(tablesIn(file), ['schema_meta'], 'the fixture really is minimal');

    assert.throws(() => store.getOrganisation(orgId), /schema version/i, 'the open is refused');

    // THE PROPERTY: nothing was written. Asserted by hash, which is
    // unconditionally reliable, rather than by size, which only happens to hold.
    assert.equal(hashOf(file), hashBefore, 'the file is byte-identical after the refused open');
    assert.deepEqual(
        tablesIn(file),
        ['schema_meta'],
        'NO v6 table was added: the refused open wrote nothing'
    );
    assert.equal(stampedVersion(file), '5', 'the stamp is untouched');

    // The size is reported for the record, but the assertion above is the hash.
    // Under the old code this file grew 12288 -> 139264 while the v6 tables
    // appeared, which is the defect the size check could not see.
    assert.equal(fs.statSync(file).size, sizeBefore, 'and the size is unchanged too, in this case');
});

test('the minimal file is STILL refused on a second attempt, and still unchanged', () => {
    // Under the old code the first refused open left the file v6-shaped but stamped
    // 5, so every later open refused it again while the file kept its damage. This
    // asserts the refusal is repeatable without further change.
    const orgId = 'minimal-v5-repeat';
    const file = fileFor(orgId);
    fs.mkdirSync(orgsDir(), { recursive: true });

    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.exec("INSERT INTO schema_meta (key, value) VALUES ('schema_version', '5')");
    db.close();

    const hashBefore = hashOf(file);

    for (let attempt = 0; attempt < 3; attempt += 1) {
        assert.throws(() => store.getOrganisation(orgId), /schema version/i, `attempt ${attempt + 1} refuses`);
        assert.equal(hashOf(file), hashBefore, `attempt ${attempt + 1} wrote nothing`);
    }

    store.closeAll();
});

test('a v6 file that is simply current opens normally, so the refusal is specific to the version', () => {
    // A guard against a test that passes because EVERY open is refused.
    const org = store.createOrganisation('Current version');
    store.closeAll();

    const opened = store.getOrganisation(org.id);
    assert.equal(opened.name, 'Current version', 'a current file opens');
    assert.equal(stampedVersion(fileFor(org.id)), '6', 'and it is stamped with the current version');
});

// ===========================================================================
// THE DEFECT ITSELF, AS A NEGATIVE
// ===========================================================================

test('the refused file is not left v6-SHAPED AND stamped v5', () => {
    // The exact end state the defect produced: the shape of v6 with the stamp of v5.
    // Stated as a negative, because that combination is the thing to prevent.
    const orgId = 'not-half-migrated';
    const file = fileFor(orgId);
    fs.mkdirSync(orgsDir(), { recursive: true });

    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.exec("INSERT INTO schema_meta (key, value) VALUES ('schema_version', '5')");
    db.close();

    assert.throws(() => store.getOrganisation(orgId));

    const tables = tablesIn(file);
    const stamp = stampedVersion(file);
    const v6TablesAdded = tables.some((name) => ['process', 'process_revision', 'process_response'].includes(name));

    assert.equal(
        v6TablesAdded && stamp === '5',
        false,
        'the file must NOT be left with v6 tables and a v5 stamp'
    );
    assert.equal(v6TablesAdded, false, 'no v6 table was created at all');
});
