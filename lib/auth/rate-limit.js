/**
 * Rate limiting, in memory and per process: a restart clears the counters, which is acceptable because these
 * limits exist to stop a loop or a script, not to enforce a quota.
 *
 * Two limiters share one window mechanism:
 *
 *   checkLoginRate    the sign-in and lost-link forms, keyed by email and by IP
 *   checkChatRate     the questionnaire's AI endpoint, keyed by participant token
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

/**
 * One interview's turn budget, per participant token.
 *
 * MEASURED: a real interview is 8 `/api/chat` calls for one process (the mock script asks
 * eight questions) and 10 for two, and a working conversation gains evidence on nearly every
 * turn. The evidence cap bounds a stuck one at 20 turns without new evidence.
 *
 * 60 in an hour is therefore SEVEN TIMES a two-process interview: a person answering honestly
 * cannot reach it, and it holds even for somebody who abandons and resumes repeatedly. A loop
 * reaches it in under a minute.
 *
 * Per token and not per IP, deliberately. `/api/chat` is reached from a browser on whatever
 * network the participant is on, so an IP key would punish an office behind one NAT and be
 * evaded by a script that rotates addresses. The token is the unit of cost: one invitation,
 * one budget. Reloading the page re-sends the same token and continues the same count, so a
 * genuine resume is not refused - which is exactly the case an IP window would break.
 */
const CHAT_LIMIT = 60;
const CHAT_WINDOW_MS = 60 * 60_000;

/**
 * Counts one AI call against a participant token. The token is what the route already
 * resolved, so this cannot be keyed on anything an unauthenticated caller chooses.
 *
 * @param {string} participantToken The token the route resolved to an organisation.
 * @returns {{ allowed: boolean, retryAfterSeconds: number, remaining: number }}
 */
export function checkChatRate(participantToken) {
    const key = `chat:${String(participantToken).trim()}`;
    const result = record(key, CHAT_LIMIT, CHAT_WINDOW_MS);

    return {
        allowed: result.allowed,
        retryAfterSeconds: result.allowed ? 0 : Math.ceil(CHAT_WINDOW_MS / 1000),
        remaining: result.remaining
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

/** The AI endpoint's budget, separate from LIMITS because that object is the login limiter's. */
export const CHAT_LIMITS = {
    max: CHAT_LIMIT,
    windowMinutes: CHAT_WINDOW_MS / 60_000
};
