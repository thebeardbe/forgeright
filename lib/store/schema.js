/**
 * Schema application and migration.
 *
 * Split from registry.js so the connection lifecycle stays readable. This module
 * touches a database only through a connection handed to it, so like the
 * statement modules it cannot widen its scope: it never opens a file.
 *
 * THE SCHEMA IS THE SOURCE OF TRUTH. data/store/schema.sql and
 * data/store/admin-schema.sql are applied on every open, so a new table or index
 * needs no migration step. A COLUMN added to an existing table does: CREATE TABLE
 * IF NOT EXISTS leaves the old shape alone, which is why a column change requires a
 * new version rather than relying on this file.
 *
 * The two files version independently, because they change for different reasons
 * and a change to one should not force a bump in the other.
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

function schemaSql() {
    if (cachedSchema === null) {
        cachedSchema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    }
    return cachedSchema;
}

/**
 * Applies the connection pragmas and the schema, migrating an older file first.
 *
 * The schema file is idempotent (CREATE TABLE IF NOT EXISTS), so this runs on
 * every open, including for an existing file. That covers new tables but NOT a
 * column added to an existing table: CREATE TABLE IF NOT EXISTS leaves the old
 * shape alone. A column added in a later version therefore needs an explicit
 * migration step, and this project has none: an older file is refused instead.
 */
export function prepareDatabase(db) {
    // Set the wait BEFORE anything else, because applying the schema is itself a
    // write and must not be the statement that fails under contention. This is a
    // connection-level pragma, so it covers every statement on this connection
    // for as long as it is cached, which is why it lives here rather than in
    // schema.sql: the schema describes one organisation's data, a wait policy is
    // a property of how this process talks to SQLite.
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs()}`);
    db.exec('PRAGMA foreign_keys = ON');

    // Read the version BEFORE the schema runs, because the schema updates it.
    const previous = readSchemaVersion(db);

    // A throw from the schema propagates to connectionFor, which closes the
    // half-initialised handle rather than caching it.
    db.exec(schemaSql());
    assertOrganisationSchemaIsCurrent(previous);
    verifySchema(db, previous);
}

/**
 * Reads a file's recorded schema version, or null when it has none yet.
 *
 * A file with no schema_meta is brand new: the table does not exist until the
 * schema is applied. That is not an error here, it is the empty case.
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
 * The versions this code expects.
 *
 * TWO FILES, TWO VERSIONS. The organisation schema and the installation schema
 * change for different reasons, so they version independently. Sharing one
 * constant would mean a change to either forced a bump in both, and a file at the
 * "wrong" version would be reported as a mismatch when it is simply the other
 * file's version. Kept in step with their respective .sql files.
 */
const EXPECTED_ORG_SCHEMA_VERSION = '5';
const EXPECTED_ADMIN_SCHEMA_VERSION = '4';

/**
 * Refuses a file this code cannot read, rather than upgrading it.
 *
 * THERE IS NO MIGRATION PATH, DELIBERATELY. This is the proof of concept: V2 is a
 * rewrite on a different database, so an upgrade here would be work spent on a
 * schema with no future. The version check exists to REFUSE a file this code does
 * not understand, not to carry one forward.
 *
 * Earlier versions of this function DID migrate -- v1 to v2 added a column, v2 to
 * v3 moved tokens into their own table and carried every existing hash across so
 * mailed links kept working. That was right while those versions were supported.
 * It is wrong now: silently upgrading a file hides that its shape was written by
 * different code, and the queries that follow would be answering a question about
 * a schema nobody designed together. A loud refusal is the honest outcome, and
 * anyone who wants the data can export it before deleting the file.
 *
 * The schema_meta table is created by the schema file, so a brand-new file has
 * `previous === null` and is not refused.
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
 * Fails loudly when a file's schema version is not the one this code expects,
 * having already migrated what it can.
 *
 * @param {object} db
 * @param {string|null} previous The version read before the schema ran, so a
 *   version this code cannot move forward can be named as such rather than
 *   reported as a mismatch with no explanation.
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
 * Applies the pragmas and the installation schema to admin.db.
 *
 * Mirrors prepareDatabase, with the same pragma order and the same reason for
 * setting busy_timeout first: applying the schema is itself a write, so it must
 * not be the statement that fails under contention.
 *
 * The installation file has its own version, independent of the organisation
 * schema: the two change for different reasons, and a change to one should not
 * force a bump in the other.
 */
export function prepareAdminDatabase(db) {
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs()}`);
    db.exec('PRAGMA foreign_keys = ON');

    // Read before the schema runs, because the schema updates the version. Used
    // only to name the version in an error.
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
