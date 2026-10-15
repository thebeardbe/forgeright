/**
 * The cookie notice: one partial, every page, and a dismiss control that works wherever it appears.
 *
 * WHY IT IS A SHARED PARTIAL, and why the two symptoms were one cause. The banner's markup and
 * script must not live inline in one page: a page without the partial has no banner at all, and a
 * banner whose button does nothing reads as a broken click. It is a partial included from
 * `theme-head`, which every page already renders.
 *
 * TWO THINGS THAT COULD SHIP BROKEN, and they are what this file exists to catch:
 *
 *   1. `.hidden` LIVED ONLY IN `questionnaire.css`. The banner uses it in the markup and on click,
 *      so extracting the markup without moving that rule would have put a VISIBLE banner on the
 *      other pages where clicking did nothing - the owner's symptom, widened to nine pages.
 *   2. THE BANNER COVERS THE QUESTIONNAIRE'S INPUT. It is `position: fixed; bottom: 0`, 177px tall
 *      at 390px, and `elementFromPoint` at the input's centre returned the banner, so a participant
 *      could not type.
 *
 * TWO KINDS OF ASSERTION, chosen to fit what each claim actually is:
 *
 *   - THE PAGE REACH is driven over HTTP against a spawned server, because "it renders here" is a
 *     statement about a real request through the real router - a source grep would pass on a view
 *     that includes the partial inside a branch that never runs.
 *   - THE DISMISS BEHAVIOUR runs the partial's OWN SCRIPT in a `node:vm` sandbox with a stub DOM.
 *     There is no DOM library in this project, and the script touches a small, known surface, so a
 *     stub is enough to answer "does clicking hide it and store the key" - which is the assertion
 *     that would have caught `.hidden` being left behind.
 *
 * WHAT THIS FILE CANNOT DO IS MEASURE LAYOUT. The overlap fix is a CSS custom property, and its
 * effect on whether a participant can reach the input needs a browser's layout engine - see the
 * section at the end, which characterises the mechanism and says plainly what was not verified.
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

/** The partial's source, read once: the markup, the script and the CSS rules all come from it. */
const PARTIAL = fs.readFileSync(path.join(VIEWS, 'partials', 'cookie-notice.ejs'), 'utf8');
const STORAGE_KEY = 'fr_cookie_notice';

/** The banner's inline script, extracted from the partial so the tests run the REAL code. */
const SCRIPT = (() => {
    const match = PARTIAL.match(/<script>([\s\S]*?)<\/script>/);
    assert.notEqual(match, null, 'the partial carries an inline script');
    return match[1];
})();

// ===========================================================================
// THE SANDBOX - the partial's own script, against a stub DOM
// ===========================================================================

/**
 * Runs the banner's script against a stub DOM and returns handles to inspect it.
 *
 * `storage` is `'working'`, `'throwing'` (getItem throws, as a blocked store does) or `'absent'`
 * (`localStorage` is undefined, as in an environment without it).
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

// ===========================================================================
// 1. THE PAGE REACH - driven over HTTP, not grepped
// ===========================================================================

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

/** One HTTP request, with the allowed Host and the trusted HTTPS header. */
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
            // Neutralised so an untracked `.env` cannot change this suite's behaviour.
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

    // An admin session, for the console pages. The sign-in link is printed to the log.
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
 * The page types the banner must reach, with the reason each is on the list.
 *
 * THE LAST TWO ARE THE POINT of including them: the 404 and the 421 render WITHOUT console chrome,
 * from the error page rather than a console view, and they are the ones most likely to have been
 * missed when the banner moved into `theme-head`.
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
        // The markup, and NOT `hidden` in the served HTML: the script decides whether to reveal it,
        // so a page that shipped it visible would flash for everybody who had already dismissed it.
        assert.match(res.text, /id="cookie-banner"/, `${name}: the banner markup is rendered`);
        assert.match(res.text, /class="cookie-banner hidden"/, `${name}: it starts hidden`);
        // The script travels with the markup, so a page cannot get one without the other.
        assert.match(res.text, new RegExp(STORAGE_KEY), `${name}: the inline script is rendered`);
        assert.match(res.text, /id="cookie-ok"/, `${name}: the dismiss control is rendered`);
        // THE STYLESHEET, because a page with the markup and no `app.css` renders a fixed,
        // unstyled bar and a control whose `.hidden` rule does nothing.
        assert.match(res.text, /\/css\/app\.css/, `${name}: app.css is loaded`);
    }
});

test('the 404 and the 421 carry the banner although they render no console chrome', async () => {
    // Called out separately because they are the two the owner's report would have missed: they
    // come from `views/error.ejs`, not from a console view, and they render with no session.
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
    // A page that included the partial directly AND through `theme-head` would render two banners
    // and two scripts, and the second `getElementById` would attach a second click handler.
    //
    // THE SCRIPT IS COUNTED BY THE BLOCK THAT CARRIES THE BEHAVIOUR, not by occurrences of the key:
    // the key appears TWICE inside one script (`getItem` and `setItem`), which an earlier version of
    // this test read as two scripts. The marker used is the click handler, which appears once per
    // script and nowhere else.
    const res = await request({ path: '/' });
    const banners = (res.text.match(/id="cookie-banner"/g) ?? []).length;
    const scripts = (res.text.match(/getElementById\('cookie-ok'\)/g) ?? []).length;

    assert.equal(banners, 1, 'exactly one banner element');
    assert.equal(scripts, 1, 'exactly one inline script - counted by its click handler, not the key');
});

test('NO view includes the banner without also loading app.css', async () => {
    // The structural form of the stylesheet claim, checked across every view rather than the pages
    // a request happens to reach: a view that included the partial and skipped `app.css` would
    // render a fixed unstyled bar. Both arrive through `theme-head`, and this asserts that no view
    // reaches the partial another way.
    const viewFiles = fs.readdirSync(VIEWS).filter((f) => f.endsWith('.ejs'));
    const includesBannerDirectly = [];

    for (const file of viewFiles) {
        const source = fs.readFileSync(path.join(VIEWS, file), 'utf8');
        // `theme-head` and the partial itself are the legitimate carriers.
        if (file === 'theme-head.ejs' || file === 'cookie-notice.ejs') continue;
        if (/include\(['"]cookie-notice['"]/.test(source)) includesBannerDirectly.push(file);
    }

    assert.deepEqual(includesBannerDirectly, [],
        'no view includes the banner directly; it arrives through theme-head, which loads app.css');

    // And `theme-head` itself really carries both.
    const themeHead = fs.readFileSync(path.join(VIEWS, 'partials', 'theme-head.ejs'), 'utf8');
    assert.match(themeHead, /include\(['"]cookie-notice['"]\)/, 'theme-head includes the banner');
    assert.match(themeHead, /\/css\/app\.css/, 'and loads app.css');
});

// ===========================================================================
// 2 & 3. THE DISMISS CONTROL, AND ONE KEY FOR EVERY PAGE
// ===========================================================================

test('LOADING with no stored key REVEALS the banner', () => {
    const banner = runBanner({ storage: 'working' });
    assert.equal(banner.visible(), true, 'the banner is shown on a first visit');
});

test('LOADING with the key already stored LEAVES IT HIDDEN', () => {
    const banner = runBanner({ storage: 'working', storedKey: '1' });
    assert.equal(banner.visible(), false, 'a returning visitor is not shown it again');
});

test('the DISMISS control HIDES the banner and STORES the record', () => {
    // THE ASSERTION THAT WOULD HAVE CAUGHT `.hidden` BEING LEFT BEHIND. If the rule stayed in
    // `questionnaire.css`, the click would still store the key and remove the class, so this test
    // alone would pass - which is why the CSS section below asserts the rule's location too.
    const banner = runBanner({ storage: 'working' });
    assert.equal(banner.visible(), true, 'shown before the click');
    assert.equal(banner.stored(), null, 'and nothing stored yet');

    banner.click();

    assert.equal(banner.visible(), false, 'clicking HIDES it');
    assert.equal(banner.stored(), '1', `and stores \`${STORAGE_KEY}\``);
});

test('the stored key is the SAME one on every page, so one dismissal covers all of them', () => {
    // ONE KEY, not one per page: dismissing on the landing page must silence the console, the
    // questionnaire and the error pages too. The script is the same partial everywhere, so this
    // asserts the key it writes is the key it reads.
    const first = runBanner({ storage: 'working' });
    first.click();
    assert.equal(first.stored(), '1');

    // A SECOND page's script - same partial, so same key - sees the stored record and stays hidden.
    const second = runBanner({ storage: 'working', storedKey: first.stored() });
    assert.equal(second.visible(), false, 'a different page does not show it again');
});

test('the click handler is registered exactly once per page', () => {
    // A page that rendered the partial twice would attach two handlers; the count is cheap to pin.
    const banner = runBanner({ storage: 'working' });
    assert.equal(banner.clickHandlers(), 1, 'one click handler on the dismiss control');
});

// ===========================================================================
// 4. THE DEGRADATION - storage unavailable means SHOWN, not silently absent
// ===========================================================================

test('a THROWING localStorage SHOWS the notice - the deliberate degradation', () => {
    // A banner that silently never appears is worse than one that appears twice: a reader who
    // cannot dismiss it is annoyed, while a reader who never sees it is not told at all. The
    // `catch` reveals rather than hides, and this asserts that direction.
    const blocked = runBanner({ storage: 'throwing' });
    assert.equal(blocked.visible(), true, 'the notice is SHOWN when storage throws');
});

test('an ABSENT localStorage SHOWS the notice too', () => {
    // The same degradation reached the other way: the property is not there at all, so the read
    // throws a ReferenceError-adjacent failure inside the same `try`.
    const absent = runBanner({ storage: 'absent' });
    assert.equal(absent.visible(), true, 'the notice is SHOWN when there is no storage');
});

test('a THROWING setItem still hides the banner, so the click is not a dead end', () => {
    // The click must visibly work even when the record cannot be written. Otherwise the button
    // appears broken and the reader presses it repeatedly.
    const blocked = runBanner({ storage: 'throwing' });
    assert.equal(blocked.visible(), true, 'shown to begin with');
    blocked.click();
    assert.equal(blocked.visible(), false, 'the banner still hides on click');
});

// ===========================================================================
// 5. THE STYLESHEET - the rule the banner depends on
// ===========================================================================

test('the `.hidden` rule lives in app.css, which every page loads - NOT in questionnaire.css', () => {
    // The banner carries `hidden` in its markup and adds it on click, so `.hidden` must live in a
    // stylesheet every page loads. Defined only in `questionnaire.css`, it would leave a visible
    // banner on every other page WHERE CLICKING DID NOTHING - a broken control, not an absent one.
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
    // And the questionnaire's file no longer holds them.
    const questionnaire = fs.readFileSync(path.join(CSS, 'questionnaire.css'), 'utf8');
    assert.equal(/\.cookie-banner\s*\{/.test(questionnaire), false, 'questionnaire.css does not define the banner');
});

test('the reserved space is a custom property the script sets and the CSS consumes', () => {
    // The overlap mechanism, asserted STRUCTURALLY: the script measures the banner and writes
    // `--cookie-notice-height`; `app.css` pads the body by it; `questionnaire.css` shrinks the
    // history area by it. Whether that is ENOUGH at a given viewport needs layout - see below.
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
    // The order matters: a served-visible banner would flash for a returning visitor before the
    // script hid it. The class is in the markup, and the script REMOVES it rather than adding it.
    assert.match(PARTIAL, /class="cookie-banner hidden"/, 'the markup ships it hidden');
    assert.match(SCRIPT, /classList\.remove\('hidden'\)/, 'and the script reveals it');
});

// ===========================================================================
// 6. WHAT CANNOT BE ASSERTED HERE - recorded, not asserted away
// ===========================================================================
//
// POINT 5 OF THE BRIEF ASKED FOR A REAL MEASUREMENT: "the input must be reachable and typeable with
// the banner visible". THAT CANNOT BE DONE IN THIS SUITE, and no assertion below pretends to.
//
//   - There is no DOM or layout engine in this project. `elementFromPoint`, `offsetHeight` and a
//     computed `padding-bottom` are all layout queries, and a `node:vm` stub can only return the
//     numbers a test hands it - which is how a test comes to "verify" the very thing it assumed.
//   - The browser measurement at four viewports is the evidence for the layout; it is not
//     reproducible here. What is asserted is the MECHANISM: the property is written from the
//     banner's own height, the body consumes it, and the questionnaire shrinks by it. Whether
//     `max(120px, calc(360px - h))` clears the input at a given width is a layout question.
//
// AND TWO HONEST LIMITS THIS FILE DOES NOT TEST, RECORDED SO THEY ARE NOT LOST:
//
//   1. AT 360x640 AND 320x568 THE INPUT IS STILL COVERED ON ARRIVAL, because the header and the
//      intro alone exceed the viewport. SCROLLING REACHES IT and typing works, so no participant
//      is blocked - but a reader at that size does not see the input until they scroll. No test
//      here asserts otherwise, because there is nothing to assert it with.
//   2. THE BANNER APPEARS ONCE PER BROWSER, tied to `localStorage`. There is no `localStorage`
//      isolation needed in this file, because the suite never shares one: every `runBanner` call
//      builds a FRESH store, so the "skip/none" path cannot leak between tests. That is a property
//      of the harness, checked below rather than assumed.

test('each sandbox gets its OWN storage, so the once-per-browser behaviour cannot leak across tests', () => {
    // The skip/none path in one test must not silence another. Verified rather than asserted: two
    // sandboxes are independent, and a dismissal in the first is invisible to the second.
    const first = runBanner({ storage: 'working' });
    first.click();
    assert.equal(first.stored(), '1', 'the first dismissed it');

    const second = runBanner({ storage: 'working' });
    assert.equal(second.visible(), true, 'a FRESH sandbox still shows the banner');
    assert.equal(second.stored(), null, 'with no stored record of its own');
});

test('the overlap fix is recorded as UNVERIFIABLE here, in one place', () => {
    // A test that states the limit, so a future reader finds it rather than inferring coverage from
    // the structural assertions above. It asserts the two facts that ARE checkable: the mechanism
    // exists in the CSS, and this suite has no layout engine to measure its effect.
    const hasLayoutEngine = typeof document !== 'undefined' && typeof window !== 'undefined';
    assert.equal(hasLayoutEngine, false,
        'this suite has no browser DOM, so the input-reachability measurement is NOT made here');

    // What IS verifiable is that the mechanism was not quietly dropped.
    const app = fs.readFileSync(path.join(CSS, 'app.css'), 'utf8');
    assert.match(app, /--cookie-notice-height/, 'the reserved-space mechanism is still in place');
});
