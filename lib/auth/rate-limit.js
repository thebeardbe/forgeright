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

/**
 * THE CLIENT ADDRESS, AS EXPRESS RESOLVED IT.
 *
 * `req.ip` is the value `app.set('trust proxy', ...)` produces: Express walks the connection peer and
 * the forwarded headers together, trusting only the peers TRUST_PROXY names, and returns the address
 * it has established is the client. That is the ONLY correct way to get this, and the previous code
 * was wrong in the direction that hurts every user:
 *
 *   It read `req.socket.remoteAddress`. Behind the owner's Nginx Proxy Manager that is NPM's own
 *   address for EVERY visitor, so all sign-ins in the world shared one bucket and ten attempts from
 *   anywhere locked every admin out for fifteen minutes. The participant bucket had the same fault.
 *
 * DO NOT REIMPLEMENT THIS FROM HEADERS. `X-Forwarded-For` is a list, and its leftmost entry is
 * whatever the client sent unless a trusted proxy overwrote it. Express already knows which peers
 * are trusted; a hand-rolled `split(',')[0]` would let any caller pick its own bucket.
 *
 * WHEN TRUST_PROXY IS UNSET AND A PROXY IS IN FRONT, `req.ip` is still the proxy, so the sharing
 * fault remains. That is a DEPLOYMENT fault rather than a code one, and the startup log names the
 * setting so an operator can see it: see `describeAddressSource` below.
 *
 * `req.ip` falls back to the socket address on a request object Express did not build, which is what
 * the unit tests use.
 */
function ipKey(req) {
    const address = req.ip || req.socket?.remoteAddress || 'unknown';
    return `ip:${address}`;
}

/**
 * A sentence for the startup log, so an operator can see WHICH address the limiter is keyed on before
 * a user reports a lockout.
 *
 * @param {{setting: boolean|number|string|string[], summary: string}} trustProxy the resolved setting
 * @returns {string}
 */
export function describeAddressSource(trustProxy) {
    const trusted = trustProxy?.setting;
    const on = trusted !== false && trusted !== undefined && trusted !== null;

    if (!on) {
        return 'rate limits key on the connection peer (req.ip). TRUST_PROXY is unset, so if a '
            + 'reverse proxy is in front, EVERY visitor shares that one address and one bucket: set '
            + 'TRUST_PROXY to the proxy address (see DEPLOY.md).';
    }
    return `rate limits key on the client address Express resolves through the trusted proxy `
        + `(${trustProxy.summary}). Every visitor gets their own bucket.`;
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
