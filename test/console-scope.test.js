/**
 * The admin console is scoped to the session, never to the request.
 *
 * THE PROPERTY, which is the one mistake in this area that shows a client another
 * client's data: a console route learns its organisation from the session, and
 * NEVER from a parameter, a query string, a body field or a path segment.
 * `scopeForSession` is meant to be the only place that happens; this file tests
 * that it is.
 *
 * INSPECT THE FILES, NOT THE STATUS CODE. A console action that returns 302 while
 * writing to the wrong organisation is exactly the failure this section exists to
 * catch, and only reading the organisation databases sees it.
 *
 * Follows the spawned-server pattern: own temp STORE_DIR, every environment
 * variable pinned, child stopped in cleanup. Sessions are obtained by signing in
 * through the real route, which consumes the login rate limit, so the number of
 * sign-ins is kept small and deliberate.
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
const SERVER = path.join(__dirname, '..', 'server.js');

const ALLOWED_HOST = 'allowed.example.test';
const STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-console-scope-'));

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

/** Every environment variable the child reads, pinned as its WHOLE environment. */
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
        MAIL_SENDER: 'console'
    };
}

/** One HTTP request with the trusted forwarded-protocol header. */
function request({ method = 'GET', path: urlPath = '/', form, cookie, headers = {} } = {}) {
    const payload = form === undefined ? undefined : new URLSearchParams(form).toString();
    return new Promise((resolve, reject) => {
        const h = {
            host: ALLOWED_HOST,
            'x-forwarded-proto': 'https',
            ...(cookie ? { cookie } : {}),
            ...(payload !== undefined
                ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(payload) }
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

// Set up inside before(): the sign-ins and console setup below need the child
// running, and top-level code would run before the server was listening.
let cookieA;
let cookieB;
let ORG_A;
let ORG_B;
let INVITATION_A;
let INVITATION_B;

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

    // Two organisations, each with an invitation, created through the real
    // console routes so the setup uses the same code path the tests then police.
    cookieA = await signIn('admin-a@scope.test');
    cookieB = await signIn('admin-b@scope.test');

    ORG_A = orgIdFor('admin-a@scope.test');
    ORG_B = orgIdFor('admin-b@scope.test');

    await postForm('/admin/invitations', cookieA, { email: 'invited-a@scope.test', department: 'Finance' });
    await postForm('/admin/invitations', cookieB, { email: 'invited-b@scope.test', department: 'Ops' });

    INVITATION_A = invitationsIn(ORG_A)[0];
    INVITATION_B = invitationsIn(ORG_B)[0];
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

// --- signing in and file-level evidence --------------------------------------

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

/** Runs a function against one organisation file, opening and closing it. */
function inOrgFile(orgId, fn) {
    const db = new DatabaseSync(path.join(STORE_DIR, 'orgs', `${orgId}.db`));
    try {
        return fn(db);
    } finally {
        db.close();
    }
}

function readAdmin(fn) {
    const db = new DatabaseSync(path.join(STORE_DIR, 'admin.db'));
    try {
        return fn(db);
    } finally {
        db.close();
    }
}

const orgIdFor = (email) => readAdmin((db) => db.prepare('SELECT organisation_id FROM users WHERE email = ?').get(email).organisation_id);
const userIdFor = (email) => readAdmin((db) => db.prepare('SELECT id FROM users WHERE email = ?').get(email).id);
const invitationsIn = (orgId) => inOrgFile(orgId, (db) => db.prepare('SELECT id, email, department FROM invitation ORDER BY email').all());
const orgNameIn = (orgId) => inOrgFile(orgId, (db) => db.prepare('SELECT name FROM organisation').get().name);
const tokenCountIn = (orgId) => inOrgFile(orgId, (db) => db.prepare('SELECT COUNT(*) AS n FROM participant_tokens').get().n);

// Two organisations are created in before() once the server is listening.

// ===========================================================================
// 1. THE CONSOLE LISTS ONLY ITS OWN ORGANISATION
// ===========================================================================

test('a forged organisation id in the QUERY on GET /admin is ignored by the listing', async () => {
    // The console's own GET must ignore a tenant in the query for what it LISTS,
    // not only for what it writes. A route that trusted the query here would show
    // B's invitations to A.
    const res = await request({ path: `/admin?organisationId=${ORG_B}&orgId=${ORG_B}&id=${ORG_B}`, cookie: cookieA });

    assert.equal(res.status, 200);
    assert.ok(res.text.includes('invited-a@scope.test'), "A's own invitation is listed");
    assert.equal(res.text.includes('invited-b@scope.test'), false, "B's invitation is NOT listed, despite the query");
    assert.equal(res.text.includes('admin-b@scope.test'), false, "B's users are NOT listed, despite the query");
});

test('a forged organisation id in the PATH of the console GET is ignored', async () => {
    // A path segment is the other shape a tenant could arrive in.
    const res = await request({ path: `/admin?organisationId=${ORG_B}`, cookie: cookieB });
    assert.ok(res.text.includes('invited-b@scope.test'), "B still sees only B's data");
    assert.equal(res.text.includes('invited-a@scope.test'), false);
});

test('A\'s console lists A\'s invitations and not B\'s', async () => {
    const res = await request({ path: '/admin', cookie: cookieA });
    assert.equal(res.status, 200);
    assert.ok(res.text.includes('invited-a@scope.test'), "A's invitation is shown");
    assert.equal(res.text.includes('invited-b@scope.test'), false, "B's invitation is not shown");
});

test('B\'s console lists B\'s invitations and not A\'s', async () => {
    const res = await request({ path: '/admin', cookie: cookieB });
    assert.equal(res.status, 200);
    assert.ok(res.text.includes('invited-b@scope.test'), "B's invitation is shown");
    assert.equal(res.text.includes('invited-a@scope.test'), false, "A's invitation is not shown");
});

test('each console lists only its own users', async () => {
    // Add a user to A, then check neither console shows the other's people.
    await postForm('/admin/users', cookieA, { email: 'staff-a@scope.test', role: 'user' });

    const consoleA = await request({ path: '/admin', cookie: cookieA });
    const consoleB = await request({ path: '/admin', cookie: cookieB });

    assert.ok(consoleA.text.includes('staff-a@scope.test'), "A's user is shown in A");
    assert.equal(consoleB.text.includes('staff-a@scope.test'), false, "A's user is not shown in B");
    assert.ok(consoleB.text.includes('admin-b@scope.test'), "B's own admin is in B");
    assert.equal(consoleA.text.includes('admin-b@scope.test'), false, "B's admin is not shown in A");
});

// ===========================================================================
// 2. A TENANT SUPPLIED IN THE REQUEST IS IGNORED
// ===========================================================================

test('a forged organisation id in the query string is ignored for a rename', async () => {
    // The strongest observable: rename A's organisation while naming B in the
    // query. If the query were honoured, B's NAME would change.
    const beforeB = orgNameIn(ORG_B);

    const res = await postForm(`/admin/organisation/name?organisationId=${ORG_B}&orgId=${ORG_B}&id=${ORG_B}`, cookieA, {
        name: 'Renamed by A'
    });
    assert.equal(res.status, 302, 'the rename is accepted');

    assert.equal(orgNameIn(ORG_A), 'Renamed by A', "A's own organisation was renamed");
    assert.equal(orgNameIn(ORG_B), beforeB, "B's organisation name is unchanged");
});

test('a forged organisation id in the BODY is ignored for a rename', async () => {
    const beforeB = orgNameIn(ORG_B);

    const res = await postForm('/admin/organisation/name', cookieA, {
        name: 'Renamed via body',
        organisationId: ORG_B,
        organisation_id: ORG_B,
        tenantId: ORG_B,
        organisation: JSON.stringify({ id: ORG_B })
    });
    assert.equal(res.status, 302);

    assert.equal(orgNameIn(ORG_A), 'Renamed via body', "A's own organisation was renamed");
    assert.equal(orgNameIn(ORG_B), beforeB, "B's organisation name is unchanged");
});

test('a forged organisation id is ignored when adding a user', async () => {
    const usersBeforeInB = readAdmin((db) => db.prepare('SELECT id FROM users WHERE organisation_id = ?').all(ORG_B).length);

    await postForm('/admin/users', cookieA, {
        email: 'forged-body@scope.test',
        role: 'user',
        organisationId: ORG_B,
        orgId: ORG_B,
        organisation: JSON.stringify({ id: ORG_B })
    });

    const created = readAdmin((db) => db.prepare('SELECT organisation_id FROM users WHERE email = ?').get('forged-body@scope.test'));
    assert.equal(created.organisation_id, ORG_A, 'the user joined the SESSION organisation');
    assert.equal(
        readAdmin((db) => db.prepare('SELECT id FROM users WHERE organisation_id = ?').all(ORG_B).length),
        usersBeforeInB,
        'no user was added to B'
    );
});

test('a forged organisation id is ignored when creating an invitation', async () => {
    const beforeInB = invitationsIn(ORG_B).length;

    await postForm('/admin/invitations?organisationId=' + ORG_B, cookieA, {
        email: 'forged-invitation@scope.test',
        department: 'Finance',
        organisationId: ORG_B
    });

    assert.ok(invitationsIn(ORG_A).some((i) => i.email === 'forged-invitation@scope.test'), 'the invitation is in A');
    assert.equal(invitationsIn(ORG_B).length, beforeInB, 'nothing landed in B');
});

// ===========================================================================
// 3. A'S INVITATION ID USED WITH B'S SESSION IS REFUSED
// ===========================================================================

test('A\'s invitation id with B\'s session is refused for send, and B is unchanged', async () => {
    const beforeA = tokenCountIn(ORG_A);
    const beforeB = tokenCountIn(ORG_B);

    const res = await postForm(`/admin/invitations/${INVITATION_A.id}/send`, cookieB, {});

    assert.equal(res.status, 404, 'the invitation is not found in B');
    assert.equal(tokenCountIn(ORG_A), beforeA, "no token was issued in A");
    assert.equal(tokenCountIn(ORG_B), beforeB, "no token was issued in B");
});

test('A\'s invitation id with B\'s session is refused for reset, and B is unchanged', async () => {
    const beforeA = tokenCountIn(ORG_A);
    const beforeB = tokenCountIn(ORG_B);

    const res = await postForm(`/admin/invitations/${INVITATION_A.id}/reset`, cookieB, {});

    assert.equal(res.status, 404);
    assert.equal(tokenCountIn(ORG_A), beforeA, 'no token was revoked or issued in A');
    assert.equal(tokenCountIn(ORG_B), beforeB, 'B is untouched');
});

// ===========================================================================
// 4. A'S USER ID USED WITH B'S SESSION IS REFUSED
// ===========================================================================

test('B\'s user id with A\'s session is refused for a role change, and B is unchanged', async () => {
    // The route where the consequence is longest-lived: a role change that landed
    // in the wrong organisation would grant or remove access across tenants.
    const userB = userIdFor('admin-b@scope.test');
    const roleBefore = readAdmin((db) => db.prepare('SELECT role FROM users WHERE id = ?').get(userB).role);
    assert.equal(roleBefore, 'admin');

    const res = await postForm(`/admin/users/${userB}/role`, cookieA, { role: 'user' });

    assert.notEqual(res.status, 302, 'the change is refused, not redirected as a success');
    assert.equal(
        readAdmin((db) => db.prepare('SELECT role FROM users WHERE id = ?').get(userB).role),
        'admin',
        "B's user role is unchanged"
    );
});

test('a role change for a user in this organisation DOES work', async () => {
    // The control: the same route succeeds for a user in the session's own
    // organisation, so the refusal above is about scoping and not a dead route.
    await postForm('/admin/users', cookieA, { email: 'promote-me@scope.test', role: 'user' });
    const target = userIdFor('promote-me@scope.test');
    assert.equal(readAdmin((db) => db.prepare('SELECT role FROM users WHERE id = ?').get(target).role), 'user');

    const res = await postForm(`/admin/users/${target}/role`, cookieA, { role: 'admin' });

    assert.equal(res.status, 302, 'the change is accepted');
    assert.equal(
        readAdmin((db) => db.prepare('SELECT role FROM users WHERE id = ?').get(target).role),
        'admin',
        'the role actually changed'
    );
});

// ===========================================================================
// 5. AN UNAUTHENTICATED REQUEST REDIRECTS
// ===========================================================================

test('an unauthenticated request to every console sub-route redirects to the sign-in page', async () => {
    for (const [method, urlPath] of [
        ['GET', '/admin'],
        ['POST', '/admin/organisation/name'],
        ['POST', '/admin/invitations'],
        ['POST', `/admin/invitations/${INVITATION_A.id}/send`],
        ['POST', `/admin/invitations/${INVITATION_A.id}/reset`],
        ['POST', '/admin/users'],
        ['POST', `/admin/users/${userIdFor('admin-a@scope.test')}/role`]
    ]) {
        const res = await request({ method, path: urlPath, form: method === 'POST' ? {} : undefined });
        // GET /admin serves the sign-in form itself (the page an admin bookmarks);
        // every other route redirects there. Neither serves console data.
        if (method === 'GET' && urlPath === '/admin') {
            assert.equal(res.status, 200, 'GET /admin serves the sign-in form');
            assert.equal(res.text.includes('invited-a@scope.test'), false, 'but no console data');
        } else {
            assert.equal(res.status, 302, `${method} ${urlPath} must redirect`);
            assert.match(res.location, /\/admin/, `${method} ${urlPath} redirects to the sign-in page`);
        }
    }
});

// ===========================================================================
// 6. THE ROLE CONTROL IS ADMIN-ONLY IN EFFECT
// ===========================================================================

test('a `user`-role session cannot reach ANY console route, even by guessing the URL', async () => {
    // Section 3 covered the sign-in redirect. This covers the routes themselves:
    // a `user` who is signed in must be refused by the guard, not merely steered
    // away from a link. The account is created through the console route, so it
    // belongs to A without importing the store into this process.
    await postForm('/admin/users', cookieA, { email: 'limited@scope.test', role: 'user' });
    const cookieLimited = await signIn('limited@scope.test');

    for (const [method, urlPath] of [
        ['GET', '/admin'],
        ['POST', '/admin/organisation/name'],
        ['POST', '/admin/invitations'],
        ['POST', '/admin/users'],
        ['POST', `/admin/users/${userIdFor('admin-a@scope.test')}/role`]
    ]) {
        const res = await request({ method, path: urlPath, cookie: cookieLimited, form: method === 'POST' ? {} : undefined });
        assert.equal(res.status, 403, `${method} ${urlPath} is forbidden for a plain user`);
    }
});

// ===========================================================================
// 7. THE TWO TOKEN ACTIONS REACH THE STORE
// ===========================================================================

test('Send a link with a REAL invitation id succeeds and issues a token in the session\'s organisation', async () => {
    const before = tokenCountIn(ORG_A);

    const res = await postForm(`/admin/invitations/${INVITATION_A.id}/send`, cookieA, {});

    assert.equal(res.status, 302, 'the action succeeds');
    assert.equal(tokenCountIn(ORG_A), before + 1, 'exactly one token was issued in A');
});

test('Reset all access with a REAL invitation id succeeds and revokes the tokens', async () => {
    const before = tokenCountIn(ORG_A);

    const res = await postForm(`/admin/invitations/${INVITATION_A.id}/reset`, cookieA, {});

    assert.equal(res.status, 302, 'the action succeeds');
    // A reset revokes every live token and issues one, so the count grows by one
    // and exactly one is live.
    assert.equal(tokenCountIn(ORG_A), before + 1, 'one replacement token was issued in A');
    const live = inOrgFile(ORG_A, (db) => db.prepare(
        'SELECT COUNT(*) AS n FROM participant_tokens WHERE invitation_id = ? AND revoked_at IS NULL'
    ).get(INVITATION_A.id).n);
    assert.equal(live, 1, 'exactly one live token after the reset');
});

test('Send a link and Reset all access with a FAKE id are refused with 404', async () => {
    // The reviewer claimed these could never match a real id. They do; this pins
    // that a fake id is correctly refused, without asserting the buttons broken.
    const send = await postForm('/admin/invitations/not-a-real-id/send', cookieA, {});
    const reset = await postForm('/admin/invitations/not-a-real-id/reset', cookieA, {});

    assert.equal(send.status, 404, 'a fake id is refused for send');
    assert.equal(reset.status, 404, 'a fake id is refused for reset');
});

test('a forged organisation in the BODY of the token actions is ignored', async () => {
    // The token actions are the routes where a body field could plausibly be
    // trusted. Each must act on the session's organisation regardless.
    const beforeA = tokenCountIn(ORG_A);
    const beforeB = tokenCountIn(ORG_B);

    const send = await postForm(`/admin/invitations/${INVITATION_A.id}/send`, cookieA, {
        organisationId: ORG_B,
        orgId: ORG_B,
        organisation: JSON.stringify({ id: ORG_B })
    });
    assert.equal(send.status, 302, 'the send succeeds against A');
    assert.equal(tokenCountIn(ORG_A), beforeA + 1, 'A gained a token');
    assert.equal(tokenCountIn(ORG_B), beforeB, 'B gained none');

    const reset = await postForm(`/admin/invitations/${INVITATION_A.id}/reset`, cookieA, {
        organisationId: ORG_B,
        orgId: ORG_B
    });
    assert.equal(reset.status, 302, 'the reset succeeds against A');
    assert.equal(tokenCountIn(ORG_B), beforeB, 'B is still untouched after the reset');
    const liveInB = inOrgFile(ORG_B, (db) => db.prepare(
        'SELECT COUNT(*) AS n FROM participant_tokens WHERE invitation_id = ? AND revoked_at IS NULL'
    ).get(INVITATION_B.id).n);
    assert.equal(liveInB, 1, "B's own invitation still has its token, untouched by A's forged call");
});
