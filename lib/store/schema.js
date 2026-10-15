/**
 * Schema application and migration. Never opens a file, only uses a connection handed to it.
 *
 * The schema files are applied on every open, so a new table or index needs no migration step; a column
 * added to an existing table does, because CREATE TABLE IF NOT EXISTS leaves the old shape alone.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { busyTimeoutMs } from './busy-timeout.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Repository root, two levels up from lib/store. */
const PROJECT_ROOT = path.join(__dirname, '..', '..');

/** The schema for one organisation. Applied on every connection open. */
const SCHEMA_PATH = path.join(PROJECT_ROOT, 'data', 'store', 'schema.sql');

/** The schema for the installation database. Applied on every open. */
const ADMIN_SCHEMA_PATH = path.join(PROJECT_ROOT, 'data', 'store', 'admin-schema.sql');

/** Read once per process; the file does not change while running. */
let cachedSchema = null;

/** The cached contents of the organisation schema file. */
function schemaSql() {
    if (cachedSchema === null) {
        cachedSchema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    }
    return cachedSchema;
}

/**
 * Applies the connection pragmas and the schema, refusing an older file before applying anything.
 *
 * The wait is set first because applying the schema is itself a write, and the version is read before
 * the schema runs because the schema updates it. The refusal must leave the file exactly as it was:
 * applying the schema first adds every missing table, leaving an old file shaped like the new one but
 * stamped with its old version.
 *
 * A refusal is checked by hashing the whole file before and after; size alone is not the test, because a
 * file already holding the tables the schema would add has nothing to write.
 */
export function prepareDatabase(db) {
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs()}`);
    db.exec('PRAGMA foreign_keys = ON');

    const previous = readSchemaVersion(db);

    assertOrganisationSchemaIsCurrent(previous);

    db.exec(schemaSql());
    verifySchema(db, previous);
}

/**
 * Reads a file's recorded schema version, or null when it has none yet: the table does not exist until
 * the schema is applied.
 */
function readSchemaVersion(db) {
    const hasMeta = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'"
    ).get();
    if (!hasMeta) return null;

    const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('schema_version');
    return row ? row.value : null;
}

/**
 * The versions this code expects, each kept in step with its own .sql file. A table added by CREATE TABLE
 * IF NOT EXISTS needs no bump: a bump would refuse every existing file.
 */
const EXPECTED_ORG_SCHEMA_VERSION = '6';
const EXPECTED_ADMIN_SCHEMA_VERSION = '4';

/**
 * Refuses a file this code cannot read, rather than upgrading it. Called before the schema is applied, so
 * the file is untouched, and a brand-new file is not refused because the schema creates schema_meta.
 *
 * @param {string|null} previous The version recorded before the schema ran.
 * @throws {Error} When the file predates this code.
 */
function assertOrganisationSchemaIsCurrent(previous) {
    if (previous === null) return; // A new file; the schema just created it.
    if (previous === EXPECTED_ORG_SCHEMA_VERSION) return;

    throw new Error(
        `This organisation's database is at schema version ${previous}, and this code expects ` +
        `${EXPECTED_ORG_SCHEMA_VERSION}. There is no upgrade path: this is a proof of concept and ` +
        'V2 is a rewrite, so an older file is refused rather than read with queries that do not ' +
        'match it. Export anything you need from the file, then delete it to start fresh.'
    );
}

/**
 * Fails loudly when the version the schema recorded is not the one this code expects.
 *
 * @param {object} db
 * @param {string|null} previous The version read before the schema ran, used to name the version
 *   the mismatch came from rather than report it with no explanation.
 */
function verifySchema(db, previous) {
    const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('schema_version');
    if (!row) {
        throw new Error(`Schema file ${SCHEMA_PATH} did not record schema_version.`);
    }
    if (row.value !== EXPECTED_ORG_SCHEMA_VERSION) {
        const from = previous === null ? 'a new file' : `version ${previous}`;
        throw new Error(
            `Schema version mismatch: ${SCHEMA_PATH} produced version ${row.value} from ${from}, ` +
            `but this code expects ${EXPECTED_ORG_SCHEMA_VERSION}. The file needs a migration this ` +
            'code does not have.'
        );
    }
}

/**
 * Applies the pragmas and the installation schema to admin.db, mirroring prepareDatabase with the same
 * pragma order.
 */
export function prepareAdminDatabase(db) {
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs()}`);
    db.exec('PRAGMA foreign_keys = ON');

    // Read before the schema runs; used only to name the version in an error.
    const previous = readSchemaVersion(db);

    db.exec(fs.readFileSync(ADMIN_SCHEMA_PATH, 'utf8'));

    const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('schema_version');
    if (!row) {
        throw new Error(`Schema file ${ADMIN_SCHEMA_PATH} did not record schema_version.`);
    }
    if (row.value !== EXPECTED_ADMIN_SCHEMA_VERSION) {
        const from = previous === null ? 'a new file' : `version ${previous}`;
        throw new Error(
            `Installation schema version mismatch: ${ADMIN_SCHEMA_PATH} produced version ${row.value} ` +
            `from ${from}, but this code expects ${EXPECTED_ADMIN_SCHEMA_VERSION}. There is no upgrade ` +
            'path: export anything you need from the file, then delete it to start fresh.'
        );
    }
}
