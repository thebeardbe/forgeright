/**
 * Error pages: what a visitor sees when a request cannot be served.
 *
 * A module rather than views, because some statuses are sent from places that run before the usual
 * middleware, so `res.locals.theme` may not exist yet and a view reading it would throw while reporting an
 * error.
 *
 * The format is decided by `Accept`, which is correctness rather than politeness: the questionnaire fetches
 * `/api/chat` and `/api/score`, so a client asking for JSON that received a page would fail parsing it. The
 * status is always the one we were given, because every monitor treats a 200 as success. Nothing from the
 * request is rendered except the status.
 */
import { themeMiddleware } from './theme.js';

/**
 * The pages, by status. Each entry says what happened and whose problem it is, because a visitor cannot act
 * on an HTTP concept.
 *
 * The 421 does not print the allowed host list: the log names the offending host and every allowed one,
 * while the page would hand the installation's configuration to whoever asked.
 *
 * The 403 and 502 entries are unreachable from this module today and stay: those statuses are emitted through
 * `admin-console-error.ejs` instead, `FALLBACK_STATUS` means no entry is load-bearing, and they are the most
 * likely to become reachable.
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
    413: {
        title: 'Too large',
        heading: 'That was too much to send at once',
        message: 'The request body is larger than this site accepts, so it was refused before it '
            + 'was read.',
        detail: 'This is a size limit rather than a fault. Sending less, or in smaller parts, will '
            + 'work.'
    },
    421: {
        title: 'Wrong address',
        heading: 'This site does not answer for that address',
        message: 'The address you used is not one this installation is configured to serve, so the '
            + 'request was refused.',
        detail: 'This is a deployment matter rather than something you did. The server log names '
            + 'the address it received and the ones it expects.',
        // Hidden here and nowhere else, because on this status the picker cannot work: the page is served
        // precisely because the host was refused, so every same-host URL is refused with it and submitting
        // the picker does nothing. A flag on the status rather than the view inspecting `status`, because
        // the view cannot know why a status makes a control unusable.
        hideThemePicker: true
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
 * Whether the caller asked for JSON, whatever it was routed to: a request naming `application/json` gets
 * JSON.
 *
 * The test is a substring rather than a parser and the quality values are deliberately not read, so
 * `text/html;q=0.9, application/json;q=0.1` gets JSON even though that client prefers HTML. A caller naming
 * json at all is a program that will parse the body.
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

    // JSON first, so a client that asked for it never receives a page. The body uses the `error` shape those
    // routes already use.
    if (wantsJson(req)) {
        return res.status(status).json({ error: page.message });
    }

    // Filled here if missing rather than trusted, because this runs above the middleware that sets them.
    // `themeMiddleware` reads only the cookie and the headers, so calling it directly is safe.
    if (!res.locals.basePath) res.locals.basePath = '';
    if (!res.locals.theme) themeMiddleware(req, res, () => {});
    if (!res.locals.themeOptions) res.locals.themeOptions = [];

    return res.status(status).render('error', {
        ...page,
        backPath,
        backLabel,
        // Always passed, so the view tests a boolean rather than `typeof`.
        hideThemePicker: page.hideThemePicker === true
    });
}
