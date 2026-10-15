/**
 * Connection registry: the only module that opens a database connection, which is what makes isolation
 * structural rather than a rule each caller remembers.
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

/** Deliberately not a UUID, so it cannot collide with an organisation id. */
const ADMIN_CONNECTION_KEY = 'admin';

/**
 * A connection scoped to one organisation, opened on first use and cached.
 *
 * @param {string} orgId
 * @param {object} [options]
 * @param {boolean} [options.mayCreate] True only on the create path. False, the default, refuses an org
 *   id with no file, because opening a path creates it and a read must not conjure a tenant.
 * @returns {DatabaseSync}
 */
export function connectionFor(orgId, { mayCreate = false } = {}) {
    assertSafeOrgId(orgId);

    const existing = openConnections.get(orgId);
    if (existing) return existing;

    // Before building or opening any path, so a swapped store directory stops the open.
    assertOrgsDirectoryUnchanged();

    const dbPath = orgDbPath(orgId);
    // Look at the file before opening it, so a symlink is refused rather than followed.
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
        // Must not be cached, or every later call inherits the half-applied state.
        db.close();
        console.error(`[store] applying the schema to ${dbPath} failed:`, err.message);
        throw err;
    }

    openConnections.set(orgId, db);
    return db;
}

/**
 * The installation database, at <STORE_DIR>/admin.db, the second of the two kinds of connection this
 * module opens.
 *
 * Not tenant data: it holds admin login tokens and sessions, so it must never be joined to an
 * organisation's file, and nothing in the organisation API can reach it.
 *
 * @returns {DatabaseSync}
 */
export function adminConnection() {
    const cacheKey = ADMIN_CONNECTION_KEY;
    const existing = openConnections.get(cacheKey);
    if (existing) return existing;

    // The root must not have moved, and the file must be a regular file inside it.
    assertStoreDirUnchanged();

    const dbPath = adminDbPath();
    assertOpenableAdminDatabaseFile(dbPath);

    // Created on first use, unlike an organisation file. There is no "read invented a tenant" risk,
    // because there is exactly one of these and no request can name it.
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
        // Already out of the map, so it cannot be handed out again.
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
