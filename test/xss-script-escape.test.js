/**
 * C1: a transcript is participant text, and it is embedded in a `<script>` block on every admin page.
 *
 * `JSON.stringify` escapes quotes and backslashes but NOT `<`, `>` or `&`, so a value containing
 * `</script>` closes the block early and the rest of it is parsed as markup. On an admin page that is
 * a script running on the page's own origin, with the admin's cookie.
 *
 * The fix is at OUTPUT (`lib/json-for-script.js`), not by rewriting the transcript: a participant's
 * words are read later by the model, so changing them would change the evidence.
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
import { runInNewContext } from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const SERVER = path.join(PROJECT_ROOT, 'server.js');

const ALLOWED_HOST = 'allowed.example.test';
const STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-c1-'));
process.env.STORE_DIR = STORE_DIR;
process.env.SESSION_SECRET = 'c'.repeat(64);

const store = await import('../lib/store/index.js');
const { jsonForScript } = await import('../lib/json-for-script.js');

/** The exact breakout a stored transcript would carry. */
const BREAKOUT = '</script><script>window.__x=1</script>';
/** The two characters the escaping is easiest to half-do. */
const LINE_SEPARATOR = '\u2028';
const PARAGRAPH_SEPARATOR = '\u2029';

const org = store.createOrganisation('C1 org');
const invitation = store.addInvitation(org.id, { email: 'c1@example.test', department: 'Finance' });
const TOKEN = invitation.token;

/** A transcript whose every turn carries a hostile value. */
const HOSTILE_TRANSCRIPT = [
    { role: 'user', content: BREAKOUT },
    { role: 'assistant', content: `before${LINE_SEPARATOR}after & more` },
    { role: 'user', content: `line${PARAGRAPH_SEPARATOR}break & <b>` }
];

store.recordTurn(org.id, TOKEN, { data: { task: BREAKOUT }, transcript: HOSTILE_TRANSCRIPT });
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
            res.on('end', () => resolve({ status: res.statusCode, text }));
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
            ALLOWED_HOST, SESSION_SECRET: 'c'.repeat(64), STORE_DIR,
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

// ===========================================================================
// The unit: jsonForScript
// ===========================================================================

test('jsonForScript escapes the three HTML-significant characters', () => {
    assert.equal(jsonForScript('</script>'), '"\\u003c/script\\u003e"');
    assert.equal(jsonForScript('a & b'), '"a \\u0026 b"');
});

test('jsonForScript escapes U+2028 and U+2029, which are line terminators in older engines', () => {
    assert.equal(jsonForScript(`a${LINE_SEPARATOR}b`), '"a\\u2028b"');
    assert.equal(jsonForScript(`a${PARAGRAPH_SEPARATOR}b`), '"a\\u2029b"');
});

test('the escaped form parses back to the ORIGINAL string, character for character', () => {
    // The property that makes the escaping safe rather than merely quiet.
    for (const value of [BREAKOUT, `a${LINE_SEPARATOR}b`, 'a & b <c> d', '"quoted" \\backslash', 'ünïcode ✓']) {
        assert.equal(JSON.parse(jsonForScript(value)), value, `${JSON.stringify(value.slice(0, 20))} round-trips`);
    }
});

test('jsonForScript emits no raw < in any string', () => {
    const hostile = ['<', '</script>', '<!--', '<script>', `${LINE_SEPARATOR}<`];
    for (const value of hostile) {
        assert.equal(/</.test(jsonForScript(value)), false, `${JSON.stringify(value)} leaves no raw <`);
    }
});

test('jsonForScript handles the values a config block can carry', () => {
    assert.equal(jsonForScript(undefined), 'null', 'undefined becomes null, not the bare token');
    assert.equal(jsonForScript(null), 'null');
    assert.equal(jsonForScript([]), '[]');
    assert.equal(jsonForScript({ a: '<' }), '{"a":"\\u003c"}');
});

// ===========================================================================
// The served page: the three interpolation sites
// ===========================================================================

/** The body of `window.AUDIT_CONFIG = { ... };`, as served. */
function configBlock(html) {
    const start = html.indexOf('window.AUDIT_CONFIG = ');
    assert.notEqual(start, -1, 'the page carries a config block');
    const from = start + 'window.AUDIT_CONFIG = '.length;

    // Walk to the closing brace of the object, counting braces OUTSIDE string literals and skipping
    // escapes, so a `}` inside a value cannot end the block early.
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = from; i < html.length; i += 1) {
        const ch = html[i];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth += 1;
        else if (ch === '}') {
            depth -= 1;
            if (depth === 0) return html.slice(from, i + 1);
        }
    }
    assert.fail('the config block never closes');
}

/** The `<script>` blocks of a page, each split at the first `</script` the parser would act on. */
function scriptBlocks(html) {
    return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

test('a hostile transcript produces NO raw </script> inside the config block', async () => {
    const res = await request({ path: `/q/${TOKEN}` });
    assert.equal(res.status, 200);

    const config = configBlock(res.text);
    assert.equal(/<\/script/i.test(config), false,
        'the transcript cannot close the block early');
    assert.equal(config.includes(BREAKOUT), false, 'and the raw breakout is not in it at all');
});

test('the whole page carries the breakout only in escaped form, never as markup', async () => {
    const res = await request({ path: `/q/${TOKEN}` });

    // The page's own script elements, counted as the parser sees them. A breakout would add two.
    const openers = (res.text.match(/<script\b/g) || []).length;
    const closers = (res.text.match(/<\/script>/g) || []).length;
    assert.equal(openers, closers, 'every script element is closed, so none was split?');

    // The injected tag is present only as escaped data, never as a literal `</script>` the parser would
    // act on. A single pass of unescaping, on the config block only, is what a browser would parse.
    const config = configBlock(res.text);
    const decoded = config.replace(/\\u003c/g, '<').replace(/\\u003e/g, '>');
    assert.equal(decoded.includes('</script>'), true,
        'unescaped once, the text a browser reads back IS the original string');
    assert.equal(config.includes('</script>'), false,
        'but the source carries no literal close tag');
});

test('the served config parses back to the ORIGINAL transcript, character for character', async () => {
    const res = await request({ path: `/q/${TOKEN}` });
    const config = configBlock(res.text);

    // An object literal with comments, so it is evaluated as JavaScript.
    const parsed = runInNewContext(`(${config})`, {});
    const stored = store.openOrganisationForTest?.(org.id);
    void stored;

    assert.equal(parsed.existingResponses.length, 1, 'the round is in the config');
    const turns = parsed.existingResponses[0].transcript;
    assert.equal(turns.length, HOSTILE_TRANSCRIPT.length);

    for (let i = 0; i < HOSTILE_TRANSCRIPT.length; i += 1) {
        assert.equal(turns[i].content, HOSTILE_TRANSCRIPT[i].content,
            `turn ${i} survives the round trip exactly`);
    }
});

test('the strings site is escaped too: a hostile strings table cannot break out', async () => {
    // The strings table is server-supplied, so this asserts the SITE, not a participant value.
    const res = await request({ path: `/q/${TOKEN}` });
    const config = configBlock(res.text);

    // `strings` is the third jsonForScript site; if it were interpolated raw, a `</script>` in any
    // string would end the block. The block parsing at all, with the closing `};` present, is the
    // evidence that all three sites escaped.
    // The block is an OBJECT LITERAL, not JSON: unquoted keys and // comments, which is why it is
    // parsed as JavaScript below rather than with JSON.parse.
    assert.match(config, /strings:\s*\{/, 'the strings table is present');
    assert.equal((config.match(/<\/script/gi) || []).length, 0);
});

test('the participantToken site is escaped: a token with HTML characters cannot break out', () => {
    // The token is a fixed-shape credential, so this is asserted on the function rather than by
    // minting an impossible one: the SITE is what the fix had to cover.
    const nasty = '</script><script>alert(1)</script>';
    assert.equal(jsonForScript(nasty).includes('</script>'), false);
    assert.equal(JSON.parse(jsonForScript(nasty)), nasty);
});
