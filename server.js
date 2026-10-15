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
 * Interface the listener binds, from HOST: loopback by default, because the deployment is a reverse proxy on
 * the same host.
 *
 * This is the other half of the proxy-trust boundary - TRUST_PROXY decides which peer may claim a request was
 * HTTPS, HOST decides who can connect at all - and with the listener open on every interface the trust
 * setting alone stands between a LAN client and the application.
 */
const HOST = (process.env.HOST || '127.0.0.1').trim();

// Fail before serving anything, rather than at the first sign-in attempt. A
// missing SESSION_SECRET would otherwise surface as "login is broken", which is
// the hardest kind of misconfiguration to diagnose from the outside.
assertSessionSecretConfigured();
assertMailSenderUsable();
// Warned rather than thrown, because the console does not need mail to work; a missing binary or an
// expired session would otherwise fail silently at the first send.
for (const problem of mailReadinessProblems()) {
    console.warn(`[mail] ${problem}`);
}
// The mail-link configuration is validated here too: a PUBLIC_BASE_URL that
// cannot be combined with BASE_PATH must stop the process at startup, not throw
// on an admin's first login attempt, which it did before this check existed.
assertPublicBaseUrlUsable();

/**
 * Hostnames this instance answers on, from a comma-separated ALLOWED_HOST; unset means accept any host.
 * Entries are trimmed and lowercased once, and empty ones are dropped, because an empty entry matches a
 * request with no Host header, which is exactly the request that should be refused.
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
 * Expose the public path to every template, so views build URLs from one value rather than hand-writing a
 * prefix. It is PUBLIC_PATH rather than BASE_PATH, because the browser is outside the mount and the two
 * differ when a proxy strips its prefix.
 *
 * `currentUrl` is the path the browser is on, taken from the request rather than built from
 * PUBLIC_BASE_URL, because behind a proxy terminating a different hostname a configured link sends the user
 * to a host they are not using.
 *
 * THE QUERY STRING IS DELIBERATELY DROPPED: this value goes into a hidden form field on every page, so
 * carrying the query would echo the demo link's token into the body of the very refusal page that exists to
 * say nothing about it. The cost is that changing the theme on a page showing a rejudge notice returns
 * without the notice.
 */
app.use((req, res, next) => {
    res.locals.basePath = PUBLIC_PATH;

    // The picker's list, derived from the palette data so a new palette appears without
    // touching a template. Ordered as lib/palettes.js orders them.
    res.locals.themeOptions = PALETTE_IDS.map((id) => ({ id, name: PALETTES[id].name }));

    res.locals.currentUrl = req.path;

    // The formatting helpers, so a template writes `<%= shortInstant(x) %>` rather than reaching for a
    // method on a raw value.
    res.locals.shortInstant = shortInstant;
    res.locals.shortDuration = shortDuration;
    // The response-shape resolvers; see lib/view-format.js.
    res.locals.responseTitle = responseTitle;
    res.locals.responseWorkflow = responseWorkflow;
    next();
});

/**
 * Restricts the Host header when ALLOWED_HOST is set, mounted before every route so a request from an
 * unlisted host cannot reach one.
 *
 * The log names the host and the list while the page names neither, because a visitor reading the allowed
 * list would be handed this installation's configuration.
 */
app.use((req, res, next) => {
    if (ALLOWED_HOSTS.length === 0) return next();

    const host = hostnameFromHeader(req.headers.host);
    if (ALLOWED_HOSTS.includes(host)) return next();

    console.warn(
        `[host] rejected request for host "${host}" ` +
        `(allowed: ${ALLOWED_HOSTS.join(', ')})`
    );

    // The log names the host and the list; the page names neither.
    return sendError(req, res, 421);
});

// Reads the header into req.cookies for the whole app, after the host guard so an unlisted host cannot
// reach a route. It sets no cookie itself.
app.use(cookieReader);

// After cookieReader, which it reads from: running it first would silently see no cookie and always fall
// back to the system preference.
app.use(themeMiddleware);

/**
 * Everything the app serves is HTTPS only, applied here rather than per route, before the content routes so
 * one added later is covered without anyone remembering.
 *
 * After the host guard, so an unlisted host is rejected as misdirected first; see lib/auth/require-secure.js
 * for the single /healthz exemption.
 */
app.use(requireSecureConnection);

/**
 * Everything the application serves lives on this sub-app, mounted at the base path below, so the prefix
 * has one home and a new route added here is prefixed automatically.
 */
const appInternal = express.Router();

appInternal.use(express.json({ limit: '256kb' }));
appInternal.use(express.urlencoded({ extended: false, limit: '64kb' }));
appInternal.use(express.static(path.join(__dirname, 'public')));

/**
 * Expose the strings and language every template needs, on res.locals and before every router, because a
 * page rendered by a route mounted earlier would otherwise have them undefined.
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

// The theme route; see lib/theme-route.js for why the return target comes from the query.
registerThemeRoute(appInternal, {
    PUBLIC_PATH, FOLLOW_SYSTEM, PALETTES, parseThemeChoice,
    THEME_COOKIE, THEME_COOKIE_MAX_AGE, isSecureRequest, publicBaseUrl
});


/**
 * The participant's routes: /q/<token>, /q, /lost-link and the answer API.
 */
appInternal.use('/', participantRouter);

// Mounted after the participant routes, so those specific paths win and only the bare `/` reaches it.
appInternal.use('/', landingRouter);

// The questionnaire's API: one conversation turn, and scoring.
appInternal.use('/', apiRouter);

appInternal.use((req, res) => {
    sendError(req, res, 404);
});

/**
 * Mount the application at the base path. A prefix moves routes, static files and the API together, which is
 * why they share one app: three mount points are three chances to prefix only two of them.
 */
app.use(BASE_PATH, appInternal);

/**
 * 404 for anything outside the prefix, so a wrong URL looks the same wherever it lands and a request that
 * missed the prefix cannot reach a route.
 */
app.use((req, res) => {
    sendError(req, res, 404);
});

/**
 * The last handler. Without it an uncaught throw reaches Express's default, which puts the stack trace in the
 * body outside production, so a fault mid-interview would show a participant a file path and a line number.
 *
 * The log gets the message and stack while the page gets neither, in any environment.
 *
 * It must take four arguments, which is how Express recognises error middleware.
 *
 * An error that knows its own status keeps it, because the page's wording depends on whose fault it is, and
 * the body parsers attach one: malformed JSON is 400 and an oversized body is 413, where answering 500 would
 * tell the sender "our fault" about a request they malformed.
 *
 * The status is validated rather than merely converted, because `res.status()` accepts only 100-599 and an
 * out-of-range value would throw from inside the error handler and put a stack trace in the body, which is
 * what this handler exists to prevent. The floor is 400, because everything here is an error and a 2xx or 3xx
 * page would let a monitor count a failure as success. Anything outside becomes 500.
 */
app.use((err, req, res, next) => {
    console.error(`[server] unhandled error on ${req.method} ${req.originalUrl}:`, err);

    // A response already under way cannot be replaced: `res.status(...)` would throw in turn and hide the
    // original fault behind a second one.
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
 * `mock` answers every turn with a scripted question and never completes, so an instance left on it cannot
 * run a real interview and nothing about that is visible from outside. It is not an error and must not
 * become one, because local development and the whole suite depend on it.
 *
 * The condition is that the app is not bound to loopback, which is narrow on purpose. A key being present is
 * not the test, because the mock branch skips the key check entirely.
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

    // A wrong prefix produces 404s that look like a missing file.
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

    // The trust boundary decides whether a request counts as secure and is otherwise invisible.
    console.log(`[server] trust proxy: ${TRUST_PROXY.summary}`);
    console.log(`[server] bound to ${HOST}:${PORT}${HOST === '127.0.0.1' ? ' (loopback only; set HOST to widen it deliberately)' : ''}`);

    if (ALLOWED_HOSTS.length === 0) {
        console.warn('[server] ALLOWED_HOST is unset: accepting any host (development only).');
    } else {
        console.log(`[server] accepting hosts: ${ALLOWED_HOSTS.join(', ')}`);
    }

    // The PUBLIC_BASE_URL warning lives with the code that builds the link, and is emitted once on the
    // first login request rather than here.
});

// Store connections are closed too: an open SQLite handle keeps a write lock and the -wal file around.
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
