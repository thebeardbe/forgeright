/**
 * The error pages: the format decision, the 500 handler, and what must not leak.
 *
 * WHY THIS FILE EXISTS. `views/error.ejs` and `lib/error-page.js` shipped in d24a280 without a
 * test, which is the gap this file closes. Two claims in that commit are load-bearing enough to
 * be worth stating before any assertion:
 *
 *   - THE `Accept` HEADER DECIDES THE FORMAT. A participant's client talks to `/api/chat` and
 *     `/api/score` with `fetch` and would fail PARSING JSON if a page came back, so a 500 would
 *     surface as a syntax error rather than as the error it was. That is a correctness matter,
 *     and it is the first thing tested here.
 *   - NOTHING FROM THE REQUEST IS RENDERED. The 421 is the page a visitor reaches by using a host
 *     the installation does not answer for, so naming the allowed hosts would hand out the
 *     configuration; the 500 is a fault, so naming the message or a path would leak internals.
 *
 * EVERY REQUEST HERE IS REAL. The server has no exported app factory and listens on import, so it
 * is started as a child process on a free port and exercised over HTTP, the same way
 * test/routes.test.js does it.
 *
 * A NOTE ON ONE ASSERTION BEING A FALSE FRIEND. The page embeds a stylesheet and a script partial,
 * and those carry build comments that mention `lib/palettes.js`. So "the response contains no file
 * path" is FALSE for every page, including a plain 404, and a test written that way would either
 * fail wrongly or be weakened until it proved nothing. The leak tests below therefore assert the
 * ABSENCE OF THE ERROR'S OWN CONTENT - the message, the stack frames, the file the throw came
 * from - which is what the commit actually claims.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, '..', 'server.js');

const ALLOWED_HOST = 'allowed.example.test';
const STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-error-page-'));

process.env.STORE_DIR = STORE_DIR;
process.env.SESSION_SECRET = 'a'.repeat(64);
const store = await import('../lib/store/index.js');
store.createOrganisation('Error page test organisation');
store.closeAll();

/** Every variable the spawned server reads; the child gets this as its WHOLE environment. */
function spawnedEnv(port, extra = {}) {
    return {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: 'test',
        PORT: String(port),
        HOST: '127.0.0.1',
        BASE_PATH: '',
        PUBLIC_BASE_URL: `https://${ALLOWED_HOST}`,
        TRUST_PROXY: '127.0.0.1',
        ALLOWED_HOST,
        SESSION_SECRET: 'a'.repeat(64),
        STORE_DIR,
        AI_PROVIDER: 'mock',
        MAIL_SENDER: 'console',
        ...extra
    };
}

function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.on('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

const PORT = await freePort();

/**
 * One HTTP request, with the allowed Host and the trusted HTTPS header by default.
 *
 * `host` is overridden by a test that must exercise the 421, and `rawBody` is used for a body that
 * is deliberately not valid JSON.
 */
function request({ method = 'GET', path: urlPath = '/', headers = {}, body, rawBody, host = ALLOWED_HOST } = {}) {
    const payload = rawBody !== undefined ? rawBody : (body === undefined ? undefined : JSON.stringify(body));
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: '127.0.0.1',
                port: PORT,
                path: urlPath,
                method,
                headers: {
                    host,
                    'x-forwarded-proto': 'https',
                    ...(payload !== undefined
                        ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
                        : {}),
                    ...headers
                }
            },
            (res) => {
                let text = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => { text += chunk; });
                res.on('end', () => resolve({ status: res.statusCode, text, contentType: res.headers['content-type'] || '' }));
            }
        );
        req.on('error', reject);
        if (payload !== undefined) req.write(payload);
        req.end();
    });
}

async function waitForServer(deadlineMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < deadlineMs) {
        try {
            const res = await request({ path: '/healthz' });
            if (res.status === 200) return true;
        } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`server did not become ready on port ${PORT}`);
}

/**
 * Boots a server on its own port and captures its output, for the tests that need a different
 * environment (a forced 500, a different NODE_ENV).
 */
async function bootWith(extra = {}) {
    const port = await freePort();
    const child = spawn(process.execPath, [SERVER], { env: spawnedEnv(port, extra), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });

    const get = (options) => new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, ...options }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { text += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, text, contentType: res.headers['content-type'] || '' }));
        });
        req.on('error', reject);
        if (options.body) req.write(options.body);
        req.end();
    });

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
        try {
            const r = await get({ method: 'GET', path: '/healthz', headers: { host: ALLOWED_HOST, 'x-forwarded-proto': 'https' } });
            if (r.status === 200) break;
        } catch { /* not up */ }
        await new Promise((r) => setTimeout(r, 50));
    }

    const kill = () => new Promise((resolve) => {
        child.once('exit', () => resolve());
        child.kill('SIGKILL');
    });
    return { get, kill, output: () => output, port };
}

let child;

before(async () => {
    child = spawn(process.execPath, [SERVER], { env: spawnedEnv(PORT), stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    await waitForServer();
});

after(async () => {
    fs.rmSync(STORE_DIR, { recursive: true, force: true });
    if (!child || child.killed) return;
    await new Promise((resolve) => {
        child.once('exit', () => resolve());
        child.kill('SIGKILL');
    });
});

// ===========================================================================
// 1. THE `Accept` DECISION - the constraint that could break a participant silently
// ===========================================================================

test('the Accept header decides the format, and the status is correct in every case', async () => {
    // THE TABLE FROM THE COMMIT, through a real request. A JSON client must never receive a page,
    // and the status must not be traded for the format.
    const cases = [
        ['application/json', 'application/json'],
        ['application/json, text/plain, */*', 'application/json'],
        ['text/html', 'text/html'],
        ['*/*', 'text/html'],
        [null, 'text/html']
    ];

    for (const [accept, expected] of cases) {
        const headers = accept === null ? {} : { accept };
        const res = await request({ path: '/definitely-not-a-page', headers });
        assert.equal(res.status, 404, `status stays 404 for Accept: ${accept}`);
        assert.match(res.contentType, new RegExp(`^${expected}`),
            `Accept: ${accept} must be answered as ${expected} (got ${res.contentType})`);
    }
});

test('a BROWSER\'s real Accept header lands on HTML', async () => {
    // What a browser actually sends, with quality values - the header that made `includes` the
    // right test. It names `application/xml` and `*/*` but NOT `application/json`, so it is a page.
    const browser = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
    const res = await request({ path: '/definitely-not-a-page', headers: { accept: browser } });

    assert.equal(res.status, 404);
    assert.match(res.contentType, /^text\/html/, 'a browser gets the page');
    assert.match(res.text, /<!DOCTYPE html>/, 'and it is a page');
});

test('the `includes` reasoning holds: a JSON type ANYWHERE in the list wins', async () => {
    // The commit chose `includes` over equality "because a real client sends a list with quality
    // values". The reasoning is checked: a media type in the middle of a list, with parameters and
    // quality values around it, still selects JSON - which an equality test would refuse.
    const res = await request({
        path: '/definitely-not-a-page',
        headers: { accept: 'text/plain;q=0.5, application/json;q=0.9, */*;q=0.1' }
    });

    assert.equal(res.status, 404);
    assert.match(res.contentType, /^application\/json/, 'JSON named in a list selects JSON');
    assert.doesNotMatch(res.text, /<!DOCTYPE html>/, 'and no page is sent');
});

test('a header PREFERRING HTML but naming JSON gets JSON - INTENDED, quality values are not read', async () => {
    // THE BEHAVIOUR THE COMMENT NOW ADMITS TO. `text/html;q=0.9, application/json;q=0.1` prefers
    // HTML by quality value, and this returns JSON anyway. That is DELIBERATE rather than a bug: a
    // caller that names `application/json` at all is a program that will try to parse the body, so
    // a page would produce a parse error instead of the error it asked about. Honouring the
    // preference would mean replying with something the caller cannot read, to satisfy a ranking it
    // expressed for a format it did not ask for.
    //
    // PINNED SO A FUTURE READER DOES NOT "FIX" THIS INTO A QUALITY-VALUE PARSER. If someone does,
    // this test is the one that tells them it was a decision.
    const res = await request({
        path: '/definitely-not-a-page',
        headers: { accept: 'text/html;q=0.9, application/json;q=0.1' }
    });

    assert.equal(res.status, 404);
    assert.match(res.contentType, /^application\/json/, 'JSON wins despite the lower quality value');
    assert.doesNotMatch(res.text, /<!DOCTYPE html>/, 'no page, because the caller named JSON');

    // And the reverse - HTML named alone - still gets the page, so this is not "JSON always".
    const html = await request({ path: '/definitely-not-a-page', headers: { accept: 'text/html;q=0.9' } });
    assert.match(html.contentType, /^text\/html/, 'HTML alone still gets the page');
});

test('a JSON error carries the shape a client parses', async () => {
    // The body must be valid JSON with the `error` key the module documents, or a client reading it
    // breaks on the error path - the failure this format decision exists to prevent.
    const res = await request({ path: '/definitely-not-a-page', headers: { accept: 'application/json' } });

    const parsed = JSON.parse(res.text); // throws if it is not JSON, which is the assertion
    assert.equal(typeof parsed.error, 'string', 'the body carries a string `error`');
    assert.ok(parsed.error.length > 0, 'and it says something');
});

// ===========================================================================
// 2. THE ERROR STATUS - a client error keeps its status, a throw becomes 500
// ===========================================================================

/**
 * A malformed JSON body, which `express.json()` rejects with `err.status = 400`.
 *
 * THIS IS A CLIENT ERROR, NOT AN UNCAUGHT THROW, and the name says so. The earlier fixture called
 * this an "uncaught throw" and asserted 500, which ENCODED THE BUG: Express attaches 400 to a
 * malformed body, and a handler that answered 500 told the sender "this is a fault on our side,
 * not yours" about a request THEY malformed. Six tests shared that fixture and every one of them
 * wanted the real status, which is 400.
 *
 * SO IT IS USED WHERE THE TEST IS ABOUT A MALFORMED BODY (the status, the wording, the leak and
 * the format), and the genuine-throw fixture below is used where the test is about an uncaught
 * throw.
 */
async function malformedBodyRequest(extra = {}) {
    return request({
        method: 'POST',
        path: '/api/score',
        rawBody: '{ this is not json',
        headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength('{ this is not json')) },
        ...extra
    });
}

/**
 * An OVERSIZED JSON body, which `express.json()` rejects with `err.status = 413`.
 *
 * The JSON limit is 256kb, so this exceeds it. The parse never runs, so this is a second status
 * that travels from a middleware rather than from a route.
 */
async function oversizedBodyRequest(extra = {}) {
    const filler = 'x'.repeat(300 * 1024);
    const body = `{"a":"${filler}"}`;
    return request({
        method: 'POST',
        path: '/api/score',
        rawBody: body,
        headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
        ...extra
    });
}

/**
 * A GENUINE UNCAUGHT THROW through the real handler, with a status of its own choosing.
 *
 * No route in this app throws uncaught, so this cannot be reached through a real request - the
 * handler body is read OUT OF server.js and mounted on a two-route app, which is as close as an
 * offline test can come and is stated as such. `status` is what the thrown error carries, which is
 * how the unrecognised-status case is built.
 */
async function genuineThrow(status) {
    const express = (await import('express')).default;
    const { sendError } = await import('../lib/error-page.js');
    const source = fs.readFileSync(path.join(PROJECT_ROOT(), 'server.js'), 'utf8');

    // The handler must resolve the status the way server.js does, or this tests nothing about it.
    assert.match(source, /return sendError\(req, res, Number\(err\.status\) \|\| 500\);\n\}/,
        'server.js resolves the status with `Number(err.status) || 500`');

    const app = express();
    // THE VIEW ENGINE AND LOCALS ARE CONFIGURED, as server.js does, or `sendError`'s
    // `res.render('error', ...)` throws "No default engine" and the 500 comes from Express's
    // default rather than from the page - which would make this test pass for the wrong reason.
    // `currentUrl` is the one local the theme picker needs that no middleware here supplies; on the
    // real server it is set at server.js:148, above the routes.
    app.set('view engine', 'ejs');
    app.set('views', path.join(PROJECT_ROOT(), 'views'));
    app.use((req, res, next) => { res.locals.currentUrl = req.path; next(); });
    app.get('/boom', (req, res, next) => {
        const error = new Error('a genuine fault');
        if (status !== undefined) error.status = status;
        next(error); // the real Express path: an error passed to next()
    });
    // The body, verbatim from server.js, with the status resolution the test above asserts.
    app.use((err, req, res, next) => {
        if (res.headersSent) return next(err);
        return sendError(req, res, Number(err.status) || 500);
    });

    const port = await freePort();
    const server = app.listen(port, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
        return await new Promise((resolve, reject) => {
            const req = http.request({ host: '127.0.0.1', port, path: '/boom', headers: { accept: 'text/html' } }, (r) => {
                let text = '';
                r.setEncoding('utf8');
                r.on('data', (c) => { text += c; });
                r.on('end', () => resolve({ status: r.statusCode, text, contentType: r.headers['content-type'] || '' }));
            });
            req.on('error', reject);
            req.end();
        });
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

test('a MALFORMED BODY is the sender\'s error: 400, with wording about the request', async () => {
    // REPURPOSED from "an uncaught throw is answered with the 500 page". The fixture posts broken
    // JSON, which is a CLIENT error, so the test now asserts what it is actually producing and its
    // name says "malformed body" rather than lying about being an uncaught throw.
    const res = await malformedBodyRequest({ accept: 'text/html' });

    assert.equal(res.status, 400, 'a malformed body is a 400, not a 500');
    assert.match(res.contentType, /^text\/html/, 'and a page is sent');
    assert.match(res.text, /request did not make sense|not in the form this site expects/i,
        'the wording is about the request');
    assert.doesNotMatch(res.text, /fault on our side, not yours/i,
        'and does NOT blame the server, which is the wrong message this fix corrects');
});

test('a GENUINE UNCAUGHT THROW is a 500 - the fixture that name really needs', async () => {
    // The real throw path, through the real handler body. Distinct from the malformed body above:
    // nothing the sender did caused this, so it is 500 and the page says so.
    const res = await genuineThrow(undefined);

    assert.equal(res.status, 500, 'an uncaught throw is a 500');
    assert.match(res.text, /Something went wrong here|fault on our side/i, 'and the page says it is ours');
    assert.doesNotMatch(res.text, /\n\s+at [A-Za-z]/, 'with no stack');
});

test('an OVERSIZED body is a 413, with size wording and NOT the 500 message', async () => {
    // The second wrong message the fix exposed: an oversized body previously kept 413 but showed
    // the 500 copy, about a body the sender made too large.
    const res = await oversizedBodyRequest({ accept: 'text/html' });

    assert.equal(res.status, 413, 'an oversized body keeps its 413');
    assert.match(res.text, /too much to send|larger than this site accepts/i, 'the wording is about size');
    assert.doesNotMatch(res.text, /fault on our side, not yours/i, 'and not the server-fault message');
});

test('an error with an UNRECOGNISED status falls back to 500 - the safe direction', async () => {
    // `Number(err.status) || 500` rather than `err.status || 500`: anything unrecognised reads as a
    // server fault. Claiming a client error for something we threw would send the sender looking
    // for a mistake they did not make, which is the distinction these pages exist to get right.
    for (const weird of ['teapot', 0, null, NaN, undefined]) {
        const res = await genuineThrow(weird);
        assert.equal(res.status, 500, `err.status ${JSON.stringify(weird)} falls back to 500`);
    }
});

test('a MALFORMED BODY leaks NOTHING - no message, no stack, no body fragment', async () => {
    // Kept from the earlier version, which is genuinely about leaking rather than about the status,
    // so it keeps its fixture and only its status expectation changes. The error is a SyntaxError
    // from `express.json()`, whose message names the body and whose stack names the file.
    //
    // THE MESSAGE IS ASSERTED BY ITS ACTUAL TEXT: on this Node version the parser says "Expected
    // property name or '}' in JSON at position 1", and an earlier check looked for "Unexpected
    // token" and would have passed while the message WAS being rendered.
    const res = await malformedBodyRequest({ accept: 'text/html' });

    assert.doesNotMatch(res.text, /Expected property name|Unexpected token|in JSON at position/i,
        'the parser message is not rendered');
    assert.doesNotMatch(res.text, /this is not json/, 'nor the body fragment the message quotes');
    assert.doesNotMatch(res.text, /SyntaxError/i, 'nor the error type');
    assert.doesNotMatch(res.text, /\n\s+at [A-Za-z]/, 'nor a stack frame');
    assert.doesNotMatch(res.text, /express\.json|body-parser|raw-body/i, 'nor the middleware that threw');
});

test('a DISTINCTIVE secret in the error does not reach the response, while the log has it', async () => {
    // Kept from the earlier version: this is about LEAKING, not about which status. The fixture is
    // the malformed body because it echoes a body fragment in its message, which is where a secret
    // would travel - so the status is 400 here, and that is stated rather than asserted as 500.
    const secret = 'zQX-SECRET-4417';
    const booted = await bootWith();
    try {
        const body = `{ "broken": "${secret}" `; // unterminated: the parser quotes the input
        const res = await booted.get({
            method: 'POST',
            path: '/api/score',
            headers: {
                host: ALLOWED_HOST, 'x-forwarded-proto': 'https', accept: 'text/html',
                'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body))
            },
            body
        });

        assert.equal(res.status, 400, 'a malformed body is a 400 (the leak is what this tests)');
        assert.equal(res.text.includes(secret), false, 'the secret does NOT appear in the response');
        // The log carries the real error, which is what makes the page's silence safe.
        assert.match(booted.output(), /unhandled error/i, 'the log records the error');
        assert.equal(booted.output().includes(secret), true, 'and the log DOES carry the secret, so the page can be silent');
    } finally {
        await booted.kill();
    }
});

test('the error page is the same with NODE_ENV unset - no development exception', async () => {
    // Kept: this is about the ABSENCE OF A DEVELOPMENT BRANCH, not about the status, so the
    // malformed body is fine as a trigger and the status is 400. Checked with NODE_ENV absent,
    // which is how a mis-set environment could have switched a stack trace on.
    const booted = await bootWith({ NODE_ENV: '' });
    try {
        const body = '{ not json';
        const res = await booted.get({
            method: 'POST', path: '/api/score',
            headers: {
                host: ALLOWED_HOST, 'x-forwarded-proto': 'https', accept: 'text/html',
                'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body))
            },
            body
        });

        assert.equal(res.status, 400, 'a malformed body is a 400 with NODE_ENV unset too');
        assert.doesNotMatch(res.text, /\n\s+at [A-Za-z]/, 'no stack with NODE_ENV unset');
        assert.doesNotMatch(res.text, /Expected property name|Unexpected token|not json/i, 'and no parser message');
    } finally {
        await booted.kill();
    }
});

test('a JSON client gets a JSON 400 for a malformed body, so it can parse its own failure', async () => {
    // REPURPOSED from "a JSON client gets a JSON 500". The FORMAT decision is what this tests, and
    // it applies at any status; the fixture is a malformed body, so the status is 400. The client
    // would otherwise surface a JSON page as a syntax error rather than as the error it was.
    const body = '{ not json';
    const res = await request({
        method: 'POST',
        path: '/api/score',
        rawBody: body,
        headers: { 'content-type': 'application/json', accept: 'application/json', 'content-length': String(Buffer.byteLength(body)) }
    });

    assert.equal(res.status, 400, 'a malformed body is a 400');
    assert.match(res.contentType, /^application\/json/, 'answered as JSON');
    const parsed = JSON.parse(res.text);
    assert.equal(typeof parsed.error, 'string', 'with the `error` key a client reads');
});

// ===========================================================================
// 3. THE `headersSent` PATH - constructed, and stated as constructed
// ===========================================================================

test('the headersSent path hands off to Express rather than throwing a second time', async () => {
    // A ROUTE THAT SENDS HEADERS AND THEN THROWS DOES NOT EXIST IN THIS APP, so this cannot be
    // reached through a real request. It is constructed instead by mounting THE EXACT HANDLER BODY
    // from server.js on a two-route Express app, which is as close as an offline test can come -
    // and it says so rather than pretending to be end-to-end.
    //
    // WHY IT MATTERS: `res.status(...)` throws once headers are sent, so a handler that tried to
    // render anyway would raise a SECOND error from inside the error handler and hide the first.
    //
    // THE HANDLER IS READ FROM server.js AND EXECUTED, not re-typed here, so removing the
    // `headersSent` branch from production turns this red. A test that copied the branch would
    // pass whatever the server did - the failure mode this project has hit repeatedly.
    const express = (await import('express')).default;
    const { sendError } = await import('../lib/error-page.js');

    const source = fs.readFileSync(path.join(PROJECT_ROOT(), 'server.js'), 'utf8');
    assert.match(source, /if \(res\.headersSent\) return next\(err\);/,
        'server.js has the headersSent hand-off this test exercises');
    // And it is the FOUR-argument registration, which is how Express recognises error middleware.
    assert.match(source, /app\.use\(\(err, req, res, next\) => \{/, 'the handler is registered with four arguments');

    const app = express();
    app.get('/boom', (req, res) => {
        res.status(200).write('partial output'); // headers sent, response under way
        throw new Error('the original fault');
    });

    let handedOff = null;
    // The handler body, verbatim from server.js.
    app.use((err, req, res, next) => {
        if (res.headersSent) { handedOff = err; return next(err); }
        return sendError(req, res, 500);
    });
    // Express's default, reached through next(err), closes the response.
    app.use((err, req, res, next) => { res.end(); });

    const port = await freePort();
    const server = app.listen(port, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));

    try {
        const res = await new Promise((resolve, reject) => {
            const req = http.request({ host: '127.0.0.1', port, path: '/boom' }, (r) => {
                let text = '';
                r.setEncoding('utf8');
                r.on('data', (c) => { text += c; });
                r.on('end', () => resolve({ status: r.statusCode, text }));
            });
            req.on('error', reject);
            req.end();
        });

        assert.equal(handedOff?.message, 'the original fault',
            'the ORIGINAL error is handed to next(), not a second one raised by the handler');
        // The status is whatever the route had already sent; the handler cannot change it.
        assert.equal(res.status, 200, 'the already-sent status is left alone');
        assert.match(res.text, /partial output/, 'and the partial output is not replaced');
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

// ===========================================================================
// 4. NOTHING LEAKS, AT ANY REACHABLE STATUS
// ===========================================================================

test('the 421 HIDES its theme picker, and no other status does - the scoping asserted both ways', async () => {
    // THE FINDING THE FIX ADDRESSES. The 421 is served precisely because the host was refused, so
    // every same-host URL is refused with it: MEASURED, `/settings/theme` returns 421 on the
    // rejected host, so the picker rendered, populated with all 23 options, and submitting it did
    // nothing - a second dead end for a reader already confused by the first.
    //
    // BOTH DIRECTIONS, because the point is that the flag is SCOPED to one status: hiding the
    // picker on a 404 or 500 would be wrong, since those hosts are accepted and the picker works
    // there.
    const rejected = await request({ path: '/', host: 'wrong-host.example', headers: { accept: 'text/html' } });
    const notFound = await request({ path: '/definitely-not-a-page', headers: { accept: 'text/html' } });

    // THE COUNT IS THE ASSERTION, not mere absence: the picker's own markup names `theme-picker`.
    const pickerCount = (text) => (text.match(/theme-picker/g) ?? []).length;

    assert.equal(pickerCount(rejected.text), 0, 'the 421 renders ZERO theme pickers');
    assert.equal(pickerCount(notFound.text), 1, 'a 404 on an accepted host renders EXACTLY ONE');
});

test('the picker WORKS on a host that is accepted, which is why it is only hidden on the 421', async () => {
    // The reason hiding is scoped rather than global: on an accepted host the round-trip succeeds,
    // so removing the control everywhere would take away a working feature. The 421 cannot offer it
    // because the form posts to `/settings/theme`, refused by the same guard.
    const theme = await request({ path: '/settings/theme?to=dracula', headers: { accept: 'text/html' } });
    assert.equal(theme.status, 302, 'the theme route round-trips on an accepted host');

    // And on the rejected host the same route is refused, which is the fact the flag encodes.
    const refused = await request({ path: '/settings/theme?to=dracula', host: 'wrong-host.example', headers: { accept: 'text/html' } });
    assert.equal(refused.status, 421, 'the theme route is refused on the rejected host, so the picker could not work');
});

test('the 421 names NEITHER the offending host NOR the allowed one', async () => {
    // The page a visitor reaches by using a host the installation does not answer for. Naming the
    // allowed list would hand out the configuration; naming the host they used would echo input.
    const offending = 'wrong-host.example';
    const res = await request({ paths: undefined, path: '/', host: offending, headers: { accept: 'text/html' } });

    assert.equal(res.status, 421, 'a wrong host is refused with 421');
    assert.equal(res.text.includes(ALLOWED_HOST), false, 'the allowed host is not named');
    assert.equal(res.text.includes(offending), false, 'nor the host that was sent');
    assert.equal(/ALLOWED_HOST/.test(res.text), false, 'nor the variable name');
});

test('the 421 log names the host and the allowed list, so an operator can act', async () => {
    // The other half of the 421 decision: the page is silent and the LOG is not. Without this the
    // operator has the same blank wall the visitor does.
    const booted = await bootWith();
    try {
        const res = await booted.get({
            method: 'GET', path: '/',
            headers: { host: 'wrong-host.example', 'x-forwarded-proto': 'https', accept: 'text/html' }
        });
        assert.equal(res.status, 421);
        assert.match(booted.output(), /rejected request for host "wrong-host\.example"/,
            'the log names the host it received');
        assert.ok(booted.output().includes(ALLOWED_HOST), 'and the list it expects');
    } finally {
        await booted.kill();
    }
});

test('the 404 does not echo the failing path or a query parameter', async () => {
    // THE ONE PLACE A PATH LEGITIMATELY APPEARS: the theme picker's form carries the current URL in
    // a hidden `next` field, on every page that has the picker, so a bare "contains no path" is
    // false for the whole app and would prove nothing. The assertion is therefore that the ERROR
    // does not echo the failing path - checked by removing the legitimate round-trip field first.
    const res = await request({ path: '/a/path/that/does/not/exist?token=SECRET', headers: { accept: 'text/html' } });

    assert.equal(res.status, 404);
    // Drop the theme picker's `next` value, which is the only legitimate place the URL travels.
    const errorBody = res.text.replace(/value="[^"]*"/g, 'value=""');
    assert.equal(errorBody.includes('/a/path/that/does/not/exist'), false,
        'the failing path is not in the error page itself');
    assert.equal(errorBody.includes('SECRET'), false, 'nor a query parameter');
    assert.equal(res.text.includes(ALLOWED_HOST), false, 'nor the host');
});

// ===========================================================================
// 5. THE STATUS CODES STAY CORRECT - a pretty page at 200 is worse than bare text
// ===========================================================================

test('every reachable status is served as itself', async () => {
    const wrongHost = await request({ path: '/', host: 'wrong-host.example', headers: { accept: 'text/html' } });
    const notFound = await request({ path: '/definitely-not-a-page', headers: { accept: 'text/html' } });
    const malformed = await malformedBodyRequest({ accept: 'text/html' });
    const oversized = await oversizedBodyRequest({ accept: 'text/html' });
    const genuine = await genuineThrow(undefined);

    assert.equal(wrongHost.status, 421, '421 for a refused host');
    assert.equal(notFound.status, 404, '404 for a missing route');
    assert.equal(malformed.status, 400, '400 for a malformed body, which is the sender\'s error');
    assert.equal(oversized.status, 413, '413 for an oversized body');
    assert.equal(genuine.status, 500, '500 for a genuine uncaught throw');

    // None of them is 200, which is the failure a pretty page invites.
    for (const [label, res] of [['421', wrongHost], ['404', notFound], ['400', malformed], ['413', oversized], ['500', genuine]]) {
        assert.notEqual(res.status, 200, `${label} must not be 200`);
    }
});

// ===========================================================================
// 6. THE API CONTRACT IS UNCHANGED
// ===========================================================================

test('/api/chat with no token still returns 403 JSON - the questionnaire must not break', async () => {
    // The test that matters most: a change to how errors are rendered must not change the shape a
    // participant's client parses. Even asking for HTML, the API answers JSON.
    //
    // THE SHAPE IS `{ status, content }` FOR THIS ROUTE, not `{ error }` - the chat route was
    // written before the module existed and uses its own body, which is a contract its client
    // already reads. So the assertion is on the shape THIS route has, not on the other one's.
    const res = await request({
        method: 'POST', path: '/api/chat',
        body: { messages: [] },
        headers: { accept: 'text/html' } // deliberately NOT asking for JSON
    });

    assert.equal(res.status, 403, 'the gate still returns 403');
    assert.match(res.contentType, /^application\/json/, 'and still as JSON, whatever Accept said');
    const parsed = JSON.parse(res.text);
    assert.equal(parsed.status, 'error', 'the chat route keeps its `status: error` shape');
    assert.equal(typeof parsed.content, 'string', 'and its `content` message');
});

test('/api/score with no token still returns 403 JSON', async () => {
    const res = await request({
        method: 'POST', path: '/api/score',
        body: { audit: { workflows: [] } },
        headers: { accept: 'application/json' }
    });

    assert.equal(res.status, 403);
    assert.match(res.contentType, /^application\/json/);
    const parsed = JSON.parse(res.text);
    assert.equal(typeof parsed.error, 'string');
});

// ===========================================================================
// 7. REACHABILITY - what is not reachable, said rather than claimed
// ===========================================================================

test('the statuses REACHABLE THROUGH THE ERROR PAGE are the ones I measured, not the ones claimed', () => {
    // ASSERT THE SET I FIND. The earlier version asserted `['404','421','500']`, which the fix
    // falsified: `err.status` now travels, so a 400 and a 413 reach this page too. The set below is
    // what the code does - a literal `sendError(req, res, N)` call site for 421/404/500, plus the
    // status resolution that lets a middleware's status through.
    const source = fs.readFileSync(path.join(PROJECT_ROOT(), 'server.js'), 'utf8');
    const literal = [...source.matchAll(/sendError\(req, res, (\d+)\)/g)].map((m) => m[1]);

    // The literal call sites, plus the error handler's resolved status. The set is asserted as I
    // measured it rather than as the comment claims.
    assert.deepEqual([...new Set(literal)].sort(), ['404', '421'],
        'the literal call sites are 421 and 404 - 500 comes through the error handler below');
    assert.match(source, /sendError\(req, res, Number\(err\.status\) \|\| 500\)/,
        'the error handler resolves a middleware status, so 400, 413 and 500 are reachable through it');
});

test('the statuses with NO caller stay unreachable, and the reason is recorded', async () => {
    // 403 and 502 have no call site at all: the console's 403 renders `admin-no-access.ejs`, the
    // API's 403 and 502 return JSON, and 502 is not emitted here. The comment in lib/error-page.js
    // records why the entries stay, and this checks the FACT rather than the reasoning.
    const source = fs.readFileSync(path.join(PROJECT_ROOT(), 'server.js'), 'utf8');
    for (const status of ['403', '502']) {
        assert.equal(new RegExp(`sendError\\(req, res, ${status}\\)`).test(source), false,
            `${status} has no sendError call site`);
    }

    // And the console 403 really renders its own page, which is why the error page's 403 is dead.
    const consoleSource = fs.readFileSync(path.join(PROJECT_ROOT(), 'lib', 'auth', 'console.js'), 'utf8');
    assert.match(consoleSource, /status\(403\)\.render\('admin-no-access'/, 'the console 403 renders admin-no-access');

    // Confirmed through a real request that a plain 403 does NOT produce the error page.
    const res = await request({ method: 'POST', path: '/api/chat', body: { messages: [] }, headers: { accept: 'text/html' } });
    assert.equal(res.status, 403);
    assert.doesNotMatch(res.text, /<!DOCTYPE html>/, 'a 403 is JSON, not the error page');
});

/** The project root, as an absolute path. */
function PROJECT_ROOT() {
    return path.join(__dirname, '..');
}
