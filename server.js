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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const PORT = Number(process.env.PORT) || 3000;
const ALLOWED_HOST = process.env.ALLOWED_HOST || '';

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

/**
 * Restricts the Host header when ALLOWED_HOST is set. The hostname belongs in
 * the environment and on the proxy, never hardcoded in the application, so the
 * same image runs locally and on the VPS.
 */
app.use((req, res, next) => {
    if (!ALLOWED_HOST) return next();
    const host = (req.headers.host || '').split(':')[0];
    if (host === ALLOWED_HOST) return next();
    console.warn(`[host] rejected request for host "${host}" (expected "${ALLOWED_HOST}")`);
    res.status(421).send('Misdirected request.');
});

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

app.get('/healthz', (req, res) => {
    res.json({ ok: true });
});

app.get('/', (req, res) => {
    const lang = resolveLang(req);
    const strings = stringsFor(lang);
    res.render('audit', {
        strings,
        lang,
        toolId: DEFAULT_TOOL_ID,
        supportedLangs: SUPPORTED_LANGS
    });
});

app.post('/api/chat', async (req, res) => {
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

app.post('/api/score', async (req, res) => {
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

app.use((req, res) => {
    res.status(404).send('Not found.');
});

const server = app.listen(PORT, () => {
    const config = loadAiConfig();
    console.log(`[server] listening on http://localhost:${PORT}`);
    console.log(`[server] AI provider: ${config.name} (${config.type})`);
    if (!process.env.AUDIT_ACCESS_CODE) {
        console.warn('[server] WARNING: AUDIT_ACCESS_CODE is unset, every request will be rejected.');
    }
    if (!ALLOWED_HOST) {
        console.warn('[server] ALLOWED_HOST is unset: accepting any host (development only).');
    }
});

// Leave no orphan processes, and say why we are stopping.
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        console.log(`[server] received ${signal}, shutting down`);
        server.close(() => process.exit(0));
    });
}
