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
import { runAuditTurn, validateWorkflows } from './ai/audit-core.js';
import { aggregate } from './lib/scoring.js';
import { stringsFor, SUPPORTED_LANGS, DEFAULT_LANG } from './lib/strings.js';
import { DEFAULT_TOOL_ID, getTool } from './config/tools.js';
import { loadAiConfig } from './ai/config.js';
import { assertSessionSecretConfigured } from './lib/auth/session.js';
import { cookieReader, router as adminRouter, assertPublicBaseUrlUsable } from './lib/auth/routes.js';
import { requireSecureConnection } from './lib/auth/require-secure.js';
import { assertMailSenderUsable } from './lib/mail/index.js';
import { closeAll } from './lib/store/index.js';
import { BASE_PATH } from './lib/base-path.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const PORT = Number(process.env.PORT) || 3000;

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

/**
 * How many proxy hops in front of this app may be trusted, from TRUST_PROXY.
 *
 * WHAT THIS CONTROLS. `req.secure` (and `req.protocol`, and `req.ip`) reflect
 * the `X-Forwarded-*` headers only for hops Express has been told to trust. The
 * admin session cookie is marked Secure when `req.secure` is true, so this value
 * decides whether a request arriving over plain HTTP from the proxy can be
 * recognised as having been HTTPS for the browser.
 *
 * WHY IT DEFAULTS TO 0 (trust nobody). Trusting a forwarded header means
 * trusting whoever can send it. `trust proxy = true` trusts every client, so a
 * request made DIRECTLY to this port could send `X-Forwarded-Proto: https` and
 * be treated as secure. Measured on this machine, with Express:
 *
 *   trust proxy unset, X-Forwarded-Proto: https -> secure false  (header ignored)
 *   trust proxy = 1,     X-Forwarded-Proto: https -> secure true  (header trusted)
 *
 * With the default, the socket is the only thing trusted, which is correct when
 * nothing is in front. Set TRUST_PROXY=1 when exactly one reverse proxy
 * terminates TLS and forwards to this container; that is the intended
 * deployment. Set it to the real number of hops, not more.
 *
 * WHAT GOES WRONG IF IT IS WRONG, in both directions:
 *   - too LOW (0 behind a proxy): a genuine HTTPS request looks like HTTP, the
 *     cookie is set without Secure, and over a plain-HTTP hop the cookie travels
 *     in clear text. Sign-in still works, which is why this is the failure an
 *     owner sees rather than a crash.
 *   - too HIGH: a client that is not a trusted proxy can set the header and have
 *     its request treated as secure when it is not. That is an attacker-chosen
 *     change, so more hops is never the safer setting.
 *
 * THE RESIDUAL RISK, stated plainly because it cannot be removed here. A hop
 * count of 1 means "trust the peer that connects to me". If that peer can be a
 * client rather than the proxy (the app is reachable directly, which it is while
 * the listener binds all interfaces), that client can send X-Forwarded-Proto
 * itself. Measured: with TRUST_PROXY=1, a direct client sending the header gets
 * a Secure cookie over plain HTTP. No value of this setting fixes that, because
 * Express decides trust from the hop count, not from the peer's identity.
 *
 * So TRUST_PROXY=1 is correct ONLY where the proxy is the only thing that can
 * reach this port (a private network, or a firewall rule dropping direct access).
 * Until that holds, keep the default of 0. The alternative, trusting a specific
 * address or subnet, is what TRUST_PROXY would need to be if this process could
 * be reached both ways; that is a deployment decision, not one to guess here.
 *
 * The value is the NUMBER OF HOPS, or 0 for none. It is deliberately not a
 * boolean: a boolean true is the one value that cannot be reasoned about, and a
 * count makes the operator state the topology.
 */
const TRUST_PROXY_HOPS = (() => {
    const raw = process.env.TRUST_PROXY;

    if (raw === undefined || raw.trim() === '') return 0;

    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) {
        console.warn(
            `[server] TRUST_PROXY=${JSON.stringify(raw)} is not a non-negative whole number; ` +
            'treating it as 0 (trust no proxy). Set it to the number of reverse proxies in front ' +
            'of this app, for example TRUST_PROXY=1 when one proxy terminates TLS.'
        );
        return 0;
    }
    return parsed;
})();

// 0 means trust nothing: the socket address is the only thing believed, which is
// what `false` means to Express. A positive count is passed through.
app.set('trust proxy', TRUST_PROXY_HOPS);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

/**
 * Expose the base path to every template, so views build URLs from one value
 * rather than hand-writing a prefix that would then drift.
 *
 * `basePath` is "" when served at the root, and views interpolate it directly:
 * href="<%= basePath %>/admin/login". Empty means the ordinary root-relative
 * path, so the same template serves both deployments.
 */
app.use((req, res, next) => {
    res.locals.basePath = BASE_PATH;
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
    // The raw header is used rather than Express's req.hostname, because
    // req.hostname is derived and can normalise a bracketed IPv6 form. Splitting
    // the header ourselves keeps one rule for what is compared.
    //
    // Edge cases, both of which must NOT pass by accident:
    //   - a missing Host header yields "", which matches no configured entry,
    //     because empty entries were filtered out above
    //   - an IPv6 host like "[::1]:3000" splits on the first colon to "[", which
    //     matches no configured entry. A bracketed IPv6 literal is therefore
    //     refused even if it is written in ALLOWED_HOST, because every form of
    //     it reduces to "[". IPv6 literals are not supported by this check; the
    //     deployment is a named subdomain behind a proxy. The failure direction
    //     is safe (refused, not accepted), and this is stated rather than
    //     implied.
    const host = (req.headers.host || '').split(':')[0].trim().toLowerCase();
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

appInternal.get('/', (req, res) => {
    const lang = resolveLang(req);
    const strings = stringsFor(lang);
    res.render('audit', {
        strings,
        lang,
        toolId: DEFAULT_TOOL_ID,
        supportedLangs: SUPPORTED_LANGS
    });
});

appInternal.post('/api/chat', async (req, res) => {
    const { toolId, messages, pass, lang } = req.body || {};

    const tool = getTool(toolId || DEFAULT_TOOL_ID);
    if (!tool) {
        return res.status(400).json({ status: 'error', content: 'Unknown tool.' });
    }

    const expected = process.env[tool.accessCodeEnv] || '';
    if (!expected || pass !== expected) {
        return res.status(403).json({ status: 'error', content: 'Invalid code.' });
    }

    if (!Array.isArray(messages)) {
        return res.status(400).json({ status: 'error', content: 'Missing messages.' });
    }

    try {
        const result = await runAuditTurn({
            messages,
            lang,
            toolId: tool.promptDir
        });
        res.json(result);
    } catch (err) {
        console.error('[api/chat] failed:', err);
        res.status(500).json({
            status: 'error',
            content: 'The analysis service is temporarily unavailable. Please try again.'
        });
    }
});

appInternal.post('/api/score', async (req, res) => {
    const { toolId, pass, audit } = req.body || {};

    const tool = getTool(toolId || DEFAULT_TOOL_ID);
    const expected = tool ? (process.env[tool.accessCodeEnv] || '') : '';
    if (!tool || !expected || pass !== expected) {
        return res.status(403).json({ error: 'Invalid code.' });
    }

    // Validate with the same rule the model path uses, rather than duplicating
    // the checks. This route takes the payload straight from the client, so
    // without it a request could serve a blank heading to the reader.
    const check = validateWorkflows(audit?.workflows);
    if (!check.ok) {
        return res.status(400).json({ error: `Invalid audit: ${check.reason}.` });
    }

    // Scoring is pure and cannot fail on well-formed input, but guard the shape
    // so a malformed payload is a 400 rather than a 500.
    try {
        res.json(aggregate(audit.workflows));
    } catch (err) {
        console.error('[api/score] failed:', err);
        res.status(400).json({ error: 'Could not score the supplied audit.' });
    }
});

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

const server = app.listen(PORT, () => {
    const config = loadAiConfig();
    console.log(`[server] listening on http://localhost:${PORT}${BASE_PATH}`);
    console.log(`[server] AI provider: ${config.name} (${config.type})`);
    console.log(`[server] mail sender: ${process.env.MAIL_SENDER || 'console'} (default console)`);

    // Say where the app is served, because a wrong prefix produces 404s that look
    // like a missing file. The empty case is called out as the root.
    if (BASE_PATH === '') {
        console.log('[server] base path: none (BASE_PATH unset). The app is served at the root.');
    } else {
        console.log(`[server] base path: ${BASE_PATH} (all URLs and routes are prefixed, including the session cookie path)`);
    }

    // State the trust boundary at startup, because it decides whether a session
    // cookie is marked Secure and is otherwise invisible until sign-in misbehaves
    // on a particular hostname.
    if (TRUST_PROXY_HOPS === 0) {
        console.log('[server] trust proxy: none (TRUST_PROXY=0). Forwarded protocol headers are ignored, so a request is secure only over TLS to this port.');
    } else {
        console.log(`[server] trust proxy: ${TRUST_PROXY_HOPS} hop(s). X-Forwarded-Proto from those hops decides whether the session cookie is Secure.`);
    }

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
