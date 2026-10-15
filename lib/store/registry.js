/**
 * Connection registry: the only module that opens a database connection.
 *
 * Everything else works through index.js, which asks the registry for a connection for one
 * organisation, which is what makes isolation structural rather than a rule each caller remembers.
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
 * Cache key for the installation connection. Deliberately not a UUID: organisation ids are UUIDs, so a
 * key without hyphens cannot collide with one.
 */
const ADMIN_CONNECTION_KEY = 'admin';

/**
 * A connection scoped to one organisation, opened on first use and cached.
 *
 * @param {string} orgId
 * @param {object} [options]
 * @param {boolean} [options.mayCreate] True only on the create path. When false (the default), an org
 *   id with no file is refused rather than opening a new empty database, because opening a path
 *   creates it and a read for an unknown or stale id must not conjure a tenant.
 * @returns {DatabaseSync}
 */
export function connectionFor(orgId, { mayCreate = false } = {}) {
    assertSafeOrgId(orgId);

    const existing = openConnections.get(orgId);
    if (existing) return existing;

    // Check the store directory before building or opening any path: if it was swapped for a symlink
    // since startup, throwing here is what stops the open from following the redirect out of the
    // store.
    assertOrgsDirectoryUnchanged();

    const dbPath = orgDbPath(orgId);
    // Look at the file before opening it, so a symlink is refused rather than followed and a
    // legal-looking id cannot reach another organisation's data.
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
        // A file that cannot take the schema is useless and must not be cached, or every later call
        // inherits the half-applied state.
        db.close();
        console.error(`[store] applying the schema to ${dbPath} failed:`, err.message);
        throw err;
    }

    openConnections.set(orgId, db);
    return db;
}

/**
 * The installation database, at <STORE_DIR>/admin.db. Opened here so the rule holds: this module is
 * the only one that opens a connection, and it opens exactly two kinds, so the admin store inherits
 * the org store's protections by construction.
 *
 * Not tenant data: it holds installation-level records (admin login tokens and sessions), so it must
 * never be joined to an organisation's file, and nothing in the organisation API can reach it, because
 * that API resolves a path under orgs/ while this is a sibling reached only by name.
 *
 * @returns {DatabaseSync}
 */
export function adminConnection() {
    const cacheKey = ADMIN_CONNECTION_KEY;
    const existing = openConnections.get(cacheKey);
    if (existing) return existing;

    // Both containment checks: the root must not have moved, and this file must be a regular file
    // inside it rather than a symlink pointing elsewhere.
    assertStoreDirUnchanged();

    const dbPath = adminDbPath();
    assertOpenableAdminDatabaseFile(dbPath);

    // mayCreate is implied: the installation database is created on first use, because its existence
    // is what makes the installation usable at all. Unlike an organisation file there is no "read
    // invented a tenant" risk: there is exactly one of these, its name is a literal, and no request
    // can name it.
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
        // The connection is already out of the map, so it cannot be handed out again. Log the failure
        // rather than swallowing it silently.
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
