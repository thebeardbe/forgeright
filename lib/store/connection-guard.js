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
 * A missing or empty `?token=` IS ROUTINE, not a programming error, so the READ paths treat an
 * unusable token as a token matching nothing: nothing to return. `hashToken` stays strict, because
 * it is the wrong place to loosen the contract; the guard belongs at the call site, where a browser
 * with a malformed link and a write with no credential can be told apart.
 *
 * THE RULE: a READ returns nothing for any token yielding no invitation, usable or not. A WRITE
 * throws for both, because a write with no valid credential is a caller error and a returned null is
 * a silent failure a caller has to remember to check.
 *
 * ONE SHARED IMPLEMENTATION, so the invitation and response paths agree on "unusable".
 *
 * @param {unknown} token
 * @returns {boolean}
 */
export function isUnusableToken(token) {
    return typeof token !== 'string' || token.length === 0;
}
