/**
 * The analytics exclusion, the notice's promise, and the server-resolved `?tab=`.
 *
 * The questionnaire URL is `/q/<token>` and the participant's 90-day bearer credential is a path
 * segment, so a page view would hand a working interview link to the analytics host.
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
const PROJECT_ROOT = path.join(__dirname, '..');
const SERVER = path.join(PROJECT_ROOT, 'server.js');

const ALLOWED_HOST = 'allowed.example.test';
const STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-analytics-'));
process.env.STORE_DIR = STORE_DIR;
process.env.SESSION_SECRET = 'a'.repeat(64);

const store = await import('../lib/store/index.js');
const { recordIdentification } = await import('../lib/store/processes.js');
const org = store.createOrganisation('Analytics org');
const invitation = store.addInvitation(org.id, { email: 'p@example.test', department: 'Finance' });
const PARTICIPANT_TOKEN = invitation.token;
store.recordTurn(org.id, invitation.token, { data: { task: 'entering invoices' }, transcript: [] });
store.closeAll();

/** The counting script's own source, which is what actually reaches the browser. */
const ANALYTICS_HOST = 'stats.thebeard.be';
const WEBSITE_ID = '89c983d9-1018-40ee-a3bd-48c54b691f7f';

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

function request({ method = 'GET', path: urlPath = '/', cookie, form } = {}) {
    const payload = form === undefined ? undefined : new URLSearchParams(form).toString();
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port: PORT, path: urlPath, method,
            headers: {
                host: ALLOWED_HOST,
                'x-forwarded-proto': 'https',
                ...(cookie ? { cookie } : {}),
                ...(payload !== undefined
                    ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(payload) }
                    : {})
            }
        }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { text += chunk; });
            res.on('end', () => resolve({
                status: res.statusCode, text, location: res.headers.location || null,
                setCookie: res.headers['set-cookie'] || null
            }));
        });
        req.on('error', reject);
        if (payload !== undefined) req.write(payload);
        req.end();
    });
}

let child;
let adminCookie = null;
let childLog = '';

before(async () => {
    child = spawn(process.execPath, [SERVER], {
        env: {
            PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test',
            PORT: String(PORT), HOST: '127.0.0.1', BASE_PATH: '',
            PUBLIC_BASE_URL: `https://${ALLOWED_HOST}`, TRUST_PROXY: '127.0.0.1',
            ALLOWED_HOST, SESSION_SECRET: 'a'.repeat(64), STORE_DIR,
            AI_PROVIDER: 'mock', MAIL_SENDER: 'console',
            DEMO_LOGIN: '', DEMO_LOGIN_ORG: '', DEMO_LOGIN_TOKEN: ''
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', (d) => { childLog += d; });
    child.stderr.on('data', (d) => { childLog += d; });

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
        try {
            const res = await request({ path: '/healthz' });
            if (res.status === 200) break;
        } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 50));
    }

    adminCookie = 'x';
});

after(async () => {
    if (child) {
        child.kill('SIGTERM');
        await new Promise((resolve) => child.once('exit', resolve));
    }
    fs.rmSync(STORE_DIR, { recursive: true, force: true });
});

/**
 * Whether the page loads the counting script at all.
 *
 * Asserted on the host it would fetch from, not on a flag: a `typeof analytics` check in the view
 * could be right while the tag still shipped.
 */
const hasAnalyticsTag = (text) => text.includes(ANALYTICS_HOST);
const hasExcludeSearch = (text) => text.includes("setAttribute('data-exclude-search', 'true')");

// ===========================================================================
// 1. The regression that would otherwise return
// ===========================================================================

test('/q/<token> serves NO analytics tag', async () => {
    const res = await request({ path: `/q/${PARTICIPANT_TOKEN}` });

    assert.equal(res.status, 200);
    assert.equal(hasAnalyticsTag(res.text), false, 'the analytics element is absent from the rendered page');
    assert.equal(res.text.includes(WEBSITE_ID), false, 'and the website id is absent with it');
});

test('/q/<token> still WORKS: the input and the send control are present', async () => {
    // A page that is safe because it is broken is not a fix.
    const res = await request({ path: `/q/${PARTICIPANT_TOKEN}` });

    assert.equal(res.status, 200);
    assert.match(res.text, /id="input"/, 'the answer input is on the page');
    assert.match(res.text, /id="send-btn"/, 'and the send control');
    assert.equal(res.text.includes(PARTICIPANT_TOKEN), true, 'and the token the client posts back with');
});

test('a token that resolves to nothing also serves no analytics tag', async () => {
    // The same page family, reached by a mangled link: the branch that renders with an error.
    const res = await request({ path: '/q/not-a-real-token' });

    assert.equal(res.status, 400);
    assert.equal(hasAnalyticsTag(res.text), false);
});

test('the token entry form at /q serves no analytics tag', async () => {
    const res = await request({ path: '/q' });

    assert.equal(res.status, 200);
    assert.match(res.text, /id="token-input"|name="token"/, 'the paste-a-token form rendered');
    assert.equal(hasAnalyticsTag(res.text), false);
});

test('the token entry form refusing an empty POST serves no analytics tag', async () => {
    const res = await request({ method: 'POST', path: '/q', form: { token: '' } });

    assert.equal(res.status, 400);
    assert.equal(hasAnalyticsTag(res.text), false);
});

// ===========================================================================
// 2. The flag DEFAULTS TO ON
// ===========================================================================

test('a page that does not opt out IS counted', async () => {
    // The silent failure mode this pins: a default flipped to off would leave every page
    // uncounted, and nothing would look wrong.
    const res = await request({ path: '/' });

    assert.equal(res.status, 200);
    assert.equal(hasAnalyticsTag(res.text), true, 'the landing page counts its views');
});

test('the default is ON in the view: an undefined flag renders the tag', () => {
    // Read from the partial, because that is where the default lives. `!== false` would flip the
    // whole site off the moment somebody tidied it.
    const partial = fs.readFileSync(
        path.join(PROJECT_ROOT, 'views', 'partials', 'theme-head.ejs'), 'utf8');

    assert.match(partial, /typeof analytics === 'undefined' \|\| analytics/,
        'the tag renders unless the page explicitly passes analytics: false');
});

// ===========================================================================
// 3. data-exclude-search on every counted page
// ===========================================================================

test('every counted page strips the query string from the reported URL', async () => {
    // The demo link's token is a query string, so exclude-search is what keeps it out.
    for (const urlPath of ['/', '/lost-link']) {
        const res = await request({ path: urlPath });
        assert.equal(res.status, 200, `${urlPath} served`);
        if (!hasAnalyticsTag(res.text)) continue;
        assert.equal(hasExcludeSearch(res.text), true, `${urlPath} sets data-exclude-search`);
    }
});

// ===========================================================================
// 4. Which pages are counted, and which are not
// ===========================================================================

test('the participant pages are the ONLY uncounted ones among the reachable set', async () => {
    const expected = [
        { path: '/', counted: true },
        { path: '/lost-link', counted: true },
        { path: '/q', counted: false },
        { path: `/q/${PARTICIPANT_TOKEN}`, counted: false },
        { path: '/q/not-a-real-token', counted: false }
    ];

    for (const { path: urlPath, counted } of expected) {
        const res = await request({ path: urlPath });
        assert.equal(res.status === 200 || res.status === 400, true, `${urlPath} answered`);
        assert.equal(hasAnalyticsTag(res.text), counted,
            `${urlPath} is ${counted ? 'counted' : 'NOT counted'}`);
    }
});

// ===========================================================================
// 5. ?tab= resolved server-side
// ===========================================================================

test('the notice promises that participant pages are not counted', async () => {
    // The clause that carries the promise, not the whole paragraph: wording edits elsewhere must
    // not fail this.
    const res = await request({ path: '/' });

    assert.match(res.text, /pages reached\s+through a participant link are not counted/i,
        'the notice says participant pages are not counted');
    assert.equal(hasAnalyticsTag(res.text), true,
        'and the claim is true: this page IS counted, the participant ones are not');
});

// ===========================================================================
// 6. ?tab= resolved SERVER-SIDE, through the real route
// ===========================================================================
//
// Driven over HTTP against the running server, not through a copy of the route's logic: a local
// `resolveTab` would agree with itself and certify nothing. The assertions are on the HTML the
// browser receives, with no script involved.

const ROADMAP_TABS = ['steps', 'departments', 'score', 'grouping', 'answers', 'history'];

/** The panel names the page marked visible, read from the `hidden` attribute each one carries. */
function visiblePanels(html) {
    const found = [...html.matchAll(/<section class="tab-panel" data-panel="([a-z]+)"([^>]*)>/g)];
    return found.filter(([, , attrs]) => !/\bhidden\b/.test(attrs)).map(([, name]) => name);
}

async function postForm(urlPath, cookie, form) {
    const payload = new URLSearchParams(form).toString();
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port: PORT, path: urlPath, method: 'POST',
            headers: {
                host: ALLOWED_HOST, 'x-forwarded-proto': 'https',
                ...(cookie ? { cookie } : {}),
                'content-type': 'application/x-www-form-urlencoded',
                'content-length': Buffer.byteLength(payload)
            }
        }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { text += c; });
            res.on('end', () => resolve({ status: res.statusCode, text, setCookie: res.headers['set-cookie'] || null }));
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

/** Signs in through the real mailed-link flow and returns the session cookie. */
async function signInAsAdmin(email) {
    const before = childLog.length;
    await postForm('/admin/login', undefined, { email });
    const token = (childLog.slice(before).match(/token=([A-Za-z0-9_-]{43})/) || [])[1];
    assert.ok(token, `a sign-in link for ${email} was captured`);
    const res = await request({ path: `/admin/login/verify?token=${token}` });
    assert.ok(res.setCookie, `signing in ${email} set a cookie`);
    return res.setCookie[0].split(';')[0];
}

let roadmapCookie = null;
let roadmapOrgId = null;
let roadmapSeeded = null;

/**
 * Seeds one identified process and signs in, ONCE, on the first tab test.
 *
 * Not a second `before`: hooks run in file order but the server hook is asynchronous, and a second
 * one that signs in would race it. Deferred to first use instead.
 */
function ensureRoadmapFixture() {
    if (roadmapSeeded) return roadmapSeeded;
    roadmapSeeded = (async () => {
        const { recordIdentification } = await import('../lib/store/processes.js');
        const { DatabaseSync } = await import('node:sqlite');

        // Sign in FIRST: a first sign-in creates its own organisation, so the process must be seeded
        // into the organisation the admin actually lands in.
        roadmapCookie = await signInAsAdmin('tabs@example.test');

        const db = new DatabaseSync(path.join(STORE_DIR, 'admin.db'));
        try {
            roadmapOrgId = db.prepare('SELECT organisation_id FROM users WHERE email = ?')
                .get('tabs@example.test').organisation_id;
        } finally {
            db.close();
        }
        assert.ok(roadmapOrgId, 'the signed-in admin has an organisation');

        const inv = store.addInvitation(roadmapOrgId, { email: 'tab-participant@example.test', department: 'Finance' });
        const response = store.addResponse(roadmapOrgId, inv.token, {
            department: 'Finance', data: { task: 'entering invoices', trigger: 'the mail arrives' }
        });
        recordIdentification({
            orgId: roadmapOrgId,
            responseId: response.id,
            reply: { matches: null, name: 'Entering invoices', reasoning: 'a new process', confidence: 'high' }
        });
    })();
    return roadmapSeeded;
}

const roadmap = (tab) => request({
    path: tab === undefined ? '/admin/roadmap' : `/admin/roadmap?tab=${encodeURIComponent(tab)}`,
    cookie: roadmapCookie
});

test('the roadmap serves a tab bar with a panel per tab', async () => {
    // The fixture guard: without a process there are no tabs, and every test below would pass
    // for the wrong reason.
    await ensureRoadmapFixture();
    const res = await roadmap();
    assert.equal(res.status, 200);
    assert.equal(visiblePanels(res.text).length, 1, 'exactly one panel is visible');
    assert.match(res.text, /role="tablist"/, 'and the tab bar rendered');
});

test('every known ?tab= renders exactly that panel visible and the rest hidden', async () => {
    await ensureRoadmapFixture();
    for (const tab of ROADMAP_TABS) {
        const res = await roadmap(tab);
        assert.equal(res.status, 200);
        assert.deepEqual(visiblePanels(res.text), [tab], `?tab=${tab} shows only its own panel`);
    }
});

test('an unknown ?tab= falls back to the FIRST panel rather than hiding everything', async () => {
    await ensureRoadmapFixture();
    for (const bad of ['nonsense', 'STEPS', 'history;drop', '../etc', ' ']) {
        const res = await roadmap(bad);
        assert.equal(res.status, 200);
        assert.deepEqual(visiblePanels(res.text), ['steps'],
            `?tab=${JSON.stringify(bad)} falls back to steps`);
    }
});

test('a URL with no ?tab= shows the first panel', async () => {
    await ensureRoadmapFixture();
    const res = await roadmap();
    assert.deepEqual(visiblePanels(res.text), ['steps']);
});

test('the active tab link is marked, and only one of them', async () => {
    await ensureRoadmapFixture();
    const res = await roadmap('score');

    const active = [...res.text.matchAll(/<a href="\?tab=([a-z]+)" role="tab" data-tab="[a-z]+"( class="active")?/g)]
        .filter(([, , cls]) => cls !== undefined)
        .map(([, name]) => name);

    // One active link per process, and the fixture seeds exactly one.
    assert.deepEqual(active, ['score'], 'the selected tab carries class="active"');
});

test('a tab link is a plain GET href, so it works without a script running', async () => {
    await ensureRoadmapFixture();
    const res = await roadmap();
    for (const tab of ROADMAP_TABS) {
        assert.match(res.text, new RegExp(`<a href="\\?tab=${tab}" role="tab"`),
            `${tab} is an anchor to ?tab=${tab}`);
    }
});

test('the roadmap IS counted, so the participant exclusion is not sitewide', async () => {
    await ensureRoadmapFixture();
    const res = await roadmap();
    assert.equal(res.status, 200);
    assert.equal(hasAnalyticsTag(res.text), true, 'the admin roadmap counts its views');
    assert.equal(hasExcludeSearch(res.text), true, 'and strips its query string');
});
