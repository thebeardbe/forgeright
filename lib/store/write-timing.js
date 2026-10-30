/**
 * Write timing, and reporting when a write had to wait for a lock. SQLite's busy handler waits inside the
 * statement, so timing the call is the cheap way to know. No retry: a failed write has already waited up to
 * STORE_BUSY_TIMEOUT_MS.
 */

/** Milliseconds; above a normal local write, so the log records contention rather than routine operation. */
const WAITED_FOR_LOCK_MS = 100;

/** SQLite's lock errors have more than one spelling, and the driver can capitalise differently. */
const LOCKED_PATTERN = /database (table )?is locked/i;


function isLockError(err) {
    if (!err || typeof err !== 'object') return false;
    if (typeof err.message === 'string' && LOCKED_PATTERN.test(err.message)) return true;
    // SQLITE_BUSY and SQLITE_LOCKED, in case the code arrives without a recognisable message.
    return err.errcode === 5 || err.errcode === 6;
}

/**
 * A failure is never swallowed: a lock error is logged and rethrown. The wait warning is on the success path
 * only.
 *
 * @param {string} operation Named operation, so the log says which write waited.
 * @returns {any} Whatever the write returned.
 */
export function timedWrite(orgId, operation, write) {
    const started = Date.now();
    try {
        const result = write();
        const waited = Date.now() - started;
        if (waited >= WAITED_FOR_LOCK_MS) {
            console.warn(`[store] ${operation} in organisation ${orgId} waited ${waited}ms for a write lock.`);
        }
        return result;
    } catch (err) {
        if (isLockError(err)) {
            const waited = Date.now() - started;
            console.error(
                `[store] ${operation} in organisation ${orgId} gave up after ${waited}ms waiting ` +
                `for a write lock; another writer held the file longer than ` +
                `STORE_BUSY_TIMEOUT_MS (${process.env.STORE_BUSY_TIMEOUT_MS || 'default'}).`
            );
        }
        throw err;
    }
}
