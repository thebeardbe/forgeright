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

    // AND REFUSE BEFORE APPLYING IT. Running AFTER `db.exec(schemaSql())` half-migrated an older
    // file before refusing it: `CREATE TABLE IF NOT EXISTS` added every missing table, leaving it
    // v6-SHAPED but stamped with its old version. Every later open refused it again, and following
    // the error's own advice destroyed a file already written to. A REFUSAL MUST LEAVE THE FILE
    // EXACTLY AS IT WAS.
    //
    // HOW TO CHECK IT: HASH THE WHOLE FILE before and after a refused open. FILE SIZE ALONE IS NOT
    // THE TEST - it stayed identical in the case that mattered, because the file already held the
    // tables the schema would have added, so there was nothing to write. A minimal file missing
    // them grew from 12288 to 139264, which is the same defect appearing in the measure quoted as
    // proof it was fine.
    assertOrganisationSchemaIsCurrent(previous);

    // A throw from the schema propagates to connectionFor, which closes the
    // half-initialised handle rather than caching it.
    db.exec(schemaSql());
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
// UNCHANGED BY THE CORRECTION TABLE, deliberately: `response_field_correction` is added by
// CREATE TABLE IF NOT EXISTS, so an existing file gains it on its next open with nothing to
// migrate. A bump would REFUSE every existing file, which data/store/schema.sql explains at
// length beside the two indexes that took the same route.
const EXPECTED_ORG_SCHEMA_VERSION = '6';
const EXPECTED_ADMIN_SCHEMA_VERSION = '4';

/**
 * Refuses a file this code cannot read, rather than upgrading it.
 *
 * THERE IS NO MIGRATION PATH, DELIBERATELY: this is the proof of concept, so an upgrade would be
 * work spent on a schema with no future. The check exists to REFUSE a file this code does not
 * understand, not to carry one forward.
 *
 * EARLIER VERSIONS DID MIGRATE - v1 to v2 added a column, v2 to v3 carried every existing token hash
 * across. That was right while those versions were supported and is wrong now: silently upgrading
 * hides that a file's shape was written by different code, so the queries that follow answer a
 * question about a schema nobody designed together. A loud refusal is honest, and anyone who wants
 * the data can export it before deleting the file.
 *
 * A brand-new file has `previous === null` and is not refused, because the schema creates
 * schema_meta. CALLED BEFORE THE SCHEMA IS APPLIED, so a refusal happens while the file is untouched.
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
