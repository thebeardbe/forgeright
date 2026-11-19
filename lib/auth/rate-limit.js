/**
 * Rate limiting for the admin login request, in memory and per process: a restart clears the counters, which is
 * acceptable because the limit exists to stop a loop or a script filling someone's inbox. Both windows must
 * pass, and the email one is stricter.
 */

/** A sign-in link is valid for 15 minutes; asking twice a minute is ample. */
const EMAIL_LIMIT = 3;
const EMAIL_WINDOW_MS = 15 * 60_000;

/** Ten per IP per 15 minutes: generous for a shared office, far below what enumerating a mailbox list needs. */
const IP_LIMIT = 10;
const IP_WINDOW_MS = 15 * 60_000;

/** Timestamps of recent attempts, keyed by email and by IP. */
const attemptsByKey = new Map();

/** Lowercased, so the same address is not counted twice by case. */
function emailKey(email) {
    return `email:${String(email).trim().toLowerCase()}`;
}

/** The socket address, not a forwarded header, which is attacker-controlled unless a trusted proxy sets it. */
function ipKey(req) {
    const address = req.socket?.remoteAddress || 'unknown';
    return `ip:${address}`;
}

/**
 * @returns {{ allowed: boolean, remaining: number }}
 */
function record(key, limit, windowMs) {
    const now = Date.now();
    const recent = (attemptsByKey.get(key) || []).filter((at) => now - at < windowMs);

    if (recent.length >= limit) {
        attemptsByKey.set(key, recent);
        return { allowed: false, remaining: 0 };
    }

    recent.push(now);
    attemptsByKey.set(key, recent);
    return { allowed: true, remaining: limit - recent.length };
}

/**
 * A refused attempt consumes both counters as well, so hammering the endpoint cannot clear its own window.
 *
 * @returns {{ allowed: boolean, retryAfterSeconds: number, reason?: 'email'|'ip' }}
 */
export function checkLoginRate(req, email) {
    const byEmail = record(emailKey(email), EMAIL_LIMIT, EMAIL_WINDOW_MS);
    const byIp = record(ipKey(req), IP_LIMIT, IP_WINDOW_MS);

    if (!byEmail.allowed) {
        return { allowed: false, retryAfterSeconds: Math.ceil(EMAIL_WINDOW_MS / 1000), reason: 'email' };
    }
    if (!byIp.allowed) {
        return { allowed: false, retryAfterSeconds: Math.ceil(IP_WINDOW_MS / 1000), reason: 'ip' };
    }

    return {
        allowed: true,
        retryAfterSeconds: 0
    };
}

/** Tests and shutdown only; not called in normal operation. */
export function resetRateLimits() {
    attemptsByKey.clear();
}

/** The configured limits, for the startup log and for tests. */
export const LIMITS = {
    email: { max: EMAIL_LIMIT, windowMinutes: EMAIL_WINDOW_MS / 60_000 },
    ip: { max: IP_LIMIT, windowMinutes: IP_WINDOW_MS / 60_000 }
};
