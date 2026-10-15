/**
 * The connection wait policy for writer contention.
 *
 * WAL allows exactly one writer at a time and does not queue writers, so without a wait a second
 * participant submitting at the same moment fails with "database is locked" immediately, which
 * reaches the route as a 500. The value here is applied to every connection by registry.js.
 */

/** How long a connection waits for a writer's lock before giving up, in milliseconds. */
const DEFAULT_BUSY_TIMEOUT_MS = 2000;

/**
 * The largest wait accepted, in milliseconds. A larger value only hides a stuck writer for longer; a
 * value above this is clamped rather than refused, because refusing it would fail every connection
 * over a configuration typo.
 */
const MAX_BUSY_TIMEOUT_MS = 60_000;

/**
 * The wait to apply to a new connection. Read per call rather than at module load, so a test or a
 * deployment can set the variable before the first connection is opened. An empty or
 * whitespace-only value counts as unset, not as zero, because `Number('')` is `0` and zero would
 * silently reinstate the immediate "database is locked" failure this setting exists to prevent.
 *
 * @returns {number} Milliseconds to wait.
 */
export function busyTimeoutMs() {
    const raw = process.env.STORE_BUSY_TIMEOUT_MS;

    if (raw === undefined || raw.trim() === '') {
        return DEFAULT_BUSY_TIMEOUT_MS;
    }

    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
        console.warn(
            `[store] STORE_BUSY_TIMEOUT_MS=${JSON.stringify(raw)} is not a usable number; ` +
            `using ${DEFAULT_BUSY_TIMEOUT_MS}ms.`
        );
        return DEFAULT_BUSY_TIMEOUT_MS;
    }

    if (parsed > MAX_BUSY_TIMEOUT_MS) {
        console.warn(
            `[store] STORE_BUSY_TIMEOUT_MS=${JSON.stringify(raw)} exceeds the ` +
            `${MAX_BUSY_TIMEOUT_MS}ms maximum; clamping to ${MAX_BUSY_TIMEOUT_MS}ms.`
        );
        return MAX_BUSY_TIMEOUT_MS;
    }

    console.info(`[store] busy timeout for new connections: ${parsed}ms (from STORE_BUSY_TIMEOUT_MS)`);
    return parsed;
}
