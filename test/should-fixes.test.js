/**
 * The two should-fixes on this branch, and the pieces they made reachable.
 *
 * 1. `minutesPerInstance` declared a shape, so its FIELD_MAXIMUMS entry applies at all. Before that the
 *    bound was dead: `checkAnswerSizes` skips a field whose shape it does not know, and
 *    `40 * 1e300 * 2` gives a FINITE 1.3e+300 that round()'s non-finite floor never caught.
 * 2. A closed organisation is refused at the RENDER door, not only at the API, and both doors say the
 *    same sentence because it is imported rather than repeated.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

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
const STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-should-'));
process.env.STORE_DIR = STORE_DIR;
process.env.SESSION_SECRET = 'h'.repeat(64);

const store = await import('../lib/store/index.js');
const shapes = await import('../ai/field-shapes.js');
const { fieldsMissingFrom } = await import('../ai/matrix.js');
const { checkAnswerSizes } = await import('../lib/store/field-limits.js');
const { byScoreDescending, scoreWorkflow } = await import('../lib/scoring.js');
const { QUESTIONNAIRE_CLOSED_MESSAGE } = await import('../lib/routes-api.js');

const { FIELD_SHAPES, FIELD_MAXIMUMS, fieldsPresentIn } = shapes;

const openOrg = store.createOrganisation('Should-fix open org');
const openInvite = store.addInvitation(openOrg.id, { email: 'open@example.test', department: 'Finance' });

/** A second organisation, closed immediately, so it differs from the open one in nothing else. */
const closedOrg = store.createOrganisation('Should-fix closed org');
const closedInvite = store.addInvitation(closedOrg.id, { email: 'closed@example.test', department: 'Ops' });
store.finishOrganisation(closedOrg.id);

const OPEN_TOKEN = openInvite.token;
const CLOSED_TOKEN = closedInvite.token;

// ===========================================================================
// 1. minutesPerInstance is now bounded
// ===========================================================================

const taskOnly = () => ({ task: 'Entering invoices', trigger: 'the mail arrives' });

test('minutesPerInstance has a declared shape, which is what makes its bound apply at all', () => {
    // Before this, FIELD_MAXIMUMS listed the number but FIELD_SHAPES had no entry, and checkAnswerSizes
    // skips an unknown shape: the bound was dead.
    assert.equal(FIELD_SHAPES.minutesPerInstance, 'count', 'the shape is declared');
    assert.equal(FIELD_MAXIMUMS.minutesPerInstance, 100000, 'and the bound is the one listed');
});

test('1e300 in minutesPerInstance is REFUSED at the write path', () => {
    // The hole: this was FINITE, so round()'s non-finite floor never saw it, and the score dominated
    // the ranking exactly as M5 describes.
    const result = checkAnswerSizes({ ...taskOnly(), minutesPerInstance: 1e300 }, FIELD_SHAPES);

    assert.equal(result.ok, false, 'the write path refuses it');
    assert.equal(result.field, 'minutesPerInstance');
    assert.equal(result.limit, 100000);
});

test('minutesPerInstance at 100000 is accepted and at 100001 refused', () => {
    assert.deepEqual(checkAnswerSizes({ ...taskOnly(), minutesPerInstance: 100000 }, FIELD_SHAPES), { ok: true },
        'exactly at the bound');

    const over = checkAnswerSizes({ ...taskOnly(), minutesPerInstance: 100001 }, FIELD_SHAPES);
    assert.equal(over.ok, false);
    assert.equal(over.field, 'minutesPerInstance');
});

test('the score that 1e300 would have produced still dominates, which is why the bound matters', () => {
    // Measured, so the harm is on record rather than asserted: with the bound bypassed the score is a
    // finite figure that ranks above every real one.
    const original = console.warn;
    console.warn = () => {};
    let absurd;
    try {
        absurd = scoreWorkflow({
            id: 'absurd', title: 'Absurd minutes',
            frequencyPerWeek: 40, minutesPerInstance: 1e300, peopleAffected: 2,
            judgementScore: 5, stepsConsistent: true
        });
    } finally {
        console.warn = original;
    }

    assert.equal(Number.isFinite(absurd.score), true, 'finite, so the non-finite floor does not catch it');
    assert.ok(absurd.score > 1e290, `and enormous (measured ${absurd.score})`);
});

// ===========================================================================
// 1b. THE REGRESSION: a response WITHOUT the field reads identically
// ===========================================================================

test('a stored response without minutesPerInstance reads IDENTICALLY - all three readers', () => {
    // THE RISK: the field is deliberately in neither PROCESS_FIELDS nor EFFORT_FIELDS, and a future
    // change to those lists would start treating an absent value as a refused one - breaking every
    // response stored before the field was declared.
    const stored = {
        task: 'Entering invoices',
        trigger: 'the mail arrives',
        steps: [{ name: 'Open the mail', whatHappens: 'Open it', decidedHow: 'it is a rule', needsReasoning: false }],
        peopleAffected: 3,
        frequencyPerWeek: 40
    };
    assert.equal('minutesPerInstance' in stored, false, 'the fixture really has no such key');

    // 1. fieldsPresentIn: the five fields it carries, and NOT minutesPerInstance.
    assert.deepEqual(fieldsPresentIn(stored),
        ['task', 'trigger', 'steps', 'peopleAffected', 'frequencyPerWeek'],
        'an absent optional field is not reported present');

    // 2. fieldsMissingFrom: the nine optional fields, and NOT minutesPerInstance.
    assert.deepEqual(fieldsMissingFrom(stored),
        ['handoffTo', 'waitsFor', 'dependsOn', 'systems', 'touchedDepartments',
            'mistakesPerPeriod', 'mistakeConsequence', 'currentState', 'frustration'],
        'and is not reported missing either, because it is not in the matrix');

    // 3. checkAnswerSizes: an absent field is accepted, so every existing response keeps its meaning.
    assert.deepEqual(checkAnswerSizes(stored, FIELD_SHAPES), { ok: true },
        'and nothing is refused for its absence');
});

test('minutesPerInstance is in neither list that feeds fieldsPresentIn', () => {
    // The mechanism behind the test above, pinned directly: declaring the shape must not have added the
    // field to a list that would make it required.
    assert.equal(shapes.PROCESS_FIELDS.includes('minutesPerInstance'), false,
        'not a required process field');
    assert.equal(shapes.EFFORT_FIELDS.includes('minutesPerInstance'), false,
        'not half of the effort pair');
});

test('an ABSENT minutesPerInstance is accepted by the store, not only by the checker', () => {
    // The end-to-end version: a real write of a response with no such field.
    const turn = store.recordTurn(openOrg.id, OPEN_TOKEN, {
        data: { ...taskOnly(), frequencyPerWeek: 40, peopleAffected: 3 }
    });
    assert.equal(turn.data.minutesPerInstance, undefined, 'stored without the field');
    assert.equal(store.getResponsesByToken(openOrg.id, OPEN_TOKEN).length > 0, true, 'and it was stored');
});

// ===========================================================================
// 2. A closed organisation is refused at the RENDER door
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

function request({ method = 'GET', path: urlPath, body }) {
    const text = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port: PORT, path: urlPath, method,
            headers: {
                host: ALLOWED_HOST, 'x-forwarded-proto': 'https',
                ...(text !== undefined
                    ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }
                    : {})
            }
        }, (res) => {
            let out = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { out += c; });
            res.on('end', () => resolve({ status: res.statusCode, text: out }));
        });
        req.on('error', reject);
        if (text !== undefined) req.write(text);
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
            ALLOWED_HOST, SESSION_SECRET: 'h'.repeat(64), STORE_DIR,
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

/**
 * The input boxes a participant could TYPE INTO.
 *
 * Not every `<input>`: the theme picker carries a hidden `next` field on every page, so counting all
 * inputs would count it as a form. A hidden field is not a box, and the assertion is about whether the
 * participant is offered somewhere to type.
 */
const textInputs = (html) => (html.match(/<input\b[^>]*type="(?:text|textarea)"/g) || []).length;

test('GET /q/<token> for a CLOSED organisation is 409 with NO input box', async () => {
    // The render door: before this the page drew an input box and a send button, so the participant
    // typed their first answer and only then found out it could not be kept.
    const res = await request({ path: `/q/${CLOSED_TOKEN}` });

    assert.equal(res.status, 409, 'the status agrees with the body');
    assert.equal(textInputs(res.text), 0, 'and there is no box to type into');
    assert.equal(/<textarea\b/.test(res.text), false, 'nor a text area');
    assert.equal(/id="send-btn"/.test(res.text), false, 'nor a send control');
});

test('GET /q/<token> for an OPEN organisation is 200 WITH an input box', async () => {
    // The control: the closed check must not refuse a working questionnaire.
    const res = await request({ path: `/q/${OPEN_TOKEN}` });

    assert.equal(res.status, 200);
    assert.equal(textInputs(res.text) >= 1, true, 'there is a box to type into');
    assert.equal(/id="send-btn"/.test(res.text), true, 'and a send control');
});

test('the page and the API carry the SAME sentence, character for character', async () => {
    // Compared, not assumed: two copies would drift and a participant would get a different
    // explanation depending on which door they came through.
    const page = await request({ path: `/q/${CLOSED_TOKEN}` });
    const api = await request({
        method: 'POST', path: '/api/chat',
        body: { participantToken: CLOSED_TOKEN, messages: [{ role: 'user', content: 'hello' }] }
    });

    assert.equal(page.status, 409);
    assert.equal(api.status, 403);

    const pageSaysIt = page.text.includes(QUESTIONNAIRE_CLOSED_MESSAGE);
    const apiBody = JSON.parse(api.text).content;

    assert.equal(pageSaysIt, true, 'the page carries the exported sentence');
    assert.equal(apiBody, QUESTIONNAIRE_CLOSED_MESSAGE, 'the API carries it exactly');
    assert.equal(pageSaysIt && apiBody === QUESTIONNAIRE_CLOSED_MESSAGE, true,
        'so both doors say the same thing');
});

test('the closed sentence is the only one either door uses for a closed round', () => {
    // The sentence itself, pinned as the exported constant so a rewrite of one door cannot pass by
    // copying it wrongly.
    assert.equal(typeof QUESTIONNAIRE_CLOSED_MESSAGE, 'string');
    assert.match(QUESTIONNAIRE_CLOSED_MESSAGE, /has been closed/i, 'it says the questionnaire is closed');
    assert.match(QUESTIONNAIRE_CLOSED_MESSAGE, /answers so far are saved/i, 'and that earlier answers are kept');
});

// ===========================================================================
// 3. byScoreDescending
// ===========================================================================

// WHY THESE ARE HAND-BUILT. `aggregate()` can never reach the NaN branch: `round()` floors every score
// to a finite number before the sort runs, so removing the guard would leave the whole suite green. The
// comparator is exported so it can be handed two Infinity scores directly. That makes it defence in
// depth rather than a live fix - and defence in depth that nothing exercises is the kind of code that
// quietly rots. Do not delete these as "impossible to reach": they are the only thing that keeps the
// guard honest.

test('byScoreDescending returns 0 for two Infinity scores, not NaN', () => {
    const result = byScoreDescending({ score: Infinity }, { score: Infinity });

    assert.equal(Number.isNaN(result), false, 'the comparator never returns NaN');
    assert.equal(result, 0, 'two equal scores are a tie');
});

test('byScoreDescending treats a NaN score as a tie rather than poisoning the comparison', () => {
    // A comparator that returned NaN leaves the order of those entries to whatever the sort does.
    for (const pair of [
        [{ score: NaN }, { score: NaN }],
        [{ score: NaN }, { score: 10 }],
        [{ score: 10 }, { score: NaN }],
        [{ score: Infinity }, { score: 10 }]
    ]) {
        assert.equal(Number.isNaN(byScoreDescending(...pair)), false,
            `${JSON.stringify(pair.map((p) => p.score))} does not return NaN`);
    }
});

test('byScoreDescending sorts an ordinary list descending', () => {
    const list = [{ score: 5 }, { score: 60 }, { score: 13.33 }, { score: 0 }];
    const sorted = [...list].sort(byScoreDescending);

    assert.deepEqual(sorted.map((w) => w.score), [60, 13.33, 5, 0], 'highest first');
});

test('byScoreDescending orders two ordinary scores negatively for the higher one', () => {
    // The direction stated directly, not inferred from a sorted result.
    assert.ok(byScoreDescending({ score: 60 }, { score: 10 }) < 0, 'the higher score sorts first');
    assert.ok(byScoreDescending({ score: 10 }, { score: 60 }) > 0, 'and the lower one after it');
    assert.equal(byScoreDescending({ score: 7 }, { score: 7 }), 0, 'equal scores tie');
});

// ===========================================================================
// 4. round's non-finite floor
// ===========================================================================

test('round returns 0 for a non-finite figure AND logs a warning', () => {
    // Reached through the overflow path, because `measuredNumber` rejects a non-finite FACTOR before the
    // product is taken: the product of large finite factors is how a non-finite figure gets here.
    const original = console.warn;
    const lines = [];
    console.warn = (...args) => { lines.push(args.join(' ')); };
    let scored;
    try {
        scored = scoreWorkflow({
            id: 'overflow', title: 'Overflowing product',
            frequencyPerWeek: 1e200, minutesPerInstance: 1e200, peopleAffected: 1e200,
            judgementScore: 5, stepsConsistent: true
        });
    } finally {
        console.warn = original;
    }

    assert.equal(scored.score, 0, 'the score floors to 0');
    assert.equal(scored.effortHoursPerWeek, 0, 'and the effort with it');
    assert.ok(lines.some((l) => /non-finite figure/.test(l)), 'and a warning names the figure');
});

// ===========================================================================
// 6. THE DEMO
// ===========================================================================

test('the demo scores are unchanged: 68, 58, 58, 58, 58, 38, 38', () => {
    // Read from a COPY in /tmp, opened read-only. data/demo is never opened for writing.
    const copyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-demo-copy-'));
    try {
        fs.cpSync(path.join(PROJECT_ROOT, 'data', 'demo'), copyDir, { recursive: true });
        const db = new DatabaseSync(path.join(copyDir, 'orgs', 'example-ltd-demo.db'), { readOnly: true });
        try {
            const scores = db.prepare('SELECT score FROM process_score WHERE is_current = 1 ORDER BY score DESC')
                .all().map((row) => row.score);
            assert.deepEqual(scores, [68, 58, 58, 58, 58, 38, 38], 'the committed demo scores are unchanged');
        } finally {
            db.close();
        }
    } finally {
        fs.rmSync(copyDir, { recursive: true, force: true });
    }
});
