/** The read-only enforcement for demo sessions: what a session issued by `demo-login.js` may then do. */
import { demoRowForSession, DEMO_VIEWER_EMAIL } from './demo-login.js';

/**
 * Everything not named here is refused, so a route added later is refused without anybody guarding it.
 * The sign-in routes are absent because a demo session reaching them turns the link into a mail relay.
 */
const DEMO_SESSION_ALLOWED = new Set(['POST /logout']);

/** Entries are `METHOD /path-within-this-router`, no `/admin` prefix, because `req.path` is relative. */
function routeKey(req) {
    return `${req.method} ${req.path}`;
}

/**
 * Mounted at the top of the admin router, so it covers every route and a route cannot act and then be
 * refused. An unsigned request is not a demo session, so the sign-in routes stay reachable.
 *
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

/** Separate from validity, so an expiry on the demo row cannot turn a demo session into a writable one. */
export function isDemoSession(session) {
    if (!session || typeof session.sessionId !== 'string') return false;

    // The identity first: a session whose email is the demo viewer is a demo session whatever the table says.
    if (session.email === DEMO_VIEWER_EMAIL) return true;

    return demoRowForSession(session.sessionId) !== null;
}

/**
 * A missing demo row means the record was tampered with. Refused rather than re-labelled, because
 * re-labelling would take an organisation from a `users` row; without this, deleting the row makes
 * `isDemoSession` return false and the session becomes writable.
 */
export function isOrphanedDemoSession(session) {
    if (!session || typeof session.email !== 'string') return false;
    if (session.email !== DEMO_VIEWER_EMAIL) return false;
    return typeof session.sessionId === 'string' && demoRowForSession(session.sessionId) === null;
}
