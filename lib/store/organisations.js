/**
 * Resolving an organisation id to a connection that exists.
 *
 * Every operation in lib/store/index.js needs the same three answers before it
 * touches data: is the id safe, does this organisation exist, and is the file a
 * real one? Writing that once here means the "a read must not create a tenant"
 * rule cannot be forgotten by a new method.
 *
 * Kept separate from index.js so the public interface stays a list of
 * operations, and from registry.js so the connection lifecycle stays free of
 * application rules about what counts as an existing organisation.
 */
import fs from 'node:fs';
import { assertOrgsDirectoryUnchanged, assertSafeOrgId, connectionFor, orgDbPath } from './registry.js';
import * as sql from './sqlite.js';

/**
 * A connection for an organisation that already exists, or null.
 *
 * This is the guard that keeps a read from inventing a tenant. `connectionFor`
 * opens a file, which creates it if absent, so a read for an unknown id used to
 * conjure an empty organisation: a stale cookie would get a clean-looking empty
 * tenant instead of an error, and `listOrganisationIds()` could no longer tell
 * a real organisation from one created by a bad request.
 *
 * Returns null only when there is no database file for the id. It throws when
 * the store cannot be used at all: an unsafe id, a symlink or other non-regular
 * file, or a file with no organisation row. Those are failures to compute, not
 * missing data, and the distinction is the point of returning null here.
 *
 * @param {string} orgId
 * @returns {object|null} A DatabaseSync connection, or null when absent.
 */
export function connectionForOrNull(orgId) {
    assertSafeOrgId(orgId);

    // Check the store directory FIRST, before any existence test. If it was
    // swapped for a symlink since startup, this throws the explanatory error
    // naming both paths. Testing existence first would follow the redirect,
    // find nothing there, and report "no such organisation" instead, which is
    // safe but names the wrong problem for whoever has to fix it.
    assertOrgsDirectoryUnchanged();

    // A symlink or other non-regular file raises from the callers below with a
    // logged error, and that must propagate: it is an attack or a mistake, not
    // a missing organisation.
    if (!fs.existsSync(orgDbPath(orgId))) {
        console.warn(`[store] no database for organisation ${orgId}; a read does not create one.`);
        return null;
    }

    const db = connectionFor(orgId);

    // A file with no organisation row is the half-initialised state verifySchema
    // fails loudly on. Surface it rather than treating it as an empty tenant.
    if (!sql.selectOrganisation(db)) {
        console.error(`[store] ${orgDbPath(orgId)} exists but holds no organisation row.`);
        throw new Error(
            `Organisation ${orgId} has a database file but no organisation row; the store is half-initialised.`
        );
    }
    return db;
}

/**
 * A connection for an organisation that is known to exist, or a thrown error.
 *
 * The single place every non-creating operation resolves its organisation, so
 * the "this does not exist" refusal is written once rather than repeated in each
 * method. An operation that cannot find its organisation is a caller error (a
 * stale id, a bad route) and must be loud, not silently empty.
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
