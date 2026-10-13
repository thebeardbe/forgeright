/**
 * Error pages: what a visitor sees when a request cannot be served.
 *
 * WHY THIS IS A MODULE RATHER THAN A VIEW AND A FEW `res.render` CALLS. Three of the statuses
 * here are sent from places that run BEFORE the usual middleware, and the difference matters:
 * the 421 fires in the host guard, which is mounted above `cookieReader` and `themeMiddleware`,
 * so `res.locals.theme` does not exist yet and a view interpolating `theme.followingSystem`
 * would throw while reporting an error. One module owns that ordering problem for every status
 * rather than each call site remembering it.
 *
 * THE FORMAT IS DECIDED BY `Accept`, and that is a correctness matter rather than politeness. A
 * participant's questionnaire talks to `/api/chat` and `/api/score` with `fetch`, and a client
 * that asked for JSON and received an HTML page would fail parsing it - so a 500 would surface
 * as a syntax error rather than as the error it was. `wantsJson` is the single test.
 *
 * THE STATUS IS ALWAYS THE ONE WE WERE GIVEN. A pretty page with a 200 is worse than a bare
 * string with a 404, because every monitor, test and browser treats it as success.
 *
 * NOTHING FROM THE REQUEST IS RENDERED except the status itself. No path, no stack, no host and
 * no configuration: an error page is the page a stranger is most likely to reach on purpose, so
 * it says what happened in words we wrote rather than echoing anything back.
 */
import { themeMiddleware } from './theme.js';

/**
 * The pages, by status.
 *
 * EACH ENTRY SAYS WHAT HAPPENED AND WHOSE PROBLEM IT IS. A visitor cannot act on "misdirected
 * request" - it names an HTTP concept rather than a situation - and the owner read exactly that
 * string from this application and had nothing to go on. So the 421 says the address is not one
 * this installation answers for and that it is a deployment matter, because the person most
 * likely to see it is the person who just changed a setting.
 *
 * THE 421 DELIBERATELY DOES NOT PRINT THE ALLOWED LIST. The log names the offending host and
 * every allowed one, which is what an operator needs; the page would be handing an installation's
 * configuration to whoever asked. "Not recognised" says enough to act on with the log open.
 */
const PAGES = {
    400: {
        title: 'Bad request',
        heading: 'That request did not make sense',
        message: 'Something about the request was not in the form this site expects.',
        detail: 'Going back and trying again usually fixes it.'
    },
    403: {
        title: 'Not allowed',
        heading: 'You are not allowed to see this',
        message: 'Your account does not have access to this part of the site.',
        detail: 'An admin in your organisation can change that.'
    },
    404: {
        title: 'Not found',
        heading: 'There is nothing at that address',
        message: 'The page you asked for does not exist. It may have been moved, or the link may '
            + 'be incomplete.',
        detail: 'A link from an email is the usual cause: mail clients sometimes wrap long URLs.'
    },
    421: {
        title: 'Wrong address',
        heading: 'This site does not answer for that address',
        message: 'The address you used is not one this installation is configured to serve, so the '
            + 'request was refused.',
        detail: 'This is a deployment matter rather than something you did. The server log names '
            + 'the address it received and the ones it expects.'
    },
    500: {
        title: 'Something broke',
        heading: 'Something went wrong here',
        message: 'This is a fault on our side, not yours. Nothing you did caused it.',
        detail: 'The error has been logged. Trying again in a moment may work.'
    },
    502: {
        title: 'Upstream failed',
        heading: 'The analysis service did not answer',
        message: 'This site could not reach the service it uses to read the answers.',
        detail: 'Trying again in a moment usually works.'
    }
};

/** The status used when a caller asks for a code this module does not have a page for. */
const FALLBACK_STATUS = 500;

/**
 * Whether the caller asked for JSON.
 *
 * A REQUEST THAT NAMES JSON GETS JSON, whatever it was routed to. `fetch` sends
 * `Accept: *​/*` by default, which is why the wildcard counts as HTML: a browser or a script
 * that accepts anything is happy with a page, while one that said `application/json` is not.
 *
 * THE TEST IS `includes` RATHER THAN EQUALITY, because an Accept header is a list with quality
 * values - `application/json, text/plain, *​/*` is what a real client sends - and comparing the
 * whole string to one media type would refuse it.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function wantsJson(req) {
    const accept = String(req.headers?.accept || '');
    return accept.includes('application/json');
}

/**
 * Sends an error response in the format the caller asked for.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {number} status The status to send. Kept, never replaced with 200.
 * @param {object} [options]
 * @param {string} [options.backPath] Where the one link on the page goes.
 * @param {string} [options.backLabel] What that link says.
 */
export function sendError(req, res, status, { backPath = '/', backLabel = 'Go to the front page' } = {}) {
    const page = PAGES[status] || PAGES[FALLBACK_STATUS];

    // JSON FIRST, so a client that asked for it never receives a page. The body carries the
    // same facts in the shape those routes already use - `error` - so a caller reading one
    // 403 from this module reads the others the same way.
    if (wantsJson(req)) {
        return res.status(status).json({ error: page.message });
    }

    // THE LOCALS AN ERROR PAGE CANNOT ASSUME. `res.locals.basePath` and the theme are set by
    // middleware, and the 421 runs above two of them, so they are filled here if they are
    // missing rather than trusted. `themeMiddleware` reads only the cookie and the headers, so
    // calling it directly is safe at any point - it does not depend on anything mounted after
    // the host guard.
    if (!res.locals.basePath) res.locals.basePath = '';
    if (!res.locals.theme) themeMiddleware(req, res, () => {});
    if (!res.locals.themeOptions) res.locals.themeOptions = [];

    return res.status(status).render('error', { ...page, backPath, backLabel });
}
