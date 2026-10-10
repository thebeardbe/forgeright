/**
 * Test helper: redeem one sign-in token, in its own thread.
 *
 * The single-use guarantee lives in an UPDATE ... WHERE used_at IS NULL, which
 * only means anything if two redemptions can actually overlap. node:sqlite is
 * synchronous on the calling thread, so overlapping calls need separate workers;
 * this is that worker. It imports the module fresh per thread and reports the
 * result back.
 */
import { workerData, parentPort } from 'node:worker_threads';

const tokens = await import('../../lib/auth/tokens.js');

try {
    const result = tokens.redeemLoginToken(workerData.token);
    parentPort.postMessage(result);
} catch (err) {
    parentPort.postMessage({ ok: false, reason: `threw:${err.message}` });
}
