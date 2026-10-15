/**
 * The read-only demo link: a session that can look at one organisation and change nothing.
 *
 * A separate route rather than a long-lived sign-in token, because the tokens in `lib/auth/tokens.js` are
 * single-use and short-lived and a link that works for weeks is a different kind of credential rather than
 * a weakened one.
 *
 * `DEMO_LOGIN=1` is required and without it the route is not registered at all; `DEMO_LOGIN_ORG` names the
 * organisation; `DEMO_LOGIN_TOKEN` is the credential; `DEMO_LOGIN_DAYS` is optional.
 *
 * The organisation comes from configuration and never from the request, which is this codebase's central
 * invariant.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { adminConnection } from '../store/registry.js';
import { assertDemoTokenNotPlaceholderInPublic } from './demo-token-policy.js';

/** Length of a SHA-256 hex digest, the form a token is compared in. */
const TOKEN_HASH_HEX_LENGTH = 64;

/** Lowercase hex only, matching what `hashToken` produces. */
const HEX_PATTERN = /^[0-9a-f]+$/;

/** The link's life, in days, when DEMO_LOGIN_DAYS says nothing. */
const DEFAULT_DEMO_DAYS = 60;


/** ISO 8601 UTC, matching the store's timestamp convention. */
function nowIso() {
    return new Date().toISOString();
}

/**
 * Whether demo login is configured, and the settings it needs. Every requirement is checked here, so a
 * half-configured deployment gets no route rather than one that half works; a missing organisation is the
 * dangerous case, because the tempting fix at that point is to read one from the request.
 *
 * @returns {{enabled: true, orgId: string, token: string, days: number}
 *   | {enabled: false, reason: string}}
 */
export function demoLoginConfig() {
    if (process.env.DEMO_LOGIN !== '1') {
        return { enabled: false, reason: 'DEMO_LOGIN is not 1' };
    }

    const orgId = (process.env.DEMO_LOGIN_ORG || '').trim();
    const token = (process.env.DEMO_LOGIN_TOKEN || '').trim();

    if (orgId === '') {
        return { enabled: false, reason: 'DEMO_LOGIN=1 but DEMO_LOGIN_ORG is empty' };
    }
    if (token.length < 24) {
        return {
            enabled: false,
            reason: `DEMO_LOGIN=1 but DEMO_LOGIN_TOKEN is ${token.length} characters, ` +
                'and a link that leaves the building needs at least 24'
        };
    }

    // Last, so a misconfigured organisation is reported before a token problem.
    const tokenCheck = assertDemoTokenNotPlaceholderInPublic(token);
    if (!tokenCheck.ok) {
        return {
            enabled: false,
            reason:
                'DEMO_LOGIN=1 with the committed placeholder token, but this installation is ' +
                `reachable beyond this machine: ${tokenCheck.reason}. The placeholder is in the ` +
                'repository, so anyone who has read it can open the demo. Set DEMO_LOGIN_TOKEN to ' +
                'a private value, for example the output of `openssl rand -base64 32`. To run the ' +
                'demo locally instead, set PUBLIC_BASE_URL to a localhost URL such as ' +
                'https://localhost:8443.'
        };
    }

    return { enabled: true, orgId, token, days: demoDays() };
}

/**
 * How long a demo link lives, in days. Empty and whitespace count as unset, as everywhere else.
 *
 * @returns {number}
 */
function demoDays() {
    const raw = process.env.DEMO_LOGIN_DAYS;
    if (raw === undefined || raw.trim() === '') return DEFAULT_DEMO_DAYS;

    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        console.warn(
            `[demo] DEMO_LOGIN_DAYS=${JSON.stringify(raw)} is not a positive number; ` +
            `using ${DEFAULT_DEMO_DAYS} days.`
        );
        return DEFAULT_DEMO_DAYS;
    }
    return parsed;
}

/** SHA-256 of a token, hex. The form the comparison works in, so no plaintext lives long. */
function hashToken(token) {
    return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Whether a supplied token is the configured one, compared in constant time.
 *
 * Both sides are hashed first, which is what makes `timingSafeEqual` usable: it throws on unequal lengths,
 * while hashing gives two 32-byte buffers whatever was supplied, where padding or a length comparison would
 * leak the expected token's length.
 *
 * A missing token and a wrong token take the same path and return the same false, so neither the caller nor
 * a timing measurement can distinguish them.
 *
 * @param {string} supplied The value from the query string, possibly empty or absent.
 * @param {string} expected The configured token.
 * @returns {boolean}
 */
export function demoTokenMatches(supplied, expected) {
    const suppliedText = typeof supplied === 'string' ? supplied : '';
    const expectedText = typeof expected === 'string' ? expected : '';

    const a = hashToken(suppliedText);
    const b = hashToken(expectedText);

    // Equal length by construction; the guard is here so a future change fails loudly here.
    if (a.length !== TOKEN_HASH_HEX_LENGTH || b.length !== TOKEN_HASH_HEX_LENGTH) return false;
    if (!HEX_PATTERN.test(a) || !HEX_PATTERN.test(b)) return false;
    if (Buffer.from(a, 'hex').length !== Buffer.from(b, 'hex').length) return false;

    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * Marks a session as a demo of one organisation.
 *
 * A row rather than a session column, because a new table reaches an existing file through `CREATE TABLE IF
 * NOT EXISTS` while a new column would need a migration this project does not have.
 *
 * The expiry mirrors the session's, and the session row remains the authority for validity.
 *
 * @param {object} args
 * @param {string} args.sessionId
 * @param {string} args.orgId
 * @param {string} args.email
 * @param {string} args.expiresAt The session's own expiry.
 */
export function markSessionAsDemo({ sessionId, orgId, email, expiresAt }) {
    adminConnection().prepare(
        `INSERT INTO demo_session (session_id, org_id, email, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET org_id = excluded.org_id, expires_at = excluded.expires_at`
    ).run(sessionId, orgId, email, nowIso(), expiresAt);
}

/**
 * The demo row for a session, or null. It returns null for an expired demo row too, and the caller must
 * treat that as read-only rather than as an ordinary session; use `isDemoSession` for that question.
 *
 * @param {string} sessionId
 * @returns {{org_id: string, email: string, expires_at: string}|null}
 */
export function demoRowForSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return null;
    return adminConnection()
        .prepare('SELECT org_id, email, expires_at FROM demo_session WHERE session_id = ?')
        .get(sessionId) ?? null;
}

/**
 * Records that a demo link was used: the email and the organisation, never the token, so a leaked link
 * shows up as an unexplained access rather than not at all.
 *
 * @param {string} orgId
 * @param {string} email
 */
export function logDemoUse(orgId, email) {
    console.info(
        `[demo] a demo link was used: organisation ${orgId}, session for ${email}, at ${nowIso()}`
    );
}

/**
 * Removes demo rows whose session has gone. Housekeeping rather than a control, so the installation
 * database does not grow without bound.
 *
 * @returns {number} Rows removed.
 */
export function pruneDemoSessions() {
    const result = adminConnection().prepare(
        `DELETE FROM demo_session
         WHERE expires_at <= ?
            OR session_id NOT IN (SELECT id FROM admin_session WHERE revoked_at IS NULL)`
    ).run(nowIso());
    return Number(result.changes);
}

/**
 * The address a demo session is recorded under. Not a real user, and deliberately not provisioned: the
 * session resolves its organisation from its `demo_session` row, so removing the demo configuration leaves
 * nothing behind. `.invalid` is reserved by RFC 2606, so it can never belong to a real mailbox.
 */
export const DEMO_VIEWER_EMAIL = 'demo-viewer@forgeright.invalid';

/**
 * Registers `GET /demo` on the admin router, but only when the demo is configured.
 *
 * The route is not added at all without `DEMO_LOGIN=1`: the path is never registered, so an unconfigured
 * deployment answers it as it answers any unknown console path.
 *
 * The organisation comes from configuration and never from the request.
 *
 * @param {object} router The admin router to register on.
 * @param {object} deps The pieces this route needs from the auth layer, passed rather
 *   than imported, so this module does not import `routes.js` back and create a cycle.
 */
export function registerDemoRoute(router, deps) {
    const {
        createSession, currentSession, isDemoSession, sessionCookieOptions,
        isSecureRequest, withBasePath, SESSION_COOKIE, getOrganisation
    } = deps;

    const demo = demoLoginConfig();
    if (!demo.enabled) {
        // Logged here, because the caller ignores the returned object and a refusal that only returned
        // would be invisible. `DEMO_LOGIN is not 1` is the default rather than a misconfiguration.
        if (demo.reason !== 'DEMO_LOGIN is not 1') {
            console.error(
                `[demo] the read-only demo route is NOT registered: ${demo.reason}`
            );
        }
        return { registered: false, reason: demo.reason };
    }

    // The organisation must exist, or the link would set a session pointing at nothing, and the check is at
    // startup because it is a configuration error rather than a request condition.
    //
    // A malformed id throws rather than returning null, because the store's `getOrganisation` refuses
    // anything outside the safe-path pattern, so it must be caught here. A catch rather than a pattern check,
    // so this refuses whatever the store refuses rather than duplicating its validation.
    let organisationExists = false;
    try {
        organisationExists = Boolean(getOrganisation(demo.orgId));
    } catch (err) {
        console.error(
            `[demo] DEMO_LOGIN=1 but DEMO_LOGIN_ORG=${JSON.stringify(demo.orgId)} was refused by the ` +
            `store: ${err.message} A real id is a UUID, so this is a configuration error. The demo ` +
            'route is NOT registered, and the server is starting anyway so the mistake is visible here ' +
            'rather than by the route quietly not existing.'
        );
        return { registered: false, reason: 'DEMO_LOGIN_ORG is not a usable organisation id' };
    }

    if (!organisationExists) {
        console.error(
            `[demo] DEMO_LOGIN=1 but DEMO_LOGIN_ORG=${JSON.stringify(demo.orgId)} names no ` +
            'organisation in this store. The demo route is NOT registered. Point it at an ' +
            'organisation that exists.'
        );
        return { registered: false, reason: 'DEMO_LOGIN_ORG names no organisation' };
    }

    console.info(
        `[demo] read-only demo login ENABLED for organisation ${demo.orgId}, ` +
        `links valid for ${demo.days} day(s)`
    );
    pruneDemoSessions();

    router.get('/demo', (req, res) => {
        const session = currentSession(req);

        // A demo link must not silently downgrade a working admin to read-only.
        if (session && !isDemoSession(session)) {
            console.warn('[demo] a demo link was opened by an already signed-in session; left unchanged.');
            return res.redirect(withBasePath('/admin'));
        }

        if (!demoTokenMatches(req.query?.token, demo.token)) {
            // One outcome for a wrong token and a missing one, so the route cannot be probed for its
            // existence; the log distinguishes them for an operator.
            console.warn('[demo] a demo link was refused: the token did not match.');
            return res.status(404).render('admin-no-access', { email: null, demo: true });
        }

        // The session is created and marked before the cookie is set, so no request sees a demo cookie as
        // a writable session.
        const { cookieValue, sessionId, expiresAt } = createSession(DEMO_VIEWER_EMAIL);
        markSessionAsDemo({ sessionId, orgId: demo.orgId, email: DEMO_VIEWER_EMAIL, expiresAt });
        logDemoUse(demo.orgId, DEMO_VIEWER_EMAIL);

        res.cookie(SESSION_COOKIE, cookieValue, sessionCookieOptions(isSecureRequest(req)));
        return res.redirect(withBasePath('/admin'));
    });

    return { registered: true, orgId: demo.orgId, days: demo.days };
}
