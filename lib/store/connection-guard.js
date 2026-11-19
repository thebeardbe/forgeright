/** Helpers shared by the statement modules. Opens nothing and holds no state, so two tenants cannot meet here. */

/** ISO 8601 UTC, the format every timestamp column holds, so text sorts chronologically. */
export function nowIso() {
    return new Date().toISOString();
}

/** A missing connection is a programming error: these modules never open one. */
export function assertConnection(db) {
    if (!db || typeof db.prepare !== 'function') {
        throw new Error('A DatabaseSync connection is required; statement modules never open one.');
    }
    return db;
}

/**
 * The guard belongs at the call site rather than in `hashToken`, so a browser with a malformed link and a
 * write with no credential can be told apart.
 *
 * @returns {boolean}
 */
export function isUnusableToken(token) {
    return typeof token !== 'string' || token.length === 0;
}
