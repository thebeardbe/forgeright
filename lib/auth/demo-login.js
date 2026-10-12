/**
 * The read-only demo link: a session that can look at ONE organisation and change nothing.
 *
 * WHAT IT IS FOR. A link the owner sends to a prospective client, showing a demo
 * organisation. It leaves the owner's hands, so it is treated as untrusted: it is
 * long-lived (60 days by default), it is reusable (that is the point of a link that
 * works for weeks), and it must not be able to change anything.
 *
 * WHY A SEPARATE ROUTE RATHER THAN A LONG-LIVED SIGN-IN TOKEN. The sign-in tokens in
 * `lib/auth/tokens.js` are SINGLE-USE and SHORT-LIVED, and both rules are enforced well
 * - the single-use one by a conditional UPDATE, so two concurrent redemptions cannot
 * both win. A link that works for weeks is a DIFFERENT KIND OF CREDENTIAL, not a
 * weakened one, and it is modelled separately here. Relaxing `redeemLoginToken` would
 * take a live defence away from the credential that guards real access, to serve a
 * route that needs none of it.
 *
 * FOUR VARIABLES, ALL IN THE ENVIRONMENT, AND NONE OF THEM IN THE DATABASE:
 *
 *   DEMO_LOGIN=1               REQUIRED. Without it the route is not registered at all.
 *   DEMO_LOGIN_ORG=<org id>    the organisation to show, read from CONFIG.
 *   DEMO_LOGIN_TOKEN=<random>  the credential, compared in constant time.
 *   DEMO_LOGIN_DAYS=60         optional, the link's life. Default 60.
 *
 * THE ORGANISATION COMES FROM CONFIGURATION AND NEVER FROM THE REQUEST. That is this
 * codebase's central invariant: no route takes a tenant from the request, which is why
 * `scopeForSession` is the single place a console route learns its organisation. A demo
 * route reading an org id from a query string would be the one mistake that shows one
 * client another client's data, and it would be reachable by editing a URL.
 *
 * THE ROUTE DOES NOT EXIST WITHOUT THE FLAG. It is registered only when `DEMO_LOGIN=1`,
 * so it cannot be enabled in production by a stray variable, and a probe of its path
 * gets the ordinary 404 that any unknown path gets.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { adminConnection } from '../store/registry.js';

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
 * Whether demo login is configured, and the settings it needs.
 *
 * EVERY REQUIREMENT IS CHECKED HERE, so a half-configured deployment gets NO route
 * rather than a route that half works. A missing organisation is the dangerous case:
 * the route would have nothing to show, and the tempting fix at that point is to read
 * one from the request.
 *
 * The token must be long enough to be worth comparing: a short value is guessable, and
 * this is a link that leaves the building. 24 characters of an operator's random string
 * is a floor, not a recommendation; the docs suggest 32 bytes in base64url, which is
 * what `generateLoginToken` produces.
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

    return { enabled: true, orgId, token, days: demoDays() };
}

/**
 * How long a demo link lives, in days.
 *
 * Empty and whitespace count as unset, as everywhere else in this codebase: an empty
 * variable is how one is disabled in a `.env` file, and a life of zero days would
 * issue links that are dead on arrival, which looks exactly like a broken route.
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
 * BOTH SIDES ARE HASHED FIRST, which is what makes `timingSafeEqual` usable here: it
 * throws on unequal lengths, and hashing gives two 32-byte buffers whatever was
 * supplied. The alternative - padding the shorter value, or comparing by length first -
 * leaks the length of the expected token, and length is the one thing an attacker
 * controls cheaply.
 *
 * A MISSING TOKEN AND A WRONG TOKEN TAKE THE SAME PATH and return the same false, with
 * no early return for one of them, so the caller cannot accidentally distinguish them
 * and neither can a timing measurement.
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

    // The hashes are equal length by construction, so this cannot throw. The guard is
    // kept because a future change to hashToken should fail here rather than at runtime.
    if (a.length !== TOKEN_HASH_HEX_LENGTH || b.length !== TOKEN_HASH_HEX_LENGTH) return false;
    if (!HEX_PATTERN.test(a) || !HEX_PATTERN.test(b)) return false;
    if (Buffer.from(a, 'hex').length !== Buffer.from(b, 'hex').length) return false;

    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * Marks a session as a demo of one organisation.
 *
 * A ROW RATHER THAN A SESSION COLUMN, because the admin schema is applied by
 * `CREATE TABLE IF NOT EXISTS` and a new table reaches an existing file with no version
 * bump, while a new column would need a migration this project deliberately does not
 * have. See the table's comment in `data/store/admin-schema.sql`.
 *
 * The expiry mirrors the session's, so a demo row cannot outlive the session it belongs
 * to. The session row remains the single authority for whether a session is valid.
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
 * The demo row for a session, or null when the session is an ordinary one.
 *
 * Returns null for an EXPIRED demo row as well, and the caller must treat that as
 * read-only rather than as an ordinary session: a demo login whose row has aged out is
 * still a demo login. `isDemoSession` is the accessor for that question, and it is what
 * callers should use.
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
 * Records that a demo link was used.
 *
 * LOGS THE EMAIL AND THE ORGANISATION, NEVER THE TOKEN. A log is a place a credential
 * leaks from, and the token is the whole credential here; it lives in configuration and
 * appears in a URL, which is already a place it can be captured. What an operator needs
 * after the fact is WHO used the link and WHEN, so a leaked link is visible in the log
 * as an unexplained access rather than not at all.
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
 * Removes demo rows whose session has gone.
 *
 * Housekeeping, not a control: `isDemoSession` refuses on the session's validity, which
 * the session table owns. Kept so the installation database does not grow without bound.
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
 * The address a demo session is recorded under.
 *
 * NOT A REAL USER, and deliberately not provisioned: a demo session resolves its
 * organisation from its `demo_session` row rather than from a `users` row, so the link
 * works without creating an account and removing the demo configuration leaves nothing
 * behind in the installation. The value is fixed and unmistakable so every demo access
 * is greppable in the log, and `.invalid` is reserved by RFC 2606, so it can never
 * belong to a real mailbox.
 */
export const DEMO_VIEWER_EMAIL = 'demo-viewer@forgeright.invalid';

/**
 * Registers `GET /demo` on the admin router, but ONLY when the demo is configured.
 *
 * IT LIVES HERE, BESIDE ITS OWN CONFIG, TOKEN AND SESSION MARKING, rather than in
 * `routes.js`: the route is the last step of a mechanism whose other three parts are in
 * this file, and splitting them across two files is how a change to one stops matching
 * the other. `routes.js` calls this with the pieces it owns.
 *
 * THE ROUTE IS NOT ADDED AT ALL WITHOUT `DEMO_LOGIN=1`. It is not a handler that checks
 * a flag and refuses; the path is never registered, so an unconfigured deployment
 * answers it exactly as it answers any unknown console path. That is what makes the
 * feature impossible to enable by forgetting a variable.
 *
 * THE ORGANISATION COMES FROM CONFIGURATION AND NEVER FROM THE REQUEST, which is this
 * codebase's central invariant: no route takes a tenant from the request. An org id in
 * a query string would be the one mistake that shows one client another client's data.
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
    if (!demo.enabled) return { registered: false, reason: demo.reason };

    // The organisation must EXIST, or the link would set a session pointing at nothing
    // and the console would refuse every page with a data fault. Checked once, at
    // startup, because it is a configuration error rather than a request condition.
    //
    // A MALFORMED ID THROWS RATHER THAN RETURNING NULL, and it must be caught here. The
    // store's `getOrganisation` calls `assertSafeOrgId`, which refuses anything outside
    // the safe-path pattern - an id pasted from a name, or a corrupted value - so a
    // config error used to escape this function. That is bad in TWO ways, and the second
    // is worse than the crash it caused: escaping during module load was swallowed
    // upstream, so the run started with the demo route silently NOT REGISTERED and no
    // message anywhere. The comment above used to claim this "refuses registration with a
    // message naming the problem", which was true only for an absent id.
    //
    // THE FIX IS A CATCH RATHER THAN A PATTERN CHECK, so this refuses whatever the store
    // refuses, including a rule added there later, instead of duplicating the store's
    // validation here and letting the two drift.
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

        // A REAL session is left alone rather than replaced. A demo link opened while
        // signed in must not silently downgrade a working admin to read-only, which
        // would look like the console had broken.
        if (session && !isDemoSession(session)) {
            console.warn('[demo] a demo link was opened by an already signed-in session; left unchanged.');
            return res.redirect(withBasePath('/admin'));
        }

        if (!demoTokenMatches(req.query?.token, demo.token)) {
            // ONE OUTCOME FOR A WRONG TOKEN AND A MISSING ONE, and nothing about
            // whether demo login exists. The log distinguishes them for an operator;
            // the response does not, so the route cannot be probed for its existence.
            console.warn('[demo] a demo link was refused: the token did not match.');
            return res.status(404).render('admin-no-access', { email: null, demo: true });
        }

        // The session is created first, then marked. Both happen before the cookie is
        // set, so there is no request in which a demo cookie is a writable session.
        const { cookieValue, sessionId, expiresAt } = createSession(DEMO_VIEWER_EMAIL);
        markSessionAsDemo({ sessionId, orgId: demo.orgId, email: DEMO_VIEWER_EMAIL, expiresAt });
        logDemoUse(demo.orgId, DEMO_VIEWER_EMAIL);

        res.cookie(SESSION_COOKIE, cookieValue, sessionCookieOptions(isSecureRequest(req)));
        return res.redirect(withBasePath('/admin'));
    });

    return { registered: true, orgId: demo.orgId, days: demo.days };
}
