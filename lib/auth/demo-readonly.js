/**
 * The read-only enforcement for demo sessions.
 *
 * SEPARATE FROM `demo-login.js`, WHICH ISSUES THE SESSION. That module establishes a
 * demo session: the link, the token, the marking. This one is about what such a session
 * may then do. Two concerns, and the split keeps both files inside the size budget.
 *
 * IT TAKES THE SESSION HELPERS AS ARGUMENTS rather than importing them, because the
 * module that mounts it imports this one; a direct import would close a cycle. This
 * module imports `demo-login.js` itself, which does NOT import this one, so that direction
 * is acyclic.
 */
import { demoRowForSession, DEMO_VIEWER_EMAIL } from './demo-login.js';

/**
 * The routes a READ-ONLY DEMO SESSION may still reach.
 *
 * AN EXPLICIT LIST IS THE POINT: everything not named here is refused for a demo session, so a route
 * added below the guard is refused without anybody remembering to guard it. It is short because
 * almost nothing should be reachable.
 *
 *   POST /logout   A DEMO SESSION MUST BE ABLE TO END ITSELF. Signing out changes no data - it
 *                  revokes the session's own row and clears the cookie - and refusing it leaves a
 *                  visitor unable to leave, which on a shared machine is worse than the risk.
 *
 * DELIBERATELY ABSENT, and these three were reachable and should not have been. The guard used to sit
 * on the CONSOLE CHAIN, covering every console route and NOT the routes registered earlier on the
 * same router: `POST /` and `POST /login` are the sign-in action, which ISSUES A SIGN-IN LINK AND
 * SENDS MAIL, and `POST /login/verify` redeems one, provisioning a user and an organisation. A demo
 * session reaching the sign-in action turned the demo link into a mail relay using the owner's
 * identity, and each link it issued could be redeemed to create a NEW organisation with the
 * attacker's address as admin. REPRODUCED before the guard moved: a demo session wrote a
 * `login_token` row for attacker@evil.test and the redemption created a tenant.
 */
const DEMO_SESSION_ALLOWED = new Set(['POST /logout']);

/** The key a demo exemption is matched on: method and path together. */
function routeKey(req) {
    // `req.path` is relative to the router's mount point, so this reads `/logout`
    // rather than `/admin/logout`, matching the list above.
    //
    // THE ASSUMPTION, STATED RATHER THAN LEFT IMPLICIT: every entry in
    // `DEMO_SESSION_ALLOWED` is written as `METHOD /path-within-this-router`, so adding a
    // route to that set means writing the path WITHOUT the `/admin` prefix. An entry
    // written as `'POST /admin/logout'` would never match and would silently refuse
    // logout for a demo session.
    //
    // MEASURED, because it is the kind of claim that is easier to assert than to check:
    // mounting this router at a SECOND path does NOT break the matching. `req.path` is
    // recomputed against whichever mount the request came in on, so it is `/logout` under
    // `/admin` and `/logout` under `/second` too. The risk is an entry written with the
    // prefix, not a second mount.
    return `${req.method} ${req.path}`;
}

/**
 * REFUSES EVERY ADMIN ROUTE A DEMO SESSION MUST NOT REACH.
 *
 * MOUNTED AT THE TOP OF THE ADMIN ROUTER, BEFORE EVERY ROUTE - which is what the earlier version got
 * wrong by sitting on the console chain alone, leaving the three routes registered earlier on the
 * same router reachable. See the note above for what a demo session did with them.
 *
 * WHAT IT COVERS, PRECISELY, because Express runs middleware IN REGISTRATION ORDER: every route
 * registered BELOW it in `routes.js`, which is all of them, so a route added at the end is refused by
 * default unless it is added to the allowed list - forgetting the list refuses rather than exposes.
 * A route registered ABOVE it would NOT be covered, and there is none: an Express router cannot cover
 * a route registered before it, whatever a comment says. VERIFIED BY ADDING A ROUTE AND MAKING THE
 * REQUEST, not by reading middleware order.
 *
 * IT RUNS BEFORE THE HANDLERS, so a route cannot act and then be refused.
 *
 * AN UNSIGNED REQUEST IS NOT A DEMO SESSION: `isDemoSession` needs a session, and the sign-in routes
 * must stay reachable for every ordinary visitor.
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
 * Whether a session is a demo session.
 *
 * This is the question the read-only guard asks, and it is deliberately SEPARATE from
 * the session's validity: a session that is a demo stays a demo, so an expiry on the
 * demo row cannot turn it into a writable session. The failure direction is the safe one.
 *
 * @param {object} session A session from `readSession`, with `sessionId`.
 * @returns {boolean}
 */
export function isDemoSession(session) {
    if (!session || typeof session.sessionId !== 'string') return false;

    // THE IDENTITY FIRST, THE ROW SECOND. A session whose email IS the demo viewer is a
    // demo session whatever the table says, and the row is only corroboration.
    if (session.email === DEMO_VIEWER_EMAIL) return true;

    return demoRowForSession(session.sessionId) !== null;
}

/**
 * Whether a session is an ORPHANED demo session: the demo viewer's identity with no demo
 * row behind it.
 *
 * A FAIL-OPEN THAT WAS CLOSED, rather than a feature. `isDemoSession` used to answer from the demo
 * ROW alone, which failed safe for EXPIRY because the row stays. DELETION is different: with the row
 * gone it returned false, so the session stopped being treated as a demo and the console fell
 * through to looking up a `users` row for the email - which only threw because the demo address had
 * no user, and NOTHING GUARANTEED IT. Given a `users` row for the demo address, which the console's
 * own Add-user form accepts, and a manually deleted demo row, the session became WRITABLE:
 * REPRODUCED, with a rename that persisted. The defence held by accident, from an unrelated fact.
 *
 * REFUSED RATHER THAN RE-LABELLED AS READ-ONLY:
 *   - there is no legitimate state in which an orphaned demo session is signed in. The row is written
 *     in the same request that sets the cookie, so a missing row means the record was tampered with
 *     or the database edited by hand;
 *   - RE-LABELLING WOULD SILENTLY PICK AN ORGANISATION, because the fall-through would take it from a
 *     `users` row - exactly the mutable, attacker-influenceable input this fix stops trusting;
 *   - refusing cannot be wrong: the worst outcome is needing a new link, and the link is reusable.
 *
 * @param {object} session A session from `readSession`.
 * @returns {boolean}
 */
export function isOrphanedDemoSession(session) {
    if (!session || typeof session.email !== 'string') return false;
    if (session.email !== DEMO_VIEWER_EMAIL) return false;
    return typeof session.sessionId === 'string' && demoRowForSession(session.sessionId) === null;
}
