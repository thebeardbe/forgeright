/**
 * Small helpers shared by the statement modules.
 *
 * Split out so that invitation-sql.js and sqlite.js can both use them without
 * importing each other: this module opens nothing and holds no state, so it
 * cannot become a place where two tenants meet.
 */

/** ISO 8601 UTC, the format every timestamp column holds, so text sorts chronologically. */
export function nowIso() {
    return new Date().toISOString();
}

/**
 * Fails loudly when a connection was not handed in.
 *
 * These modules NEVER open a connection: one is handed to them by
 * lib/store/registry.js, so a mistake here can lose a row but never reach
 * another organisation's file. A missing connection is a programming error.
 */
export function assertConnection(db) {
    if (!db || typeof db.prepare !== 'function') {
        throw new Error('A DatabaseSync connection is required; statement modules never open one.');
    }
    return db;
}

/**
 * True when a value could not be a token this system issued.
 *
 * A participant link with a missing or empty `?token=` parameter is a routine
 * event, not a programming error, so the READ paths treat an unusable token the
 * same way as a token that matches nothing: nothing to return. `hashToken` stays
 * strict, because it is the wrong place to loosen the contract; the guard belongs
 * at the call site, where the two kinds of caller (a browser with a malformed
 * link, and a write with no credential) can be told apart.
 *
 * THE RULE, in full: a READ returns nothing for any token that yields no
 * invitation, whether the token is unusable or simply unknown. A WRITE throws for
 * both, because a write with no valid credential is a caller error and a returned
 * null is a silent failure a caller has to remember to check.
 *
 * One implementation, shared, because the invitation paths and the response paths
 * must agree on what "unusable" means.
 *
 * @param {unknown} token
 * @returns {boolean}
 */
export function isUnusableToken(token) {
    return typeof token !== 'string' || token.length === 0;
}
