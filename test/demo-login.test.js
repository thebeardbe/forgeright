/**
 * The read-only demo link: the guard and the refusal.
 *
 * `GET /admin/demo?token=...` signs someone into a FIXED demo organisation read-only. The link
 * goes to a prospective client outside the owner's control.
 *
 * FIXTURE: A SEEDED STORE BUILT IN THIS PROCESS, not `scripts/seed-demo-org.js`, which needs a live
 * provider and DELETES an organisation.
 *
 * Each test spawns its own server: the demo route is registered at startup from the environment.
 */
import { test } from 'node:test';
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
const SERVER = path.join(__dirname, '..', 'server.js');
const DEMO_TOKEN = 'demo-token-for-tests-0123456789abcdef';
const ALLOWED_HOST = 'allowed.example.test';

const store = await import('../lib/store/index.js');
const processes = await import('../lib/store/processes.js');
const weighing = await import('../lib/store/weighing.js');

function seedStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-demo-'));
    process.env.STORE_DIR = dir;

    const org = store.createOrganisation('Demo organisation');
    const invitation = store.addInvitation(org.id, { email: 'participant@example.test', department: 'Finance' });
    const response = store.addResponse(org.id, invitation.token, { department: 'Finance', data: { task: 'invoices' } });
    const identified = processes.recordIdentification({
        orgId: org.id,
        reply: { matches: null, reasoning: 'nobody has described this', confidence: 'high', name: 'Invoices' },
        responseId: response.id
    });
    weighing.recordWeighing({
        orgId: org.id,
        processId: identified.process.id,
        reply: { score: 42, terms: Object.fromEntries(weighing.TERMS.map((term) => [term, 50])), reasoning: 'a demo paragraph' }
    });

    const db = new DatabaseSync(path.join(dir, 'admin.db'));
    db.prepare('INSERT OR REPLACE INTO users (id, organisation_id, email, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('real-admin', org.id, 'real@admin.test', 'admin', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    db.close();

    store.closeAll();
    return { dir, orgId: org.id };
}

const { dir: STORE_DIR, orgId: ORG_ID } = seedStore();

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

/** Spawns the server with a chosen demo environment (DEMO_LOGIN / DEMO_LOGIN_ORG / DEMO_LOGIN_TOKEN). */
async function startServer(demoEnv = {}) {
    const port = await freePort();
    const child = spawn(process.execPath, [SERVER], {
        env: {
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
            // EMPTY STRINGS, NOT OMITTED: `dotenv` fills only ABSENT keys, so a developer's
            // untracked `.env` with `DEMO_LOGIN=1` would be inherited. A key that IS present (even
            // as '') is left alone. `...demoEnv` below overrides these where the flag is ENABLED.
            DEMO_LOGIN: '',
            DEMO_LOGIN_ORG: '',
            DEMO_LOGIN_TOKEN: '',
            DEMO_LOGIN_DAYS: '',
            ...demoEnv
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });

    const started = Date.now();
    for (;;) {
        try {
            const res = await request(port, { path: '/healthz' });
            if (res.status === 200) break;
        } catch {
        }
        if (Date.now() - started > 8000) throw new Error('server did not start');
        await new Promise((r) => setTimeout(r, 50));
    }

    return {
        port,
        child,
        log: () => output,
        stop: async () => {
            if (child.killed) return;
            await new Promise((resolve) => {
                child.once('exit', resolve);
                child.kill('SIGTERM');
                const force = setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 2000);
                force.unref();
                child.once('exit', () => clearTimeout(force));
            });
        }
    };
}

function request(port, { method = 'GET', path: urlPath = '/', form, cookie, headers = {} } = {}) {
    const payload = form === undefined ? undefined : new URLSearchParams(form).toString();
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: '127.0.0.1',
                port,
                path: urlPath,
                method,
                headers: {
                    host: ALLOWED_HOST,
                    'x-forwarded-proto': 'https',
                    ...(cookie ? { cookie } : {}),
                    ...(payload !== undefined
                        ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(payload) }
                        : {}),
                    ...headers
                }
            },
            (res) => {
                let text = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => { text += chunk; });
                res.on('end', () => resolve({
                    status: res.statusCode,
                    text,
                    location: res.headers.location || null,
                    setCookie: res.headers['set-cookie'] || null
                }));
            }
        );
        req.on('error', reject);
        if (payload !== undefined) req.write(payload);
        req.end();
    });
}

async function signInAdmin(server, email) {
    const link = await request(server.port, { method: 'POST', path: '/admin/login', form: { email } });
    assert.equal(link.status, 200);
    const token = (server.log().match(/token=([A-Za-z0-9_-]{43})/) || [])[1];
    assert.ok(token, 'the sign-in link was printed');
    const verified = await request(server.port, { path: `/admin/login/verify?token=${token}` });
    assert.ok(verified.setCookie, 'signing in set a cookie');
    return verified.setCookie[0].split(';')[0];
}

async function openDemo(server) {
    const res = await request(server.port, { path: `/admin/demo?token=${DEMO_TOKEN}` });
    assert.ok(res.setCookie, 'the demo link set a cookie');
    return res.setCookie[0].split(';')[0];
}

function storedState() {
    const admin = new DatabaseSync(path.join(STORE_DIR, 'admin.db'));
    const org = new DatabaseSync(path.join(STORE_DIR, 'orgs', `${ORG_ID}.db`));
    try {
        return {
            orgName: org.prepare('SELECT name FROM organisation').get().name,
            invitations: org.prepare('SELECT COUNT(*) AS n FROM invitation').get().n,
            processes: org.prepare('SELECT COUNT(*) AS n FROM process').get().n,
            responses: org.prepare('SELECT COUNT(*) AS n FROM response').get().n,
            users: admin.prepare('SELECT COUNT(*) AS n FROM users').get().n
        };
    } finally {
        admin.close();
        org.close();
    }
}

test('with the flag unset, /admin/demo behaves as an UNKNOWN console path', async () => {
    const server = await startServer();
    try {
        const demoOut = await request(server.port, { path: `/admin/demo?token=${DEMO_TOKEN}` });
        const unknownOut = await request(server.port, { path: '/admin/nonsense' });
        assert.equal(demoOut.status, unknownOut.status, 'the two paths answer identically when signed out');
        assert.equal(demoOut.status, 302);
        assert.equal(demoOut.setCookie, null, 'NO demo cookie is set with the flag off');
        assert.equal(demoOut.location, unknownOut.location);
    } finally {
        await server.stop();
    }
});

test('with the flag unset, a CORRECT token still does not sign anyone in', async () => {
    // Stronger than "same as an unknown path": with the flag off but a correct token, NO cookie
    // may be set. Both paths 302 when signed out, so a status comparison would miss it.
    const server = await startServer({ DEMO_LOGIN_ORG: ORG_ID, DEMO_LOGIN_TOKEN: DEMO_TOKEN });
    try {
        const res = await request(server.port, { path: `/admin/demo?token=${DEMO_TOKEN}` });
        assert.equal(res.setCookie, null, 'no session is created without the flag');
        assert.equal(/\[demo\]/.test(server.log()), false, 'the demo mechanism never runs with the flag off');
    } finally {
        await server.stop();
    }
});

test('with the flag unset, a SIGNED-IN request gets the same 404 as an unknown path', async () => {
    const server = await startServer({ DEMO_LOGIN_ORG: ORG_ID, DEMO_LOGIN_TOKEN: DEMO_TOKEN });
    try {
        const admin = await signInAdmin(server, 'real@admin.test');
        const demo = await request(server.port, { path: `/admin/demo?token=${DEMO_TOKEN}`, cookie: admin });
        const unknown = await request(server.port, { path: '/admin/nonsense', cookie: admin });
        assert.equal(demo.status, unknown.status, 'the demo path is indistinguishable from an unknown one');
        assert.equal(demo.setCookie, null, 'and it sets no cookie');
    } finally {
        await server.stop();
    }
});

test('the demo route logs nothing at startup when the flag is off', async () => {
    const server = await startServer();
    try {
        assert.equal(/\[demo\]/.test(server.log()), false, 'no demo line before the flag is set');
    } finally {
        await server.stop();
    }
});

// ===========================================================================
// 2. EVERY MUTATING CONSOLE ROUTE IS REFUSED FOR A DEMO SESSION
// ===========================================================================
// Six POSTs in `lib/auth/console.js`, two in `lib/auth/console-views.js`.

const MUTATING_ROUTES = [
    ['/admin/organisation/name', { name: 'HACKED' }],
    ['/admin/invitations', { email: 'a@b.test', department: 'Finance' }],
    ['/admin/invitations/some-id/send', {}],
    ['/admin/invitations/some-id/reset', {}],
    ['/admin/users', { email: 'a@b.test', role: 'admin' }],
    ['/admin/users/some-id/role', { role: 'admin' }],
    ['/admin/answers/some-id/rejudge', { reason: 'x' }],
    ['/admin/roadmap/some-id/rejudge', { reason: 'x' }]
];

test('the eight mutating console routes are all refused for a demo session', async () => {
    const server = await startServer({ DEMO_LOGIN: '1', DEMO_LOGIN_ORG: ORG_ID, DEMO_LOGIN_TOKEN: DEMO_TOKEN });
    try {
        const demo = await openDemo(server);

        for (const [route, body] of MUTATING_ROUTES) {
            const res = await request(server.port, { method: 'POST', path: route, cookie: demo, form: body });
            assert.equal(res.status, 403, `POST ${route} must be refused for a demo session`);
        }
    } finally {
        await server.stop();
    }
});

test('a GET on the console still WORKS for a demo session, so the refusal is by method', async () => {
    const server = await startServer({ DEMO_LOGIN: '1', DEMO_LOGIN_ORG: ORG_ID, DEMO_LOGIN_TOKEN: DEMO_TOKEN });
    try {
        const demo = await openDemo(server);
        for (const route of ['/admin', '/admin/roadmap', '/admin/answers']) {
            assert.equal((await request(server.port, { path: route, cookie: demo })).status, 200, `GET ${route} is allowed`);
        }
    } finally {
        await server.stop();
    }
});

// ===========================================================================
// 3. NOTHING CHANGED AFTER A REFUSED WRITE
// ===========================================================================
// A guard that refused the RESPONSE but left a write half-done would pass a status check, so the
// state is read directly.

test('a refused write leaves the stored state EXACTLY as it was', async () => {
    const server = await startServer({ DEMO_LOGIN: '1', DEMO_LOGIN_ORG: ORG_ID, DEMO_LOGIN_TOKEN: DEMO_TOKEN });
    try {
        const demo = await openDemo(server);
        const before = storedState();

        for (const [route, body] of MUTATING_ROUTES) {
            await request(server.port, { method: 'POST', path: route, cookie: demo, form: body });
        }

        assert.deepEqual(storedState(), before, 'no refused write changed anything in the store');
    } finally {
        await server.stop();
    }
});

test('renaming the demo organisation does not change the name', async () => {
    const server = await startServer({ DEMO_LOGIN: '1', DEMO_LOGIN_ORG: ORG_ID, DEMO_LOGIN_TOKEN: DEMO_TOKEN });
    try {
        const demo = await openDemo(server);
        const before = storedState().orgName;

        const res = await request(server.port, { method: 'POST', path: '/admin/organisation/name', cookie: demo, form: { name: 'RENAMED BY DEMO' } });

        assert.equal(res.status, 403);
        assert.equal(storedState().orgName, before, 'the name is unchanged');
        assert.notEqual(storedState().orgName, 'RENAMED BY DEMO');
    } finally {
        await server.stop();
    }
});

test('a refused invitation write does not add an invitation', async () => {
    const server = await startServer({ DEMO_LOGIN: '1', DEMO_LOGIN_ORG: ORG_ID, DEMO_LOGIN_TOKEN: DEMO_TOKEN });
    try {
        const demo = await openDemo(server);
        const before = storedState().invitations;

        const res = await request(server.port, { method: 'POST', path: '/admin/invitations', cookie: demo, form: { email: 'new@example.test', department: 'Finance' } });

        assert.equal(res.status, 403);
        assert.equal(storedState().invitations, before, 'no invitation was created');
    } finally {
        await server.stop();
    }
});

test('a real admin session writes successfully, so the guard does not refuse real admins', async () => {
    const server = await startServer();
    try {
        const admin = await signInAdmin(server, 'real@admin.test');
        const before = storedState().orgName;

        const res = await request(server.port, { method: 'POST', path: '/admin/organisation/name', cookie: admin, form: { name: 'Renamed by a real admin' } });

        assert.equal(res.status, 302, 'the real write is accepted and redirects');
        assert.equal(storedState().orgName, 'Renamed by a real admin', 'and it really changed the name');
        assert.notEqual(storedState().orgName, before);
    } finally {
        await server.stop();
    }
});

test('a real admin console page carries no read-only banner or demo tag', async () => {
    const server = await startServer();
    try {
        const admin = await signInAdmin(server, 'real@admin.test');
        const page = await request(server.port, { path: '/admin', cookie: admin });

        assert.equal(page.status, 200);
        assert.equal(/read[- ]only/i.test(page.text), false, 'an ordinary session sees no read-only notice');
        assert.equal(/demo session/i.test(page.text), false, 'and no demo-session tag');
    } finally {
        await server.stop();
    }
});

test('the demo banner IS shown on a demo session, so the absence above is meaningful', async () => {
    const server = await startServer({ DEMO_LOGIN: '1', DEMO_LOGIN_ORG: ORG_ID, DEMO_LOGIN_TOKEN: DEMO_TOKEN });
    try {
        const demo = await openDemo(server);
        const page = await request(server.port, { path: '/admin', cookie: demo });

        assert.equal(page.status, 200);
        assert.match(page.text, /read[- ]only/i, 'the demo session IS told it is read-only');
    } finally {
        await server.stop();
    }
});

const { demoTokenMatches } = await import('../lib/auth/demo-login.js');

test('every wrong token shape fails without throwing', () => {
    const shapes = ['wrong', '', undefined, null, 42, {}, [], true,
        DEMO_TOKEN.slice(0, -1), `${DEMO_TOKEN}x`, DEMO_TOKEN.toUpperCase()];

    for (const shape of shapes) {
        let result;
        assert.doesNotThrow(() => { result = demoTokenMatches(shape, DEMO_TOKEN); }, `token ${String(shape)} must not throw`);
        assert.equal(result, false, `token ${String(shape)} must not match`);
    }
});

test('the correct token matches', () => {
    assert.equal(demoTokenMatches(DEMO_TOKEN, DEMO_TOKEN), true);
});

test('a wrong-length value does not throw, so the length is never compared first', () => {
    // Both sides are hashed first, so a length mismatch cannot leak through `timingSafeEqual`
    // throwing.
    for (const length of [0, 1, 23, 24, 31, 32, 33, 64, 1000]) {
        assert.doesNotThrow(() => demoTokenMatches('x'.repeat(length), DEMO_TOKEN), `length ${length} must not throw`);
    }
    assert.equal(demoTokenMatches('x'.repeat(24), DEMO_TOKEN), false);
    assert.equal(demoTokenMatches('x'.repeat(31), DEMO_TOKEN), false);
    assert.equal(demoTokenMatches('x'.repeat(33), DEMO_TOKEN), false);
});

test('a WRONG and a MISSING token are indistinguishable over HTTP', async () => {
    const server = await startServer({ DEMO_LOGIN: '1', DEMO_LOGIN_ORG: ORG_ID, DEMO_LOGIN_TOKEN: DEMO_TOKEN });
    try {
        const wrong = await request(server.port, { path: `/admin/demo?token=${'z'.repeat(32)}` });
        const missing = await request(server.port, { path: '/admin/demo' });
        const empty = await request(server.port, { path: '/admin/demo?token=' });

        assert.equal(wrong.status, 404);
        assert.equal(missing.status, wrong.status, 'a missing token gives the same status as a wrong one');
        assert.equal(empty.status, wrong.status);
        assert.equal(missing.text, wrong.text, 'and the same body');
        assert.equal(empty.text, wrong.text);
        assert.equal(wrong.setCookie, null, 'no session is created for a bad token');
    } finally {
        await server.stop();
    }
});

test('a refused token reveals nothing about whether the demo is configured', async () => {
    const configured = await startServer({ DEMO_LOGIN: '1', DEMO_LOGIN_ORG: ORG_ID, DEMO_LOGIN_TOKEN: DEMO_TOKEN });
    const unconfigured = await startServer();
    try {
        const configuredBody = await request(configured.port, { path: `/admin/demo?token=${'z'.repeat(32)}` });
        const unconfiguredOut = await request(unconfigured.port, { path: `/admin/demo?token=${'z'.repeat(32)}` });

        assert.equal(/configured|enabled|demo exists/i.test(configuredBody.text), false, 'the refusal does not confirm the demo exists');
    } finally {
        await configured.stop();
        await unconfigured.stop();
    }
});

// ===========================================================================
// 6. EXPIRY CANNOT TURN A DEMO SESSION WRITABLE
// ===========================================================================
// `expires_at` is expired while the SESSION stays valid: if the guard read expiry, it might decide
// "not a demo any more" and allow a write.

test('an EXPIRED demo row is still read-only, and the write is refused', async () => {
    const server = await startServer({ DEMO_LOGIN: '1', DEMO_LOGIN_ORG: ORG_ID, DEMO_LOGIN_TOKEN: DEMO_TOKEN });
    try {
        const demo = await openDemo(server);
        const before = storedState();

        const admin = new DatabaseSync(path.join(STORE_DIR, 'admin.db'));
        admin.prepare("UPDATE demo_session SET expires_at = '2000-01-01T00:00:00Z'").run();
        const demoRows = admin.prepare('SELECT COUNT(*) AS n FROM demo_session').get().n;
        admin.close();
        assert.ok(demoRows > 0, 'a demo row exists to expire');

        const res = await request(server.port, { method: 'POST', path: '/admin/organisation/name', cookie: demo, form: { name: 'WRITTEN BY AN EXPIRED DEMO' } });

        assert.equal(res.status, 403, 'an expired demo row is still read-only');
        assert.deepEqual(storedState(), before, 'and nothing was written');
    } finally {
        await server.stop();
    }
});

test('a revoked demo session reaches no console page, only the sign-in form', async () => {
    // `GET /admin` serves the SIGN-IN FORM (200) without a valid session, so the signal is the
    // console content.
    const server = await startServer({ DEMO_LOGIN: '1', DEMO_LOGIN_ORG: ORG_ID, DEMO_LOGIN_TOKEN: DEMO_TOKEN });
    try {
        const demo = await openDemo(server);
        const before = await request(server.port, { path: '/admin', cookie: demo });
        assert.equal(before.status, 200);
        assert.match(before.text, /read[- ]only/i, 'the demo console really rendered before the revoke');

        const admin = new DatabaseSync(path.join(STORE_DIR, 'admin.db'));
        admin.prepare('UPDATE admin_session SET revoked_at = ? WHERE revoked_at IS NULL').run(new Date().toISOString());
        admin.close();

        const after = await request(server.port, { path: '/admin', cookie: demo });
        assert.equal(/read[- ]only/i.test(after.text), false, 'the read-only console does not render');

        const roadmap = await request(server.port, { path: '/admin/roadmap', cookie: demo });
        assert.equal(roadmap.status, 302, 'a console page redirects to the sign-in page');
    } finally {
        await server.stop();
    }
});

test('a demo session whose scope carries the ADMIN role is STILL refused writes', async () => {
    // The demo scope's synthetic user has role ADMIN, and the guard never reads role.
    const server = await startServer({ DEMO_LOGIN: '1', DEMO_LOGIN_ORG: ORG_ID, DEMO_LOGIN_TOKEN: DEMO_TOKEN });
    try {
        const demo = await openDemo(server);

        assert.equal((await request(server.port, { path: '/admin', cookie: demo })).status, 200, 'the demo has console read access');

        for (const [route, body] of MUTATING_ROUTES) {
            assert.equal(
                (await request(server.port, { method: 'POST', path: route, cookie: demo, form: body })).status,
                403,
                `POST ${route} refused despite the admin role`
            );
        }
    } finally {
        await server.stop();
    }
});

test('there is no third role: the demo flag rides on the session scope', () => {
    const users = fs.readFileSync(path.join(__dirname, '..', 'lib', 'users.js'), 'utf8');
    const roles = users.match(/ROLES\s*=\s*Object\.freeze\(\{([^}]*)\}/);
    assert.ok(roles, 'ROLES is declared as a frozen object');
    assert.match(roles[1], /ADMIN:\s*'admin'/, 'admin exists');
    assert.match(roles[1], /USER:\s*'user'/, 'user exists');
    assert.equal(/demo/i.test(roles[1]), false, 'no demo role was added');
});

// ===========================================================================
// 6. THE COPY, COUNTED - the product sentence and the pages that carry it
// ===========================================================================
//
// The product sentence appears on the console lead, the roadmap lead, and the banner, and the banner
// is DELIBERATELY not centralised: TWICE on a demo session is the design.

/** WHITESPACE-TOLERANT: the SOURCE line-breaks differ between the three places. */
const PRODUCT_SENTENCE = /forgeright interviews your team about the\s+work they do by hand, then ranks\s+what it finds by what is worth automating first/g;

const countOf = (text, pattern) => (text.match(pattern) ?? []).length;

test('the product sentence appears ONCE on an ordinary console and roadmap page', async () => {
    const server = await startServer();
    try {
        const admin = await signInAdmin(server, 'real@admin.test');

        const consolePage = await request(server.port, { path: '/admin', cookie: admin });
        assert.equal(consolePage.status, 200);
        assert.equal(countOf(consolePage.text, PRODUCT_SENTENCE), 1,
            'the console carries the product sentence exactly once');

        const roadmap = await request(server.port, { path: '/admin/roadmap', cookie: admin });
        assert.equal(roadmap.status, 200);
        assert.equal(countOf(roadmap.text, PRODUCT_SENTENCE), 1,
            'the roadmap carries it exactly once');
    } finally {
        await server.stop();
    }
});

test('the product sentence appears TWICE on a demo session - the banner AND the lead, by design', async () => {
    const server = await startServer({ DEMO_LOGIN: '1', DEMO_LOGIN_ORG: ORG_ID, DEMO_LOGIN_TOKEN: DEMO_TOKEN });
    try {
        const demo = await openDemo(server);
        const page = await request(server.port, { path: '/admin', cookie: demo });

        assert.equal(page.status, 200);
        assert.equal(countOf(page.text, PRODUCT_SENTENCE), 2,
            'a demo session sees it twice: the banner and the page lead');
        assert.match(page.text, /read-only demo/i, 'the banner is one occurrence');
    } finally {
        await server.stop();
    }
});

test('the roadmap renders TWO lead paragraphs, and the console has a lead where it had none', async () => {
    const server = await startServer();
    try {
        const admin = await signInAdmin(server, 'real@admin.test');
        const roadmap = await request(server.port, { path: '/admin/roadmap', cookie: admin });
        const consolePage = await request(server.port, { path: '/admin', cookie: admin });

        const roadmapLeads = countOf(roadmap.text, /<p class="intro">/g);
        assert.ok(roadmapLeads >= 2, `the roadmap renders at least two lead paragraphs (found ${roadmapLeads})`);
        assert.match(roadmap.text, /These are the processes your team described/,
            'the second lead says what the page shows');

        assert.match(consolePage.text, /<p class="intro">/,
            'the console has a lead paragraph where it had none');
    } finally {
        await server.stop();
    }
});

test('the OLD copy appears nowhere, and the removed developer sentence is gone', async () => {
    const server = await startServer();
    try {
        const admin = await signInAdmin(server, 'real@admin.test');
        const pages = await Promise.all([
            request(server.port, { path: '/admin', cookie: admin }),
            request(server.port, { path: '/admin/roadmap', cookie: admin }),
            request(server.port, { path: '/admin/answers', cookie: admin })
        ]);

        for (const page of pages) {
            assert.equal(page.text.includes('Why it got this weight'), false, 'the old heading is gone');
            assert.equal(page.text.includes('The name starts as a placeholder until it is set here'), false,
                'the removed developer sentence is not rendered');
        }
    } finally {
        await server.stop();
    }
});

test('`weight` is STILL the label beside the number - the metric was not renamed with the heading', async () => {
    const server = await startServer();
    try {
        const admin = await signInAdmin(server, 'real@admin.test');
        const roadmap = await request(server.port, { path: '/admin/roadmap', cookie: admin });

        assert.match(roadmap.text, /<div class="weight-label">weight<\/div>/,
            'the metric is still called `weight` beside its number');
    } finally {
        await server.stop();
    }
});

test('the console creation date still renders formatted, and is escaped', async () => {
    // `shortInstant` renders `YYYY-MM-DD HH:MM UTC`.
    const server = await startServer();
    try {
        const admin = await signInAdmin(server, 'real@admin.test');
        const page = await request(server.port, { path: '/admin', cookie: admin });

        assert.match(page.text, /Created \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/,
            'the creation date renders through shortInstant');
        // Escaping is covered by the injection tests in console-views.test.js.
    } finally {
        await server.stop();
    }
});

test('no em dash (U+2014) appears on any rendered console page', async () => {
    // House style: no em dash (U+2014) in user-facing copy; en-dash ranges are allowed.
    const server = await startServer();
    try {
        const admin = await signInAdmin(server, 'real@admin.test');
        const pages = await Promise.all([
            request(server.port, { path: '/admin', cookie: admin }),
            request(server.port, { path: '/admin/roadmap', cookie: admin }),
            request(server.port, { path: '/admin/answers', cookie: admin })
        ]);

        for (const page of pages) {
            assert.equal(page.text.includes('\u2014'), false, 'no em dash is rendered');
        }
    } finally {
        await server.stop();
    }
});
