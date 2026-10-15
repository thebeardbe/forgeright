/**
 * Resolving an organisation id to a connection that exists. Writing the same three answers (is the
 * id safe, does this organisation exist, is the file a real one?) once here means the "a read must
 * not create a tenant" rule cannot be forgotten by a new method.
 */
import fs from 'node:fs';
import { assertOrgsDirectoryUnchanged, assertSafeOrgId, connectionFor, orgDbPath } from './registry.js';
import * as sql from './sqlite.js';

/**
 * A connection for an organisation that already exists, or null. This is the guard that keeps a read
 * from inventing a tenant: `connectionFor` opens a file and so creates it if absent.
 *
 * It returns null only when there is no database file for the id, and throws when the store cannot
 * be used at all (an unsafe id, a symlink or other non-regular file, or a file with no organisation
 * row), because those are failures to compute rather than missing data.
 *
 * @param {string} orgId
 * @returns {object|null} A DatabaseSync connection, or null when absent.
 */
export function connectionForOrNull(orgId) {
    assertSafeOrgId(orgId);

    assertOrgsDirectoryUnchanged();

    // A symlink or other non-regular file raises from the callers below, and that must propagate: it
    // is an attack or a mistake, not a missing organisation.
    if (!fs.existsSync(orgDbPath(orgId))) {
        console.warn(`[store] no database for organisation ${orgId}; a read does not create one.`);
        return null;
    }

    const db = connectionFor(orgId);

    // A file with no organisation row is the half-initialised state verifySchema fails loudly on.
    if (!sql.selectOrganisation(db)) {
        console.error(`[store] ${orgDbPath(orgId)} exists but holds no organisation row.`);
        throw new Error(
            `Organisation ${orgId} has a database file but no organisation row; the store is half-initialised.`
        );
    }
    return db;
}

/**
 * A connection for an organisation that is known to exist, or a thrown error: the single place every
 * non-creating operation resolves its organisation.
 *
 * @param {string} orgId
 * @throws {Error} When no organisation exists for the id.
 * @returns {object} The DatabaseSync connection.
 */
export function requireConnection(orgId) {
    const db = connectionForOrNull(orgId);
    if (db === null) {
        throw new Error(`Organisation ${orgId} does not exist in the store.`);
    }
    return db;
}
