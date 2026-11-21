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

/**
 * THE MAP IS SWEPT, because nothing else ever removes a key.
 *
 * A key is added for every distinct address and every distinct email, and the array beside it is
 * only ever filtered on the next attempt with THAT key. A flood of distinct addresses or addresses
 * therefore grows this map for the life of the process, and the report is right that it is unbounded.
 *
 * THE BOUND: one sweep interval removes every key whose newest attempt is older than the longest
 * window, which is also the point after which the key can no longer refuse anything. So the map holds
 * at most every key seen within the last full window, plus none that can affect a decision. Three
 * limits are in play (3 per email, 10 per IP, 60 per token, the last over an hour), so the sweep
 * horizon is the LONGEST of them and a shorter window's keys are still swept by their own age.
 *
 * `unref()` matters: the interval must not hold the process open, or a shutdown would hang for the
 * length of a window waiting for a timer nobody needs.
 */
const SWEEP_INTERVAL_MS = 60_000;

/** The longest window any limiter uses, so a key younger than this may still refuse. */
const LONGEST_WINDOW_MS = Math.max(EMAIL_WINDOW_MS, IP_WINDOW_MS, 60 * 60_000);

/** The most keys the map may hold before the sweep refuses to rely on age alone. */
const MAX_TRACKED_KEYS = 100_000;

let lastSweepAt = 0;
let sweepTimer = null;

/**
 * Remove keys that can no longer affect a decision, and report the size.
 *
 * @returns {{ before: number, after: number }}
 */
export function sweepRateLimits(now = Date.now()) {
    const before = attemptsByKey.size;

    for (const [key, timestamps] of attemptsByKey) {
        const newest = timestamps.length ? timestamps[timestamps.length - 1] : 0;
        if (now - newest >= LONGEST_WINDOW_MS) attemptsByKey.delete(key);
    }

    // A map still this large after an age sweep is a flood rather than normal traffic. Clearing it is
    // the safe direction: it can only admit a request, never refuse one, and an unbounded map is the
    // fault being fixed.
    if (attemptsByKey.size > MAX_TRACKED_KEYS) {
        console.warn(`[rate-limit] ${attemptsByKey.size} keys after a sweep, over the ${MAX_TRACKED_KEYS} bound: clearing`);
        attemptsByKey.clear();
    }

    lastSweepAt = now;
    return { before, after: attemptsByKey.size };
}

/** Start the periodic sweep. Idempotent, and `unref()` so it never keeps the process alive. */
export function startRateLimitSweep() {
    if (sweepTimer) return;
    sweepTimer = setInterval(() => {
        const { before, after } = sweepRateLimits();
        if (before !== after) console.log(`[rate-limit] swept ${before - after} expired keys (${after} remain)`);
    }, SWEEP_INTERVAL_MS);
    sweepTimer.unref();
}

/** Stop the sweep. Tests and shutdown. */
export function stopRateLimitSweep() {
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = null;
}

/** The most characters a sign-in address may have: the address maximum, RFC 5321 section 4.5.3.1.3. */
export const MAX_EMAIL_CHARS = 254;

/** Lowercased, so the same address is not counted twice by case. */
function emailKey(email) {
    return `email:${String(email).trim().toLowerCase()}`;
}

/**
 * Whether an address may be used as a rate-limit key at all.
 *
 * The limit is recorded BEFORE the form is validated, so an unvalidated body becomes a key: a 64KB
 * body contributes a 64KB key, and a flood of distinct junk addresses each gets its own bucket. An
 * address that cannot be a real address is REFUSED BY THE FORM ANYWAY, so it needs no bucket, and the
 * IP bucket still counts the request.
 *
 * @param {string} email
 * @returns {boolean}
 */
export function isRateLimitableEmail(email) {
    const text = String(email ?? '').trim();
    if (text.length === 0 || text.length > MAX_EMAIL_CHARS) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
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
 * THE EMAIL BUCKET IS ONLY USED FOR SOMETHING THAT COULD BE AN ADDRESS. `isRateLimitableEmail` decides
 * that here rather than at each call site, because a call site that forgot was how a caller-supplied
 * 64KB body became a key. A malformed address still counts against the IP bucket, so the request is
 * still limited; it simply does not get a bucket of its own.
 *
 * @param {object} req the request, for `req.ip`
 * @param {string} email the address from the form, not yet validated by the route
 * @param {{ scope?: string }} [options] `scope` keeps two forms apart, so a lost-link attempt and a
 *   sign-in attempt for one address do not spend each other's budget
 * @returns {{ allowed: boolean, retryAfterSeconds: number, reason?: 'email'|'ip' }}
 */
export function checkLoginRate(req, email, { scope = '' } = {}) {
    const prefix = scope ? `${scope}:` : '';

    // The IP bucket is always spent: an invalid address is still a request.
    const byIp = record(ipKey(req), IP_LIMIT, IP_WINDOW_MS);

    // Validate BEFORE counting, so no key is created for an address that could not be real.
    let byEmail = { allowed: true, remaining: EMAIL_LIMIT };
    if (isRateLimitableEmail(email)) {
        byEmail = record(`${prefix}${emailKey(email)}`, EMAIL_LIMIT, EMAIL_WINDOW_MS);
    }

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
