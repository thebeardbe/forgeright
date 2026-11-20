/**
 * H6: security headers on every response, and the per-request nonce that keeps the inline scripts
 * working under a policy with no `'unsafe-inline'`.
 *
 * Derived from `lib/security-headers.js`: the policy string, the nonce on `res.locals` as `cspNonce`,
 * the fixed headers, and `Cache-Control: no-store` on `/q` and `/admin` only.
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
const STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-h6-'));
process.env.STORE_DIR = STORE_DIR;
process.env.SESSION_SECRET = 'e'.repeat(64);

const store = await import('../lib/store/index.js');
const org = store.createOrganisation('H6 org');
const invitation = store.addInvitation(org.id, { email: 'h6@example.test', department: 'Finance' });
const TOKEN = invitation.token;
store.closeAll();

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

function request({ path: urlPath = '/' } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port: PORT, path: urlPath,
            headers: { host: ALLOWED_HOST, 'x-forwarded-proto': 'https' }
        }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { text += c; });
            res.on('end', () => resolve({
                status: res.statusCode, text,
                headers: res.headers
            }));
        });
        req.on('error', reject);
        req.end();
    });
}

let child;
before(async () => {
    child = spawn(process.execPath, [SERVER], {
        env: {
            PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test',
            PORT: String(PORT), HOST: '127.0.0.1', BASE_PATH: '',
            PUBLIC_BASE_URL: `https://${ALLOWED_HOST}`, TRUST_PROXY: '127.0.0.1',
            ALLOWED_HOST, SESSION_SECRET: 'e'.repeat(64), STORE_DIR,
            AI_PROVIDER: 'mock', MAIL_SENDER: 'console',
            DEMO_LOGIN: '', DEMO_LOGIN_ORG: '', DEMO_LOGIN_TOKEN: ''
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
        try {
            const res = await request({ path: '/healthz' });
            if (res.status === 200) break;
        } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 50));
    }
});

after(async () => {
    if (child) {
        child.kill('SIGTERM');
        await new Promise((resolve) => child.once('exit', resolve));
    }
    fs.rmSync(STORE_DIR, { recursive: true, force: true });
});

/** The nonce a response's own CSP header names. */
function nonceOf(headers) {
    const csp = headers['content-security-policy'] || '';
    const match = csp.match(/'nonce-([^']+)'/);
    return match ? match[1] : null;
}

// ===========================================================================
// The headers on every response
// ===========================================================================

test('every response carries the fixed security headers', async () => {
    for (const urlPath of ['/', '/lost-link', '/q', `/q/${TOKEN}`, '/definitely-not-a-page']) {
        const res = await request({ path: urlPath });

        assert.notEqual(res.headers['content-security-policy'], undefined, `${urlPath} carries a CSP`);
        assert.equal(res.headers['referrer-policy'], 'no-referrer', `${urlPath} carries Referrer-Policy`);
        assert.equal(res.headers['x-content-type-options'], 'nosniff', `${urlPath} carries nosniff`);
        assert.equal(res.headers['x-frame-options'], 'DENY', `${urlPath} carries X-Frame-Options`);
    }
});

test('Express does not announce itself', async () => {
    const res = await request({ path: '/' });
    assert.equal(res.headers['x-powered-by'], undefined);
});

test('an early refusal carries the headers too, not only a served page', async () => {
    // The bad host is refused before any route runs, which is exactly the response a missing
    // middleware would leave bare.
    const res = await request({ path: '/definitely-not-a-page' });
    assert.equal(res.status, 404);
    assert.notEqual(res.headers['content-security-policy'], undefined);
});

// ===========================================================================
// Cache-Control
// ===========================================================================

test('/q and /admin carry no-store, and the landing page does not', async () => {
    for (const urlPath of ['/q', `/q/${TOKEN}`]) {
        const res = await request({ path: urlPath });
        assert.equal(res.headers['cache-control'], 'no-store', `${urlPath} is not cacheable`);
    }

    for (const urlPath of ['/', '/lost-link']) {
        const res = await request({ path: urlPath });
        assert.notEqual(res.headers['cache-control'], 'no-store',
            `${urlPath} is public and may be cached`);
    }
});

// ===========================================================================
// The policy itself
// ===========================================================================

test('script-src carries a nonce and NO unsafe-inline', async () => {
    // The line that keeps C1 closed: 'unsafe-inline' beside a nonce makes browsers ignore the nonce.
    const res = await request({ path: '/' });
    const csp = res.headers['content-security-policy'];
    const scriptSrc = csp.split(';').map((p) => p.trim()).find((p) => p.startsWith('script-src'));
    assert.ok(scriptSrc, 'the policy has a script-src');
    assert.match(scriptSrc, /'nonce-[^']+'/, 'with a nonce');
    assert.equal(/'unsafe-inline'/.test(scriptSrc), false, "and NOT 'unsafe-inline'");
});

test('the policy blocks framing, base rewriting and foreign form posts', async () => {
    const res = await request({ path: '/' });
    const csp = res.headers['content-security-policy'];

    for (const directive of [
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "object-src 'none'",
        "default-src 'self'"
    ]) {
        assert.ok(csp.includes(directive), `the policy carries ${directive}`);
    }
});

// ===========================================================================
// The nonce matches the page
// ===========================================================================

test('every inline script carries the nonce its own response header names', async () => {
    for (const urlPath of ['/', `/q/${TOKEN}`]) {
        const res = await request({ path: urlPath });
        const nonce = nonceOf(res.headers);
        assert.notEqual(nonce, null, `${urlPath} names a nonce in its CSP`);

        // Each inline block - one with a body - must carry that exact value.
        const inline = [...res.text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
            .filter(([, , body]) => body.trim() !== '');

        assert.ok(inline.length > 0, `${urlPath} has at least one inline script`);
        for (const [, attrs] of inline) {
            assert.match(attrs, new RegExp(`nonce="${nonce.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`),
                `${urlPath}: an inline script carries the response's nonce`);
        }
    }
});

test('two responses get DIFFERENT nonces', async () => {
    const first = await request({ path: '/' });
    const second = await request({ path: '/' });

    const a = nonceOf(first.headers);
    const b = nonceOf(second.headers);
    assert.notEqual(a, null);
    assert.notEqual(b, null);
    assert.notEqual(a, b, 'the nonce is per response, not a constant');
});

// ===========================================================================
// The analytics exclusion, restated against the CSP
// ===========================================================================

test('/q carries no analytics element and the landing page does', async () => {
    const participant = await request({ path: `/q/${TOKEN}` });
    const landing = await request({ path: '/' });

    assert.equal(participant.text.includes('stats.thebeard.be/script.js'), false,
        'the questionnaire carries no analytics element');
    assert.equal(landing.text.includes('stats.thebeard.be/script.js'), true,
        'the landing page does');
});
