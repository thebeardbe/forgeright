/**
 * Provisioning: turning a sign-in into a user with an organisation.
 *
 * THE DECISIONS THESE TESTS PROTECT, which are not obvious from the code:
 *
 *   1. an unknown address creates an organisation and becomes its admin
 *   2. the same address signs in to the SAME organisation, not a second one
 *   3. the address is case-normalised and trimmed
 *   4. provisioning happens at REDEEM, not at link request
 *   5. a user row whose organisation file is missing is refused, not re-provisioned
 *   6. the sign-in response does not depend on whether the address is known
 *   7. a first sign-in is admin; a user added as `user` gets no console
 *
 * SPLIT BY NECESSITY. The redeem-time and enumeration properties can only be
 * proven over HTTP, so those run against a spawned child. The organisation-identity
 * properties (case, whitespace, returning sign-in) are properties of resolveSignIn
 * itself and are tested in-process, because the login route is rate limited to 10
 * per IP per 15 minutes with a hardcoded constant that no environment variable
 * raises, and driving every case over HTTP exhausts that budget and makes the
 * suite fail on 429s rather than on the property under test.
 *
 * Where it matters the assertions inspect the FILES: count organisation databases,
 * read `admin.db` for the users table, rather than inferring from a response.
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
const STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-provision-'));
// The test process imports the store to inspect the files the child writes.
process.env.STORE_DIR = STORE_DIR;
process.env.SESSION_SECRET = 'a'.repeat(64);

const store = await import('../lib/store/index.js');
const provision = await import('../lib/provision.js');
const users = await import('../lib/users.js');

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
function request({ method = 'GET', path: urlPath = '/', form, headers = {} } = {}) {
    const payload = form === undefined ? undefined : new URLSearchParams(form).toString();
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: '127.0.0.1',
                port: PORT,
                path: urlPath,
                method,
                headers: {
                    host: ALLOWED_HOST,
                    'x-forwarded-proto': 'https',
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

const postForm = (urlPath, form) => request({ method: 'POST', path: urlPath, form });

let child;
/** Everything the child has printed to stdout, so the mailed link can be read. */
let childOutput = '';

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

// --- file-level evidence -----------------------------------------------------

const orgsDir = () => path.join(STORE_DIR, 'orgs');

/** How many organisation database files exist on disk right now. */
function organisationFileCount() {
    const dir = orgsDir();
    if (!fs.existsSync(dir)) return 0;
    return fs.readdirSync(dir).filter((name) => name.endsWith('.db')).length;
}

/** Every user row in the installation database, read directly. */
function userRows() {
    const dbPath = path.join(STORE_DIR, 'admin.db');
    if (!fs.existsSync(dbPath)) return [];
    const db = new DatabaseSync(dbPath);
    try {
        return db.prepare('SELECT id, email, role, organisation_id FROM users ORDER BY email').all();
    } finally {
        db.close();
    }
}

/** Requests a sign-in link and reads the token the console sender printed. */
async function requestLinkAndReadToken(email) {
    childOutput = '';
    const res = await postForm('/admin/login', { email });
    const match = childOutput.match(/token=([A-Za-z0-9_-]{43})/);
    return { res, token: match ? match[1] : null };
}

// ===========================================================================
// HTTP: PROVISIONING HAPPENS AT REDEEM, NOT AT LINK REQUEST
// (the most valuable property here; it needs the real redeem route)
// ===========================================================================

test('requesting a sign-in link creates NO organisation and NO user', async () => {
    const orgsBefore = organisationFileCount();
    const usersBefore = userRows().length;

    const { res } = await requestLinkAndReadToken('request-only@provisioning.test');
    assert.equal(res.status, 200, 'the link is sent');

    // ASSERT THE ABSENCE: creating an organisation when a link is merely
    // REQUESTED would let anyone fill the installation from an address they do
    // not control.
    assert.equal(organisationFileCount(), orgsBefore, 'requesting a link created no organisation file');
    assert.equal(userRows().length, usersBefore, 'requesting a link created no user row');
});

test('redeeming a link creates exactly one organisation and one admin user', async () => {
    const orgsBefore = organisationFileCount();
    const usersBefore = userRows().length;

    const { token } = await requestLinkAndReadToken('first-signin@provisioning.test');
    assert.ok(token, 'the link token was captured from the mail the console sender printed');

    const redeem = await request({ path: `/admin/login/verify?token=${token}` });
    assert.equal(redeem.status, 302, 'a successful redeem redirects');
    assert.ok(redeem.setCookie, 'and sets the session cookie');

    assert.equal(organisationFileCount(), orgsBefore + 1, 'exactly one organisation file was created');
    const rows = userRows();
    assert.equal(rows.length, usersBefore + 1, 'exactly one user row was created');
    const created = rows.find((u) => u.email === 'first-signin@provisioning.test');
    assert.ok(created, 'the user row is for the signing-in address');
    assert.equal(created.role, 'admin', 'a first sign-in becomes the admin');
    assert.ok(fs.existsSync(store.orgDbPath(created.organisation_id)), 'the organisation file exists on disk');
});

test('a FAILED redeem of an unknown token creates nothing', async () => {
    const orgsBefore = organisationFileCount();
    const usersBefore = userRows().length;

    const res = await request({ path: '/admin/login/verify?token=not-a-real-token-at-all' });
    assert.equal(res.status, 400, 'the bogus token is refused');
    assert.equal(organisationFileCount(), orgsBefore, 'no organisation was created');
    assert.equal(userRows().length, usersBefore, 'no user was created');
});

test('a FAILED redeem of a missing token creates nothing', async () => {
    const orgsBefore = organisationFileCount();
    const res = await request({ path: '/admin/login/verify' });
    assert.equal(res.status, 400);
    assert.equal(organisationFileCount(), orgsBefore);
});

// ===========================================================================
// HTTP: THE SIGN-IN RESPONSE DOES NOT DEPEND ON WHETHER THE ADDRESS IS KNOWN
// ===========================================================================

test('the login response is byte-identical for a known and an unknown address', async () => {
    // An unknown address provisions and a known one does not, so any difference
    // would say which addresses have signed in. Compared on the ACTUAL BYTES.
    const known = await postForm('/admin/login', { email: 'first-signin@provisioning.test' });
    const unknown = await postForm('/admin/login', { email: 'never-seen-before@provisioning.test' });

    assert.equal(known.status, 200);
    assert.equal(known.status, unknown.status, 'the status is the same');
    assert.equal(known.text, unknown.text, 'the response bytes are identical');
    assert.equal(known.location, unknown.location, 'neither redirects');
    assert.deepEqual(known.setCookie, unknown.setCookie, 'neither sets a cookie');
});

test('redeeming a link signs in identically whether the address was known or new', async () => {
    const { token: newToken } = await requestLinkAndReadToken('brand-new@provisioning.test');
    const { token: knownToken } = await requestLinkAndReadToken('first-signin@provisioning.test');

    const brandNew = await request({ path: `/admin/login/verify?token=${newToken}` });
    const known = await request({ path: `/admin/login/verify?token=${knownToken}` });

    assert.equal(brandNew.status, 302);
    assert.equal(brandNew.status, known.status);
    assert.equal(brandNew.location, known.location, 'the same redirect target');
    assert.match(brandNew.setCookie[0], /^fr_admin=/);
    assert.match(known.setCookie[0], /^fr_admin=/);
});

// ===========================================================================
// 7. ROLE (HTTP: the redirect differs by role)
// ===========================================================================

test('a user added as `user` signs in but does not reach the console', async () => {
    const admin = userRows().find((u) => u.email === 'first-signin@provisioning.test');
    assert.ok(admin, 'the admin created earlier exists');
    users.addUserToOrganisation({
        organisationId: admin.organisation_id,
        email: 'plain.user@provisioning.test',
        role: 'user'
    });

    const { token } = await requestLinkAndReadToken('plain.user@provisioning.test');
    const redeem = await request({ path: `/admin/login/verify?token=${token}` });

    assert.equal(redeem.status, 302, 'they sign in successfully');
    assert.match(redeem.location, /role=user/, 'they are sent to the page that says so, not the console');
    assert.ok(redeem.setCookie, 'with a session cookie, so the sign-in itself works');
});

test('an invalid address is refused by the login form and provisions nothing', async () => {
    const orgsBefore = organisationFileCount();
    const res = await postForm('/admin/login', { email: 'not-an-address' });
    assert.equal(res.status, 400, 'an invalid address is refused before the rate limiter counts it as a send');
    assert.equal(organisationFileCount(), orgsBefore, 'no organisation was created for an invalid address');
});

// ===========================================================================
// IN-PROCESS: ORGANISATION IDENTITY (1, 2, 3, 5)
// ===========================================================================
//
// These are properties of resolveSignIn, and driving each over HTTP would exhaust
// the login route's hardcoded 10-per-IP rate limit. The store is the same code
// path the route uses, in the same process, so the property is the same.

test('an unknown address creates an organisation and becomes its admin', () => {
    const result = provision.resolveSignIn('new-address@identity.test');

    assert.equal(result.created, true, 'the organisation was created');
    assert.equal(result.user.role, 'admin', 'the first sign-in is the admin');
    assert.equal(result.user.organisation_id, result.organisation.id, 'the user belongs to the new organisation');
    assert.ok(fs.existsSync(store.orgDbPath(result.organisation.id)), 'the file exists on disk');
    assert.equal(result.organisation.finished_at, null, 'a new organisation is open');
});

test('signing in twice with the same address lands in the same organisation', () => {
    const first = provision.resolveSignIn('returning@identity.test');
    assert.equal(first.created, true);

    const second = provision.resolveSignIn('returning@identity.test');
    assert.equal(second.created, false, 'no second organisation was created');
    assert.equal(second.organisation.id, first.organisation.id, 'the same organisation');
    assert.equal(second.user.id, first.user.id, 'the same user row');
});

test('the address is case-normalised: a different case is the same user', () => {
    const first = provision.resolveSignIn('CaseTest@Identity.test');
    assert.equal(first.user.email, 'casetest@identity.test', 'stored lowercased');

    const second = provision.resolveSignIn('CASETEST@IDENTITY.TEST');
    assert.equal(second.created, false, 'case did not create a second organisation');
    assert.equal(second.organisation.id, first.organisation.id);
    assert.equal(second.user.id, first.user.id);
});

test('a whitespace-padded address is the same user', () => {
    const first = provision.resolveSignIn('padded@identity.test');
    const second = provision.resolveSignIn('  padded@identity.test  ');

    assert.equal(second.created, false, 'padding did not create a second organisation');
    assert.equal(second.organisation.id, first.organisation.id);
    assert.equal(second.user.id, first.user.id);
});

test('the placeholder organisation name is derived from the address domain', () => {
    // Self-service, so there is nobody to ask for a real name. The name exists so
    // the console does not show a blank row.
    const result = provision.resolveSignIn('naming@some-company.test');
    assert.equal(result.organisation.name, 'Organisation for some-company.test');
});

test('a user whose organisation file has been deleted is refused, not re-provisioned', () => {
    // Otherwise a deleted file silently becomes a new empty tenant, and the user's
    // data is gone with no error.
    const created = provision.resolveSignIn('orphan@identity.test');
    assert.equal(created.created, true);

    store.closeAll();
    fs.rmSync(store.orgDbPath(created.organisation.id));

    assert.throws(
        () => provision.resolveSignIn('orphan@identity.test'),
        /missing from the store/,
        'the sign-in is refused rather than silently re-provisioned'
    );

    // No replacement was created for that address in the installation database.
    assert.equal(
        userRows().filter((u) => u.email === 'orphan@identity.test').length,
        1,
        'still exactly one user row, still pointing at the missing organisation'
    );
});

test('the users table holds one row per address, never two', () => {
    const emails = userRows().map((u) => u.email);
    assert.equal(new Set(emails).size, emails.length, 'no address appears twice');
});

test('resolveSignIn does not accept or use an organisation id', () => {
    // The design rule: the id comes from the user row, never from the caller.
    // A second argument is ignored, so passing one cannot redirect the sign-in.
    const result = provision.resolveSignIn('no-second-arg@identity.test', 'some-other-organisation-id');
    assert.notEqual(result.organisation.id, 'some-other-organisation-id', 'a supplied id is not honoured');
    assert.equal(result.user.organisation_id, result.organisation.id);
});

test('addUserToOrganisation refuses to move an existing user into another organisation', () => {
    const a = provision.resolveSignIn('belongs-to-a@identity.test');
    const b = provision.resolveSignIn('belongs-to-b@identity.test');

    assert.throws(
        () => users.addUserToOrganisation({ organisationId: b.organisation.id, email: 'belongs-to-a@identity.test', role: 'admin' }),
        /already belongs to a different organisation/,
        'an address belongs to exactly one organisation'
    );
    assert.equal(users.findUserByEmail('belongs-to-a@identity.test').organisation_id, a.organisation.id);
});
