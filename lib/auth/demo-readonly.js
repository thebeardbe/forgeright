/**
 * The read-only enforcement for demo sessions.
 *
 * SEPARATE FROM `demo-login.js`, WHICH ISSUES THE SESSION. That module establishes a
 * demo session: the link, the token, the marking. This one is about what such a session
 * may then do. Two concerns, and the split keeps both files inside the size budget.
 *
 * IT TAKES THE SESSION HELPERS AS ARGUMENTS rather than importing them, because the
 * module that mounts it imports this one; a direct import would close a cycle.
 */

/**
 * The routes a READ-ONLY DEMO SESSION may still reach.
 *
 * EXEMPTIONS ARE AN EXPLICIT LIST, WHICH IS THE POINT: everything not named here is
 * refused for a demo session, so a route added BELOW the guard is refused without
 * anybody remembering to guard it. The list is short because almost nothing should be
 * reachable, and each entry needs a reason.
 *
 *   POST /logout   A DEMO SESSION MUST BE ABLE TO END ITSELF. Signing out is not a
 *                  change to any data: it revokes the session's own row and clears the
 *                  cookie. Refusing it would leave a visitor unable to leave, which on a
 *                  shared machine is worse than the risk it avoids.
 *
 * DELIBERATELY ABSENT, and these are the ones that were reachable and should not have
 * been. The guard used to sit ON THE CONSOLE CHAIN, which covered every console route
 * and NOT the routes registered earlier on the same router:
 *
 *   POST /            the sign-in action, which ISSUES A SIGN-IN LINK AND SENDS MAIL. A
 *                     demo session reaching it turned the demo link into a mail relay
 *                     using the owner's identity, and each link it issued could be
 *                     redeemed to provision a NEW organisation with the attacker's
 *                     address as its admin. Reproduced before this guard moved: a demo
 *                     session wrote a `login_token` row for attacker@evil.test and the
 *                     redemption created a tenant.
 *   POST /login       the same handler at its second address.
 *   POST /login/verify  redeeming a link provisions a user and an organisation. It
 *                     carries a token rather than a session cookie, so a demo session
 *                     has no business sending it.
 */
const DEMO_SESSION_ALLOWED = new Set(['POST /logout']);

/** The key a demo exemption is matched on: method and path together. */
function routeKey(req) {
    // `req.path` is relative to the router's mount point, so this reads `/logout`
    // rather than `/admin/logout`, matching the list above.
    return `${req.method} ${req.path}`;
}

/**
 * REFUSES EVERY ADMIN ROUTE A DEMO SESSION MUST NOT REACH.
 *
 * MOUNTED AT THE TOP OF THE ADMIN ROUTER, BEFORE EVERY ROUTE. It used to be mounted on
 * the console chain alone, which covered the console routes and NOT the three registered
 * earlier on the same router: `POST /`, `POST /login` (the sign-in action) and
 * `POST /logout`. A demo session reached the sign-in action and could issue sign-in
 * links for addresses it controlled; redeeming one provisioned a new organisation with
 * that address as its admin. The comment there claimed a route added later was "covered
 * on the day it is written", which was false: a route registered BEFORE that chain is
 * not covered by it.
 *
 * WHAT IT COVERS, PRECISELY, because Express runs middleware IN REGISTRATION ORDER and
 * the earlier comment claimed more than the code did:
 *
 *   - it covers every route registered BELOW it in `routes.js`, which is all of them,
 *     including the sign-in action. A route added at the end of the file is refused by
 *     default unless it is added to `DEMO_SESSION_ALLOWED`, so forgetting the list
 *     refuses a route rather than exposing it;
 *   - a route registered ABOVE it would NOT be covered, and there is none. This is a
 *     weaker guarantee than "by construction" and it is the true one: an Express router
 *     cannot cover a route registered before it, whatever a comment says.
 *
 * VERIFIED BY ADDING A ROUTE AND MAKING THE REQUEST, not by reading middleware order.
 *
 * IT RUNS BEFORE THE HANDLERS, so a route cannot act and then be refused: a refusal
 * after the write would not be a refusal.
 *
 * AN UNSIGNED REQUEST IS NOT A DEMO SESSION. `isDemoSession` needs a session, and the
 * sign-in routes must stay reachable for somebody who is not signed in, which is every
 * ordinary visitor. Only a session that IS a demo session is restricted.
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
