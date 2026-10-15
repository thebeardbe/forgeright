/**
 * Roadmap builder server.
 *
 * A standalone Node application, sharing no configuration, data store or code with the CV site -
 * see the note in README.md for why the separation matters.
 *
 * Routes:
 *   GET  /                -> questionnaire UI
 *   POST /api/chat        -> one turn of the intake conversation
 *   POST /api/score       -> score a completed audit
 *   GET  /healthz         -> liveness
 *   /admin/*              -> admin sign-in and console (see lib/auth/routes.js)
 */
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { stringsFor, SUPPORTED_LANGS, DEFAULT_LANG } from './lib/strings.js';
import { loadAiConfig } from './ai/config.js';
import { assertSessionSecretConfigured } from './lib/auth/session.js';
import { cookieReader, router as adminRouter, assertPublicBaseUrlUsable } from './lib/auth/routes.js';
import { requireSecureConnection } from './lib/auth/require-secure.js';
import { assertMailSenderUsable, mailReadinessProblems } from './lib/mail/index.js';
import { closeAll } from './lib/store/index.js';
import { BASE_PATH, PUBLIC_PATH, describeMount, describePublicPath } from './lib/base-path.js';
import { resolveTrustProxy, hostnameFromHeader } from './lib/trust-proxy.js';
import { sendError } from './lib/error-page.js';
import { router as participantRouter } from './lib/auth/participant-routes.js';
import { router as landingRouter } from './lib/landing.js';
import { registerThemeRoute } from './lib/theme-route.js';
import { shortInstant, shortDuration, responseTitle, responseWorkflow } from './lib/view-format.js';
import { router as apiRouter } from './lib/routes-api.js';
import { DEFAULT_TOOL_ID } from './config/tools.js';
import { FOLLOW_SYSTEM, PALETTE_IDS, PALETTES } from './lib/palettes.js';
import { themeMiddleware, parseThemeChoice, THEME_COOKIE, THEME_COOKIE_MAX_AGE } from './lib/theme.js';
import { isSecureRequest } from './lib/auth/session.js';
import { publicBaseUrl } from './lib/auth/public-base-url.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const PORT = Number(process.env.PORT) || 3000;

/**
 * Interface the listener binds, from HOST. Defaults to loopback.
 *
 * WHY LOOPBACK BY DEFAULT: the deployment is a reverse proxy on the same host connecting over
 * loopback, so 127.0.0.1 is exactly the access needed while making the container unreachable
 * elsewhere. It is the other half of the proxy-trust boundary - TRUST_PROXY decides which PEER may
 * claim a request was HTTPS, HOST decides who can connect at all - and with the listener open on all
 * interfaces the trust setting is the ONLY thing between a LAN client and the application. One
 * mistake there serves it over cleartext: that was the H2 bypass, reachable on the LAN so one forged
 * header was believed.
 *
 * Set 0.0.0.0 deliberately, and then TRUST_PROXY must NAME that proxy's address; a hop count is not
 * enough, for the reason above.
 */
const HOST = (process.env.HOST || '127.0.0.1').trim();

// Fail before serving anything, rather than at the first sign-in attempt. A
// missing SESSION_SECRET would otherwise surface as "login is broken", which is
// the hardest kind of misconfiguration to diagnose from the outside.
assertSessionSecretConfigured();
assertMailSenderUsable();
// AND WHETHER IT CAN ACTUALLY SEND, which the check above does not answer. A valid
// transport name says the configuration is understood; it says nothing about a
// missing binary or an expired session, and both fail silently at the first send
// rather than here. WARNED, not thrown: the console does not need mail to work, and
// an operator signing in to fix mail should not be locked out by it.
for (const problem of mailReadinessProblems()) {
    console.warn(`[mail] ${problem}`);
}
// The mail-link configuration is validated here too: a PUBLIC_BASE_URL that
// cannot be combined with BASE_PATH must stop the process at startup, not throw
// on an admin's first login attempt, which it did before this check existed.
assertPublicBaseUrlUsable();

/**
 * Hostnames this instance answers on, from a comma-separated ALLOWED_HOST.
 *
 * An empty or unset value means "accept any host", which is the local
 * development default. Each entry is trimmed and lowercased once, here, so the
 * per-request comparison does no work beyond a lookup.
 *
 * Empty entries are dropped. A trailing comma ("localhost,") would otherwise
 * add "" as a valid entry, and an empty entry matches a request with no Host
 * header, which is exactly the request that should be refused.
 */
const ALLOWED_HOSTS = (process.env.ALLOWED_HOST || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

// Which peers may set the forwarded-protocol headers. Resolved and validated
// here so a bad value stops startup rather than quietly refusing every request.
// See lib/trust-proxy.js for the forms and why addresses beat hop counts.
const TRUST_PROXY = resolveTrustProxy();

app.set('trust proxy', TRUST_PROXY.setting);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

/**
 * Expose the PUBLIC path to every template, so views build URLs from one value
 * rather than hand-writing a prefix that would then drift.
 *
 * PUBLIC_PATH, not BASE_PATH: the browser is outside the mount, so the prefix it
 * must use is where the app is VISIBLE, which differs from where it is mounted
 * whenever a proxy strips its prefix (the Tailscale deployment). See
 * lib/base-path.js.
 *
 * The value is "" when the site is at an origin root, and views interpolate it
 * directly: href="<%= basePath %>/admin/login".
 *
 * `currentUrl` IS THE PATH THE BROWSER IS ON, for the theme picker's way back. TAKEN FROM THE
 * REQUEST, NOT BUILT FROM PUBLIC_BASE_URL: behind a proxy terminating a different hostname, a
 * link built from the configuration sends the user to a host they are not using.
 *
 * **THE QUERY STRING IS DELIBERATELY DROPPED - A SECURITY DECISION.** This value goes into a
 * hidden form field on every page, so carrying the query would echo whatever the URL held into
 * the body: the demo link's TOKEN, on the very refusal page that exists to say nothing about it.
 * A credential reflected into HTML lands in browser history, a proxy log, and any error reporter
 * capturing the DOM. MEASURED: a bad-token request returned a page containing the submitted
 * token, and the demo tests caught it because two requests that must be indistinguishable had
 * different bodies.
 *
 * THE COST: changing the theme on a page showing a rejudge notice returns without the notice - a
 * small convenience against not writing credentials into pages.
 */
app.use((req, res, next) => {
    res.locals.basePath = PUBLIC_PATH;

    // The picker's list, derived from the palette data so a new palette appears without
    // touching a template. Ordered as lib/palettes.js orders them.
    res.locals.themeOptions = PALETTE_IDS.map((id) => ({ id, name: PALETTES[id].name }));

    res.locals.currentUrl = req.path;

    // The formatting helpers, so a template writes `<%= shortInstant(x) %>` rather than
    // reaching for a method on a raw value. See lib/view-format.js for why the output is
    // unambiguous rather than locale-formatted.
    res.locals.shortInstant = shortInstant;
    res.locals.shortDuration = shortDuration;
    // The response-shape resolvers; see lib/view-format.js.
    res.locals.responseTitle = responseTitle;
    res.locals.responseWorkflow = responseWorkflow;
    next();
});

/**
 * Restricts the Host header when ALLOWED_HOST is set. The hostname belongs in
 * the environment and on the proxy, never hardcoded in the application, so the
 * same image runs locally and on the VPS.
 *
 * Mounted BEFORE the admin router and every other route. Order matters here: a
 * router mounted earlier would run first and let a request from an unlisted host
 * reach a route, which is the whole thing this guard exists to stop.
 *
 * The raw header is parsed by `hostnameFromHeader`, which handles an IPv6 authority: a
 * bracketed literal yields "[", so an entry could never match however it was written.
 *
 * Edge cases, both of which must NOT pass by accident: a missing Host header yields "",
 * matching no entry, because empty entries were filtered out above; and an IPv6 host is
 * matched as written, so "[::1]" in ALLOWED_HOST works.
 */
app.use((req, res, next) => {
    if (ALLOWED_HOSTS.length === 0) return next();

    const host = hostnameFromHeader(req.headers.host);
    if (ALLOWED_HOSTS.includes(host)) return next();

    console.warn(
        `[host] rejected request for host "${host}" ` +
        `(allowed: ${ALLOWED_HOSTS.join(', ')})`
    );

    // THE LOG NAMES THE HOST AND THE LIST; THE PAGE NAMES NEITHER. An operator reads the log
    // and can fix this in a minute; a visitor reading the allowed list would be handed this
    // installation's configuration, and would not know what to do with it anyway. See
    // lib/error-page.js for the wording, which says it is a deployment matter.
    return sendError(req, res, 421);
});

// The admin routes need cookies; this reads the header into req.cookies for the
// whole app, because the reader is cheap and mounts before any route. It sets no
// cookie itself. Mounted after the host guard, so an unlisted host cannot reach
// a route at all.
app.use(cookieReader);

// Resolves the theme from the cookie, or the system preference when there is no
// usable choice, and exposes it to every view as `theme`.
//
// AFTER cookieReader: it reads req.cookies, so running it before the reader would
// silently see no cookie and always fall back to the system preference.
app.use(themeMiddleware);

/**
 * EVERYTHING the app serves is HTTPS only, applied here rather than per route.
 *
 * BEFORE THE CONTENT ROUTES, so one added later is covered without anyone remembering: the rule is
 * the connection, not the feature. See lib/auth/require-secure.js for why the questionnaire is
 * included and for the single /healthz exemption.
 *
 * AFTER THE HOST GUARD, so an unlisted host is rejected as misdirected first, and it sets no
 * cookie - so a refusal cannot leave state behind.
 */
app.use(requireSecureConnection);

/**
 * Everything the application SERVES lives on this sub-app, mounted at the base
 * path below. Express strips the prefix from req.url for a mounted app, so the
 * route definitions here stay written as if the app were at the root, and the
 * prefix has exactly one home (the mount point). That is what stops a route
 * from being missed: a new route added to this app is prefixed automatically.
 */
const appInternal = express.Router();

appInternal.use(express.json({ limit: '256kb' }));
appInternal.use(express.urlencoded({ extended: false, limit: '64kb' }));
appInternal.use(express.static(path.join(__dirname, 'public')));

/**
 * Expose the strings and language every template needs.
 *
 * SET ON res.locals, not on the request, and BEFORE every router: templates read
 * these as locals, and a page rendered by a route mounted earlier would otherwise
 * have them undefined. That is what broke the paste-a-token page, which is served
 * by the participant router before this used to run.
 */
appInternal.use((req, res, next) => {
    const lang = resolveLang(req);
    res.locals.lang = lang;
    res.locals.strings = stringsFor(lang);
    res.locals.toolId = DEFAULT_TOOL_ID;
    res.locals.supportedLangs = SUPPORTED_LANGS;
    next();
});

appInternal.use('/admin', adminRouter);

/** Resolves the UI language from ?lang= or Accept-Language. */
function resolveLang(req) {
    const explicit = req.query.lang;
    if (explicit && SUPPORTED_LANGS.includes(explicit)) return explicit;

    const header = req.headers['accept-language'] || '';
    for (const part of header.split(',')) {
        const code = part.trim().slice(0, 2).toLowerCase();
        if (SUPPORTED_LANGS.includes(code)) return code;
    }
    return DEFAULT_LANG;
}

appInternal.get('/healthz', (req, res) => {
    res.json({ ok: true });
});

// The theme route, in its own module: see lib/theme-route.js for why the return
// target comes from the query rather than the Referer header.
registerThemeRoute(appInternal, {
    PUBLIC_PATH, FOLLOW_SYSTEM, PALETTES, parseThemeChoice,
    THEME_COOKIE, THEME_COOKIE_MAX_AGE, isSecureRequest, publicBaseUrl
});


/**
 * The participant's routes: /q/<token>, /q, /lost-link and the answer API.
 *
 * Under /q rather than at the root, so the root can be a landing page rather
 * than "the questionnaire, sometimes". See lib/landing.js.
 */
appInternal.use('/', participantRouter);

// The landing page, at the root, mounted AFTER the participant routes so those
// specific paths win and only the bare `/` reaches it.
appInternal.use('/', landingRouter);

// The questionnaire's API: one conversation turn, and scoring. In its own
// module so the two endpoints that take a participant's answers live together.
appInternal.use('/', apiRouter);

appInternal.use((req, res) => {
    sendError(req, res, 404);
});

/**
 * Mount the application at the base path.
 *
 * An empty BASE_PATH makes this app.use(appInternal), which is the root, so the
 * existing deployment is unchanged. A prefix moves routes, static files and the
 * API together, which is why they share one app rather than being mounted
 * separately: three mount points are three chances to prefix only two of them.
 */
app.use(BASE_PATH, appInternal);

/**
 * 404 for anything outside the prefix.
 *
 * Without this, a request to the root of a prefixed deployment, or a typo in
 * the prefix, falls through to Express's default handler, which answers with an
 * HTML page naming the path. This says the same "Not found." as the app's own
 * 404, so a wrong URL looks the same wherever it lands. It also means a request
 * that missed the prefix cannot accidentally reach a route.
 */
app.use((req, res) => {
    sendError(req, res, 404);
});

/**
 * THE LAST HANDLER. Without it an uncaught throw reached Express's default, which puts the stack
 * trace in the body when NODE_ENV is not production - so a fault mid-interview showed a participant
 * a file path and a line number.
 *
 * THE LOG AND THE PAGE CARRY DIFFERENT AMOUNTS on purpose: the log gets the message and stack,
 * because an operator needs them and the log is not public, while the page gets neither in any
 * environment.
 *
 * IT MUST TAKE FOUR ARGUMENTS, which is how Express recognises error middleware; a handler with
 * three is mounted as an ordinary route and never called.
 *
 * AN ERROR THAT KNOWS ITS OWN STATUS KEEPS IT, because the page's wording depends on whose
 * fault it is. Express's body parsers attach one - MEASURED: malformed JSON gives
 * `err.status = 400` with `type = entity.parse.failed`; an oversized body gives `413` with
 * `entity.too.large`. Answering 500 told the sender "our fault, not yours" about a request
 * THEY malformed, and hid the problem from a monitor.
 *
 * VALIDATED, NOT MERELY CONVERTED. `Number(err.status) || 500` passed any truthy number and
 * `res.status()` accepts only 100-599, so a middleware attaching -1 made it THROW from inside
 * the error handler and the body carried a STACK TRACE - the outcome this handler exists to
 * eliminate, arrived at by the handler itself. MEASURED: -1 gave `RangeError
 * [ERR_HTTP_INVALID_STATUS_CODE]`.
 *
 * THE BOUNDS ARE 400 TO 599, THE FLOOR DELIBERATELY NOT 100: everything here is an error, so
 * a status below 400 is nonsense, and a 2xx or 3xx page is worse than the stack trace - a
 * monitor counts a failure as success. Outside the band becomes 500.
 *
 * `Number.isInteger` RATHER THAN A RANGE TEST, so `NaN`, `Infinity` and "418" behave: NaN and
 * Infinity fail and become 500, "418" is coerced and passes. Verified: 400 for a malformed
 * body, 413 for an oversized one, 418 for a teapot, 400 from the string "400".
 */
app.use((err, req, res, next) => {
    console.error(`[server] unhandled error on ${req.method} ${req.originalUrl}:`, err);

    // A RESPONSE ALREADY UNDER WAY CANNOT BE REPLACED. A route that sent headers and then threw
    // would make `res.status(...)` throw in turn, hiding the original fault behind a second one,
    // so the default handler is handed this case - which closes the connection and leaves the
    // error in the log.
    if (res.headersSent) return next(err);

    // A status the error carries is kept, validated; see the bounds note above.
    const rawStatus = Number(err.status);
    const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599
        ? rawStatus
        : 500;

    return sendError(req, res, status);
});

/**
 * Starts the HTTP server and warns when the configuration cannot run a real interview.
 *
 * A DEPLOYMENT THAT CANNOT INTERVIEW SHOULD NOT BE SILENT ABOUT IT. `mock` answers every turn
 * with a scripted question and NEVER completes, so an instance left on it cannot run a real
 * interview - and nothing about that is visible from outside. The owner's container sat on
 * mock for hours while he read the result as a bug in the interview. This fixes the SILENCE,
 * not the setting.
 *
 * IT IS NOT AN ERROR AND MUST NOT BECOME ONE: local development uses mock and the whole suite
 * depends on it, so refusing to start would break both.
 *
 * THE CONDITION IS "THIS LOOKS LIKE A DEPLOYMENT", and the tell is that the app is NOT bound
 * to loopback - narrow on purpose, so the warning does not become noise an operator learns to
 * skip. A KEY PRESENT IS NOT THE TEST: the mock branch of ai/config.js skips the key check
 * entirely, so `DEEPSEEK_API_KEY` being set proves nothing about which provider is in use.
 */
const server = app.listen(PORT, HOST, () => {
    const config = loadAiConfig();
    console.log(`[server] listening on http://${HOST}:${PORT}${BASE_PATH}`);
    console.log(`[server] AI provider: ${config.name} (${config.type})`);

    // A deployment that cannot interview should not be silent; see the note above.
    if (config.type === 'mock' && HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1') {
        console.warn(
            `[server] WARNING: AI_PROVIDER is "${config.name}" while this instance is bound to ` +
            `${HOST}, which is reachable beyond this machine. The mock provider answers every turn ` +
            'with a scripted question and NEVER completes, so no real interview can run and every ' +
            'round is saved as a partial. Set AI_PROVIDER to a real provider (gemini or deepseek) ' +
            'and set its key in .env. Use mock deliberately for development, or bind to 127.0.0.1.'
        );
    }
    console.log(`[server] mail sender: ${process.env.MAIL_SENDER || 'console'} (default console)`);

    // Say where the app is served, because a wrong prefix produces 404s that look
    // like a missing file. The empty case is called out as the root.
    if (BASE_PATH === PUBLIC_PATH) {
        if (BASE_PATH === '') {
            console.log('[server] paths: mounted and visible at the origin root.');
        } else {
            console.log(
                `[server] paths: mounted and visible at ${BASE_PATH} ` +
                '(the proxy passes its prefix through).'
            );
        }
    } else {
        console.log(
            `[server] paths: mounted at ${describeMount()}, visible at ${describePublicPath()} ` +
            '(the proxy strips its prefix before forwarding, so emitted URLs still carry it).'
        );
    }

    // State the trust boundary at startup, because it decides whether a request
    // counts as secure and is otherwise invisible until the site misbehaves on a
    // particular address.
    console.log(`[server] trust proxy: ${TRUST_PROXY.summary}`);
    console.log(`[server] bound to ${HOST}:${PORT}${HOST === '127.0.0.1' ? ' (loopback only; set HOST to widen it deliberately)' : ''}`);

    // A WARNING ABOUT AUDIT_ACCESS_CODE USED TO SIT HERE AND WAS FALSE. It said that
    // with the variable unset "every request will be rejected", and that was never
    // true: a participant token satisfied the questionnaire's gate on its own, so the
    // interview worked with no code set at all. A startup message that describes
    // behaviour the code does not have is worse than no message, because it sends an
    // operator looking for a setting that is not the problem. The variable is gone
    // entirely now; see mayUseQuestionnaire in lib/routes-api.js.
    if (ALLOWED_HOSTS.length === 0) {
        console.warn('[server] ALLOWED_HOST is unset: accepting any host (development only).');
    } else {
        console.log(`[server] accepting hosts: ${ALLOWED_HOSTS.join(', ')}`);
    }

    // The PUBLIC_BASE_URL warning lives with the code that builds the link, so
    // the message and the fallback cannot drift apart. It is emitted once, on
    // the first login request, rather than here: the listener callback runs even
    // when a test imports this module without sending mail.
});

// Leave no orphan processes, and say why we are stopping. Store connections are
// closed too: an open SQLite handle keeps a write lock and the -wal file around,
// so dropping it cleanly is part of not leaving a mess behind.
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        console.log(`[server] received ${signal}, shutting down`);
        server.close(() => {
            const closed = closeAll();
            console.log(`[server] closed ${closed} store connection(s)`);
            process.exit(0);
        });
    });
}
