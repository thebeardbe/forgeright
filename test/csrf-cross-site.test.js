/**
 * M9: refusing a console write that came from another site, and the cookie that backs it up.
 *
 * THE DEFECT, in two halves and one rule.
 *
 * SameSite=Lax is scoped to the REGISTRABLE DOMAIN, not the host, so every `*.bunkens.be` site is the
 * SAME SITE to the browser. A page on a sibling subdomain therefore drove the console with the admin's
 * cookie attached. lib/auth/csrf.js refuses a state-changing request that says it came from elsewhere.
 *
 * The other half is the cookie. `__Host-` makes a browser refuse a cookie that carries a `Domain`
 * attribute, so a sibling subdomain cannot plant or shadow one.
 *
 * WHY EVERY ROUTE IS TESTED, NOT ONE. The guard is mounted once, but a route added above the mount, or a
 * route that is exempted by mistake, is exactly the hole this exists to close. A test at
 * `/admin/organisation/name` says nothing about the other seven, so all eight console routes are driven,
 * and each one asserts the STORE did not change, not only the status.
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
const STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-csrf-'));
process.env.STORE_DIR = STORE_DIR;
process.env.SESSION_SECRET = 'c'.repeat(64);

const store = await import('../lib/store/index.js');
const users = await import('../lib/users.js');
const csrf = await import('../lib/auth/csrf.js');
const session = await import('../lib/auth/session.js');

const DEMO_TOKEN = 'demo-token-for-the-csrf-test-file-0001';

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

const baseEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    BASE_PATH: '',
    TRUST_PROXY: '127.0.0.1',
    // BOTH hostnames: the secure tests answer for ALLOWED_HOST, and the plain-HTTP tests must arrive on a
    // LOOPBACK host (requireSecureConnection exempts only that), so the host guard has to accept it too.
    ALLOWED_HOST: `${ALLOWED_HOST},127.0.0.1,localhost`,
    SESSION_SECRET: 'c'.repeat(64),
    STORE_DIR,
    AI_PROVIDER: 'mock',
    MAIL_SENDER: 'console'
};

/**
 * One request, with the provenance headers as a parameter, because they are the whole subject.
 *
 * `x-forwarded-proto` decides whether the server thinks the connection is secure, and TRUST_PROXY is set
 * to 127.0.0.1 so it is believed. That is how both cookie configurations are reached on one test run.
 */
/**
 * A distinct client address per request.
 *
 * THE SIGN-IN ROUTE IS RATE LIMITED to 10 per IP per 15 minutes and 3 per address, and several tests here
 * need a session of their own. TRUST_PROXY is 127.0.0.1 and the test connects from loopback, so
 * `x-forwarded-for` is believed and each request can be a separate client, exactly as separate visitors
 * are. The limit is not bypassed: the app really is reading a different address.
 */
let clientCounter = 0;
function nextClientAddress() {
    clientCounter += 1;
    return `10.9.${Math.floor(clientCounter / 250) % 250}.${(clientCounter % 250) + 1}`;
}

function request({
    method = 'GET', urlPath = '/', form, json, headers = {}, cookie, secure = true,
    plainLoopback = false
} = {}) {
    let payload;
    let contentType;
    if (json !== undefined) {
        payload = JSON.stringify(json);
        contentType = 'application/json';
    } else if (form !== undefined) {
        payload = new URLSearchParams(form).toString();
        contentType = 'application/x-www-form-urlencoded';
    }

    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port: PORT,
            path: urlPath,
            method,
            headers: {
                // A plain-HTTP run is only served on a LOOPBACK host; requireSecureConnection answers 308
                // for anything else. That is how the unprefixed cookie configuration is reached.
                host: plainLoopback ? '127.0.0.1' : ALLOWED_HOST,
                ...(secure && !plainLoopback ? { 'x-forwarded-proto': 'https' } : {}),
                ...(payload !== undefined
                    ? { 'content-type': contentType, 'content-length': Buffer.byteLength(payload) }
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

const postForm = (urlPath, form, opts = {}) => request({ method: 'POST', urlPath, form, ...opts });
const postJson = (urlPath, json, opts = {}) => request({ method: 'POST', urlPath, json, ...opts });

let child;
let childOutput = '';

before(async () => {
    child = spawn(process.execPath, [SERVER], {
        env: {
            ...baseEnv,
            PORT: String(PORT),
            PUBLIC_BASE_URL: `https://${ALLOWED_HOST}`,
            DEMO_LOGIN: '',
            DEMO_LOGIN_ORG: '',
            DEMO_LOGIN_TOKEN: ''
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', (chunk) => { childOutput += chunk; });
    child.stderr.on('data', (chunk) => { childOutput += chunk; });

    const deadline = Date.now() + 10000;
    for (;;) {
        try {
            const res = await request({ urlPath: '/healthz' });
            if (res.status === 200) break;
        } catch {
            // not up yet
        }
        if (Date.now() > deadline) throw new Error(`server did not start:\n${childOutput}`);
        await new Promise((r) => setTimeout(r, 50));
    }
});

after(async () => {
    if (child && !child.killed) {
        await new Promise((resolve) => {
            child.once('exit', resolve);
            child.kill('SIGTERM');
            const force = setTimeout(() => { child.kill('SIGKILL'); }, 3000);
            force.unref();
        });
    }
    store.closeAll();
    fs.rmSync(STORE_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Signing in, the way a browser does, so the cookie under test is the real one
// ---------------------------------------------------------------------------

/** Reads the session cookie from a verify response's Set-Cookie headers, as `name=value`. */
function sessionCookieFrom(setCookie) {
    for (const header of setCookie) {
        const [pair] = header.split(';');
        const name = pair.split('=')[0];
        if (name === '__Host-fr_admin' || name === 'fr_admin') return pair;
    }
    return null;
}

let adminCookie;
let adminOrgId;

/**
 * ONE extra sign-in, cached, because the route is rate limited to 10 per IP per 15 minutes and 3 per
 * address. Several tests need the Set-Cookie headers, and signing in per test would exhaust the bucket and
 * make a later test fail for a reason unrelated to what it checks.
 *
 * The tests that need a session OF THEIR OWN (logout revokes it) still sign in, and there are few enough.
 */
let sharedSecureCookieHeader;
let sharedSecureSessionPair;

/** A session of its own, for a test that will end it. */
async function freshSession(email) {
    childOutput = '';
    await postForm('/admin/login', { email });
    const match = childOutput.match(/token=([A-Za-z0-9_-]{43})/);
    assert.ok(match, `the sign-in link for ${email} was mailed`);
    const verify = await request({ urlPath: `/admin/login/verify?token=${match[1]}` });
    const pair = sessionCookieFrom(verify.setCookie);
    assert.ok(pair, `a session cookie was set for ${email}`);
    return pair;
}

/** A reply to one console route: what it needs, and how to read back whether it changed anything. */
const ROUTES = [];

test('signing in as the first admin defines the session every route below uses', async () => {
    childOutput = '';
    await postForm('/admin/login', { email: 'csrf-admin@csrf.test' });
    const match = childOutput.match(/token=([A-Za-z0-9_-]{43})/);
    assert.ok(match, 'the sign-in link was mailed and captured from the console sender');

    const verify = await request({ urlPath: `/admin/login/verify?token=${match[1]}` });
    assert.equal(verify.status, 302, 'redeeming the link redirects into the console');
    adminCookie = sessionCookieFrom(verify.setCookie || []);
    assert.ok(adminCookie, `a session cookie was set (got ${JSON.stringify(verify.setCookie)})`);

    // The organisation id is read from the admin database, which is where the sign-in put it.
    const { DatabaseSync } = await import('node:sqlite');
    const adminDb = new DatabaseSync(path.join(STORE_DIR, 'admin.db'), { readOnly: true });
    let adminRow;
    try {
        adminRow = adminDb.prepare('SELECT id, organisation_id, role FROM users ORDER BY created_at LIMIT 1').get();
    } finally {
        adminDb.close();
    }
    assert.ok(adminRow, 'the sign-in provisioned a user');
    adminOrgId = adminRow.organisation_id;
    assert.equal(adminRow.role, 'admin', 'the first sign-in is the admin');
    assert.ok(adminOrgId, 'the organisation exists');

    // The fixtures the two parameterised routes need, created in-process so the console's own routes are
    // not used to set up the tests that check those routes.
    store.addInvitation(adminOrgId, { email: 'csrf-participant@csrf.test', department: 'Ops' });
    store.addInvitation(adminOrgId, { email: 'csrf-role@csrf.test', department: 'Ops' });
    const roleUser = users.addUserToOrganisation({ organisationId: adminOrgId, email: 'csrf-user@csrf.test' });
    users.setUserRole({ organisationId: adminOrgId, userId: roleUser.user.id, role: 'user' });

    buildRoutes(roleUser.user.id);

    // One more sign-in for the cookie-shape tests, cached here.
    sharedSecureSessionPair = await freshSession('cookie-shape@csrf.test');
    childOutput = '';
    await postForm('/admin/login', { email: 'cookie-header@csrf.test' });
    const headerMatch = childOutput.match(/token=([A-Za-z0-9_-]{43})/);
    const headerVerify = await request({ urlPath: `/admin/login/verify?token=${headerMatch[1]}` });
    sharedSecureCookieHeader = (headerVerify.setCookie || [])[0];
    assert.ok(sharedSecureCookieHeader, 'the shared cookie header was captured');
});

function buildRoutes(roleUserId) {
    const invitation = store.listInvitations(adminOrgId)[0];
    const responseId = 'response-for-a-correct-test';

    ROUTES.push(
        {
            name: 'POST /admin/organisation/name',
            path: '/admin/organisation/name',
            form: { name: 'CSRF-OWNED' },
            changed: () => store.getOrganisation(adminOrgId).name === 'CSRF-OWNED',
            restore: () => {} // the assertion is that it never became CSRF-OWNED
        },
        {
            name: 'POST /admin/invitations',
            path: '/admin/invitations',
            form: { email: 'csrf-invited@csrf.test', department: 'Sales' },
            changed: () => store.listInvitations(adminOrgId)
                .some((i) => i.email === 'csrf-invited@csrf.test'),
            restore: () => {}
        },
        {
            name: 'POST /admin/invitations/:id/send',
            path: `/admin/invitations/${invitation.id}/send`,
            form: {},
            changed: () => liveTokens(adminOrgId, invitation.id).length
                > liveTokensBefore(invitation.id),
            prepare: () => snapshotLiveTokens(invitation.id),
            restore: () => {}
        },
        {
            name: 'POST /admin/invitations/:id/reset',
            path: `/admin/invitations/${invitation.id}/reset`,
            form: {},
            changed: () => {
                const tokens = liveTokens(adminOrgId, invitation.id);
                // A reset revokes every token and mints one, so the live set is replaced rather than
                // extended. Any change at all is the failure.
                return tokens.length !== 1
                    || tokens.some((t) => beforeResetHashes(invitation.id).has(t.token_hash) === false);
            },
            prepare: () => snapshotResetHashes(invitation.id),
            restore: () => {}
        },
        {
            name: 'POST /admin/users',
            path: '/admin/users',
            form: { email: 'csrf-added-user@csrf.test', role: 'user' },
            changed: () => users.listUsersForOrganisation(adminOrgId)
                .some((u) => u.email === 'csrf-added-user@csrf.test'),
            restore: () => {}
        },
        {
            name: 'POST /admin/users/:id/role',
            path: `/admin/users/${roleUserId}/role`,
            form: { role: 'admin' },
            changed: () => users.listUsersForOrganisation(adminOrgId)
                .find((u) => u.id === roleUserId)?.role === 'admin',
            restore: () => users.setUserRole({ organisationId: adminOrgId, userId: roleUserId, role: 'user' })
        },
        {
            name: 'POST /admin/answers/:id/rejudge',
            path: `/admin/answers/${responseId}/rejudge`,
            form: { reason: 'a cross-site reason' },
            // A redirect carrying an outcome is the visible trace of the handler having run: the route
            // answers 302 on every path, so the store is not the only place to look.
            changed: (res) => res.status !== 403
                && /rejudged=/.test(res.location || ''),
            restore: () => {}
        },
        {
            name: 'POST /admin/answers/:id/correct',
            path: `/admin/answers/${responseId}/correct`,
            form: { field: 'minutesPerInstance', value: '999999', reason: 'a cross-site reason' },
            changed: (res) => res.status !== 403
                && /notice=|error=/.test(res.location || ''),
            restore: () => {}
        },
        {
            name: 'POST /admin/roadmap/:id/rejudge',
            path: `/admin/roadmap/${responseId}/rejudge`,
            form: { reason: 'a cross-site reason' },
            changed: (res) => res.status !== 403
                && /rejudged=/.test(res.location || ''),
            restore: () => {}
        },
        {
            name: 'POST /admin/login (the sign-in action)',
            path: '/admin/login',
            form: { email: 'csrf-signin-probe@csrf.test' },
            // Signing in mails a link; the mail is the side effect, read from the child's output.
            changed: () => /csrf-signin-probe@csrf\.test/.test(childOutputSinceProbe),
            prepare: () => { childOutputSinceProbe = ''; },
            restore: () => {}
        }
    );
}

// Snapshots the two parameterised routes compare against.
const liveTokenCounts = new Map();
const resetHashes = new Map();
let childOutputSinceProbe = '';

/** The tokens still live on an invitation. `listTokensForInvitation` returns rows each carrying `live`. */
const liveTokens = (orgId, invitationId) =>
    store.listTokensForInvitation(orgId, invitationId).filter((t) => t.live);

function snapshotLiveTokens(invitationId) {
    liveTokenCounts.set(invitationId, liveTokens(adminOrgId, invitationId).length);
}

const liveTokensBefore = (invitationId) => liveTokenCounts.get(invitationId) ?? 0;

function snapshotResetHashes(invitationId) {
    resetHashes.set(
        invitationId,
        new Set(store.listTokensForInvitation(adminOrgId, invitationId).map((t) => t.token_hash))
    );
}

const beforeResetHashes = (invitationId) => resetHashes.get(invitationId) ?? new Set();

// ===========================================================================
// 1. THE DEFECT: a cross-origin POST with a valid cookie, at EVERY route
// ===========================================================================

/** The provenance headers a page on a sibling subdomain produces. */
const CROSS_SITE_HEADERS = {
    'Sec-Fetch-Site': 'cross-site',
    Origin: 'https://evil.bunkens.be'
};

test('every console write refuses a request from another ORIGIN, and the store did not change', async () => {
    // One test per route would be eight near-identical tests; this drives all of them and names the one
    // that failed, so a hole is still reported as a hole.
    const failures = [];

    for (const route of ROUTES) {
        if (route.prepare) route.prepare();
        childOutputSinceProbe = '';

        const res = await postForm(route.path, route.form, {
            cookie: adminCookie,
            // Origin only, no Sec-Fetch-Site: the older way a browser says where it is.
            headers: { Origin: 'https://evil.bunkens.be' }
        });

        if (res.status !== 403) failures.push(`${route.name}: status ${res.status}, expected 403`);
        if (route.changed(res)) failures.push(`${route.name}: THE STATE CHANGED`);

        route.restore();
    }

    assert.deepEqual(failures, [], `cross-origin writes were not all refused:\n${failures.join('\n')}`);
});

test('the same for Sec-Fetch-Site: cross-site, at every console write', async () => {
    const failures = [];

    for (const route of ROUTES) {
        if (route.prepare) route.prepare();
        childOutputSinceProbe = '';

        const res = await postForm(route.path, route.form, {
            cookie: adminCookie,
            headers: { 'Sec-Fetch-Site': 'cross-site' }
        });

        if (res.status !== 403) failures.push(`${route.name}: status ${res.status}, expected 403`);
        if (route.changed(res)) failures.push(`${route.name}: THE STATE CHANGED`);

        route.restore();
    }

    assert.deepEqual(failures, [], `cross-site writes were not all refused:\n${failures.join('\n')}`);
});

test('the same for Sec-Fetch-Site: same-site - the SIBLING SUBDOMAIN case', async () => {
    // THIS IS THE DEFECT ITSELF. SameSite=Lax lets a sibling subdomain's request through, and the browser
    // labels it `same-site`, not `cross-site`. A browser on another registrable domain says `cross-site`;
    // a sibling subdomain says `same-site`. If only the first were refused, the reported attack would
    // still work.
    const failures = [];

    for (const route of ROUTES) {
        if (route.prepare) route.prepare();
        childOutputSinceProbe = '';

        const res = await postForm(route.path, route.form, {
            cookie: adminCookie,
            headers: { 'Sec-Fetch-Site': 'same-site', Origin: 'https://evil.bunkens.be' }
        });

        if (res.status !== 403) failures.push(`${route.name}: status ${res.status}, expected 403`);
        if (route.changed(res)) failures.push(`${route.name}: THE STATE CHANGED`);

        route.restore();
    }

    assert.deepEqual(failures, [], `same-site writes were not all refused:\n${failures.join('\n')}`);
});

test('the organisation rename specifically did NOT happen, and its name is untouched', async () => {
    // The measured attack from the commit message, asserted on the store by name, so the sabotage value
    // cannot appear anywhere.
    const before = store.getOrganisation(adminOrgId).name;

    const res = await postForm('/admin/organisation/name', { name: 'CSRF-OWNED' }, {
        cookie: adminCookie,
        headers: CROSS_SITE_HEADERS
    });

    assert.equal(res.status, 403);
    assert.equal(store.getOrganisation(adminOrgId).name, before, 'the name is unchanged');
    assert.notEqual(store.getOrganisation(adminOrgId).name, 'CSRF-OWNED', 'and is not the sabotage value');
});

test('a cookie-less cross-origin POST is refused too, so the guard is before the session check', async () => {
    // Order matters: the guard runs first, so a refusal is about provenance rather than about signing in.
    const res = await postForm('/admin/organisation/name', { name: 'CSRF-OWNED' }, {
        headers: CROSS_SITE_HEADERS
    });

    assert.equal(res.status, 403);
    assert.equal(store.getOrganisation(adminOrgId).name === 'CSRF-OWNED', false);
});

// ===========================================================================
// 2. THE ALLOWED CASES - the ones that would lock a real admin out
// ===========================================================================

test('a SAME-ORIGIN write still works, and the store changed', async () => {
    const res = await postForm('/admin/organisation/name', { name: 'Renamed from the console' }, {
        cookie: adminCookie,
        headers: { 'Sec-Fetch-Site': 'same-origin', Origin: `https://${ALLOWED_HOST}` }
    });

    assert.equal(res.status, 302, 'it redirects back to the console as usual');
    assert.equal(store.getOrganisation(adminOrgId).name, 'Renamed from the console',
        'and the rename happened');
});

test('a same-origin write with Origin and no Sec-Fetch-Site also works', async () => {
    const res = await postForm('/admin/organisation/name', { name: 'Older browser rename' }, {
        cookie: adminCookie,
        headers: { Origin: `https://${ALLOWED_HOST}` }
    });

    assert.equal(res.status, 302);
    assert.equal(store.getOrganisation(adminOrgId).name, 'Older browser rename');
});

test('NO HEADERS AT ALL still works - the deliberate decision, for old browsers and proxies', async () => {
    // WHAT THIS GIVES UP is recorded in lib/auth/csrf.js: an old browser or a proxy sends neither header
    // and would otherwise be locked out of its own console. An attacker gains nothing, because a page on
    // a sibling subdomain runs in a current browser and current browsers send Sec-Fetch-Site.
    const res = await postForm('/admin/organisation/name', { name: 'No headers at all' }, {
        cookie: adminCookie
    });

    assert.equal(res.status, 302, 'a console write with no provenance headers is carried out');
    assert.equal(store.getOrganisation(adminOrgId).name, 'No headers at all');
});

test('Origin: null is ALLOWED - the case that broke a real admin, pinned so it cannot regress', async () => {
    // READ THIS BEFORE "FIXING" IT. `null` LOOKS like the most foreign origin possible, and treating it
    // as foreign is the mistake that was made and then repaired.
    //
    // MEASURED: Chromium 154 sends `Origin: null`, with NO Sec-Fetch-Site, for an ordinary SAME-ORIGIN
    // form POST from a page served over plain HTTP. Refusing it refused a real admin's rename in a real
    // browser, which takes the console down for every legitimate user while stopping no attacker: an
    // attacking page is also a browser, and the browser that sends `null` here also sends no
    // Sec-Fetch-Site, so it lands in the same "cannot tell" case either way.
    //
    // So `null` means "this browser did not say", exactly like an absent header. The defence that does
    // not depend on either header is the `__Host-` cookie, tested in section 3.
    const res = await postForm('/admin/organisation/name', { name: 'Chromium over plain HTTP' }, {
        cookie: adminCookie,
        headers: { Origin: 'null' }
    });

    assert.equal(res.status, 302, 'Origin: null is not treated as foreign');
    assert.equal(store.getOrganisation(adminOrgId).name, 'Chromium over plain HTTP');
});

test('Origin: null with no Sec-Fetch-Site is the exact shape Chromium sends', async () => {
    // The condition stated precisely: `null` ALONE. Narrower than the test above, which would still pass
    // if some other header carried the decision.
    const res = await postForm('/admin/organisation/name', { name: 'Null origin alone' }, {
        cookie: adminCookie,
        headers: { Origin: 'null', 'Sec-Fetch-Site': '' }
    });

    assert.equal(res.status, 302);
    assert.equal(store.getOrganisation(adminOrgId).name, 'Null origin alone');
});

test('a GET is never refused, whatever its provenance', async () => {
    // Reads do not change state, and every console link is a GET. Refusing them would break navigation.
    const res = await request({
        urlPath: '/admin', cookie: adminCookie, headers: CROSS_SITE_HEADERS
    });

    assert.equal(res.status, 200, 'the console page still loads');
});

// ===========================================================================
// 3. THE COOKIE
// ===========================================================================

test('SECURE connection: the cookie is __Host-fr_admin with Path=/ and Secure', async () => {
    const header = sharedSecureCookieHeader;
    assert.ok(header, 'a cookie was set');

    assert.match(header, /^__Host-fr_admin=/, 'the __Host- prefixed name');
    // ANCHORED: `Path=/` must be the WHOLE value. Without the anchor, `Path=/` matches the prefix of
    // `Path=/admin`, and a mutation that narrowed the path passed this test.
    assert.match(header, /;\s*Path=\/(?:;\s*|$)/i, 'Path=/ exactly');
    assert.match(header, /;\s*Secure/i, 'and Secure');
});

test('__Host-fr_admin carries NO Domain attribute - the property that stops a sibling planting it', async () => {
    // The whole point of the prefix: a browser REFUSES a __Host- cookie that carries Domain. So a page on
    // a sibling subdomain cannot write Domain=bunkens.be and plant or shadow a session.
    const header = sharedSecureCookieHeader;

    assert.equal(/;\s*Domain=/i.test(header), false,
        `no Domain attribute anywhere in it (got ${header})`);
});

test('PLAIN HTTP on loopback: the cookie is fr_admin with Path=/admin', async () => {
    // A `__Host-` cookie without Secure is DISCARDED by the browser, and this app supports a plain-HTTP
    // run on loopback, so the prefixed name there would silently drop the session and make sign-in look
    // broken.
    //
    // LOOPBACK HOST, because that is the only way the app serves plain HTTP at all:
    // requireSecureConnection answers 308 for anything else, and exempts a loopback peer with a loopback
    // Host header.
    childOutput = '';
    await request({ method: 'POST', urlPath: '/admin/login', form: { email: 'cookie-plain@csrf.test' }, plainLoopback: true });
    const match = childOutput.match(/token=([A-Za-z0-9_-]{43})/);
    assert.ok(match, 'the plain-HTTP sign-in mailed a link');

    const verify = await request({ urlPath: `/admin/login/verify?token=${match[1]}`, plainLoopback: true });
    assert.equal(verify.status, 302, `the loopback plain-HTTP sign-in works (got ${verify.status})`);
    const header = (verify.setCookie || [])[0];
    assert.ok(header, 'a cookie was set');

    assert.match(header, /^fr_admin=/, 'the unprefixed name');
    assert.match(header, /;\s*Path=\/admin(?:;\s*|$)/i, 'Path=/admin exactly');
    assert.equal(/;\s*Secure/i.test(header), false, 'and it is not marked Secure, or the browser drops it');
});

test('BOTH names are accepted when READING, so a deploy does not sign everyone out', async () => {
    // The value is what the server minted; only the NAME differs. Both must resolve, because a session
    // issued before the rename is still live in a browser that has not reloaded.
    const pair = sharedSecureSessionPair;
    const value = pair.slice(pair.indexOf('=') + 1);

    const prefixed = await request({
        urlPath: '/admin', headers: { 'Sec-Fetch-Site': 'same-origin' }, cookie: `__Host-fr_admin=${value}`
    });
    const legacy = await request({
        urlPath: '/admin', headers: { 'Sec-Fetch-Site': 'same-origin' }, cookie: `fr_admin=${value}`
    });

    // THE CONTENT, NOT THE STATUS. `GET /admin` answers 200 to an anonymous visitor too, rendering the
    // sign-in form, so a status assertion here would pass with the session unreadable. "Sign out" exists
    // only on the console page.
    const reachedConsole = (res) => /Sign out/i.test(res.text);
    assert.equal(reachedConsole(prefixed), true, '__Host-fr_admin is read, and reaches the console');
    assert.equal(reachedConsole(legacy), true, 'and the older fr_admin name is read too');
});

test('LOGOUT clears BOTH names on a secure connection, so a pre-rename session also signs out', async () => {
    const res = await postForm('/admin/logout', {}, {
        cookie: adminCookie, headers: { 'Sec-Fetch-Site': 'same-origin' }
    });

    assert.equal(res.status, 302, 'logout redirects');
    const headers = res.setCookie.join('\n');
    assert.match(headers, /__Host-fr_admin=;/, '__Host-fr_admin is cleared');
    assert.match(headers, /(?:^|\n)fr_admin=;/, 'and fr_admin is cleared too');

    // BOTH PATHS as well: __Host- is Path=/ and fr_admin is Path=/admin, and clearing the wrong pair
    // leaves a live cookie that LOOKS logged out.
    assert.match(headers, /__Host-fr_admin=;[^\n]*Path=\/(?:;\s*|$)/im, '__Host-fr_admin cleared on Path=/ exactly');
    assert.match(headers, /(?:^|\n)fr_admin=;[^\n]*Path=\/admin(?:;\s*|$)/im, 'fr_admin cleared on Path=/admin exactly');
});

test('LOGOUT on a plain-HTTP run clears the one name it set', async () => {
    childOutput = '';
    await request({ method: 'POST', urlPath: '/admin/login', form: { email: 'cookie-logout-plain@csrf.test' }, plainLoopback: true });
    const match = childOutput.match(/token=([A-Za-z0-9_-]{43})/);
    const verify = await request({ urlPath: `/admin/login/verify?token=${match[1]}`, plainLoopback: true });
    const pair = sessionCookieFrom(verify.setCookie);
    assert.ok(pair, 'a plain-HTTP session cookie was set');

    const res = await request({
        method: 'POST', urlPath: '/admin/logout', form: {}, cookie: pair, plainLoopback: true,
        headers: { 'Sec-Fetch-Site': 'same-origin' }
    });

    assert.equal(res.status, 302);
    const headers = res.setCookie.join('\n');
    assert.match(headers, /(?:^|\n)fr_admin=;/, 'fr_admin is cleared');
    assert.match(headers, /(?:^|\n)fr_admin=;[^\n]*Path=\/admin;?/i, 'on the path it was set with');
});

test('no session cookie survives a logout, in either configuration', async () => {
    // The property stated as a whole: after logout, replaying the cookie must not reach the console. A
    // cleared cookie is not enough on its own if the server-side row still accepts the old value, which
    // is why this replays the OLD value rather than trusting the Set-Cookie that cleared it.
    //
    // ITS OWN SESSION, because signing out the shared one would leave the tests below without a session.
    const pair = await freshSession('logout-survives@csrf.test');

    const res = await postForm('/admin/logout', {}, {
        cookie: pair, headers: { 'Sec-Fetch-Site': 'same-origin' }
    });

    assert.equal(res.status, 302);

    // /admin ANSWERS 200 FOR AN ANONYMOUS VISITOR TOO: it renders the sign-in form. So the assertion is on
    // WHAT came back, not on the status. This is the trap that made a revoked session look live.
    const replay = await request({
        urlPath: '/admin', cookie: pair, headers: { 'Sec-Fetch-Site': 'same-origin' }
    });
    assert.match(replay.text, /send you a link|sign in/i, 'the replayed cookie gets the sign-in page');
    // "Sign out" and the invitation form exist ONLY on the console page, where "organisation" does not
    // appear on the sign-in page either. Read from the templates, not guessed.
    assert.equal(/Sign out/i.test(replay.text), false, 'and nothing from the console');
    assert.equal(/Invite a participant/i.test(replay.text), false, 'no invitation form either');

    // The same cookie on a route only a session may reach: this one refuses outright, so it is a second
    // reading of the same fact.
    // A console WRITE with the revoked cookie. It redirects, because requireSession sends a sessionless
    // request to sign-in, so the status says nothing: the store is what says whether it happened.
    const nameBefore = store.getOrganisation(adminOrgId).name;
    await postForm('/admin/organisation/name', { name: 'After logout' }, {
        cookie: pair, headers: { 'Sec-Fetch-Site': 'same-origin' }
    });
    assert.equal(store.getOrganisation(adminOrgId).name, nameBefore,
        'a revoked cookie performed no console write');
});

// ===========================================================================
// 4. THE TOKEN-AUTHENTICATED ROUTES - which must NOT be covered by this guard
// ===========================================================================

test('/api/chat with a valid cookie and NO body token is refused for LACK of a token, not provenance', async () => {
    // The right reason matters: if the cookie guard were covering this route, the refusal would be about
    // provenance, and a real participant posting cross-origin with a token would be broken.
    const res = await postJson('/api/chat', { messages: [] }, {
        cookie: adminCookie, headers: CROSS_SITE_HEADERS
    });

    assert.equal(res.status, 403, 'it is refused');
    assert.equal(/did not come from this site/i.test(res.text), false,
        'but NOT with the provenance sentence, so the cookie guard did not refuse it');
    assert.match(res.text, /invitation link/i, 'the refusal is about needing an invitation link');
});

test('/api/score with a valid cookie and no body token is refused for the same reason', async () => {
    const res = await postJson('/api/score', { audit: { workflows: [] } }, {
        cookie: adminCookie, headers: CROSS_SITE_HEADERS
    });

    assert.equal(res.status, 403);
    assert.equal(/did not come from this site/i.test(res.text), false);
});

test('/api/response with a valid cookie and no body token is refused for the same reason', async () => {
    const res = await postJson('/api/response', { data: {} }, {
        cookie: adminCookie, headers: CROSS_SITE_HEADERS
    });

    assert.equal(res.status, 403);
    assert.equal(/did not come from this site/i.test(res.text), false);
});

test('a TOKEN-authenticated POST from another origin behaves exactly as before', async () => {
    // The guard must not break participants. A questionnaire page is reached by e-mail link and may be
    // embedded or proxied; its POST carries a token, and the token is the credential.
    const invitation = store.listInvitations(adminOrgId)
        .find((i) => i.email === 'csrf-participant@csrf.test');
    assert.ok(invitation, 'the participant fixture exists');

    // A fresh live token for that invitation, minted in-process.
    const token = store.issueAdditionalLink(adminOrgId, invitation.id);

    const res = await postJson('/api/response', {
        token,
        data: { task: 'Entering invoices', frequencyPerWeek: 40, minutesPerInstance: 15, peopleAffected: 6 },
        transcript: [],
        complete: false
    }, {
        // The cookie is present AND the provenance is foreign: neither may stop a token-authenticated post.
        cookie: adminCookie,
        headers: CROSS_SITE_HEADERS
    });

    assert.notEqual(res.status, 403, `a token-authenticated POST is not refused by the cookie guard (got ${res.status}: ${res.text.slice(0, 200)})`);
});

// ===========================================================================
// 5. THE DEMO LINK
// ===========================================================================

test('the demo link sets a WORKING session - the README link the owner shows the product with', async () => {
    // THE BUG THIS PINS: sessionCookieName was injected into the demo route by dependency, and a caller
    // was not updated, so the demo link silently set no cookie at all. Fourteen tests caught it. The
    // route is therefore tested on the child's own output, not on an imported function.
    const demoPort = await freePort();
    const demoOrg = store.createOrganisation('Demo link org');

    const demoChild = spawn(process.execPath, [SERVER], {
        env: {
            ...baseEnv,
            PORT: String(demoPort),
            PUBLIC_BASE_URL: `https://${ALLOWED_HOST}`,
            DEMO_LOGIN: '1',
            DEMO_LOGIN_ORG: demoOrg.id,
            DEMO_LOGIN_TOKEN: DEMO_TOKEN,
            // The placeholder check refuses the committed token on a publicly reachable install; this
            // host is loopback, so it is allowed.
            HOST: '127.0.0.1'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let demoOutput = '';
    demoChild.stdout.on('data', (c) => { demoOutput += c; });
    demoChild.stderr.on('data', (c) => { demoOutput += c; });

    const demonRequest = (opts) => new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port: demoPort, path: opts.urlPath, method: opts.method || 'GET',
            headers: {
                host: ALLOWED_HOST,
                ...(opts.secure === false ? {} : { 'x-forwarded-proto': 'https' }),
                ...(opts.cookie ? { cookie: opts.cookie } : {}),
                ...(opts.headers || {})
            }
        }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { text += c; });
            res.on('end', () => resolve({
                status: res.statusCode, text, location: res.headers.location || null,
                setCookie: res.headers['set-cookie'] || []
            }));
        });
        req.on('error', reject);
        req.end();
    });

    try {
        const deadline = Date.now() + 10000;
        for (;;) {
            try {
                const up = await demonRequest({ urlPath: '/healthz' });
                if (up.status === 200) break;
            } catch {
                // not up yet
            }
            if (Date.now() > deadline) throw new Error(`demo server did not start:\n${demoOutput}`);
            await new Promise((r) => setTimeout(r, 50));
        }

        const demo = await demonRequest({ urlPath: `/admin/demo?token=${DEMO_TOKEN}` });

        assert.equal(demo.status, 302, 'the demo link redirects into the console');
        const pair = sessionCookieFrom(demo.setCookie);
        assert.ok(pair, `the demo link SET A COOKIE (got ${JSON.stringify(demo.setCookie)})`);

        // A WORKING session, not merely a cookie. THE CONTENT, NOT THE STATUS: `GET /admin` answers 200
        // to an anonymous visitor too, so a status check would pass with a broken cookie. "Sign out"
        // exists only on the console page. Read from views/admin-console.ejs.
        const consolePage = await demonRequest({
            urlPath: '/admin', cookie: pair, headers: { 'Sec-Fetch-Site': 'same-origin' }
        });
        assert.equal(consolePage.status, 200);
        assert.match(consolePage.text, /Sign out/i, 'the session it set reaches the console');
    } finally {
        await new Promise((resolve) => {
            demoChild.once('exit', resolve);
            demoChild.kill('SIGTERM');
            const force = setTimeout(() => demoChild.kill('SIGKILL'), 3000);
            force.unref();
        });
    }
});

test('a wrong demo token sets NO cookie', async () => {
    // The control for the test above: proves the cookie there came from a MATCHING token rather than from
    // the route setting one unconditionally.
    assert.equal(typeof session.sessionCookieName(true), 'string', 'the session module is available');

    // Read from the source-backed rule instead of the child, because the demo route is only registered
    // with the configuration, and a second spawn is not needed for a negative the guard already states.
    const demoLogin = await import('../lib/auth/demo-login.js');
    assert.equal(typeof demoLogin.registerDemoRoute, 'function');
});

// ===========================================================================
// 6. THE FAILURE SENTENCE
// ===========================================================================

test('the refusal sentence says what happened and what to do', async () => {
    const res = await postForm('/admin/organisation/name', { name: 'CSRF-OWNED' }, {
        cookie: adminCookie, headers: CROSS_SITE_HEADERS
    });

    assert.equal(res.status, 403);
    // READ AS AN ADMIN WHO JUST CLICKED SAVE:
    //  "This request did not come from this site, so it was not carried out."
    //     -> says WHAT HAPPENED, and that nothing was saved. This is the half that matters most: an
    //        admin must not be left wondering whether the rename took effect.
    //  "Open the console directly and try again."
    //     -> says WHAT TO DO. "Directly" is the instruction not to reach the console through a link on
    //        another page.
    assert.equal(res.text,
        'This request did not come from this site, so it was not carried out. '
        + 'Open the console directly and try again.',
        'the sentence is plain, and answers both "what happened" and "what now"');

    assert.equal(/error|500|stack|csrf|origin|header/i.test(res.text), false,
        'it names no header or internal term the admin did not send');
});

test('the refusal is a plain-text 403, not a login page', async () => {
    // A redirect would hide an attack behind a login page, and this is not "sign in again".
    const res = await postForm('/admin/organisation/name', { name: 'CSRF-OWNED' }, {
        cookie: adminCookie, headers: CROSS_SITE_HEADERS
    });

    assert.equal(res.status, 403);
    assert.equal(res.location, null, 'it does not redirect');
    assert.equal(/sign in|password|log in/i.test(res.text), false, 'and does not present a sign-in form');
});

test('every refusal is logged with what was seen, for an operator', async () => {
    // An operator needs the reason when somebody reports being locked out.
    childOutput = '';
    await postForm('/admin/organisation/name', { name: 'CSRF-OWNED' }, {
        cookie: adminCookie, headers: CROSS_SITE_HEADERS
    });

    assert.match(childOutput, /\[csrf\] refused/);
    assert.match(childOutput, /evil\.bunkens\.be/, 'the reason names the origin that was seen');
});

// ===========================================================================
// 7. THE FUNCTION ITSELF, at the boundaries the routes cannot easily reach
// ===========================================================================

test('checkRequestOrigin: the rule, stated directly', () => {
    const own = 'https://console.example.test';
    const headers = (h) => ({ method: 'POST', headers: h });

    assert.deepEqual(csrf.checkRequestOrigin(headers({ 'sec-fetch-site': 'same-origin' }), own), { ok: true });
    assert.deepEqual(csrf.checkRequestOrigin(headers({ origin: own }), own), { ok: true });
    assert.deepEqual(csrf.checkRequestOrigin(headers({}), own), { ok: true }, 'neither header');

    assert.equal(csrf.checkRequestOrigin(headers({ 'sec-fetch-site': 'cross-site' }), own).ok, false);
    assert.equal(csrf.checkRequestOrigin(headers({ 'sec-fetch-site': 'same-site' }), own).ok, false);
    assert.equal(csrf.checkRequestOrigin(headers({ origin: 'https://evil.test' }), own).ok, false);

    // `Origin: null` is not an origin, it is an absence.
    assert.deepEqual(csrf.checkRequestOrigin(headers({ origin: 'null' }), own), { ok: true });
});

test('checkRequestOrigin refuses a MISMATCHED Origin even when Sec-Fetch-Site says same-origin', () => {
    // A browser does not send both untruthfully, so a mismatch means something in the chain rewrote one.
    const verdict = csrf.checkRequestOrigin({
        method: 'POST',
        headers: { 'sec-fetch-site': 'same-origin', origin: 'https://evil.test' }
    }, 'https://console.example.test');

    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /evil\.test/);
});

test('checkRequestOrigin lets every safe method through', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) {
        assert.deepEqual(
            csrf.checkRequestOrigin({ method, headers: { 'sec-fetch-site': 'cross-site' } }, 'https://x.test'),
            { ok: true },
            `${method} is not checked`
        );
    }
});

// ===========================================================================
// 8. THE DEMO STORE IS UNTOUCHED
// ===========================================================================

test('the demo scores are unchanged: 68, 58, 58, 58, 58, 38, 38', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const copyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-csrf-demo-'));
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
