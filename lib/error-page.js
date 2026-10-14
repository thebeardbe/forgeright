/**
 * Error pages: what a visitor sees when a request cannot be served.
 *
 * A MODULE RATHER THAN A VIEW AND A FEW `res.render` CALLS, because three of these statuses are
 * sent from places that run BEFORE the usual middleware: the 421 fires in the host guard, mounted
 * above `cookieReader` and `themeMiddleware`, so `res.locals.theme` does not exist yet and a view
 * interpolating `theme.followingSystem` would throw while reporting an error. One module owns that
 * ordering problem for every status.
 *
 * THE FORMAT IS DECIDED BY `Accept`, which is correctness rather than politeness: the questionnaire
 * talks to `/api/chat` and `/api/score` with `fetch`, and a client asking for JSON that received a
 * page would fail parsing it - so a 500 would surface as a syntax error.
 *
 * THE STATUS IS ALWAYS THE ONE WE WERE GIVEN: a pretty page with a 200 is worse than a bare string
 * with a 404, because every monitor treats it as success.
 *
 * NOTHING FROM THE REQUEST IS RENDERED except the status. An error page is the page a stranger is
 * most likely to reach on purpose, so it says what happened in words we wrote.
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
 *
 * SOME ENTRIES ARE UNREACHABLE TODAY AND THEY STAY: `sendError` is called with 421, 404 and 500
 * from server.js plus whatever `err.status` a middleware attaches (MEASURED: 400 and 413 from
 * Express's body parsers), so the 403 and 502 entries render nothing at present. Deleting them
 * would be a mistake rather than a tidy-up, for three reasons: THE STATUSES ARE ALL EMITTED, just
 * through `admin-console-error.ejs` from lib/auth/console.js instead - the split is deliberate,
 * because a console route has a session and a nav bar and this page has neither. `FALLBACK_STATUS`
 * MEANS THE MAP CANNOT FAIL TO RENDER, so an entry is never load-bearing for correctness, only for
 * accuracy. And 400, 403 AND 502 ARE THE MOST LIKELY TO BECOME REACHABLE: whoever adds a route
 * answering 403 without a session should find the page waiting rather than have to write copy.
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
        // THE THEME PICKER IS HIDDEN HERE, AND NOWHERE ELSE, because on this status it CANNOT
        // WORK. The page is served precisely because the host was refused, so every same-host
        // URL is refused with it: MEASURED, `/settings/theme` returns 421 on the rejected host,
        // so the picker renders, populates with all 23 options, and submitting it does nothing.
        // A control that silently fails is worse than no control - it turns one dead end into
        // two, for a reader who is already confused about why they are seeing this page.
        //
        // IT IS A FLAG ON THE STATUS RATHER THAN THE VIEW INSPECTING `status`, because the view
        // cannot know WHY a status makes a control unusable: hiding the picker on a 404 or a 500
        // would be wrong, since those hosts are accepted and the picker works there. The
        // knowledge belongs beside the status that has it.
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
 * Whether the caller asked for JSON.
 *
 * A REQUEST THAT NAMES JSON GETS JSON, whatever it was routed to. `fetch` sends
 * `Accept: *​/*` by default, which is why the wildcard counts as HTML: a browser or a script
 * that accepts anything is happy with a page, while one that said `application/json` is not.
 *
 * THE TEST IS A SUBSTRING, NOT A PARSER, AND THE QUALITY VALUES ARE DELIBERATELY NOT READ:
 * `text/html;q=0.9, application/json;q=0.1` gets JSON even though that client prefers HTML. A caller
 * naming `application/json` at all is a program that will parse the body, so handing it a page
 * produces a parse error instead of the error it asked about. THE HEADER IS THEREFORE A SET OF MEDIA
 * TYPES RATHER THAN A PRIORITY LIST, which is why the header a real client sends - naming json,
 * text and a wildcard - is recognised without parsing it.
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

    return res.status(status).render('error', {
        ...page,
        backPath,
        backLabel,
        // ALWAYS PASSED, so the view tests a boolean rather than `typeof` against an absent
        // name. `FALLBACK_STATUS` renders the 500 page, which shows the picker.
        hideThemePicker: page.hideThemePicker === true
    });
}
