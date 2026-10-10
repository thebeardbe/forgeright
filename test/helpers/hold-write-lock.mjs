/**
 * Test helper: hold a write lock on one organisation database file.
 *
 * node:sqlite is synchronous on the calling thread, so a write blocked waiting
 * for a lock cannot be released by a timer in the same thread. This worker takes
 * a write transaction on the file from a SEPARATE thread, which is what lets the
 * store's synchronous write genuinely wait for the lock, then get it.
 *
 * It posts `{ holding: true }` once the lock is held, then commits and exits
 * after `holdMs`. With `holdMs: Infinity` it holds the lock until the parent
 * terminates the worker, which is how "a lock that is never released" is tested.
 */
import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';

const db = new DatabaseSync(workerData.dbPath);
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA journal_mode = WAL');

// A write transaction, so the lock is held rather than released immediately.
// The write must actually touch a row: an UPDATE that matches nothing does not
// necessarily hold a write lock in WAL, which would let the parent write through
// and make the test prove nothing. schema_meta always has a row.
db.exec('BEGIN IMMEDIATE');
db.prepare("UPDATE schema_meta SET value = value WHERE key = 'schema_version'").run();

parentPort.postMessage({ holding: true });

if (Number.isFinite(workerData.holdMs)) {
    setTimeout(() => {
        try {
            db.exec('COMMIT');
        } catch {
            // The lock may already be gone; the test does not depend on it here.
        }
        db.close();
        process.exit(0);
    }, workerData.holdMs);
} else {
    // `holdMs: Infinity` means "hold until the parent terminates this worker".
    // The event loop must stay alive, or the worker script finishes, the worker
    // exits, SQLite rolls the open transaction back, and the lock is released
    // before the parent ever tries to write: the test would then pass a write
    // through and prove nothing.
    setInterval(() => {}, 1 << 30);
}
