/**
 * The cookie notice: one partial, every page, and a dismiss control that works wherever it appears.
 *
 * The banner is a partial included from `theme-head`, which every page renders: inline in one page
 * it would be absent everywhere else, and a banner whose button does nothing reads as a broken click.
 *
 * `.hidden` must live in a stylesheet every page loads, not only `questionnaire.css`.
 *
 * THE DISMISS BEHAVIOUR runs the partial's OWN SCRIPT in a `node:vm` sandbox with a stub DOM.
 *
 * WHAT THIS FILE CANNOT DO IS MEASURE LAYOUT: the overlap fix is a CSS custom property whose effect
 * needs a browser's layout engine. See the section at the end.
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
const VIEWS = path.join(PROJECT_ROOT, 'views');
const CSS = path.join(PROJECT_ROOT, 'public', 'css');

const ALLOWED_HOST = 'allowed.example.test';
const STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-cookie-'));

process.env.STORE_DIR = STORE_DIR;
process.env.SESSION_SECRET = 'a'.repeat(64);
const store = await import('../lib/store/index.js');
const org = store.createOrganisation('Cookie notice org');
const invitation = store.addInvitation(org.id, { email: 'p@example.test', department: 'Finance' });
const PARTICIPANT_TOKEN = invitation.token;
store.closeAll();

const { createContext, runInContext } = await import('node:vm');

const PARTIAL = fs.readFileSync(path.join(VIEWS, 'partials', 'cookie-notice.ejs'), 'utf8');
const STORAGE_KEY = 'fr_cookie_notice';

const SCRIPT = (() => {
    // The tag carries a per-response nonce attribute, and that attribute's EJS expression contains a
    // `>` of its own, so the tag cannot be matched with `[^>]*`. Quoted attribute values are skipped
    // explicitly. The partial's `<%# %>` header comment also mentions `<script src>` in prose, so it is
    // stripped first and the match runs on real markup.
    const markup = PARTIAL.replace(/<%#[\s\S]*?%>/g, '');
    const match = markup.match(/<script\b(?:[^>"']|"[^"]*"|'[^']*')*>([\s\S]*?)<\/script>/);
    assert.notEqual(match, null, 'the partial carries an inline script');
    return match[1];
})();

// ===========================================================================

/**
 * Runs the banner's script against a stub DOM. `storage`: `'working'`, `'throwing'` (getItem throws,
 * as a blocked store does) or `'absent'` (`localStorage` is undefined).
 */
function runBanner({ storage = 'working', storedKey = null } = {}) {
    const classes = new Set(['cookie-banner', 'hidden']);
    const clickHandlers = [];
    const windowListeners = [];
    const styleProps = {};
    let store = storedKey === null ? {} : { [STORAGE_KEY]: storedKey };

    const banner = {
        offsetHeight: 177,
        classList: {
            add: (c) => classes.add(c),
            remove: (c) => classes.delete(c),
            contains: (c) => classes.has(c)
        }
    };
    const okButton = { addEventListener: (type, fn) => { if (type === 'click') clickHandlers.push(fn); } };
    const documentElement = {
        style: {
            setProperty: (k, v) => { styleProps[k] = v; },
            removeProperty: (k) => { delete styleProps[k]; }
        }
    };
    const document = {
        getElementById: (id) => (id === 'cookie-banner' ? banner : id === 'cookie-ok' ? okButton : null),
        documentElement
    };
    const window = { addEventListener: (type, fn) => windowListeners.push([type, fn]) };

    let localStorage;
    if (storage === 'working') {
        localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } };
    } else if (storage === 'throwing') {
        localStorage = { getItem: () => { throw new Error('storage blocked'); }, setItem: () => { throw new Error('storage blocked'); } };
    } // 'absent' leaves it undefined

    runInContext(SCRIPT, createContext({ document, window, localStorage }));

    return {
        visible: () => !classes.has('hidden'),
        height: () => styleProps['--cookie-notice-height'],
        stored: () => store[STORAGE_KEY] ?? null,
        storedKeys: () => Object.keys(store),
        click: () => clickHandlers.forEach((fn) => fn()),
        resizeHandlers: () => windowListeners.filter(([t]) => t === 'resize').length,
        clickHandlers: () => clickHandlers.length
    };
}

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

function request({ method = 'GET', path: urlPath = '/', host = ALLOWED_HOST, cookie, form } = {}) {
    const payload = form === undefined ? undefined : new URLSearchParams(form).toString();
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port: PORT, path: urlPath, method,
            headers: {
                host,
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
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
        try {
            const res = await request({ path: '/healthz' });
            if (res.status === 200) break;
        } catch { /* not up */ }
        await new Promise((r) => setTimeout(r, 50));
    }

    const link = await request({ method: 'POST', path: '/admin/login', form: { email: 'admin@example.test' } });
    assert.equal(link.status, 200, 'the sign-in form answered');
    const token = (log.match(/token=([A-Za-z0-9_-]{43})/) || [])[1];
    assert.ok(token, 'the sign-in link was printed');
    const verified = await request({ path: `/admin/login/verify?token=${token}` });
    assert.ok(verified.setCookie, 'signing in set a cookie');
    adminCookie = verified.setCookie[0].split(';')[0];
});

after(async () => {
    fs.rmSync(STORE_DIR, { recursive: true, force: true });
    if (!child || child.killed) return;
    await new Promise((resolve) => { child.once('exit', () => resolve()); child.kill('SIGKILL'); });
});

/**
 * The page types the banner must reach. The last two render WITHOUT console chrome, from the error
 * page rather than a console view: the ones most likely to be missed.
 */
const PAGES = [
    ['landing', () => request({ path: '/' })],
    ['admin-login', () => request({ path: '/admin/login' })],
    ['lost-link', () => request({ path: '/lost-link' })],
    ['the questionnaire', () => request({ path: `/q/${PARTICIPANT_TOKEN}` })],
    ['the console', () => request({ path: '/admin', cookie: adminCookie })],
    ['the roadmap', () => request({ path: '/admin/roadmap', cookie: adminCookie })],
    ['the answers view', () => request({ path: '/admin/answers', cookie: adminCookie })],
    ['the 404', () => request({ path: '/no-such-page-at-all' })],
    ['the 421 host-guard page', () => request({ path: '/', host: 'wrong-host.example' })]
];

test('the banner, its script and its stylesheet reach EVERY page type', async () => {
    for (const [name, fetch] of PAGES) {
        const res = await fetch();
        assert.match(res.text, /id="cookie-banner"/, `${name}: the banner markup is rendered`);
        assert.match(res.text, /class="cookie-banner hidden"/, `${name}: it starts hidden`);
        assert.match(res.text, new RegExp(STORAGE_KEY), `${name}: the inline script is rendered`);
        assert.match(res.text, /id="cookie-ok"/, `${name}: the dismiss control is rendered`);
        assert.match(res.text, /\/css\/app\.css/, `${name}: app.css is loaded`);
    }
});

test('the 404 and the 421 carry the banner although they render no console chrome', async () => {
    const notFound = await request({ path: '/nothing-here' });
    const refusedHost = await request({ path: '/', host: 'wrong-host.example' });

    assert.equal(notFound.status, 404);
    assert.equal(refusedHost.status, 421, 'a refused host still gets the banner on its error page');
    for (const [name, res] of [['404', notFound], ['421', refusedHost]]) {
        assert.match(res.text, /id="cookie-banner"/, `${name}: the banner is there`);
        assert.match(res.text, /\/css\/app\.css/, `${name}: and its stylesheet`);
    }
});

test('the banner is included ONCE per page, from `theme-head`, not duplicated by callers', async () => {
    const res = await request({ path: '/' });
    const banners = (res.text.match(/id="cookie-banner"/g) ?? []).length;
    const scripts = (res.text.match(/getElementById\('cookie-ok'\)/g) ?? []).length;

    assert.equal(banners, 1, 'exactly one banner element');
    assert.equal(scripts, 1, 'exactly one inline script - counted by its click handler, not the key');
});

test('NO view includes the banner without also loading app.css', async () => {
    const viewFiles = fs.readdirSync(VIEWS).filter((f) => f.endsWith('.ejs'));
    const includesBannerDirectly = [];

    for (const file of viewFiles) {
        const source = fs.readFileSync(path.join(VIEWS, file), 'utf8');
        if (file === 'theme-head.ejs' || file === 'cookie-notice.ejs') continue;
        if (/include\(['"]cookie-notice['"]/.test(source)) includesBannerDirectly.push(file);
    }

    assert.deepEqual(includesBannerDirectly, [],
        'no view includes the banner directly; it arrives through theme-head, which loads app.css');

    const themeHead = fs.readFileSync(path.join(VIEWS, 'partials', 'theme-head.ejs'), 'utf8');
    assert.match(themeHead, /include\(['"]cookie-notice['"]\)/, 'theme-head includes the banner');
    assert.match(themeHead, /\/css\/app\.css/, 'and loads app.css');
});

test('LOADING with no stored key REVEALS the banner', () => {
    const banner = runBanner({ storage: 'working' });
    assert.equal(banner.visible(), true, 'the banner is shown on a first visit');
});

test('LOADING with the key already stored LEAVES IT HIDDEN', () => {
    const banner = runBanner({ storage: 'working', storedKey: '1' });
    assert.equal(banner.visible(), false, 'a returning visitor is not shown it again');
});

test('the DISMISS control HIDES the banner and STORES the record', () => {
    const banner = runBanner({ storage: 'working' });
    assert.equal(banner.visible(), true, 'shown before the click');
    assert.equal(banner.stored(), null, 'and nothing stored yet');

    banner.click();

    assert.equal(banner.visible(), false, 'clicking HIDES it');
    assert.equal(banner.stored(), '1', `and stores \`${STORAGE_KEY}\``);
});

test('the stored key is the SAME one on every page, so one dismissal covers all of them', () => {
    const first = runBanner({ storage: 'working' });
    first.click();
    assert.equal(first.stored(), '1');

    const second = runBanner({ storage: 'working', storedKey: first.stored() });
    assert.equal(second.visible(), false, 'a different page does not show it again');
});

test('the click handler is registered exactly once per page', () => {
    const banner = runBanner({ storage: 'working' });
    assert.equal(banner.clickHandlers(), 1, 'one click handler on the dismiss control');
});

test('a THROWING localStorage SHOWS the notice - the deliberate degradation', () => {
    const blocked = runBanner({ storage: 'throwing' });
    assert.equal(blocked.visible(), true, 'the notice is SHOWN when storage throws');
});

test('an ABSENT localStorage SHOWS the notice too', () => {
    const absent = runBanner({ storage: 'absent' });
    assert.equal(absent.visible(), true, 'the notice is SHOWN when there is no storage');
});

test('a THROWING setItem still hides the banner, so the click is not a dead end', () => {
    const blocked = runBanner({ storage: 'throwing' });
    assert.equal(blocked.visible(), true, 'shown to begin with');
    blocked.click();
    assert.equal(blocked.visible(), false, 'the banner still hides on click');
});

test('the `.hidden` rule lives in app.css, which every page loads - NOT in questionnaire.css', () => {
    // `.hidden` must live in a stylesheet every page loads, or other pages show a banner WHERE
    // CLICKING DOES NOTHING.
    const app = fs.readFileSync(path.join(CSS, 'app.css'), 'utf8');
    const questionnaire = fs.readFileSync(path.join(CSS, 'questionnaire.css'), 'utf8');

    assert.match(app, /^\.hidden\s*\{[^}]*display:\s*none/m, 'app.css defines `.hidden`');
    assert.equal(/^\.hidden\s*\{/m.test(questionnaire), false,
        'questionnaire.css no longer defines it, so there is one rule rather than two that can drift');
});

test('the banner rules live in app.css, so a view cannot load them by accident or omission', () => {
    const app = fs.readFileSync(path.join(CSS, 'app.css'), 'utf8');

    for (const rule of ['.cookie-banner', '.cookie-inner', '.cookie-actions']) {
        assert.match(app, new RegExp(`\\${rule}\\s*\\{`), `app.css carries ${rule}`);
    }
    const questionnaire = fs.readFileSync(path.join(CSS, 'questionnaire.css'), 'utf8');
    assert.equal(/\.cookie-banner\s*\{/.test(questionnaire), false, 'questionnaire.css does not define the banner');
});

test('the reserved space is a custom property the script sets and the CSS consumes', () => {
    assert.match(SCRIPT, /setProperty\(\s*'--cookie-notice-height'/, 'the script writes the property');
    assert.match(SCRIPT, /offsetHeight/, 'read from the banner own measured height, not a constant');

    const app = fs.readFileSync(path.join(CSS, 'app.css'), 'utf8');
    assert.match(app, /body\s*\{[^}]*padding-bottom:\s*var\(--cookie-notice-height/,
        'the body reserves the space, so the fixed banner does not sit on the content');

    const questionnaire = fs.readFileSync(path.join(CSS, 'questionnaire.css'), 'utf8');
    assert.match(questionnaire, /--cookie-notice-height/,
        'and the questionnaire shrinks its history area by the same amount');
});

test('the banner starts HIDDEN in the markup and the script decides when to reveal it', () => {
    assert.match(PARTIAL, /class="cookie-banner hidden"/, 'the markup ships it hidden');
    assert.match(SCRIPT, /classList\.remove\('hidden'\)/, 'and the script reveals it');
});

// ===========================================================================
// 6. WHAT CANNOT BE ASSERTED HERE - recorded, not asserted away
// ===========================================================================
//
// NOT covered: the input being reachable and typeable with the banner visible. AT 360x640 AND
// 320x568 IT IS COVERED ON ARRIVAL (the header and intro exceed the viewport); SCROLLING REACHES IT.

test('each sandbox gets its OWN storage, so the once-per-browser behaviour cannot leak across tests', () => {
    const first = runBanner({ storage: 'working' });
    first.click();
    assert.equal(first.stored(), '1', 'the first dismissed it');

    const second = runBanner({ storage: 'working' });
    assert.equal(second.visible(), true, 'a FRESH sandbox still shows the banner');
    assert.equal(second.stored(), null, 'with no stored record of its own');
});

test('the overlap fix is recorded as UNVERIFIABLE here, in one place', () => {
    const hasLayoutEngine = typeof document !== 'undefined' && typeof window !== 'undefined';
    assert.equal(hasLayoutEngine, false,
        'this suite has no browser DOM, so the input-reachability measurement is NOT made here');

    const app = fs.readFileSync(path.join(CSS, 'app.css'), 'utf8');
    assert.match(app, /--cookie-notice-height/, 'the reserved-space mechanism is still in place');
});
