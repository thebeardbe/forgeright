/**
 * Roadmap builder server.
 *
 * A standalone Node application. It shares no configuration, no data store and
 * no code with the CV site: client workflow data and a personal CV corpus
 * should never live in the same place.
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
import { assertMailSenderUsable } from './lib/mail/index.js';
import { closeAll } from './lib/store/index.js';
import { BASE_PATH, PUBLIC_PATH, describeMount, describePublicPath } from './lib/base-path.js';
import { resolveTrustProxy, hostnameFromHeader } from './lib/trust-proxy.js';
import { router as participantRouter } from './lib/auth/participant-routes.js';
import { router as landingRouter } from './lib/landing.js';
import { registerThemeRoute } from './lib/theme-route.js';
import { shortInstant, shortDuration } from './lib/view-format.js';
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
 * WHY LOOPBACK BY DEFAULT. The deployment is a reverse proxy on the same host,
 * connecting over loopback, so binding 127.0.0.1 is exactly the access this
 * needs while making the container unreachable from anywhere else. That is the
 * other half of the proxy-trust boundary: TRUST_PROXY decides which PEER may
 * claim a request was HTTPS, and HOST decides who can connect at all. With the
 * listener open on all interfaces, the trust setting is the only thing standing
 * between a LAN client and the application, and a single mistake there serves it
 * over cleartext (that was the H2 bypass: reachable on the LAN, so one forged
 * header was believed).
 *
 * Set HOST=0.0.0.0 deliberately, in a container where the proxy is NOT on the
 * same host and reaches this one over a private network, or for a development
 * setup where another machine must connect. In that case TRUST_PROXY must name
 * that proxy's address, and a hop count is not enough for the reason above.
 */
const HOST = (process.env.HOST || '127.0.0.1').trim();

// Fail before serving anything, rather than at the first sign-in attempt. A
// missing SESSION_SECRET would otherwise surface as "login is broken", which is
// the hardest kind of misconfiguration to diagnose from the outside.
assertSessionSecretConfigured();
assertMailSenderUsable();
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
 */
app.use((req, res, next) => {
    res.locals.basePath = PUBLIC_PATH;

    // The picker's list, derived from the palette data so a new palette appears
    // without touching a template. Ordered as lib/palettes.js orders them.
    res.locals.themeOptions = PALETTE_IDS.map((id) => ({ id, name: PALETTES[id].name }));

    // THE PATH THE BROWSER IS ON, for the theme picker's way back.
    //
    // TAKEN FROM THE REQUEST RATHER THAN BUILT FROM PUBLIC_BASE_URL, because the whole
    // point is that the browser's URL may differ from the configured one: behind a proxy
    // that terminates a different hostname, a link built from the configuration would
    // send the user to a host they are not using. `req.path` is what the browser asked
    // for, so returning to it is a no-op the user cannot detect.
    //
    // **THE QUERY STRING IS DELIBERATELY DROPPED, AND THAT IS A SECURITY DECISION.**
    // This value is written into a hidden form field on every page, so carrying the query
    // string would echo whatever the URL held into the body: the demo link's TOKEN, on
    // the very refusal page that exists to say nothing about it. A credential reflected
    // into HTML lands in browser history, a proxy log, and any error reporter that
    // captures the DOM. It was measured: a bad-token request returned a page containing
    // the submitted token, and the demo tests caught it because two requests that must be
    // indistinguishable had different bodies.
    //
    // The cost is that changing the theme on a page showing a rejudge NOTICE returns to
    // the page without its notice. That is a small loss of convenience against not
    // writing credentials into pages, and the notice is the kind of state a reader can
    // re-trigger by acting again.
    res.locals.currentUrl = req.path;

    // The formatting helpers, so a template writes `<%= shortInstant(x) %>` rather than
    // reaching for a method on a raw value. See lib/view-format.js for why the output is
    // unambiguous rather than locale-formatted.
    res.locals.shortInstant = shortInstant;
    res.locals.shortDuration = shortDuration;
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
 */
app.use((req, res, next) => {
    if (ALLOWED_HOSTS.length === 0) return next();

    // Strip the port, then lowercase. A Host header is case-insensitive, and an
    // operator who typed "Localhost" should not be locked out.
    //
    // The raw header is parsed by hostnameFromHeader, which handles an IPv6
    // authority correctly. Splitting on ":" here was a second instance of the
    // same defect that made the loopback check unable to match "[::1]": a
    // bracketed literal yields "[", so an IPv6 entry in ALLOWED_HOST could never
    // match however it was written.
    //
    // Edge cases, both of which must NOT pass by accident:
    //   - a missing Host header yields "", which matches no configured entry,
    //     because empty entries were filtered out above
    //   - an IPv6 host is now matched as written, so "[::1]" in ALLOWED_HOST works
    const host = hostnameFromHeader(req.headers.host);
    if (ALLOWED_HOSTS.includes(host)) return next();

    console.warn(
        `[host] rejected request for host "${host}" ` +
        `(allowed: ${ALLOWED_HOSTS.join(', ')})`
    );
    res.status(421).send('Misdirected request.');
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
 * This sits before the content routes so a route added later is covered without
 * anyone remembering: the rule is the connection, not the feature. See
 * lib/auth/require-secure.js for why the questionnaire is included (the
 * participant token is a credential and the answers describe internal
 * processes) and for the single /healthz exemption.
 *
 * It runs after the host guard so an unlisted host is rejected as misdirected
 * before anything else, and it sets no cookie, so a refusal cannot itself leave
 * state behind.
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
    res.status(404).send('Not found.');
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
    res.status(404).send('Not found.');
});

const server = app.listen(PORT, HOST, () => {
    const config = loadAiConfig();
    console.log(`[server] listening on http://${HOST}:${PORT}${BASE_PATH}`);
    console.log(`[server] AI provider: ${config.name} (${config.type})`);
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

    if (!process.env.AUDIT_ACCESS_CODE) {
        console.warn('[server] WARNING: AUDIT_ACCESS_CODE is unset, every request will be rejected.');
    }
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
