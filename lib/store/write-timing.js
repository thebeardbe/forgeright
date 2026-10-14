/**
 * Write timing, and reporting when a write had to wait for a lock.
 *
 * Kept out of lib/store/index.js so the public interface stays a list of
 * operations rather than a list of operations plus timing logic, and so this
 * policy can be read on its own.
 *
 * WHY TIME AT ALL: SQLite's busy handler waits INSIDE the statement, so the delay is invisible to
 * the caller. Timing the call is the cheap way to know a write waited, and it is worth knowing - a
 * write that silently waited two seconds is contention that would otherwise surface only as an
 * occasional slow request.
 *
 * NO RETRY. A contending write already waits up to STORE_BUSY_TIMEOUT_MS and succeeds if the other
 * writer releases in time; if it still fails, a writer held the file longer than the timeout, which
 * at this workload's write sizes means a stuck transaction or an external process. Retrying would
 * delay surfacing a real fault, and a bounded retry is a queue with a small bound.
 */

/**
 * A write slower than this is reported as having waited for a lock, in
 * milliseconds. Well above a normal local write (microseconds), so the log
 * records contention rather than routine operation, and low enough to catch a
 * stall a participant would notice.
 */
const WAITED_FOR_LOCK_MS = 100;

/**
 * Matches SQLite's lock errors, which have more than one spelling.
 *
 * "database is locked" is the common one for a busy timeout, but
 * "database table is locked" also occurs, and the driver can capitalise
 * differently. Matching only the exact lowercase string meant the one thing
 * this module exists to report was missed for the other forms.
 */
const LOCKED_PATTERN = /database (table )?is locked/i;

/**
 * True when an error is a lock failure, by message or by error code.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isLockError(err) {
    if (!err || typeof err !== 'object') return false;
    if (typeof err.message === 'string' && LOCKED_PATTERN.test(err.message)) return true;
    // SQLITE_BUSY and SQLITE_LOCKED, in case a driver surfaces the code without
    // a recognisable message.
    return err.errcode === 5 || err.errcode === 6;
}

/**
 * Runs a write and reports when it had to wait for another writer's lock.
 *
 * A failure is never swallowed: a lock error is logged as the fault it is and
 * rethrown, so the caller surfaces it rather than the submission disappearing.
 *
 * The wait warning is emitted on the success path only. A write that threw has
 * not "waited for a lock" in the sense the warning means; reporting it that way
 * would describe a failure as slow contention.
 *
 * @param {string} orgId
 * @param {string} operation Named operation, so the log says which write waited.
 * @param {() => any} write
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
