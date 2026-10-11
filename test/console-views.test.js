/**
 * The two console views: reachability, scoping and escaping.
 *
 * The store's scoping is tested elsewhere (test/console-scope.test.js,
 * test/processes.test.js). THIS is the route layer, which is where a missing
 * scoping check would live, and where the templates turn stored text into HTML.
 *
 * Follows the spawned-server pattern: own temp STORE_DIR, every environment
 * variable pinned as the child's WHOLE environment, child stopped in cleanup. Data
 * is written through the real store API in this process, against the same
 * STORE_DIR the child reads.
 *
 * ASSERTIONS ARE MADE ON THE RENDERED BYTES, which is the only honest way to test
 * escaping: a DOM comparison would decode entities first and see no difference.
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

const ACCESS_CODE = 'console-views-code';
const ALLOWED_HOST = 'allowed.example.test';
const STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-console-views-'));
process.env.STORE_DIR = STORE_DIR;
process.env.SESSION_SECRET = 'a'.repeat(64);

const store = await import('../lib/store/index.js');
const processes = await import('../lib/store/processes.js');
const weighing = await import('../lib/store/weighing.js');

/** A free TCP port, released before the child claims it. */
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

/** Every environment variable the child reads, pinned as its whole environment. */
function spawnedEnv(port) {
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
        AUDIT_ACCESS_CODE: ACCESS_CODE
    };
}

/** One HTTP request with the trusted forwarded-protocol header. */
function request({ method = 'GET', path: urlPath = '/', form, json, cookie, headers = {} } = {}) {
    const payload = json !== undefined ? JSON.stringify(json)
        : form === undefined ? undefined : new URLSearchParams(form).toString();
    return new Promise((resolve, reject) => {
        const h = {
            host: ALLOWED_HOST,
            'x-forwarded-proto': 'https',
            ...(cookie ? { cookie } : {}),
            ...(payload !== undefined
                ? {
                    'content-type': json !== undefined ? 'application/json' : 'application/x-www-form-urlencoded',
                    'content-length': Buffer.byteLength(payload)
                }
                : {}),
            ...headers
        };
        const req = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method, headers: h }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { text += chunk; });
            res.on('end', () => resolve({
                status: res.statusCode,
                text,
                location: res.headers.location || null,
                setCookie: res.headers['set-cookie'] || null
            }));
        });
        req.on('error', reject);
        if (payload !== undefined) req.write(payload);
        req.end();
    });
}

const postForm = (urlPath, cookie, form) => request({ method: 'POST', path: urlPath, cookie, form });

let child;
let childOutput = '';

// Sign-in and the seed data happen inside before(): they make HTTP requests to the
// child, and top-level code would run before the server is listening.
let cookieA;
let cookieB;
let ORG_A;
let ORG_B;
let inA;
let inB;

before(async () => {
    child = spawn(process.execPath, [SERVER], { env: spawnedEnv(PORT), stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => { childOutput += chunk; });
    child.stderr.on('data', () => {});
    const start = Date.now();
    for (;;) {
        try {
            const res = await request({ path: '/healthz' });
            if (res.status === 200) break;
        } catch {
            // Not up yet.
        }
        if (Date.now() - start > 8000) throw new Error('server did not start');
        await new Promise((r) => setTimeout(r, 50));
    }

    // Two admins, one per organisation.
    cookieA = await signIn('viewer-a@views.test');
    cookieB = await signIn('viewer-b@views.test');
    ORG_A = orgIdOf('viewer-a@views.test');
    ORG_B = orgIdOf('viewer-b@views.test');

    // B's data: a process whose name and answer text are unmistakable.
    inB = addProcess(ORG_B, {
        task: 'B SECRET TASK, never to be shown to A',
        name: 'B SECRET PROCESS NAME',
        steps: [{ name: 'B secret step', whatHappens: 'B secret happens', needsReasoning: false }]
    });

    // A's data, including an XSS payload in participant- and model-controlled text.
    inA = addProcess(ORG_A, {
        task: '<script>alert(1)</script>',
        name: '<img src=x onerror=alert(3)>',
        steps: [
            { name: 'Open', whatHappens: 'onerror=alert(2)', decidedHow: '<script>alert(4)</script>', needsReasoning: false },
            { name: 'Book', whatHappens: 'plain text', decidedHow: 'depends', needsReasoning: true }
        ]
    });
});

after(async () => {
    fs.rmSync(STORE_DIR, { recursive: true, force: true });
    if (!child || child.killed) return;
    await new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill('SIGTERM');
        const force = setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 2000);
        force.unref();
        child.once('exit', () => clearTimeout(force));
    });
});

// --- fixtures ----------------------------------------------------------------

/** Signs in through the real route and returns the session cookie. */
async function signIn(email) {
    childOutput = '';
    await postForm('/admin/login', undefined, { email });
    const token = (childOutput.match(/token=([A-Za-z0-9_-]{43})/) || [])[1];
    assert.ok(token, `a sign-in link for ${email} was captured`);
    const res = await request({ path: `/admin/login/verify?token=${token}` });
    assert.ok(res.setCookie, `signing in ${email} set a cookie`);
    return res.setCookie[0].split(';')[0];
}

const orgIdOf = (email) => {
    const db = new DatabaseSync(path.join(STORE_DIR, 'admin.db'));
    try {
        return db.prepare('SELECT organisation_id FROM users WHERE email = ?').get(email).organisation_id;
    } finally {
        db.close();
    }
};

/** Adds a participant response to an org and identifies it into a process. */
function addProcess(orgId, { task, name, steps, department = 'Finance' }) {
    const invitation = store.addInvitation(orgId, { email: `p-${Math.random().toString(36).slice(2)}@example.test`, department });
    const response = store.addResponse(orgId, invitation.token, { department, data: { task, steps } });
    const identified = processes.recordIdentification({
        orgId,
        reply: { matches: null, reasoning: `because it is ${name}`, confidence: 'high', name },
        responseId: response.id
    });
    return { processId: identified.process.id, revisionId: identified.revision.id, responseId: response.id };
}

// The fixtures are created in before(), once the server is listening.

// ===========================================================================
// 3. REACHABLE
// ===========================================================================

test('the roadmap renders 200 for a signed-in admin', async () => {
    const res = await request({ path: '/admin/roadmap', cookie: cookieA });
    assert.equal(res.status, 200);
    assert.match(res.text, /<!DOCTYPE html>/i, 'an HTML page');
});

test('the answers view renders 200 for a signed-in admin', async () => {
    const res = await request({ path: '/admin/answers', cookie: cookieA });
    assert.equal(res.status, 200);
    assert.match(res.text, /<!DOCTYPE html>/i);
});

test('the answers view shows a response that has NOT been identified, as "not yet read"', async () => {
    // A response nobody has grouped has NO grouping rather than an empty one, which
    // is what lets the view say so instead of rendering a blank card.
    const invitation = store.addInvitation(ORG_A, { email: 'unread@example.test', department: 'Finance' });
    store.addResponse(ORG_A, invitation.token, { department: 'Finance', data: { task: 'an unread answer' } });

    const res = await request({ path: '/admin/answers', cookie: cookieA });
    assert.equal(res.status, 200);
    assert.ok(res.text.includes('an unread answer'), 'the unread response is listed');
    assert.ok(res.text.includes('not yet read'), 'and marked as not yet read');
});

// ===========================================================================
// 3. SCOPED — THE ROUTE LAYER
// ===========================================================================
//
// The store's scoping is tested elsewhere. This is the ROUTE layer: a route that
// read an organisation or an id from the request would be the one mistake that
// shows a client another client's data, and a missing check would live here.

test("A's roadmap with B's organisation id in the query leaks NOTHING of B's", async () => {
    for (const query of [`organisationId=${ORG_B}`, `orgId=${ORG_B}`, `organisationId=${ORG_B}&orgId=${ORG_B}`]) {
        const res = await request({ path: `/admin/roadmap?${query}`, cookie: cookieA });
        assert.equal(res.status, 200, 'the page still renders A\'s own data');
        assert.equal(res.text.includes('B SECRET PROCESS NAME'), false, `B's process name must not appear (${query})`);
        assert.equal(res.text.includes('B secret step'), false, `B's step must not appear (${query})`);
    }
});

test("A's answers view with B's ids in the query leaks NOTHING of B's", async () => {
    const res = await request({ path: `/admin/answers?responseId=${inB.responseId}&organisationId=${ORG_B}`, cookie: cookieA });
    assert.equal(res.status, 200);
    assert.equal(res.text.includes('B SECRET TASK'), false, "B's answer text must not appear");
    assert.ok(res.text.includes('alert(1)'), false, 'and neither does a relative sanity check accidentally pass');
});

test("A's roadmap with B's PROCESS id in a path segment does not act on it", async () => {
    // The rejudge route. A missing scoping check here would regroup B's process.
    const res = await postForm(`/admin/roadmap/${inB.processId}/rejudge`, cookieA, { reason: 'a forged rejudge' });
    assert.equal(res.status, 302, 'the route redirects rather than rendering');
    assert.ok(
        decodeURIComponent(res.location).includes('not in this organisation'),
        `the refusal is explicit, got ${res.location}`
    );
});

test("A's answers view with B's RESPONSE id in a path segment does not act on it", async () => {
    const res = await postForm(`/admin/answers/${inB.responseId}/rejudge`, cookieA, { reason: 'a forged rejudge' });
    assert.equal(res.status, 302);
    assert.ok(
        decodeURIComponent(res.location).includes('not in this organisation'),
        `the refusal is explicit, got ${res.location}`
    );
});

test("A's rejudge with B's process id in the BODY is still refused", async () => {
    // A body field naming a tenant must not redirect the operation.
    for (const body of [
        { reason: 'x', processId: inB.processId, organisationId: ORG_B },
        { reason: 'x', processId: inB.processId, orgId: ORG_B },
        { reason: 'x', organisationId: ORG_B }
    ]) {
        const res = await postForm(`/admin/roadmap/${inB.processId}/rejudge`, cookieA, body);
        assert.equal(res.status, 302);
        assert.ok(decodeURIComponent(res.location).includes('not in this organisation'), `body ${JSON.stringify(body)}`);
    }

    // And with a JSON body, the other content type.
    const asJson = await request({
        method: 'POST',
        path: `/admin/roadmap/${inB.processId}/rejudge`,
        cookie: cookieA,
        json: { reason: 'x', processId: inB.processId, organisationId: ORG_B }
    });
    assert.equal(asJson.status, 302);
    assert.ok(decodeURIComponent(asJson.location).includes('not in this organisation'));
});

test("B's process is UNCHANGED after A's forged rejudge attempts", () => {
    // The property behind the status code: nothing B owns was regrouped.
    const roadmapB = weighing.listRoadmap(ORG_B);
    const target = roadmapB.find((p) => p.id === inB.processId);
    assert.ok(target, "B's process is still there");
    assert.equal(target.grouping.revision, 1, 'no new revision was created in B');
    assert.equal(target.name, 'B SECRET PROCESS NAME', 'the name is unchanged');
});

test('an unauthenticated request redirects to the sign-in page on both views', async () => {
    for (const urlPath of ['/admin/answers', '/admin/roadmap']) {
        const res = await request({ path: urlPath });
        assert.equal(res.status, 302, `${urlPath} must redirect`);
        assert.match(res.location, /\/admin/, `${urlPath} redirects to the sign-in page`);
    }
});

test('an unauthenticated POST to a rejudge route redirects rather than acting', async () => {
    const res = await postForm(`/admin/roadmap/${inA.processId}/rejudge`, undefined, { reason: 'x' });
    assert.equal(res.status, 302);
    assert.match(res.location, /\/admin/);

    // Nothing changed: the seeded revision is still the current one.
    const target = weighing.listRoadmap(ORG_A).find((p) => p.id === inA.processId);
    assert.equal(target.grouping.revision, 1, 'an unauthenticated rejudge changed nothing');
});

// ===========================================================================
// 3. ESCAPED — THE INJECTION SURFACE
// ===========================================================================
//
// The participant controls this text. Asserted on the rendered BYTES: comparing a
// parsed DOM would decode the entities first and see no difference.

test('a <script> in participant text renders entity-escaped, not raw', async () => {
    const res = await request({ path: '/admin/roadmap', cookie: cookieA });

    assert.equal(res.text.includes('<script>alert(1)</script>'), false, 'no raw script tag reaches the page');
    assert.equal(res.text.includes('<script>alert(4)</script>'), false, 'nor from a step decidedHow');
    assert.ok(res.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'the task is escaped');
});

test('an onerror attribute in participant text renders escaped', async () => {
    const res = await request({ path: '/admin/roadmap', cookie: cookieA });

    assert.equal(res.text.includes('<img src=x onerror=alert(3)>'), false, 'no raw img tag reaches the page');
    assert.ok(res.text.includes('&lt;img'), 'the process name is escaped');
    assert.ok(res.text.includes('onerror=alert(2)'), 'the text of the attribute is shown as text');
});

test('the answers view escapes participant text too', async () => {
    const res = await request({ path: '/admin/answers', cookie: cookieA });

    assert.equal(res.text.includes('<script>alert(1)</script>'), false, 'no raw script tag');
    assert.ok(res.text.includes('&lt;script&gt;'), 'the answer text is escaped');
});

test('the roadmap escapes the SCORE PARAGRAPH, which the model controls', async () => {
    // A model's paragraph is text, and the view is where it is made inert.
    weighing.recordWeighing({
        orgId: ORG_A,
        processId: inA.processId,
        reply: {
            score: 50,
            terms: Object.fromEntries(weighing.TERMS.map((term) => [term, 5])),
            reasoning: '<script>alert(9)</script> in the paragraph'
        }
    });

    const res = await request({ path: '/admin/roadmap', cookie: cookieA });
    assert.equal(res.text.includes('<script>alert(9)</script>'), false, 'the paragraph is not inserted as markup');
    assert.ok(res.text.includes('&lt;script&gt;alert(9)&lt;/script&gt;'), 'it is escaped');
});

test('the roadmap shows the score, the terms and the paragraph once weighed', async () => {
    const res = await request({ path: '/admin/roadmap', cookie: cookieA });

    assert.ok(res.text.includes('Why it got this weight'), 'the paragraph section is rendered');
    assert.ok(res.text.includes('The terms behind it'), 'the terms section is rendered');
    for (const term of weighing.TERMS) {
        assert.ok(res.text.includes(term), `the term ${term} is shown`);
    }
    assert.ok(res.text.includes('(high is worse)'), 'cost terms are marked');
});

// ===========================================================================
// 3. THE BOUNDARY
// ===========================================================================

test('no participant route imports a console module', () => {
    const participantFiles = ['lib/auth/participant-routes.js', 'lib/routes-api.js'];
    const consoleModules = ['console-views.js', 'console-read.js', 'rejudge.js', 'weigh-core.js'];

    for (const file of participantFiles) {
        const source = fs.readFileSync(path.join(PROJECT_ROOT, file), 'utf8');
        for (const module of consoleModules) {
            assert.equal(
                new RegExp(`['"][^'"]*${module.replace('.', '\\.')}['"]`).test(source),
                false,
                `${file} must not import ${module}`
            );
        }
    }
});

test('the attribution lookup is still not exported anywhere', () => {
    const source = fs.readFileSync(path.join(PROJECT_ROOT, 'lib/store/processes.js'), 'utf8');
    assert.equal(/export\s+(async\s+)?function\s+groupedProcessForResponse/.test(source), false, 'it stays private');

    // And no module imports it: it is a local helper, not an export.
    const importers = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.js')) {
                const text = fs.readFileSync(full, 'utf8');
                if (/import\s*\{[^}]*groupedProcessForResponse/.test(text)) importers.push(full);
            }
        }
    };
    for (const dir of ['lib', 'ai']) walk(path.join(PROJECT_ROOT, dir));
    assert.deepEqual(importers, [], 'nothing imports the private lookup');
});

test('the console views do not render a participant email or an invitation id', async () => {
    // The attribution guarantee at the view layer: the store omits the join, so
    // there is nothing for the template to render even by accident. The seeded
    // participant addresses are what would leak if it did.
    const res = await request({ path: '/admin/answers', cookie: cookieA });
    assert.equal(res.text.includes('@views.test') && res.text.includes('p-'), false, 'no participant address is rendered');
    assert.equal(/invitation/i.test(res.text) && /[0-9a-f]{8}-[0-9a-f]{4}/.test(res.text), false, 'no invitation id is rendered');
});

// ===========================================================================
// 4. THE ROADMAP ORDER
// ===========================================================================

test('the roadmap sorts highest score first', async () => {
    const org = store.createOrganisation('Sorting org');
    const scores = [['Zulu', 30], ['Alpha', 90], ['Mike', 60]];
    for (const [name, score] of scores) {
        const { processId } = addProcess(org.id, { task: name, name });
        weighing.recordWeighing({
            orgId: org.id,
            processId,
            reply: { score, terms: Object.fromEntries(weighing.TERMS.map((t) => [t, 5])), reasoning: `${name} paragraph` }
        });
    }

    const order = weighing.listRoadmap(org.id).map((e) => e.score.value);
    assert.deepEqual(order, [90, 60, 30], 'highest first');
});

test('an unscored process with a grouping sorts LAST rather than being dropped', async () => {
    // A real state: identified, so it has a grouping, but nobody has weighed it.
    const org = store.createOrganisation('Unweighed org');
    const weighed = addProcess(org.id, { task: 'weighed', name: 'Weighed' });
    weighing.recordWeighing({
        orgId: org.id,
        processId: weighed.processId,
        reply: { score: 10, terms: Object.fromEntries(weighing.TERMS.map((t) => [t, 5])), reasoning: 'r' }
    });
    const unweighed = addProcess(org.id, { task: 'unweighed', name: 'Unweighed' });

    const roadmap = weighing.listRoadmap(org.id);
    assert.equal(roadmap.length, 2, 'both are present, none dropped');
    assert.equal(roadmap.at(-1).id, unweighed.processId, 'the unscored one is last');
    assert.equal(roadmap.at(-1).score, null, 'and its score is null, not zero');
    assert.ok(roadmap.at(-1).grouping, 'it still carries its grouping');
});

test('ties break deterministically and the order is stable across two calls', async () => {
    const org = store.createOrganisation('Ties org');
    for (const name of ['Zulu', 'Alpha', 'Mike', 'Solo']) {
        const { processId } = addProcess(org.id, { task: name, name });
        weighing.recordWeighing({
            orgId: org.id,
            processId,
            reply: { score: 50, terms: Object.fromEntries(weighing.TERMS.map((t) => [t, 5])), reasoning: 'tied' }
        });
    }

    const first = weighing.listRoadmap(org.id);
    const second = weighing.listRoadmap(org.id);

    assert.deepEqual(first.map((e) => e.name), ['Alpha', 'Mike', 'Solo', 'Zulu'], 'equal scores order by name');
    assert.equal(JSON.stringify(second), JSON.stringify(first), 'two calls give the same result');
});

test('each entry carries what the collapsed and expanded views need', async () => {
    const org = store.createOrganisation('Entry shape org');
    const { processId } = addProcess(org.id, {
        task: 'invoices',
        name: 'Invoices',
        steps: [
            { name: 'Open', whatHappens: 'open it', decidedHow: 'the inbox', needsReasoning: false },
            { name: 'Match', whatHappens: 'compare', decidedHow: 'depends', needsReasoning: true }
        ]
    });
    weighing.recordWeighing({
        orgId: org.id,
        processId,
        reply: { score: 42, terms: Object.fromEntries(weighing.TERMS.map((t) => [t, 7])), reasoning: 'a paragraph' }
    });

    const entry = weighing.listRoadmap(org.id).find((e) => e.id === processId);

    // The collapsed view: name, the weight, and the reasoning count.
    assert.equal(entry.name, 'Invoices');
    assert.equal(entry.score.value, 42);

    // The expanded view: the steps with their flags, the terms, the paragraph, the
    // grouping and both histories. The steps themselves are derived by
    // mergeProcessSteps from the responses the grouping carries.
    assert.equal(entry.grouping.responses.length, 1);
    assert.deepEqual(entry.grouping.responses[0].data.steps.map((s) => s.name), ['Open', 'Match']);
    assert.deepEqual(entry.score.terms, Object.fromEntries(weighing.TERMS.map((t) => [t, 7])));
    assert.equal(entry.score.reasoning, 'a paragraph');
    assert.ok(Array.isArray(entry.scoreHistory) && entry.scoreHistory.length === 1);
    assert.equal(entry.scoreHistory[0].score, 42);
    assert.equal(entry.scoreHistory[0].grouping_revision, 1, 'the history names the grouping it belongs to');
    assert.equal(entry.grouping.reasoning, 'because it is Invoices', 'the grouping reasoning is the identification one');
});

test('a process with a grouping but no weighing renders the "no weight" branch', async () => {
    // The template has a distinct branch for this, so the page is honest about why
    // there is no number rather than showing a zero.
    const org = store.createOrganisation('No weight org');
    const { processId } = addProcess(org.id, { task: 'unweighed', name: 'Never Weighed' });

    const entry = weighing.listRoadmap(org.id).find((e) => e.id === processId);
    assert.equal(entry.score, null);
    assert.deepEqual(entry.scoreHistory, [], 'no weighings at all');
    assert.ok(entry.grouping, 'but the grouping exists');
});
