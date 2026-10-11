/**
 * Connection registry.
 *
 * THE ONLY MODULE THAT OPENS A DATABASE CONNECTION. Everything else in the
 * application works through lib/store/index.js, which asks the registry for a
 * connection for one organisation. That is what makes isolation structural rather
 * than a convention:
 *
 *   - a connection is opened against a file that paths.assertOpenableDatabaseFile
 *     has confirmed is a regular file inside the store directory
 *   - the schema carries no orgId column, so no query can widen its scope
 *   - a query cannot reach another organisation's rows without opening another
 *     file, and only this module can do that
 *
 * Where a file lives, and whether opening it is safe, belongs to paths.js. The
 * schema and its migrations belong to schema.js. This module owns the lifecycle:
 * open once, apply the schema, cache, close.
 *
 * V2 replaces this module with a Postgres pool that sets the tenant on the
 * session and relies on row-level security. Nothing above this file changes.
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
    assertOpenableAdminDatabaseFile,
    assertOpenableDatabaseFile,
    assertOrgsDirectoryUnchanged,
    assertSafeOrgId,
    assertStoreDirUnchanged,
    listOrganisationFileIds,
    adminDbPath,
    orgDbPath
} from './paths.js';
import { prepareAdminDatabase, prepareDatabase } from './schema.js';

export {
    assertOpenableDatabaseFile,
    assertOrgsDirectoryUnchanged,
    assertSafeOrgId,
    orgDbPath,
    orgsDirectoryPath,
    storeDir
} from './paths.js';

/** Open connections, keyed by a cache key, so a file is not reopened per query. */
const openConnections = new Map();

/**
 * Cache key for the installation connection.
 *
 * Deliberately not a UUID: organisation ids are UUIDs, so a key without hyphens
 * cannot collide with one, and the two connection kinds stay distinguishable in
 * the map.
 */
const ADMIN_CONNECTION_KEY = 'admin';

/**
 * A connection scoped to ONE organisation, opened on first use and cached.
 *
 * @param {string} orgId
 * @param {object} [options]
 * @param {boolean} [options.mayCreate] True only on the create path. When false
 *   (the default), an org id with no file is refused rather than opening a new
 *   empty database, because opening a path creates it: a read for an unknown or
 *   stale id must not conjure a tenant.
 * @returns {DatabaseSync}
 */
export function connectionFor(orgId, { mayCreate = false } = {}) {
    assertSafeOrgId(orgId);

    const existing = openConnections.get(orgId);
    if (existing) return existing;

    // Check the store directory BEFORE building or opening any path. If it was
    // swapped for a symlink since startup, throwing here is what stops the open
    // from following the redirect out of the store.
    assertOrgsDirectoryUnchanged();

    const dbPath = orgDbPath(orgId);
    // Look at the file before opening it. A symlink is refused here rather than
    // followed, so a legal-looking id cannot reach another organisation's data.
    const realFile = assertOpenableDatabaseFile(dbPath, orgId);

    if (realFile === null && !mayCreate) {
        throw new Error(
            `Organisation ${orgId} has no database in the store. ` +
            `A read never creates one; use createOrganisation to register an organisation.`
        );
    }

    const db = new DatabaseSync(dbPath);
    try {
        prepareDatabase(db);
    } catch (err) {
        // A file that cannot take the schema is useless and must not be cached,
        // or every later call inherits the half-applied state.
        db.close();
        console.error(`[store] applying the schema to ${dbPath} failed:`, err.message);
        throw err;
    }

    openConnections.set(orgId, db);
    return db;
}

/**
 * The installation database, at <STORE_DIR>/admin.db.
 *
 * A SECOND KIND OF CONNECTION, opened here rather than anywhere else, so the
 * rule holds: registry.js is the only module that opens a connection, and it
 * opens exactly two kinds. Keeping it here also means the admin store inherits
 * the same protections as the org store by construction: a constructed literal
 * file name, a refused symlink, and a store directory that must not have moved
 * since it was resolved.
 *
 * WHAT THIS FILE IS NOT. It is not tenant data. It holds records belonging to
 * the whole installation (currently admin login tokens and sessions), so:
 *
 *   - it must NEVER be joined to an organisation's file. There is no foreign key
 *     across files, and adding a query that reaches from one to the other would
 *     be a bug, not a feature.
 *   - nothing in lib/store/index.js's organisation API can reach it. That API
 *     takes an orgId and resolves it under orgs/; this file is a sibling of that
 *     directory, reached only by calling this function by name.
 *
 * Cached under a key that cannot collide with an organisation id. Organisation
 * ids are UUIDs, which contain hyphens and so can never equal the key used here.
 *
 * @returns {DatabaseSync}
 */
export function adminConnection() {
    const cacheKey = ADMIN_CONNECTION_KEY;
    const existing = openConnections.get(cacheKey);
    if (existing) return existing;

    // Both containment checks: the root must not have moved, and this file must
    // be a regular file inside it rather than a symlink pointing elsewhere.
    assertStoreDirUnchanged();

    const dbPath = adminDbPath();
    assertOpenableAdminDatabaseFile(dbPath);

    // mayCreate is implied: the installation database is created on first use,
    // because its existence is what makes the installation usable at all. Unlike
    // an organisation file, there is no "read invented a tenant" risk: there is
    // exactly one of these, its name is a literal, and no request can name it.
    const db = new DatabaseSync(dbPath);
    try {
        prepareAdminDatabase(db);
    } catch (err) {
        db.close();
        console.error(`[store] applying the admin schema to ${dbPath} failed:`, err.message);
        throw err;
    }

    openConnections.set(cacheKey, db);
    return db;
}


/**
 * Closes one organisation's connection. Tests and shutdown use this.
 *
 * @param {string} orgId
 * @returns {boolean} True when a connection was closed, false when none was open.
 */
export function closeConnection(orgId) {
    const db = openConnections.get(orgId);
    if (!db) return false;

    openConnections.delete(orgId);
    try {
        db.close();
    } catch (err) {
        // The connection is already out of the map, so it cannot be handed out
        // again. Log the failure rather than swallowing it silently.
        console.error(`[store] closing ${orgId} failed:`, err.message);
        return false;
    }
    return true;
}

/** Closes every open connection. Registered against process shutdown. */
export function closeAll() {
    let closed = 0;
    for (const orgId of [...openConnections.keys()]) {
        if (closeConnection(orgId)) closed += 1;
    }
    return closed;
}

/**
 * Organisation ids present on disk. Used by tests and an admin overview.
 *
 * @returns {string[]} Sorted organisation ids.
 */
export function listOrganisationIds() {
    return listOrganisationFileIds();
}
