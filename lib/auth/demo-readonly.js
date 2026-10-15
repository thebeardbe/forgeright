/**
 * The read-only enforcement for demo sessions: what a session issued by `demo-login.js` may then do.
 */
import { demoRowForSession, DEMO_VIEWER_EMAIL } from './demo-login.js';

/**
 * The routes a read-only demo session may still reach. An explicit list is the point: everything not
 * named here is refused, so a route added below the guard is refused without anybody guarding it.
 * `POST /logout` is on it because signing out changes no data and refusing it leaves a visitor unable
 * to leave. Deliberately absent are `POST /` and `POST /login`, the sign-in action that issues a link
 * and sends mail, and `POST /login/verify`, which redeems one and provisions a user and organisation:
 * a demo session reaching them turns the demo link into a mail relay and each issued link into a new
 * organisation with the attacker's address as admin.
 */
const DEMO_SESSION_ALLOWED = new Set(['POST /logout']);

/**
 * The key a demo exemption is matched on: method and path together. Entries in
 * `DEMO_SESSION_ALLOWED` must be written as `METHOD /path-within-this-router`, without the `/admin`
 * prefix, because `req.path` is relative to the router's mount point; an entry carrying the prefix
 * would never match and would silently refuse that route.
 */
function routeKey(req) {
    return `${req.method} ${req.path}`;
}

/**
 * Express middleware refusing every admin route a demo session must not reach. It is mounted at the top of
 * the admin router, before every route, so it covers all of them and runs before the handlers, which means
 * a route cannot act and then be refused. Only `POST /logout` is exempt, so a route added later is refused
 * by default. An unsigned request is not a demo session, because `isDemoSession` needs a session and the
 * sign-in routes must stay reachable for everyone.
 *
 * @param {Function} currentSession Resolves the session for a request, or null.
 * @param {Function} isDemoSession Whether a session is a read-only demo session.
 * @returns {Function} Express middleware.
 */
export function refuseWritesForDemoSessions(currentSession, isDemoSession) {
    return (req, res, next) => {
        const session = currentSession(req);
        if (!session || !isDemoSession(session)) return next();

        if (req.method === 'GET' || req.method === 'HEAD') return next();
        if (DEMO_SESSION_ALLOWED.has(routeKey(req))) return next();

        console.warn(
            `[demo] REFUSED ${req.method} ${req.path} from a read-only demo session. ` +
            'The demo may read and sign out, and may change nothing.'
        );
        return res.status(403).render('admin-no-access', { email: null, readOnly: true });
    };
}

/**
 * Whether a session is a demo session. Deliberately separate from the session's validity, so an
 * expiry on the demo row cannot turn a demo session into a writable one.
 *
 * @param {object} session A session from `readSession`, with `sessionId`.
 * @returns {boolean}
 */
export function isDemoSession(session) {
    if (!session || typeof session.sessionId !== 'string') return false;

    // The identity is checked first and the row second: a session whose email is the demo viewer is
    // a demo session whatever the table says.
    if (session.email === DEMO_VIEWER_EMAIL) return true;

    return demoRowForSession(session.sessionId) !== null;
}

/**
 * Whether a session is an orphaned demo session: the demo viewer's identity with no demo row behind
 * it. It is refused rather than re-labelled as read-only, because a missing row means the record was
 * tampered with or the database edited by hand, and re-labelling would pick an organisation from a
 * `users` row, the mutable input this stops trusting. Without this check the row's deletion makes
 * `isDemoSession` return false, the session falls through to a `users` row for the demo email, and
 * the session becomes writable, persisting a rename.
 *
 * @param {object} session A session from `readSession`.
 * @returns {boolean}
 */
export function isOrphanedDemoSession(session) {
    if (!session || typeof session.email !== 'string') return false;
    if (session.email !== DEMO_VIEWER_EMAIL) return false;
    return typeof session.sessionId === 'string' && demoRowForSession(session.sessionId) === null;
}
