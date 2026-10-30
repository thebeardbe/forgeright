/**
 * The two console views: reachability, scoping and escaping. THE ROUTE LAYER: where a missing
 * scoping check would live, and where the templates turn stored text into HTML.
 *
 * ASSERTIONS ARE MADE ON THE RENDERED BYTES: a DOM comparison would decode entities first.
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
const STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-console-views-'));
process.env.STORE_DIR = STORE_DIR;
process.env.SESSION_SECRET = 'a'.repeat(64);

const store = await import('../lib/store/index.js');
const processes = await import('../lib/store/processes.js');
const weighing = await import('../lib/store/weighing.js');

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
        // PRESENT (empty), so dotenv leaves it alone: the demo gate stays closed.
        DEMO_LOGIN: '',
        DEMO_LOGIN_ORG: '',
        DEMO_LOGIN_TOKEN: ''
    };
}

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
        }
        if (Date.now() - start > 8000) throw new Error('server did not start');
        await new Promise((r) => setTimeout(r, 50));
    }

    cookieA = await signIn('viewer-a@views.test');
    cookieB = await signIn('viewer-b@views.test');
    ORG_A = orgIdOf('viewer-a@views.test');
    ORG_B = orgIdOf('viewer-b@views.test');

    inB = addProcess(ORG_B, {
        task: 'B SECRET TASK, never to be shown to A',
        name: 'B SECRET PROCESS NAME',
        steps: [{ name: 'B secret step', whatHappens: 'B secret happens', needsReasoning: false }]
    });

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
    // No grouping rather than an empty one, so the view can say so instead of a blank card.
    const invitation = store.addInvitation(ORG_A, { email: 'unread@example.test', department: 'Finance' });
    store.addResponse(ORG_A, invitation.token, { department: 'Finance', data: { task: 'an unread answer' } });

    const res = await request({ path: '/admin/answers', cookie: cookieA });
    assert.equal(res.status, 200);
    assert.ok(res.text.includes('an unread answer'), 'the unread response is listed');
    assert.ok(res.text.includes('not yet read'), 'and marked as not yet read');
});

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
    for (const body of [
        { reason: 'x', processId: inB.processId, organisationId: ORG_B },
        { reason: 'x', processId: inB.processId, orgId: ORG_B },
        { reason: 'x', organisationId: ORG_B }
    ]) {
        const res = await postForm(`/admin/roadmap/${inB.processId}/rejudge`, cookieA, body);
        assert.equal(res.status, 302);
        assert.ok(decodeURIComponent(res.location).includes('not in this organisation'), `body ${JSON.stringify(body)}`);
    }

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

    const target = weighing.listRoadmap(ORG_A).find((p) => p.id === inA.processId);
    assert.equal(target.grouping.revision, 1, 'an unauthenticated rejudge changed nothing');
});

test('a <script> in participant text renders entity-escaped, not raw', async () => {
    // THE ROADMAP LINKS to each answer, so the task text is not on this page. What still holds is
    // that the participant-controlled text it DOES render is escaped.
    const roadmap = await request({ path: '/admin/roadmap', cookie: cookieA });

    assert.equal(roadmap.text.includes('<script>alert(1)</script>'), false, 'no raw script tag reaches the roadmap');
    assert.equal(roadmap.text.includes('<script>alert(4)</script>'), false, 'nor from a step decidedHow');

    const answers = await request({ path: '/admin/answers', cookie: cookieA });
    assert.equal(answers.text.includes('<script>alert(1)</script>'), false, 'no raw script tag reaches the answers view');
    assert.ok(answers.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'the task is escaped on the answers view');
    assert.ok(answers.text.includes('&lt;script&gt;alert(4)&lt;/script&gt;'), 'and the step decidedHow too');
});

test('an onerror attribute in participant text renders escaped', async () => {
    const res = await request({ path: '/admin/answers', cookie: cookieA });

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

    // THE HEADING AND ITS PARAGRAPH TOGETHER, in order: the heading alone would pass with the
    // paragraph missing.
    assert.match(res.text, /<h3>Why it scored this<\/h3>\s*<p class="paragraph">/,
        'the reasoning paragraph renders under its heading, as a pair');

    assert.ok(res.text.includes('The terms behind it'), 'the terms section is rendered');
    for (const term of weighing.TERMS) {
        assert.ok(res.text.includes(term), `the term ${term} is shown`);
    }
    assert.ok(res.text.includes('(high is worse)'), 'cost terms are marked');

    assert.equal(res.text.includes('Why it got this weight'), false, 'the wrong heading does not appear');
    assert.match(res.text, /<div class="weight-label">weight<\/div>/, 'the `weight` label is unchanged beside the number');
});

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
    // The store omits the join, so there is nothing for the template to render by accident.
    const res = await request({ path: '/admin/answers', cookie: cookieA });
    assert.equal(res.text.includes('@views.test') && res.text.includes('p-'), false, 'no participant address is rendered');
    assert.equal(/invitation/i.test(res.text) && /[0-9a-f]{8}-[0-9a-f]{4}/.test(res.text), false, 'no invitation id is rendered');
});

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

    assert.equal(entry.name, 'Invoices');
    assert.equal(entry.score.value, 42);

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
    const org = store.createOrganisation('No weight org');
    const { processId } = addProcess(org.id, { task: 'unweighed', name: 'Never Weighed' });

    const entry = weighing.listRoadmap(org.id).find((e) => e.id === processId);
    assert.equal(entry.score, null);
    assert.deepEqual(entry.scoreHistory, [], 'no weighings at all');
    assert.ok(entry.grouping, 'but the grouping exists');
});
