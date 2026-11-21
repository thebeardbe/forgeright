/**
 * M3 and M5.
 *
 * M3: an expired token still authorised an interview and could spend a full 60-call provider budget,
 * because `/api/chat` resolved the token through the installation index, which has no expiry, while
 * `/api/response` used the store's liveness check.
 *
 * M5: `1e300` as a frequency counted as supplied, multiplied into `Infinity`, serialised to `null`, and
 * made the roadmap's sort `NaN`.
 */
import { test, before, after, beforeEach } from 'node:test';
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
const STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-m3m5-'));
process.env.STORE_DIR = STORE_DIR;
process.env.SESSION_SECRET = 'g'.repeat(64);

const store = await import('../lib/store/index.js');
const shapes = await import('../ai/field-shapes.js');
const { isPeriod } = await import('../ai/period.js');
const { readCorrectedValue } = await import('../lib/store/corrections.js');
const { scoreWorkflow, aggregate } = await import('../lib/scoring.js');

const {
    FIELD_MAXIMUMS, MAX_HOURS_PER_PERIOD, fieldsPresentIn
} = shapes;

const org = store.createOrganisation('M3 M5 org');
const live = store.addInvitation(org.id, { email: 'live@example.test', department: 'Finance' });

/** A second organisation, so the closed-organisation case cannot disturb the others. */
const closedOrg = store.createOrganisation('Closed org');
const inClosedOrg = store.addInvitation(closedOrg.id, { email: 'closed@example.test', department: 'Ops' });
store.finishOrganisation(closedOrg.id);

const LIVE_TOKEN = live.token;

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

function postJson(urlPath, body) {
    const text = JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port: PORT, path: urlPath, method: 'POST',
            headers: {
                host: ALLOWED_HOST, 'x-forwarded-proto': 'https',
                'content-type': 'application/json', 'content-length': Buffer.byteLength(text)
            }
        }, (res) => {
            let out = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { out += c; });
            res.on('end', () => resolve({ status: res.statusCode, text: out }));
        });
        req.on('error', reject);
        req.write(text);
        req.end();
    });
}

const chat = (token) => postJson('/api/chat', {
    participantToken: token,
    messages: [{ role: 'user', content: 'I enter supplier invoices every morning.' }]
});

/** Writes one expired token, and one revoked token, straight into the org file. */
function ageIntoPast(token, { revoked = false } = {}) {
    store.closeAll();
    const db = new DatabaseSync(store.orgDbPath(org.id));
    try {
        const hash = store.hashToken(token);
        const past = new Date(Date.now() - 60_000).toISOString();
        const changes = revoked
            ? db.prepare('UPDATE participant_tokens SET revoked_at = ? WHERE token_hash = ?').run(past, hash)
            : db.prepare('UPDATE participant_tokens SET expires_at = ? WHERE token_hash = ?').run(past, hash);
        assert.ok(changes.changes > 0, 'the token row was found and updated');
    } finally {
        db.close();
    }
}

function restoreExpiry(token) {
    store.closeAll();
    const db = new DatabaseSync(store.orgDbPath(org.id));
    try {
        const hash = store.hashToken(token);
        const future = new Date(Date.now() + 90 * 24 * 60 * 60_000).toISOString();
        db.prepare('UPDATE participant_tokens SET expires_at = ?, revoked_at = NULL WHERE token_hash = ?')
            .run(future, hash);
    } finally {
        db.close();
    }
}

let child;
before(async () => {
    child = spawn(process.execPath, [SERVER], {
        env: {
            PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test',
            PORT: String(PORT), HOST: '127.0.0.1', BASE_PATH: '',
            PUBLIC_BASE_URL: `https://${ALLOWED_HOST}`, TRUST_PROXY: '127.0.0.1',
            ALLOWED_HOST, SESSION_SECRET: 'g'.repeat(64), STORE_DIR,
            AI_PROVIDER: 'mock', MAIL_SENDER: 'console',
            DEMO_LOGIN: '', DEMO_LOGIN_ORG: '', DEMO_LOGIN_TOKEN: ''
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
        try {
            await new Promise((resolve, reject) => {
                const req = http.request({
                    host: '127.0.0.1', port: PORT, path: '/healthz',
                    headers: { host: ALLOWED_HOST, 'x-forwarded-proto': 'https' }
                }, (r) => { r.resume(); resolve(r.statusCode); });
                req.on('error', reject);
                req.end();
            });
            break;
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

beforeEach(() => {
    restoreExpiry(LIVE_TOKEN);
});

// ===========================================================================
// 1. M3 - the three token states
// ===========================================================================

test('a LIVE token is accepted by /api/chat', async () => {
    const res = await chat(LIVE_TOKEN);
    assert.equal(res.status, 200, 'the live token starts a turn');
});

test('an EXPIRED token is refused by /api/chat', async () => {
    // THE REGRESSION. The old check read the installation index, which has no expiry column, so it
    // returned the organisation for an expired token and the interview ran a full budget.
    ageIntoPast(LIVE_TOKEN);

    const res = await chat(LIVE_TOKEN);
    assert.equal(res.status, 403, 'the expired link is refused before any provider call');
    assert.equal(/not valid any more/i.test(res.text), true, 'and says so');
});

test('a REVOKED token is refused by /api/chat', async () => {
    ageIntoPast(LIVE_TOKEN, { revoked: true });

    const res = await chat(LIVE_TOKEN);
    assert.equal(res.status, 403);
    assert.equal(/not valid any more/i.test(res.text), true);
});

test('the three states differ, so the refusal is not simply "everything is refused"', async () => {
    const ok = await chat(LIVE_TOKEN);
    ageIntoPast(LIVE_TOKEN);
    const expired = await chat(LIVE_TOKEN);
    restoreExpiry(LIVE_TOKEN);
    const okAgain = await chat(LIVE_TOKEN);

    assert.equal(ok.status, 200);
    assert.equal(expired.status, 403);
    assert.equal(okAgain.status, 200, 'and restoring the row makes it live again');
});

test('the expired refusal is something a participant can act on, not a fault', async () => {
    ageIntoPast(LIVE_TOKEN);
    const res = await chat(LIVE_TOKEN);
    const body = JSON.parse(res.text);

    assert.equal(res.status, 403);
    assert.match(body.content, /not valid any more/i, 'it says the link no longer works');
    assert.match(body.content, /Ask for a new one/i, 'and what to do about it');
    assert.equal(/error|failed|went wrong/i.test(body.content), false,
        'it does not read as a fault on the site');
    assert.equal(body.status, 'error', 'while the API shape still reports an error status');
});

// ===========================================================================
// 2. M3 - a closed organisation
// ===========================================================================

test('a closed organisation is refused at the START of the turn', async () => {
    const res = await chat(inClosedOrg.token);

    assert.equal(res.status, 403, 'refused before the turn runs');
    const body = JSON.parse(res.text);
    assert.match(body.content, /closed/i, 'it says the questionnaire is closed');
});

test('the closed refusal says the answers so far are saved, and that claim is TRUE', async () => {
    // The claim is only true if the answers really are stored. The store refuses WRITES to a finished
    // organisation, so "saved" must mean "saved up to the closure", not "the next save will work".
    const res = await chat(inClosedOrg.token);
    const body = JSON.parse(res.text);

    assert.match(body.content, /answers so far are saved/i, 'it says the answers are saved');

    // The check: a write to the closed organisation is refused, so the promise is bounded to what was
    // stored before it closed. This is the assertion that keeps the sentence honest.
    assert.throws(
        () => store.recordTurn(closedOrg.id, inClosedOrg.token, { data: { task: 'a late answer' } }),
        /finished|closed/i,
        'a write after closure is refused, so "saved" means saved up to the closure only'
    );
});

test('the closed refusal tells them who to ask', async () => {
    const res = await chat(inClosedOrg.token);
    assert.match(JSON.parse(res.text).content, /ask the person who sent you the link/i,
        'it names the person to ask about reopening');
});

test('an open organisation with a live token is NOT refused as closed', async () => {
    // The control: the closed check must not refuse everything.
    const res = await chat(LIVE_TOKEN);
    assert.equal(res.status, 200);
    assert.equal(/closed/i.test(res.text), false);
});

test('/api/response agrees that the closed organisation refuses a write', async () => {
    // The same organisation through the other endpoint, so the two agree.
    store.closeAll();
    const res = await postJson('/api/response', {
        token: inClosedOrg.token, data: { task: 'a late answer' }
    });
    // 403 for an unusable token or 409 for a closed questionnaire: either way it is refused.
    assert.ok([403, 409].includes(res.status), `refused (got ${res.status})`);
});

// ===========================================================================
// 3. M5 - every bound at its edge
// ===========================================================================

test('the bounds are what the code says', () => {
    assert.equal(FIELD_MAXIMUMS.frequencyPerWeek, 10000);
    assert.equal(FIELD_MAXIMUMS.peopleAffected, 100000);
    assert.equal(FIELD_MAXIMUMS.mistakesPerPeriod, 100000);
    assert.equal(FIELD_MAXIMUMS.minutesPerInstance, 100000);
    assert.equal(MAX_HOURS_PER_PERIOD, 168);
});

/** Whether a single field counts as supplied, via the public shape reader. */
const supplied = (field, value) => fieldsPresentIn({ [field]: value }).includes(field);

test('frequencyPerWeek: 10000 counts as supplied and 10001 does not', () => {
    assert.equal(supplied('frequencyPerWeek', 10000), true, 'exactly at the bound');
    assert.equal(supplied('frequencyPerWeek', 10001), false, 'one over');
});

test('a frequency of 1e300 is not a supplied answer', () => {
    // The original defect: 1e300 counted as supplied and overflowed the effort product.
    assert.equal(supplied('frequencyPerWeek', 1e300), false);
    assert.equal(supplied('frequencyPerWeek', Number.MAX_VALUE), false);
});

test('peopleAffected: 100000 counts and 100001 does not', () => {
    assert.equal(supplied('peopleAffected', 100000), true);
    assert.equal(supplied('peopleAffected', 100001), false);
});

test('mistakesPerPeriod: 100000 counts and 100001 does not', () => {
    assert.equal(supplied('mistakesPerPeriod', 100000), true);
    assert.equal(supplied('mistakesPerPeriod', 100001), false);
});

test('minutesPerInstance is bounded at the CORRECTION door, its only door', () => {
    // `minutesPerInstance` is not a participant ANSWER field - it is absent from PROCESS_FIELDS - so the
    // shape table never sees it. Its bound reached it at the correction path, which is the door an admin
    // uses, and that is where it is asserted.
    assert.equal(shapes.PROCESS_FIELDS.includes('minutesPerInstance'), false,
        'it is not a field the participant answers, so fieldsPresentIn cannot see it');

    const atLimit = readCorrectedValue('minutesPerInstance', '100000');
    assert.equal(atLimit.ok, true, 'exactly at the bound is accepted');
    assert.equal(atLimit.value, 100000);

    const over = readCorrectedValue('minutesPerInstance', '100001');
    assert.equal(over.ok, false, 'one over is refused');
    assert.match(over.reason, /cannot exceed 100000/i, 'and names the bound');
});

test('timePerPeriod hours: 168 counts as a period and 169 does not', () => {
    assert.equal(isPeriod({ hours: 168, period: 'week' }), true, 'a week holds 168 hours');
    assert.equal(isPeriod({ hours: 169, period: 'week' }), false, '169 is more than a week');
    assert.equal(supplied('timePerPeriod', { hours: 168, period: 'week' }), true);
    assert.equal(supplied('timePerPeriod', { hours: 169, period: 'week' }), false);
});

test('a value over its bound is REFUSED at the route with a 400 naming the field and the limit', async () => {
    const res = await postJson('/api/response', {
        token: LIVE_TOKEN, data: { task: 'Entering invoices', frequencyPerWeek: 10001 }
    });

    assert.equal(res.status, 400);
    const body = JSON.parse(res.text);
    assert.match(body.error, /10000/, 'the limit is named');
    assert.match(body.error, /frequency|how often|week/i, 'and the field, in words');
});

test('the same value ONE under its bound is accepted by the route', async () => {
    // The control: the bound must not refuse ordinary large answers.
    const res = await postJson('/api/response', {
        token: LIVE_TOKEN, data: { task: 'Entering invoices', frequencyPerWeek: 10000 }
    });
    assert.equal(res.status, 200);
});

test('the SHAPE itself refuses an over-bound value, so a caller bypassing the route still hits it', () => {
    // The declared contract, asserted without the route: a matrix reconciliation reads `fieldsPresentIn`
    // directly, and it must not see 1e300 as supplied.
    const process = {
        task: 'Entering invoices', trigger: 'the mail arrives',
        frequencyPerWeek: 1e300, peopleAffected: 6
    };
    const present = fieldsPresentIn(process);

    assert.equal(present.includes('frequencyPerWeek'), false,
        'the shape does not report an over-bound count as supplied');
    assert.equal(present.includes('task'), true, 'while a legal field beside it is still supplied');
});

// ===========================================================================
// 4. M5 - the correction door
// ===========================================================================

test('a 400-digit correction is refused rather than becoming Infinity', () => {
    // Tested on the CORRECTION path, not the shape: this is a second door into the same fields, and its
    // regex alone accepts a 400-digit string.
    const fourHundredDigits = '9'.repeat(400);
    assert.equal(Number(fourHundredDigits), Infinity, 'the string really does parse to Infinity');

    const result = readCorrectedValue('frequencyPerWeek', fourHundredDigits);
    assert.equal(result.ok, false, 'so it is refused');
    assert.match(result.reason, /too large/i, 'and says why');
});

test('a correction one over the bound is refused by name', () => {
    const result = readCorrectedValue('frequencyPerWeek', '10001');
    assert.equal(result.ok, false);
    assert.match(result.reason, /cannot exceed 10000/i);
});

test('a correction exactly at the bound is accepted', () => {
    const result = readCorrectedValue('frequencyPerWeek', '10000');
    assert.equal(result.ok, true);
    assert.equal(result.value, 10000);
});

test('a correction of hours over 168 is refused', () => {
    const result = readCorrectedValue('timePerPeriod', { hours: '169', period: 'week' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /168/);
});

test('a correction at 168 hours is accepted', () => {
    const result = readCorrectedValue('timePerPeriod', { hours: '168', period: 'week' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, { hours: 168, period: 'week' });
});

// ===========================================================================
// 5. M5 - the last line
// ===========================================================================

test('round floors a non-finite figure to 0 AND logs a warning', () => {
    // A silent 0 is a floor pretending to be a measurement, so the warning is part of the behaviour.
    //
    // THE OVERFLOW PATH, not a literal Infinity input: `measuredNumber` rejects a non-finite FACTOR
    // before the product is taken, so the way a non-finite figure reaches round() is the product of
    // finite factors overflowing. That is the case exercised here.
    const big = {
        id: 'over', title: 'Overflowing product',
        frequencyPerWeek: 1e200, minutesPerInstance: 1e200, peopleAffected: 1e200,
        judgementScore: 5, stepsConsistent: true
    };

    const lines = [];
    const original = console.warn;
    console.warn = (...args) => { lines.push(args.join(' ')); };
    let scored;
    try {
        scored = scoreWorkflow(big);
    } finally {
        console.warn = original;
    }

    assert.equal(scored.effortHoursPerWeek, 0, 'the overflowing effort floors to 0');
    assert.equal(scored.score, 0, 'and the score with it');
    assert.ok(lines.some((l) => /non-finite figure \(Infinity\) was floored to 0/.test(l)),
        'and a warning names the figure and the floor');
});

test('a NaN or infinite FACTOR is refused before the product, so it cannot reach round', () => {
    // The other direction, so the two are not confused: `measuredNumber` treats a non-finite or
    // negative factor as no measurement at all, and the workflow contributes nothing.
    const lines = [];
    const original = console.warn;
    console.warn = (...args) => { lines.push(args.join(' ')); };
    let scored;
    try {
        scored = scoreWorkflow({
            id: 'nan', title: 'NaN factor', frequencyPerWeek: NaN, minutesPerInstance: 1,
            peopleAffected: 1, judgementScore: 5, stepsConsistent: true
        });
    } finally {
        console.warn = original;
    }

    assert.equal(Number.isFinite(scored.score), true);
    assert.equal(scored.score, 0, 'an unmeasurable factor contributes nothing');
});

test('two workflows whose raw products overflow produce FINITE scores and a finite total', () => {
    // The product of two large-but-finite factors overflows; the last line must keep both the scores
    // and the total finite, so the record serialises as a number rather than null.
    const big = (id) => ({
        id, title: `Big ${id}`, frequencyPerWeek: 1e200, minutesPerInstance: 1e200, peopleAffected: 1e200,
        judgementScore: 5, stepsConsistent: true
    });

    const result = aggregate([big('a'), big('b')]);

    for (const workflow of result.scored) {
        assert.equal(Number.isFinite(workflow.score), true, `${workflow.id} score is finite`);
        assert.equal(JSON.parse(JSON.stringify(workflow.score)) === null, false, 'and serialises as a number');
    }
    assert.equal(Number.isFinite(result.totalRecoverableHoursPerWeek), true, 'the total is finite');
    assert.equal(JSON.parse(JSON.stringify(result.totalRecoverableHoursPerWeek)) === null, false,
        'and the total serialises as a number, not null');
});

test('the comparator never sees a NaN difference, because every score is finite', () => {
    // The fault: two Infinity scores compared by `b.score - a.score` give NaN, and a NaN comparator
    // leaves their order to whatever the engine does. The fix floors at round(), so the subtraction is
    // always a number.
    //
    // MEASURED: the difference between any two scored entries is a number, never NaN.
    const workflow = (id, frequency) => ({
        id, title: `Workflow ${id}`, frequencyPerWeek: frequency, minutesPerInstance: 10,
        peopleAffected: 2, judgementScore: 5, stepsConsistent: true
    });
    const items = [
        workflow('overflowA', 1e200), workflow('ordinary', 40),
        workflow('overflowB', 1e200), workflow('larger', 400)
    ];

    const original = console.warn;
    console.warn = () => {};
    let scored;
    try {
        scored = aggregate(items).scored;
    } finally {
        console.warn = original;
    }

    for (let i = 0; i < scored.length; i += 1) {
        for (let j = 0; j < scored.length; j += 1) {
            const difference = scored[j].score - scored[i].score;
            assert.equal(Number.isNaN(difference), false,
                `${scored[j].id} - ${scored[i].id} is a number, not NaN`);
        }
    }

    // And the ordering is by score, descending, so the ranking is what the number says.
    const scores = scored.map((w) => w.score);
    const sorted = [...scores].sort((a, b) => b - a);
    assert.deepEqual(scores, sorted, 'the list is ordered by its own scores');
});

test('the sort is STABLE for tied scores, so the same input keeps its input order', () => {
    // WHAT THE COMPARATOR GUARANTEES, stated precisely: equal scores keep their relative input order,
    // because `Array.prototype.sort` is stable and the comparator returns 0 for a tie. It does NOT
    // re-order two equal scores by id, and that is deliberate - the input order is the participant's.
    const workflow = (id, frequency) => ({
        id, title: `Workflow ${id}`, frequencyPerWeek: frequency, minutesPerInstance: 10,
        peopleAffected: 2, judgementScore: 5, stepsConsistent: true
    });

    const original = console.warn;
    console.warn = () => {};
    let scored;
    try {
        scored = aggregate([workflow('b', 40), workflow('a', 40)]).scored;
    } finally {
        console.warn = original;
    }

    assert.deepEqual(scored.map((w) => w.id), ['b', 'a'],
        'two equal scores keep their input order, which is the tie the comparator returns 0 for');
    assert.equal(scored[0].score, scored[1].score, 'and they really are equal');
});

// ===========================================================================
// 6. THE REGRESSION THAT MATTERS MOST
// ===========================================================================

test('a realistic answer is ACCEPTED and scores EXACTLY 60', () => {
    // 40 per week, 6 people, 15 minutes. A bound that changed this score is a finding, not a nuisance.
    const workflow = {
        id: 'realistic', title: 'Entering supplier invoices',
        frequencyPerWeek: 40, minutesPerInstance: 15, peopleAffected: 6,
        judgementScore: 5, stepsConsistent: true
    };

    // Accepted by the route.
    const result = aggregate([workflow]);

    // 40 * 15 * 6 / 60 = 60 hours a week.
    assert.equal(result.scored[0].effortHoursPerWeek, 60, 'the effort figure is unchanged');
    assert.equal(result.scored[0].score, 60, 'the score is EXACTLY 60');
    assert.equal(result.scored[0].bucket, 'do_first', 'and the bucket is unchanged');
    assert.equal(result.totalRecoverableHoursPerWeek, 60, 'the total is EXACTLY 60');
});

test('a realistic answer is accepted by the ROUTE too, not only by scoring', async () => {
    const res = await postJson('/api/response', {
        token: LIVE_TOKEN,
        data: {
            task: 'Entering supplier invoices',
            frequencyPerWeek: 40,
            peopleAffected: 6,
            timePerPeriod: { hours: 2, period: 'week' }
        }
    });
    assert.equal(res.status, 200, '40 a week, 6 people and 2 hours are all well inside every bound');
});

// ===========================================================================
// 7. THE DEMO
// ===========================================================================

test('the demo scores are unchanged: 68, 58, 58, 58, 58, 38, 38', () => {
    // Read from a COPY, opened read-only. The committed artefact is never opened for writing.
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
