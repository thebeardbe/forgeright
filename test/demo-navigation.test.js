/**
 * The demo link's navigation rule, and the two things it must not disturb.
 *
 * `/admin/demo` MINTS A READ-ONLY SESSION FROM A GET, and the demo token is in README.md. A page on a
 * sibling subdomain could therefore navigate a signed-out visitor there and change who their browser is
 * signed in as: narrow login CSRF.
 *
 * The POST guard skips safe methods, so this route checks for itself, through
 * `checkNavigationOrigin` in lib/auth/csrf.js. That function shares `headerValue` with the POST guard.
 *
 * WHAT IS ALLOWED, measured against a real server (see the measurements in the commit that added this
 * file), and each case is pinned below:
 *
 *   Sec-Fetch-Site: none          ALLOWED   a typed URL or a bookmark
 *   Sec-Fetch-Site: same-origin   ALLOWED   a link on this app's own pages
 *   no header at all              ALLOWED   an old browser
 *   Sec-Fetch-Site: same-site     REFUSED   a link from another *.bunkens.be subdomain
 *   Sec-Fetch-Site: cross-site    REFUSED   a link from another site
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
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const SERVER = path.join(PROJECT_ROOT, 'server.js');

const ALLOWED_HOST = 'allowed.example.test';
const DEMO_TOKEN = 'demo-token-for-the-navigation-rule-0001';

const STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-nav-'));
process.env.STORE_DIR = STORE_DIR;
process.env.SESSION_SECRET = 'n'.repeat(64);

const store = await import('../lib/store/index.js');
const csrf = await import('../lib/auth/csrf.js');

const demoOrg = store.createOrganisation('Navigation rule demo org');

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
 * A distinct forwarded address per request.
 *
 * The SIGN-IN route is rate limited to 10 per IP per 15 minutes, and this file needs a session of its
 * own for the POST-guard test. TRUST_PROXY is 127.0.0.1 and the test connects from loopback, so the
 * header is believed and each request is a separate client. The limit is not bypassed: the app really
 * is reading a different address. Same fixture as test/provision.test.js, for the same reason.
 */
let clientCounter = 0;
const nextClientAddress = () => {
    clientCounter += 1;
    return `10.8.${Math.floor(clientCounter / 250) % 250}.${(clientCounter % 250) + 1}`;
};

function request({ method = 'GET', urlPath = '/', form, headers = {}, cookie, port = PORT, host = ALLOWED_HOST } = {}) {
    const payload = form === undefined ? undefined : new URLSearchParams(form).toString();
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port,
            path: urlPath,
            method,
            headers: {
                host,
                'x-forwarded-proto': 'https',
                ...(payload !== undefined
                    ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(payload) }
                    : {}),
                ...(cookie ? { cookie } : {}),
                'x-forwarded-for': nextClientAddress(),
                ...headers
            }
        }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { text += chunk; });
            res.on('end', () => resolve({
                status: res.statusCode,
                text,
                location: res.headers.location || null,
                setCookie: res.headers['set-cookie'] || []
            }));
        });
        req.on('error', reject);
        if (payload !== undefined) req.write(payload);
        req.end();
    });
}

/** Starts a server and waits for it to answer. Returns the child and a log reader. */
async function startServer(env) {
    const log = { text: '', exited: false };
    const child = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => { log.text += chunk; });
    child.stderr.on('data', (chunk) => { log.text += chunk; });
    child.once('exit', () => { log.exited = true; });

    const deadline = Date.now() + 10000;
    for (;;) {
        // A SERVER THAT EXITS IS REPORTED AT ONCE. Startup can stop on a bad configuration, and polling a
        // dead process until a deadline makes the hook hang for as long as the harness allows, which looks
        // like a slow test rather than a finding.
        if (log.exited) throw new Error(`server exited instead of starting:\n${log.text}`);
        try {
            const res = await request({ urlPath: '/healthz', port: Number(env.PORT) });
            if (res.status === 200) break;
        } catch {
            // not up yet
        }
        if (Date.now() > deadline) throw new Error(`server did not start:\n${log.text}`);
        await new Promise((r) => setTimeout(r, 50));
    }
    return { child, log, port: Number(env.PORT) };
}

async function stopServer(child) {
    if (!child || child.killed) return;
    await new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill('SIGTERM');
        const force = setTimeout(() => { child.kill('SIGKILL'); }, 3000);
        force.unref();
    });
}

const baseEnv = (port, extra = {}) => ({
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: 'test',
    PORT: String(port),
    HOST: '127.0.0.1',
    BASE_PATH: '',
    ALLOWED_HOST: `${ALLOWED_HOST},127.0.0.1,localhost`,
    TRUST_PROXY: '127.0.0.1',
    SESSION_SECRET: 'n'.repeat(64),
    STORE_DIR,
    AI_PROVIDER: 'mock',
    MAIL_SENDER: 'console',
    PUBLIC_BASE_URL: `https://${ALLOWED_HOST}`,
    ...extra
});

/**
 * The demo server for this file: the demo configured against a real organisation, so the route is
 * REGISTERED. Without that the route answers 404 and every test below would pass for the wrong reason.
 */
let demoServer;
let demoPort;
let demoOutput = '';

before(async () => {
    demoPort = await freePort();
    demoServer = await startServer(baseEnv(demoPort, {
        // The demo route only registers when the organisation exists, so the id is a real one.
        DEMO_LOGIN: '1',
        DEMO_LOGIN_ORG: demoOrg.id,
        DEMO_LOGIN_TOKEN: DEMO_TOKEN
    }));
    demoOutput = () => demoServer.log.text;
});

after(async () => {
    await stopServer(demoServer.child);
    store.closeAll();
    fs.rmSync(STORE_DIR, { recursive: true, force: true });
});

const demoPath = `/admin/demo?token=${DEMO_TOKEN}`;
const demoRequest = (headers = {}, opts = {}) => request({
    urlPath: demoPath, headers, port: demoPort, ...opts
});

test('the demo route is REGISTERED, or every test below would pass on a 404', async () => {
    // The negative control for the whole file. An unregistered demo route answers 404 to everything,
    // and a 404 is neither a 302 nor a 403, so this is what tells the two apart.
    const registered = demoOutput() || '';
    assert.equal(/NOT registered/.test(registered), false, 'the route is not refused at startup');

    const res = await demoRequest({ 'Sec-Fetch-Site': 'none' });
    assert.equal(res.status, 302, 'and it answers the allowed case with a redirect');
});

// ===========================================================================
// 1. THE NAVIGATION RULE
// ===========================================================================

test('Sec-Fetch-Site: none is ALLOWED - how the owner opens the link he sends to clients', async () => {
    // READ THIS BEFORE "CLOSING" IT. `none` looks like the most foreign value possible, and it is the
    // one case this route MUST allow.
    //
    // MEASURED in Chromium: clicking a link in a mail client and pasting the address into the bar BOTH
    // arrive as `Sec-Fetch-Site: none`. The owner publishes this demo link in README.md and opens it to
    // show the product, so refusing `none` breaks the single thing this route exists for. The attack
    // this rule stops arrives as `same-site`, from a sibling subdomain, and is refused below.
    //
    // A future reader who sees `none` allowed and "fixes" it has re-broken the owner's link, which is
    // why this comment is here rather than in a commit message.
    const res = await demoRequest({ 'Sec-Fetch-Site': 'none' });

    assert.equal(res.status, 302, 'a typed URL or a bookmark opens the demo');
    assert.equal(res.location, '/admin', 'and redirects into the console');
    assert.ok(res.setCookie.length > 0, 'setting a session, which is the point of the link');
});

test('Sec-Fetch-Site: same-origin is ALLOWED - a link on this app\'s own pages', async () => {
    const res = await demoRequest({ 'Sec-Fetch-Site': 'same-origin' });

    assert.equal(res.status, 302);
    assert.ok(res.setCookie.length > 0, 'and it sets a session');
});

test('NO Sec-Fetch-Site header is ALLOWED - an old browser', async () => {
    // The same decision as the POST guard: an old browser sends no header, and refusing it locks out a
    // legitimate visitor. An attacker gains nothing, because a page on a sibling subdomain runs in a
    // current browser, and current browsers send this header on every navigation.
    const res = await demoRequest({});

    assert.equal(res.status, 302);
    assert.ok(res.setCookie.length > 0, 'and it sets a session');
});

test('Sec-Fetch-Site: same-site is REFUSED - the sibling subdomain, which is the attack', async () => {
    // THE DEFECT ITSELF. A page on another *.bunkens.be site navigates a signed-out visitor here, and
    // the browser labels that navigation `same-site`. SameSite=Lax does not stop it.
    const res = await demoRequest({ 'Sec-Fetch-Site': 'same-site' });

    assert.equal(res.status, 403, 'refused');
    assert.equal(res.location, null, 'with no redirect');
});

test('Sec-Fetch-Site: cross-site is REFUSED', async () => {
    const res = await demoRequest({ 'Sec-Fetch-Site': 'cross-site' });

    assert.equal(res.status, 403);
    assert.equal(res.location, null);
});

test('a REFUSED demo GET mints NO session - the bug behind the bug', async () => {
    // A REFUSAL THAT STILL SETS A COOKIE IS NOT A REFUSAL. The session is minted a few lines above the
    // cookie, so a check placed after `createSession` would answer 403 AND sign the visitor in, which is
    // worse than allowing it: the page would look refused while the session was live.
    //
    // A COUNT, not zero: the allowed cases above have already minted sessions, and asserting an
    // absolute zero would make this test depend on the order the other tests ran in.
    const countDemoSessions = () => {
        const db = new DatabaseSync(path.join(STORE_DIR, 'admin.db'), { readOnly: true });
        try {
            return db.prepare('SELECT COUNT(*) AS n FROM demo_session').get().n;
        } finally {
            db.close();
        }
    };
    const sessionsBefore = countDemoSessions();

    for (const headers of [{ 'Sec-Fetch-Site': 'same-site' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
        const res = await demoRequest(headers);

        assert.equal(res.status, 403, `${JSON.stringify(headers)} is refused`);
        assert.deepEqual(res.setCookie, [],
            `and sets NO cookie at all, not even a clearing one (got ${JSON.stringify(res.setCookie)})`);
    }

    // AND IN THE DATABASE. A cookie-less refusal is not enough if the session row was already created,
    // because the next request carrying a valid value would find it.
    assert.equal(countDemoSessions(), sessionsBefore,
        'a refused demo GET recorded no session either');
});

/** Waits for the child's log to contain a line, because stdout is flushed asynchronously. */
async function waitForLog(predicate, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const match = predicate(demoServer.log.text);
        if (match) return match;
        if (Date.now() > deadline) return null;
        await new Promise((r) => setTimeout(r, 20));
    }
}

test('a refused demo GET is LOGGED with the reason, so an operator can see it', async () => {
    // POLLED, not sliced from a byte offset: the child's stdout arrives on its own schedule, so a slice
    // taken straight after the request is empty about half the time. Reading the offset was the flake.
    const before = demoServer.log.text.length;
    await demoRequest({ 'Sec-Fetch-Site': 'same-site' });

    const seen = await waitForLog((text) =>
        /Sec-Fetch-Site "same-site" is not a navigation from here/.test(text));
    assert.ok(seen, `the refusal was logged (log so far:\n${demoServer.log.text.slice(before)})`);
    assert.match(demoServer.log.text, /\[demo\] refused a demo link opened from elsewhere/,
        'and it is logged as a refused demo link');
});

// ===========================================================================
// 1b. THE TWO COMPARISONS CANNOT DRIFT
// ===========================================================================

test('checkNavigationOrigin: `none` is allowed and the two foreign values are not', () => {
    // The function stated on its own, so its rule is pinned separately from the route that uses it.
    assert.deepEqual(csrf.checkNavigationOrigin({ headers: { 'sec-fetch-site': 'none' } }), { ok: true });
    assert.deepEqual(csrf.checkNavigationOrigin({ headers: { 'sec-fetch-site': 'same-origin' } }), { ok: true });
    assert.deepEqual(csrf.checkNavigationOrigin({ headers: {} }), { ok: true }, 'no header');

    assert.equal(csrf.checkNavigationOrigin({ headers: { 'sec-fetch-site': 'same-site' } }).ok, false);
    assert.equal(csrf.checkNavigationOrigin({ headers: { 'sec-fetch-site': 'cross-site' } }).ok, false);
});

test('the two comparisons CANNOT DRIFT: they agree on every value that is not a deliberate difference', () => {
    // THE DRIFT PROOF. `headerValue` is NOT exported, so "both call the same helper" cannot be asserted
    // by reading the module from outside. What can be asserted is the CONSEQUENCE: the two functions
    // read the same header through the same parser and must agree wherever their rules do.
    //
    // The one deliberate difference is `none`, which a NAVIGATION may carry and a POST may not. And
    // `Origin`, which the POST guard reads and the navigation check ignores, because a navigation's
    // Origin is not a signal the browser sends for a top-level GET.
    //
    // If someone re-implemented either parser, empty strings, repeated headers or a whitespace value
    // would start to disagree. Those are the inputs below that a hand-written reader gets wrong.
    const SAME = [
        { 'sec-fetch-site': 'same-origin' },
        { 'sec-fetch-site': 'same-site' },
        { 'sec-fetch-site': 'cross-site' },
        { 'sec-fetch-site': 'cross-origin' },
        { 'sec-fetch-site': 'Same-Origin' },      // case: both must read the raw value as given
        { 'sec-fetch-site': ' same-origin' },     // whitespace is NOT trimmed by headerValue
        { 'sec-fetch-site': '' },                 // empty means absent
        { 'sec-fetch-site': ['cross-site'] },     // a repeated header reads as its first value
        { 'sec-fetch-site': ['same-origin', 'cross-site'] }
    ];

    const post = { method: 'POST', headers: {} };
    const asPost = (headers) => csrf.checkRequestOrigin({ ...post, headers }, 'https://console.test');
    const asNavigation = (headers) => csrf.checkNavigationOrigin({ headers });

    const disagreements = SAME.filter((headers) => asPost(headers).ok !== asNavigation(headers).ok);

    assert.deepEqual(disagreements, [],
        `the two comparisons disagree on: ${JSON.stringify(disagreements)}`);

    // And both must REFUSE the empty string as absent-but-then-not-foreign only if they agree, which the
    // loop above already states. The specific values that matter are asserted once more, plainly.
    assert.equal(asPost({ 'sec-fetch-site': '' }).ok, true, 'POST guard: an empty header is absent');
    assert.equal(asNavigation({ 'sec-fetch-site': '' }).ok, true, 'navigation: the same');
});

test('the ONE deliberate difference between the two: `none`', () => {
    // Stated as its own test, so a future change that makes the POST guard accept `none` (a real
    // weakening: a cross-site POST with `Sec-Fetch-Site: none` is not a same-origin POST) fails here.
    const headers = { 'sec-fetch-site': 'none' };

    assert.equal(csrf.checkNavigationOrigin({ headers }).ok, true,
        'a NAVIGATION with `none` is allowed, and must stay allowed');
    assert.equal(csrf.checkRequestOrigin({ method: 'POST', headers }, 'https://console.test').ok, false,
        'a POST with `none` is refused');
});

test('the helper is shared: one parser, so an odd header value is read identically', () => {
    // The sharing is inferred from the source (both call the module-private `headerValue`). What is
    // tested here is the behaviour that sharing produces, on the inputs a second parser would get wrong.
    for (const headers of [
        { 'sec-fetch-site': ['cross-site', 'same-origin'] },
        { 'sec-fetch-site': ['same-origin'] },
        { 'sec-fetch-site': '' },
        { 'sec-fetch-site': 'cross-site' }
    ]) {
        const nav = csrf.checkNavigationOrigin({ headers });
        assert.equal(typeof nav.ok, 'boolean',
            `a repeated or empty header is read without throwing: ${JSON.stringify(headers)}`);
    }

    // A repeated header uses its FIRST value, in both. `['same-origin', 'cross-site']` is allowed by
    // both, which a naive `String(array)` would turn into "same-origin,cross-site" and refuse.
    assert.equal(csrf.checkNavigationOrigin({ headers: { 'sec-fetch-site': ['same-origin', 'cross-site'] } }).ok,
        true, 'the first value is the one read');
});

// ===========================================================================
// 2. THE POST GUARD IS UNCHANGED BY THIS
// ===========================================================================

test('a console write from another origin is still 403, and the store did not change', async () => {
    // ONE ROUTE ONLY. The nine-route coverage lives in test/csrf-cross-site.test.js; this is the check
    // that the navigation change did not move the POST guard underneath it.
    const before = store.getOrganisation(demoOrg.id).name;

    const res = await request({
        method: 'POST',
        urlPath: '/admin/organisation/name',
        form: { name: 'CSRF-OWNED' },
        headers: { Origin: 'https://evil.bunkens.be' },
        port: demoPort
    });

    assert.equal(res.status, 403, 'refused');
    assert.equal(store.getOrganisation(demoOrg.id).name, before, 'and the name is unchanged');
});

test('and a same-origin console write still works', async () => {
    // Needs a session, which the demo link supplies.
    const demo = await demoRequest({ 'Sec-Fetch-Site': 'none' });
    const pair = (demo.setCookie[0] || '').split(';')[0];
    assert.ok(pair, 'the demo session cookie was set');

    // A DEMO SESSION IS READ-ONLY, so this asserts the POST guard ALLOWS it rather than that the write
    // happened: the refusal, if any, must not be the provenance one.
    const res = await request({
        method: 'POST',
        urlPath: '/admin/organisation/name',
        form: { name: 'Same origin rename' },
        cookie: pair,
        headers: { 'Sec-Fetch-Site': 'same-origin', Origin: `https://${ALLOWED_HOST}` },
        port: demoPort
    });

    assert.equal(/did not come from this site/i.test(res.text), false,
        'the POST guard did not refuse this request');
});

// ===========================================================================
// 3. THE FLAKE FIX: the fixture moved, the bound did not
// ===========================================================================

test('the sign-in rate limit is STILL ENFORCED: from one address, the 11th is refused', async () => {
    // THE FIXTURE MOVED, THE BOUND DID NOT. test/provision.test.js now sends a distinct
    // `x-forwarded-for` per POST, which is only honest if the limiter still counts. IP_LIMIT is 10 per
    // 15 minutes, read from lib/auth/rate-limit.js.
    //
    // ITS OWN SERVER, because this test deliberately spends one address's whole budget and must not do
    // that to the server the tests above share.
    const port = await freePort();
    const server = await startServer(baseEnv(port, {
        PUBLIC_BASE_URL: `https://${ALLOWED_HOST}`
    }));

    try {
        const ONE_ADDRESS = { 'x-forwarded-for': '203.0.113.7' };
        const statuses = [];
        for (let i = 1; i <= 11; i += 1) {
            const res = await request({
                method: 'POST',
                urlPath: '/admin/login',
                form: { email: `rate-limit-${i}@csrf.test` },
                headers: ONE_ADDRESS,
                port
            });
            statuses.push(res.status);
        }

        assert.deepEqual(statuses.slice(0, 10), Array(10).fill(200),
            `the first 10 from one address are answered (got ${statuses.join(',')})`);
        assert.equal(statuses[10], 429,
            `the 11th from the SAME address is refused (got ${statuses.join(',')})`);

        // And logged, so an operator sees why.
        assert.match(server.log.text, /\[auth\] login request rate-limited/, 'the refusal is logged');
    } finally {
        await stopServer(server.child);
    }
});

test('and a distinct address per request is not limited, which is what the provision fix relies on', async () => {
    // The other half: 12 POSTs from 12 addresses all answer 200, so the fixture change really does keep
    // each request in its own bucket rather than the limit having been raised or removed.
    const port = await freePort();
    const server = await startServer(baseEnv(port));

    try {
        const statuses = [];
        for (let i = 1; i <= 12; i += 1) {
            const res = await request({
                method: 'POST',
                urlPath: '/admin/login',
                form: { email: `distinct-${i}@csrf.test` },
                headers: { 'x-forwarded-for': `198.51.100.${i}` },
                port
            });
            statuses.push(res.status);
        }

        assert.deepEqual(statuses, Array(12).fill(200),
            `12 distinct addresses are all answered (got ${statuses.join(',')})`);
    } finally {
        await stopServer(server.child);
    }
});

// ===========================================================================
// 4. THE 403 SENTENCE
// ===========================================================================

test('the demo refusal explains, and does not accuse the reader', async () => {
    // READ AS A STRANGER WHO FOLLOWED A LINK SOMEONE SENT THEM. They did nothing wrong, and they cannot
    // see a "site" or a header. The sentence must say what to do next, and must not imply they
    // misbehaved.
    const res = await demoRequest({ 'Sec-Fetch-Site': 'cross-site' });

    assert.equal(res.status, 403);
    // PINNED WHOLE, because each half does a job:
    //  "This demo link has to be opened directly, not followed from another site."
    //     -> WHAT HAPPENED, and that it is about how the link was opened rather than about them.
    //  "Paste the address into your browser instead."
    //     -> WHAT TO DO. Concrete, and the one action that works: a pasted address arrives as
    //        Sec-Fetch-Site: none, which is allowed.
    assert.equal(res.text,
        'This demo link has to be opened directly, not followed from another site. '
        + 'Paste the address into your browser instead.',
        'the sentence is plain and actionable');

    // NOT AN ACCUSATION: no words that blame the reader.
    assert.equal(/you (did|violated|must not)|denied|forbidden|unauthori[sz]ed|blocked|suspicious|attack/i
        .test(res.text), false, 'it does not accuse or frighten the reader');

    // AND NOT INTERNAL: no header names, no status codes, no product jargon.
    assert.equal(/sec-fetch|origin|csrf|cookie|header|403/i.test(res.text), false,
        'it names nothing internal');
});

test('the demo refusal is PLAIN TEXT, not the styled no-access page', async () => {
    // A stranger who followed a link sees this. The styled "no access" view is for a signed-in user
    // without the console role, and showing it here would suggest an account problem.
    const res = await demoRequest({ 'Sec-Fetch-Site': 'cross-site' });

    assert.equal(res.status, 403);
    assert.equal(/<html|<body|<!DOCTYPE/i.test(res.text), false, 'no HTML document');
    assert.equal(/<div|<p\b|<h1/i.test(res.text), false, 'no markup at all');
    assert.equal(/no access|not have access|role/i.test(res.text), false,
        'and nothing about roles or accounts, which is not what went wrong');
});

// ===========================================================================
// 5. PUBLIC_BASE_URL UNSET, WHICH NOBODY HAD CHECKED
// ===========================================================================

test('with PUBLIC_BASE_URL unset, the guard compares against http://localhost:PORT', async () => {
    // MEASURED BEFORE THIS TEST WAS WRITTEN, on a server started from a DIRECTORY WITH NO .env (the
    // repository's .env sets PUBLIC_BASE_URL, so it must not be found, or the fallback is never
    // exercised):
    //
    //   PUBLIC_BASE_URL unset, POST Origin http://localhost:<port>   -> 302  ALLOWED
    //   PUBLIC_BASE_URL unset, POST Origin https://<real public>     -> 403  refused
    //   PUBLIC_BASE_URL unset, POST Sec-Fetch-Site: same-origin      -> 302  ALLOWED
    //   PUBLIC_BASE_URL unset, POST no headers                       -> 302  ALLOWED
    //
    // SO THE ANSWER IS NOT "COMPARES AGAINST NOTHING": publicBaseUrl() falls back to
    // `http://localhost:<PORT>`, and the guard compares Origin against THAT. A `same-origin`
    // Sec-Fetch-Site is still accepted, and so is no header at all, so the console keeps working over
    // a current browser. What breaks is the Origin fallback for the REAL host: a browser that sends
    // Origin but no Sec-Fetch-Site against the public hostname is REFUSED.
    const port = await freePort();
    // A working directory with no .env, so dotenv/config finds nothing and the fallback is reached.
    const emptyCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-nocwd-'));
    const env = baseEnv(port);
    delete env.PUBLIC_BASE_URL;

    const log = { text: '', exited: false };
    const child = spawn(process.execPath, [SERVER], { env, cwd: emptyCwd, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => { log.text += chunk; });
    child.stderr.on('data', (chunk) => { log.text += chunk; });
    child.once('exit', () => { log.exited = true; });

    try {
        const deadline = Date.now() + 10000;
        for (;;) {
            // A server that EXITS is reported at once with its output, rather than being polled until the
            // deadline: an unset PUBLIC_BASE_URL that stops startup is a finding, and the message shows it.
            if (log.exited) throw new Error(`server exited instead of starting:\n${log.text}`);
            try {
                const res = await request({ urlPath: '/healthz', port });
                if (res.status === 200) break;
            } catch {
                // not up yet
            }
            if (Date.now() > deadline) throw new Error(`server did not start:\n${log.text}`);
            await new Promise((r) => setTimeout(r, 50));
        }

        // The fallback IS announced, so an operator can see it rather than infer it.
        assert.match(log.text, /PUBLIC_BASE_URL is unset, so this instance assumes http:\/\/localhost:/,
            'the fallback is stated at startup');

        const post = (headers) => request({
            method: 'POST', urlPath: '/admin/organisation/name', form: { name: 'Unset base url' }, headers, port
        });

        const localhost = await post({ Origin: `http://localhost:${port}` });
        assert.equal(localhost.status, 302,
            'the localhost origin the fallback names is ALLOWED, so the comparison is not against nothing');

        const realHost = await post({ Origin: `https://${ALLOWED_HOST}` });
        assert.equal(realHost.status, 403,
            'and the real public origin is REFUSED, which is the cost of leaving the variable unset');

        // The two paths that keep a current browser working, and they are why this is a caveat rather
        // than an outage.
        const sameOrigin = await post({ 'Sec-Fetch-Site': 'same-origin' });
        assert.equal(sameOrigin.status, 302, 'Sec-Fetch-Site: same-origin is still accepted');

        const noHeaders = await post({});
        assert.equal(noHeaders.status, 302, 'and no headers at all is still accepted');

        // MEASURED, from the log: the guard names the origin it compared against.
        assert.match(log.text, new RegExp(`is not this app \\(http://localhost:${port}\\)`),
            'the refusal log names localhost as the expected origin, not a real host');
    } finally {
        await stopServer(child);
        fs.rmSync(emptyCwd, { recursive: true, force: true });
    }
});

test('the demo route ignores Origin and PUBLIC_BASE_URL entirely, so unset does not affect it', async () => {
    // A DIFFERENCE WORTH PINNING: checkNavigationOrigin reads Sec-Fetch-Site ONLY. A foreign Origin with
    // no Sec-Fetch-Site therefore still opens the demo, because on a top-level navigation the browser
    // does not send a useful Origin. This is measured, not assumed:
    //
    //   demo, foreign Origin, NO Sec-Fetch-Site  -> 302
    //
    // It is why leaving PUBLIC_BASE_URL unset cannot break the demo link, and it is a deliberate
    // asymmetry with the POST guard rather than an oversight.
    const res = await demoRequest({ Origin: 'https://evil.bunkens.be' });

    assert.equal(res.status, 302, 'a foreign Origin with no Sec-Fetch-Site still opens the demo');
});

// ===========================================================================
// 6. THE DEMO STORE IS UNTOUCHED
// ===========================================================================

test('the demo scores are unchanged: 68, 58, 58, 58, 58, 38, 38', () => {
    // Read from a COPY in /tmp, opened read-only. data/demo is never opened for writing.
    const copyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-nav-demo-'));
    try {
        fs.cpSync(path.join(PROJECT_ROOT, 'data', 'demo'), copyDir, { recursive: true });
        const db = new DatabaseSync(path.join(copyDir, 'orgs', 'example-ltd-demo.db'), { readOnly: true });
        try {
            const scores = db.prepare('SELECT score FROM process_score WHERE is_current = 1 ORDER BY score DESC')
                .all().map((row) => row.score);
            assert.deepEqual(scores, [68, 58, 58, 58, 58, 38, 38]);
        } finally {
            db.close();
        }
    } finally {
        fs.rmSync(copyDir, { recursive: true, force: true });
    }
});
