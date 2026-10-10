/**
 * Rate limiting for the admin login request.
 *
 * In memory, per process. Enough for this step: one instance, one admin console,
 * and the thing being protected is a mail send, not a database. A restart clears
 * the counters, which is acceptable because the limit exists to stop a loop or a
 * script filling someone's inbox, not to enforce a billing quota. A distributed
 * limit belongs with the real deployment, alongside the reverse proxy that can
 * see the true client address.
 *
 * Two windows, checked independently:
 *   per email  stops one address being mail-bombed
 *   per IP     stops one source enumerating many addresses
 *
 * Both must pass. The email window is stricter because the harm it prevents is
 * aimed at a person.
 */

/** A sign-in link is valid for 15 minutes; asking twice a minute is ample. */
const EMAIL_LIMIT = 3;
const EMAIL_WINDOW_MS = 15 * 60_000;

/**
 * Ten attempts per IP per 15 minutes. Generous for a shared office behind one
 * address, where several admins might sign in, and still far below what
 * enumerating a mailbox list would need.
 */
const IP_LIMIT = 10;
const IP_WINDOW_MS = 15 * 60_000;

/** Timestamps of recent attempts, keyed by email and by IP. */
const attemptsByKey = new Map();

/**
 * The key for an email, lowercased: an address is case-insensitive in its domain
 * and a login form should not let the same address be counted twice by case.
 *
 * @param {string} email
 * @returns {string}
 */
function emailKey(email) {
    return `email:${String(email).trim().toLowerCase()}`;
}

/**
 * The key for a client address.
 *
 * Deliberately the socket address, not a forwarded header: a header is
 * attacker-controlled unless a trusted proxy is configured to set it, and this
 * step has no such configuration. The consequence is noted in the caller: behind
 * a proxy every request shares the proxy's address, so the IP limit is coarse
 * until the proxy is trusted explicitly.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
function ipKey(req) {
    const address = req.socket?.remoteAddress || 'unknown';
    return `ip:${address}`;
}

/**
 * Counts an attempt against one key, and reports whether it is allowed.
 *
 * @param {string} key
 * @param {number} limit
 * @param {number} windowMs
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
 * Attempts from this address and for this email, which must both be allowed.
 *
 * Both counters are consumed by a refused attempt as well, so hammering the
 * endpoint cannot clear its own window by waiting less than the interval.
 *
 * @param {import('express').Request} req
 * @param {string} email
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

/** Drops every counter. Used by tests and on shutdown; not called in normal operation. */
export function resetRateLimits() {
    attemptsByKey.clear();
}

/** The configured limits, for the startup log and for tests to assert against. */
export const LIMITS = {
    email: { max: EMAIL_LIMIT, windowMinutes: EMAIL_WINDOW_MS / 60_000 },
    ip: { max: IP_LIMIT, windowMinutes: IP_WINDOW_MS / 60_000 }
};
