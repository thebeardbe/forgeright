/**
 * Small helpers shared by the statement modules. It opens nothing and holds no state, so it cannot become
 * a place where two tenants meet.
 */

/** ISO 8601 UTC, the format every timestamp column holds, so text sorts chronologically. */
export function nowIso() {
    return new Date().toISOString();
}

/**
 * Fails loudly when a connection was not handed in. These modules never open one, and a missing connection
 * is a programming error.
 */
export function assertConnection(db) {
    if (!db || typeof db.prepare !== 'function') {
        throw new Error('A DatabaseSync connection is required; statement modules never open one.');
    }
    return db;
}

/**
 * True when a value could not be a token this system issued, so a read path can treat it as matching
 * nothing. The guard belongs at the call site rather than in `hashToken`, so a browser with a malformed
 * link and a write with no credential can be told apart.
 *
 * @param {unknown} token
 * @returns {boolean}
 */
export function isUnusableToken(token) {
    return typeof token !== 'string' || token.length === 0;
}
