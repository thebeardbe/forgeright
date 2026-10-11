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
 * IF NOT EXISTS leaves the old shape alone, which is what migrateOrganisationSchema
 * is for.
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
 * migration step, which is what migrateOrganisationSchema does.
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
    migrateOrganisationSchema(db, previous);
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
 * Brings an organisation file from an older schema version up to date.
 *
 * Additive and idempotent: each step is guarded by checking for the thing it
 * adds, so running it twice is harmless and a file already at the version is
 * untouched. This is the migration the registry replaced with "apply the file
 * every time", and it is needed only for changes that CREATE TABLE cannot make.
 *
 * @param {object} db
 * @param {string|null} previous The version recorded before the schema ran.
 */
function migrateOrganisationSchema(db, previous) {
    // v1 -> v2: invitation.token_issued_at. Needed so the console can show when a
    // link was last issued, which is separate from when the invitation was made.
    if (previous === '1') {
        const columns = db.prepare('PRAGMA table_info(invitation)').all().map((c) => c.name);
        if (!columns.includes('token_issued_at')) {
            db.exec('ALTER TABLE invitation ADD COLUMN token_issued_at TEXT');
            // Existing rows have no recorded issue time, so created_at is the best
            // available answer: the token they hold was issued when the invitation
            // was made. Backfilled rather than left null, so the console does not
            // show a blank for every pre-existing invitation.
            db.exec('UPDATE invitation SET token_issued_at = created_at WHERE token_issued_at IS NULL');
            console.info('[store] migrated invitation to include token_issued_at (v1 -> v2)');
        }
    }

    // v2 -> v3: one token per invitation became many, in participant_tokens.
    //
    // The old token column is NOT dropped: SQLite cannot drop a column before 3.35
    // and rebuilding the table would risk the responses that reference it by a
    // foreign key. It is simply left unread, and the comment says so, because a
    // column nobody reads is a smaller hazard than a table rebuild.
    if (previous === '1' || previous === '2') {
        migrateTokensToTable(db);
    }
}

/**
 * Moves an invitation's single token into the participant_tokens table.
 *
 * The existing hash is carried across rather than replaced, so a participant
 * holding a link that was mailed before this change keeps working: invalidating
 * every outstanding link on a deploy would lose respondents, which is the failure
 * this whole product is built to avoid.
 *
 * `expires_at` is set far enough out that the migration does not itself expire
 * anything. See the org schema for why participant links are long-lived.
 */
function migrateTokensToTable(db) {
    const columns = db.prepare('PRAGMA table_info(invitation)').all().map((c) => c.name);
    if (!columns.includes('token')) {
        // Already migrated, or a fresh file: nothing to carry across.
        return;
    }

    // The participant_tokens table itself is created by the schema file, which
    // has already run by the time this is called.
    const invitations = db.prepare(
        'SELECT id, token, COALESCE(token_issued_at, created_at) AS issued_at FROM invitation'
    ).all();

    const insert = db.prepare(
        `INSERT OR IGNORE INTO participant_tokens
         (id, invitation_id, token_hash, issued_at, expires_at, revoked_at, issued_by)
         VALUES (?, ?, ?, ?, ?, NULL, 'admin')`
    );

    let migrated = 0;
    for (const row of invitations) {
        const expiresAt = new Date(Date.parse(row.issued_at) + 90 * 86_400_000).toISOString();
        const result = insert.run(randomUUID(), row.id, row.token, row.issued_at, expiresAt);
        migrated += result.changes;
    }

    console.info(
        `[store] migrated ${migrated} invitation token(s) into participant_tokens (v2 -> v3); ` +
        'existing links keep working'
    );
}

/**
 * The version this code expects.
 *
 * TWO FILES, TWO VERSIONS. The organisation schema and the installation schema
 * change for different reasons, so they version independently. Sharing one
 * constant would mean a change to either forced a bump in both, and a file at the
 * "wrong" version would be reported as a mismatch when it is simply the other
 * file's version. Kept in step with their respective .sql files.
 */
const EXPECTED_ORG_SCHEMA_VERSION = '3';
const EXPECTED_ADMIN_SCHEMA_VERSION = '4';

/**
 * Applies the pragmas and the installation schema to admin.db.
 *
 * Mirrors prepareDatabase, with the same pragma order and the same reason for
 * setting busy_timeout first: applying the schema is itself a write, so it must
 * not be the statement that fails under contention.
 */
export function prepareAdminDatabase(db) {
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs()}`);
    db.exec('PRAGMA foreign_keys = ON');

    // Read before the schema runs, because the schema updates the version. Used
    // only to name the version in an error; the users table is created by the
    // schema itself, so there is no column migration for v1 -> v2.
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
            `from ${from}, but this code expects ${EXPECTED_ADMIN_SCHEMA_VERSION}. The file needs a ` +
            'migration this code does not have.'
        );
    }
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
