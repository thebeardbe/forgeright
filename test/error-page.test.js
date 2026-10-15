/**
 * The error pages: the format decision, the 500 handler, and what must not leak.
 *
 * TWO RULES THIS FILE PINS:
 *
 *   - THE `Accept` HEADER DECIDES THE FORMAT. A client talks to `/api/chat` with `fetch` and would
 *     fail PARSING JSON if a page came back, so a 500 would surface as a syntax error.
 *   - NOTHING FROM THE REQUEST IS RENDERED. Naming the allowed hosts would hand out the
 *     configuration; naming the error message or a path would leak internals.
 *
 * EVERY REQUEST HERE IS REAL: the server listens on import with no app factory, so it is spawned
 * as a child process on a free port and exercised over HTTP.
 *
 * A NOTE ON ONE ASSERTION BEING A FALSE FRIEND. The page embeds a stylesheet and a script partial
 * carrying build comments that mention `lib/palettes.js`, so "the response contains no file path"
 * is FALSE for every page. The leak tests therefore assert the ABSENCE OF THE ERROR'S OWN CONTENT -
 * the message, the stack frames, the file the throw came from.
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
        // An EMPTY string is PRESENT, so dotenv leaves it alone, holding the demo gate closed against
        // an untracked .env with DEMO_LOGIN=1. See test/demo-login.test.js.
        DEMO_LOGIN: '',
        DEMO_LOGIN_ORG: '',
        DEMO_LOGIN_TOKEN: '',
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
 * `host` is overridden to exercise the 421, and `rawBody` for a body that is not valid JSON.
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
    // The decision table, through a real request. A JSON client must never receive a page, and the
    // status must not be traded for the format.
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
    // A real client sends a list with quality values, so the check is `includes` rather than
    // equality. The reasoning is checked: a media type in the middle of a list, with parameters and
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
    // A caller that names `application/json` at all is a program that will try to parse the body, so
    // a page would produce a parse error instead of the error it asked about. The quality value is
    // deliberately not read; PINNED SO A FUTURE READER DOES NOT "FIX" IT INTO A q-PARSER.
    const res = await request({
        path: '/definitely-not-a-page',
        headers: { accept: 'text/html;q=0.9, application/json;q=0.1' }
    });

    assert.equal(res.status, 404);
    assert.match(res.contentType, /^application\/json/, 'JSON wins despite the lower quality value');
    assert.doesNotMatch(res.text, /<!DOCTYPE html>/, 'no page, because the caller named JSON');

    // HTML named alone still gets the page, so this is not "JSON always".
    const html = await request({ path: '/definitely-not-a-page', headers: { accept: 'text/html;q=0.9' } });
    assert.match(html.contentType, /^text\/html/, 'HTML alone still gets the page');
});

test('a JSON error carries the shape a client parses', async () => {
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
 * THIS IS A CLIENT ERROR, NOT AN UNCAUGHT THROW: a handler that answered 500 would tell the sender
 * "this is a fault on our side" about a request THEY malformed.
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
 * An OVERSIZED JSON body, which `express.json()` rejects with `err.status = 413`: the 256kb limit
 * is exceeded, so the parse never runs and this status travels from a middleware.
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
 * No route throws uncaught, so this cannot be reached through a real request: the handler body is
 * read OUT OF server.js and mounted on a two-route app, which is as close as an offline test can
 * come. `status` is what the thrown error carries.
 *
 * THE RESOLUTION EXPRESSION IS READ FROM server.js AND EXECUTED, not copied, so a duplicated
 * expression cannot drift from the real one; the source assertion below proves it found the real
 * thing rather than matching nothing.
 */

/**
 * The status resolution, lifted verbatim from server.js's error middleware.
 *
 * Returns `(err) => status`. It throws if the block cannot be found, so a rename in server.js
 * fails loudly rather than silently testing a stale copy.
 */
function statusResolverFromServer() {
    const source = fs.readFileSync(path.join(PROJECT_ROOT(), 'server.js'), 'utf8');

    // If this ever fails to match, the fixture is testing nothing and must say so rather than run a copy.
    const match = source.match(/const rawStatus = [\s\S]*?\n    return sendError\(req, res, status\);/);
    assert.notEqual(match, null,
        'server.js still resolves an error status through `const rawStatus = ... return sendError(req, res, status)`');

    assert.match(source, /if \(res\.headersSent\) return next\(err\);/, 'the handler still has the headersSent hand-off');

    // EXECUTED, with the last line turned into a return so the resolved status comes back.
    const body = match[0].replace('return sendError(req, res, status);', 'return status;');
    // eslint-disable-next-line no-new-func
    return new Function('err', 'res', 'sendError', body);
}

async function genuineThrow(status) {
    const express = (await import('express')).default;
    const { sendError } = await import('../lib/error-page.js');
    const resolveStatus = statusResolverFromServer();

    const app = express();
    // THE VIEW ENGINE AND LOCALS ARE CONFIGURED, as server.js does, or `sendError`'s
    // `res.render('error', ...)` throws "No default engine" and the 500 comes from Express's
    // default rather than from the page. `currentUrl` is the one local the theme picker needs that
    // no middleware here supplies.
    app.set('view engine', 'ejs');
    app.set('views', path.join(PROJECT_ROOT(), 'views'));
    app.use((req, res, next) => { res.locals.currentUrl = req.path; next(); });
    app.get('/boom', (req, res, next) => {
        const error = new Error('a genuine fault');
        if (status !== undefined) error.status = status;
        next(error); // the real Express path: an error passed to next()
    });
    app.use((err, req, res, next) => {
        if (res.headersSent) return next(err);
        return sendError(req, res, resolveStatus(err, res, sendError));
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
    const res = await malformedBodyRequest({ accept: 'text/html' });

    assert.equal(res.status, 400, 'a malformed body is a 400, not a 500');
    assert.match(res.contentType, /^text\/html/, 'and a page is sent');
    assert.match(res.text, /request did not make sense|not in the form this site expects/i,
        'the wording is about the request');
    assert.doesNotMatch(res.text, /fault on our side, not yours/i,
        'and does NOT blame the server');
});

test('a GENUINE UNCAUGHT THROW with no status is a 500 - the fixture that name really needs', async () => {
    // Distinct from the malformed body above: nothing the sender did caused this, so it is 500.
    const res = await genuineThrow(undefined);

    assert.equal(res.status, 500, 'an uncaught throw with no status is a 500');
    assert.match(res.text, /Something went wrong here|fault on our side/i, 'and the page says it is ours');
    assert.doesNotMatch(res.text, /\n\s+at [A-Za-z]/, 'with no stack');
});

test('an error status is served as itself WITHIN 400-599, and folded to 500 outside it', async () => {
    // A numeric string coerces and passes; a status below 400 or above 599 is not an error status
    // and folds to 500.
    const served = [[400, 400], [413, 413], [418, 418], [599, 599], ['400', 400]];
    for (const [input, expected] of served) {
        const res = await genuineThrow(input);
        assert.equal(res.status, expected, `err.status ${JSON.stringify(input)} is served as ${expected}`);
    }

    const folded = [200, 301, -1, 99999, 0, NaN, null, 399, 600, 100, Infinity];
    for (const input of folded) {
        const res = await genuineThrow(input);
        assert.equal(res.status, 500, `err.status ${JSON.stringify(input)} folds to 500`);
    }
});

test('a FRACTIONAL status folds to 500 - the case that catches a missing integer test', async () => {
    // A fractional status passes a bare range check and DOES NOT throw:
    //
    //   - `express/lib/response.js`: `res.status(418.5)` warns and assigns the fractional value
    //     unchanged; it does not validate.
    //   - Node's `writeHead` does `statusCode |= 0`, TRUNCATING 418.5 to 418, then checks 100-999.
    //
    // So without the integer test the response is 418 rather than 500: a WRONG STATUS served
    // silently rather than a thrown one.
    for (const fractional of [400.5, 418.5, 499.99]) {
        const res = await genuineThrow(fractional);
        assert.equal(res.status, 500,
            `err.status ${fractional} must fold to 500, not be truncated to a status nobody chose`);
    }
});

test('err.status 200 does NOT serve an error page with a SUCCESS status - the worst invisible failure', async () => {
    // A 2xx is a monitor counting a server fault AS A SUCCESS: invisible, no crash, no log, no
    // alert. The assertion is on the RESULTING STATUS, not on which expression is used.
    for (const successLike of [200, 201, 204, 301, 302, 304]) {
        const res = await genuineThrow(successLike);
        assert.equal(res.status, 500, `err.status ${successLike} must NOT produce a success status`);
        assert.match(res.text, /Something went wrong here|fault on our side/i, 'and it is the 500 page');
    }
});

test('the FLOOR is 400 rather than 100, so an error page cannot carry a 1xx or 2xx or 3xx', async () => {
    // Everything reaching the error middleware is an error (the throw already happened), so a
    // sub-400 status is nonsense; a 3xx would REDIRECT the client somewhere unrelated.
    assert.equal((await genuineThrow(399)).status, 500, '399 is below the floor and folds');
    assert.equal((await genuineThrow(400)).status, 400, '400 is the floor and is served');
    assert.equal((await genuineThrow(599)).status, 599, '599 is the ceiling and is served');
    assert.equal((await genuineThrow(600)).status, 500, '600 is above the ceiling and folds');

    const redirectish = await genuineThrow(302);
    assert.equal(redirectish.status, 500, 'a 3xx becomes a 500, not a redirect');
    assert.equal(redirectish.contentType.includes('text/html'), true, 'and the body is the error page, not a Location header');
});

test('an OVERSIZED body is a 413, with size wording and NOT the 500 message', async () => {
    const res = await oversizedBodyRequest({ accept: 'text/html' });

    assert.equal(res.status, 413, 'an oversized body keeps its 413');
    assert.match(res.text, /too much to send|larger than this site accepts/i, 'the wording is about size');
    assert.doesNotMatch(res.text, /fault on our side, not yours/i, 'and not the server-fault message');
});

test('an error with an UNRECOGNISED status falls back to 500 - the safe direction', async () => {
    // An unrecognised status reads as a server fault: claiming a client error for something we threw
    // would send the sender looking for a mistake they did not make.
    for (const weird of ['teapot', 0, null, NaN, undefined, -1, 99999]) {
        const res = await genuineThrow(weird);
        assert.equal(res.status, 500, `err.status ${JSON.stringify(weird)} falls back to 500`);
    }
});

test('a MALFORMED BODY leaks NOTHING - no message, no stack, no body fragment', async () => {
    // The error is a SyntaxError from `express.json()`, whose message names the body and whose stack
    // names the file.
    //
    // THE MESSAGE IS ASSERTED BY ITS ACTUAL TEXT: on this Node version the parser says "Expected
    // property name or '}' in JSON at position 1", so a check for "Unexpected token" alone would
    // pass while the real message WAS being rendered.
    const res = await malformedBodyRequest({ accept: 'text/html' });

    assert.doesNotMatch(res.text, /Expected property name|Unexpected token|in JSON at position/i,
        'the parser message is not rendered');
    assert.doesNotMatch(res.text, /this is not json/, 'nor the body fragment the message quotes');
    assert.doesNotMatch(res.text, /SyntaxError/i, 'nor the error type');
    assert.doesNotMatch(res.text, /\n\s+at [A-Za-z]/, 'nor a stack frame');
    assert.doesNotMatch(res.text, /express\.json|body-parser|raw-body/i, 'nor the middleware that threw');
});

test('a DISTINCTIVE secret in the error does not reach the response, while the log has it', async () => {
    // About LEAKING, not about which status. The fixture is
    // the malformed body because it echoes a body fragment in its message, which is where a secret
    // travels - so the status is 400 here, and that is stated rather than asserted as 500.
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
        assert.match(booted.output(), /unhandled error/i, 'the log records the error');
        assert.equal(booted.output().includes(secret), true, 'and the log DOES carry the secret, so the page can be silent');
    } finally {
        await booted.kill();
    }
});

test('the error page is the same with NODE_ENV unset - no development exception', async () => {
    // About the ABSENCE OF A DEVELOPMENT BRANCH, not the status: checked with NODE_ENV absent,
    // which is how a mis-set environment could switch a stack trace on.
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
    // The FORMAT decision applies at any status; the fixture is a malformed body, so the status is
    // 400. The client would otherwise surface a page as a syntax error rather than the error.
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
    // The 421 is served because the host was refused, so every same-host URL is refused with it:
    // `/settings/theme` returns 421, so the picker would render and submitting it would do nothing.
    // The flag is therefore SCOPED to one status - hiding it on a 404 would take away a working
    // control, since that host is accepted.
    const rejected = await request({ path: '/', host: 'wrong-host.example', headers: { accept: 'text/html' } });
    const notFound = await request({ path: '/definitely-not-a-page', headers: { accept: 'text/html' } });

    // The COUNT is the assertion, not mere absence: the picker's own markup names `theme-picker`.
    const pickerCount = (text) => (text.match(/theme-picker/g) ?? []).length;

    assert.equal(pickerCount(rejected.text), 0, 'the 421 renders ZERO theme pickers');
    assert.equal(pickerCount(notFound.text), 1, 'a 404 on an accepted host renders EXACTLY ONE');
});

test('the picker WORKS on a host that is accepted, which is why it is only hidden on the 421', async () => {
    // The 421 cannot offer it because the form posts to `/settings/theme`, refused by the same guard.
    const theme = await request({ path: '/settings/theme?to=dracula', headers: { accept: 'text/html' } });
    assert.equal(theme.status, 302, 'the theme route round-trips on an accepted host');

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
    // The page is silent and the LOG is not, or the operator has the same blank wall the visitor does.
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
    // The theme picker's form carries the current URL in a hidden `next` field on every page that
    // has the picker, so a bare "contains no path" is false for the whole app. The assertion is
    // that the ERROR does not echo the failing path, after removing that legitimate field.
    const res = await request({ path: '/a/path/that/does/not/exist?token=SECRET', headers: { accept: 'text/html' } });

    assert.equal(res.status, 404);
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

    for (const [label, res] of [['421', wrongHost], ['404', notFound], ['400', malformed], ['413', oversized], ['500', genuine]]) {
        assert.notEqual(res.status, 200, `${label} must not be 200`);
    }
});

// ===========================================================================
// 6. THE API CONTRACT IS UNCHANGED
// ===========================================================================

test('/api/chat with no token still returns 403 JSON - the questionnaire must not break', async () => {
    // A change to how errors are rendered must not change the shape a participant's client parses:
    // even asking for HTML, the API answers JSON.
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

test('the statuses REACHABLE THROUGH THE ERROR PAGE are the ones the source has, not the ones claimed', async () => {
    // A source assertion, KEPT because a call site cannot be observed by behaviour.
    const source = fs.readFileSync(path.join(PROJECT_ROOT(), 'server.js'), 'utf8');
    const literal = [...source.matchAll(/sendError\(req, res, (\d+)\)/g)].map((m) => m[1]);

    assert.deepEqual([...new Set(literal)].sort(), ['404', '421'],
        'the literal call sites are 421 and 404');

    // THE ERROR HANDLER IS THE THIRD CALLER, and its status is whatever the resolution decides.
    assert.equal((await genuineThrow(undefined)).status, 500, 'the error handler reaches the page with 500');
    assert.equal((await genuineThrow(418)).status, 418, 'and with a middleware status when one is attached');
});

test('the statuses with NO caller stay unreachable, and the reason is recorded', async () => {
    // 403 and 502 have no call site: the console's 403 renders `admin-no-access.ejs`, the
    // API's 403 and 502 return JSON, and 502 is not emitted here.
    const source = fs.readFileSync(path.join(PROJECT_ROOT(), 'server.js'), 'utf8');
    for (const status of ['403', '502']) {
        assert.equal(new RegExp(`sendError\\(req, res, ${status}\\)`).test(source), false,
            `${status} has no sendError call site`);
    }

    const consoleSource = fs.readFileSync(path.join(PROJECT_ROOT(), 'lib', 'auth', 'console.js'), 'utf8');
    assert.match(consoleSource, /status\(403\)\.render\('admin-no-access'/, 'the console 403 renders admin-no-access');

    const res = await request({ method: 'POST', path: '/api/chat', body: { messages: [] }, headers: { accept: 'text/html' } });
    assert.equal(res.status, 403);
    assert.doesNotMatch(res.text, /<!DOCTYPE html>/, 'a 403 is JSON, not the error page');
});

/** The project root, as an absolute path. */
function PROJECT_ROOT() {
    return path.join(__dirname, '..');
}
