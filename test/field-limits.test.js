/**
 * S3: a participant field had no size bound, so one 50,000-character `task` reached the model whole
 * and spent the entire 32,000-character prompt budget.
 *
 * The bound is at the WRITE PATH (`lib/store/field-limits.js`, called from `recordTurn`) and REFUSES
 * rather than truncating: a truncated answer is a false record stored under the participant's name.
 */
import { test, before, after, beforeEach } from 'node:test';
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
const PROJECT_ROOT = path.join(__dirname, '..');
const SERVER = path.join(PROJECT_ROOT, 'server.js');

const ALLOWED_HOST = 'allowed.example.test';
const STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-s3-'));
process.env.STORE_DIR = STORE_DIR;
process.env.SESSION_SECRET = 'f'.repeat(64);

const store = await import('../lib/store/index.js');
const limits = await import('../lib/store/field-limits.js');
const { FIELD_SHAPES } = await import('../ai/field-shapes.js');
const { MAX_CONTENT_CHARS } = await import('../ai/message-validation.js');

const org = store.createOrganisation('S3 org');
const invitation = store.addInvitation(org.id, { email: 's3@example.test', department: 'Finance' });
const TOKEN = invitation.token;

// ===========================================================================
// The constants, read from the code
// ===========================================================================

const {
    MAX_PROSE_CHARS, MAX_TEXT_ENTRY_CHARS, MAX_LIST_LENGTH, MAX_STEPS,
    MAX_TRANSCRIPT_CHARS, MAX_DECLINED_WORDS_CHARS,
    checkAnswerSizes, checkTranscriptSizes, FieldTooLargeError
} = limits;

/** A payload with only the given overrides, so one field is under test at a time. */
const payload = (overrides = {}) => ({ task: 'Entering invoices', trigger: 'the mail arrives', ...overrides });

/** Rows currently stored for this invitation, read straight from the org file. */
function storedRows() {
    const db = new DatabaseSync(store.orgDbPath(org.id),
        { readOnly: true });
    try {
        return db.prepare('SELECT COUNT(*) AS n FROM response').get().n;
    } finally {
        db.close();
    }
}

// ===========================================================================
// 1. Refused AND not stored
// ===========================================================================

test('a 50,000-character task is refused by the store and creates NO row', () => {
    // Asserted on the DATABASE, not only on the throw: a refusal that still wrote is worse than the bug.
    const before = storedRows();
    const huge = 'x'.repeat(50_000);

    assert.throws(
        () => store.recordTurn(org.id, TOKEN, { data: payload({ task: huge }) }),
        (err) => err instanceof FieldTooLargeError && err.field === 'task',
        'the store refuses the oversized task'
    );

    assert.equal(storedRows(), before, 'and no row was created');
});

test('a field at 50,291 characters - the measured defect - is refused', () => {
    // The exact size the report names as reaching the model whole.
    assert.throws(
        () => store.recordTurn(org.id, TOKEN, { data: payload({ task: 'y'.repeat(50_291) }) }),
        FieldTooLargeError
    );
});

test('the refusal does not truncate what it was given', () => {
    // A stored shorter answer under the participant's name is the fault this avoids. Nothing partial
    // must survive, so no row at all is the assertion.
    const before = storedRows();
    try {
        store.recordTurn(org.id, TOKEN, { data: payload({ currentState: 'z'.repeat(MAX_PROSE_CHARS + 1) }) });
    } catch { /* expected */ }
    assert.equal(storedRows(), before, 'nothing was written, truncated or otherwise');
});

// ===========================================================================
// 2. A legitimate long answer is ACCEPTED
// ===========================================================================

test('a 3,000-character task is ACCEPTED and round-trips unchanged', () => {
    // The test that stops a future tightening from refusing real people: 3000 is well past anything
    // the interview asks for and well inside the bound.
    const long = 'A real answer. '.repeat(210).slice(0, 3000);
    assert.equal(long.length, 3000);

    const turn = store.recordTurn(org.id, TOKEN, { data: payload({ task: long }) });

    assert.equal(turn.data.task, long, 'the stored value is exactly what was sent');
    const readBack = store.getResponsesByToken(org.id, TOKEN).find((r) => r.id === turn.id);
    assert.equal(readBack.data.task, long, 'and it reads back from the file unchanged');
});

test('a prose field of exactly 4000 characters is ACCEPTED', () => {
    const atLimit = 'a'.repeat(MAX_PROSE_CHARS);
    assert.deepEqual(checkAnswerSizes(payload({ task: atLimit }), FIELD_SHAPES), { ok: true });
});

// ===========================================================================
// 3. Every boundary exactly
// ===========================================================================

test('the bounds are what the code says', () => {
    assert.equal(MAX_PROSE_CHARS, 4000);
    assert.equal(MAX_TEXT_ENTRY_CHARS, 500);
    assert.equal(MAX_LIST_LENGTH, 50);
    assert.equal(MAX_STEPS, 60);
    assert.equal(MAX_TRANSCRIPT_CHARS, 8000);
    assert.equal(MAX_DECLINED_WORDS_CHARS, MAX_PROSE_CHARS);
});

test('prose: 4000 passes and 4001 is refused', () => {
    assert.deepEqual(checkAnswerSizes(payload({ task: 'a'.repeat(4000) }), FIELD_SHAPES), { ok: true });

    const over = checkAnswerSizes(payload({ task: 'a'.repeat(4001) }), FIELD_SHAPES);
    assert.equal(over.ok, false);
    assert.equal(over.field, 'task');
    assert.equal(over.limit, MAX_PROSE_CHARS);
    assert.equal(over.actual, 4001);
});

test('a text[] entry: 500 passes and 501 is refused', () => {
    assert.deepEqual(
        checkAnswerSizes(payload({ systems: ['s'.repeat(500)] }), FIELD_SHAPES), { ok: true });

    const over = checkAnswerSizes(payload({ systems: ['s'.repeat(501)] }), FIELD_SHAPES);
    assert.equal(over.ok, false);
    assert.equal(over.field, 'systems');
    assert.equal(over.limit, MAX_TEXT_ENTRY_CHARS);
});

test('a list: 50 entries pass and 51 is refused, and the unit is ENTRIES', () => {
    const fifty = Array.from({ length: 50 }, (_, i) => `item ${i}`);
    assert.deepEqual(checkAnswerSizes(payload({ systems: fifty }), FIELD_SHAPES), { ok: true });

    const over = checkAnswerSizes(payload({ systems: [...fifty, 'one more'] }), FIELD_SHAPES);
    assert.equal(over.ok, false);
    assert.equal(over.limit, MAX_LIST_LENGTH);
    assert.equal(over.actual, 51);
    assert.equal(over.unit, 'entries', 'a count says entries, not characters');
});

test('steps: 60 pass and 61 is refused, and the unit is STEPS', () => {
    const step = (i) => ({ name: `step ${i}`, whatHappens: 'x', decidedHow: 'y', needsReasoning: false });
    const sixty = Array.from({ length: 60 }, (_, i) => step(i));
    assert.deepEqual(checkAnswerSizes(payload({ steps: sixty }), FIELD_SHAPES), { ok: true });

    const over = checkAnswerSizes(payload({ steps: [...sixty, step(60)] }), FIELD_SHAPES);
    assert.equal(over.ok, false);
    assert.equal(over.field, 'steps');
    assert.equal(over.limit, MAX_STEPS);
    assert.equal(over.unit, 'steps');
});

test('a transcript turn: 8000 passes and 8001 is refused', () => {
    const turn = (n) => [{ role: 'user', content: 'a'.repeat(n) }];
    assert.deepEqual(checkTranscriptSizes(turn(8000)), { ok: true });

    const over = checkTranscriptSizes(turn(8001));
    assert.equal(over.ok, false);
    assert.equal(over.index, 0);
    assert.equal(over.limit, MAX_TRANSCRIPT_CHARS);
});

test('a declined explanation is bounded as prose', () => {
    assert.deepEqual(
        checkAnswerSizes(payload({ frustration: { declined: 'a'.repeat(4000) } }), FIELD_SHAPES), { ok: true });

    const over = checkAnswerSizes(payload({ frustration: { declined: 'a'.repeat(4001) } }), FIELD_SHAPES);
    assert.equal(over.ok, false);
    assert.equal(over.field, 'frustration');
});

test('a `{ said: ... }` prose marker is bounded on its text', () => {
    const over = checkAnswerSizes(payload({ frustration: { said: 'a'.repeat(4001) } }), FIELD_SHAPES);
    assert.equal(over.ok, false);
    assert.equal(over.field, 'frustration');
});

// ===========================================================================
// 4. An UNBOUNDED shape throws
// ===========================================================================

test('a shape declared in FIELD_SHAPES with no size throws at the check, loudly', () => {
    // The property that stops the next field inheriting no bound, which is exactly how this defect
    // arose. Driven through the public entry point with a shape the table does not name.
    const invented = { ...FIELD_SHAPES, madeUpField: 'a-shape-nobody-bounded' };

    assert.throws(
        () => checkAnswerSizes(payload({ madeUpField: 'anything' }), invented),
        /Unknown field shape "a-shape-nobody-bounded"; add a size bound to limitsForShape/,
        'the unknown shape throws and says what to do'
    );
});

test('every shape in FIELD_SHAPES today is bounded, so none is silently unsized', () => {
    // The table-driven version: a new field added with an existing shape passes with no change here,
    // and a new SHAPE would fail this test rather than slip through.
    for (const [field, shape] of Object.entries(FIELD_SHAPES)) {
        assert.doesNotThrow(
            () => checkAnswerSizes({ [field]: [] }, FIELD_SHAPES),
            `${field} (${shape}) has a bound`
        );
    }
});

// ===========================================================================
// 5. The refusal: 400, names the field, actionable
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

function postJson(body) {
    const payloadText = JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port: PORT, path: '/api/response', method: 'POST',
            headers: {
                host: ALLOWED_HOST, 'x-forwarded-proto': 'https',
                'content-type': 'application/json', 'content-length': Buffer.byteLength(payloadText)
            }
        }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { text += c; });
            res.on('end', () => resolve({ status: res.statusCode, text }));
        });
        req.on('error', reject);
        req.write(payloadText);
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
            ALLOWED_HOST, SESSION_SECRET: 'f'.repeat(64), STORE_DIR,
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

test('an oversized field is a 400, NOT the 409 "questionnaire is closed"', async () => {
    // The wrong error code: 409 said the round was closed, which is untrue and unactionable.
    const res = await postJson({ token: TOKEN, data: payload({ task: 'x'.repeat(50_000) }) });

    assert.equal(res.status, 400, 'a 400, not a 409');
    assert.equal(res.status === 409, false, 'and specifically not the closed-questionnaire refusal');
    assert.equal(/questionnaire is closed/i.test(res.text), false,
        'the message does not claim the questionnaire is closed');
});

test('the refusal names the field in words a participant would use', async () => {
    const res = await postJson({ token: TOKEN, data: payload({ currentState: 'z'.repeat(4001) }) });
    const body = JSON.parse(res.text);

    assert.match(body.error, /how it works now/i, 'the readable name, not `currentState`');
    assert.equal(/currentState/.test(body.error), false, 'the internal name does not appear');
});

test('the refusal says the limit and what to do', async () => {
    const res = await postJson({ token: TOKEN, data: payload({ task: 'z'.repeat(4001) }) });
    const body = JSON.parse(res.text);

    assert.match(body.error, /4000/, 'names the limit');
    assert.match(body.error, /under 4000 characters/i, 'and says to keep it under that');
    assert.match(body.error, /send that answer again/i, 'and what to do next');
    assert.match(body.error, /earlier answers are saved/i, 'reassuring them the rest is kept');
});

test('a LIST refusal says "50 entries", not "50 characters"', async () => {
    // A count and a length read very differently: "under 50 characters" would be nonsense advice.
    const many = Array.from({ length: 51 }, (_, i) => `item ${i}`);
    const res = await postJson({ token: TOKEN, data: payload({ systems: many }) });
    const body = JSON.parse(res.text);

    assert.equal(res.status, 400);
    assert.match(body.error, /50 entries/i, 'it says entries');
    assert.equal(/under 50 characters/i.test(body.error), false, 'and not characters');
});

test('the message for a long answer is not the one for a long list', async () => {
    const longText = await postJson({ token: TOKEN, data: payload({ task: 'z'.repeat(4001) }) });
    const longList = await postJson({ token: TOKEN, data: payload({ systems: Array.from({ length: 51 }, (_, i) => `i${i}`) }) });

    assert.notEqual(JSON.parse(longText.text).error, JSON.parse(longList.text).error,
        'the two refusals read differently');
});

// ===========================================================================
// 6. The transcript turn bound, at the same number as /api/chat
// ===========================================================================

test('a transcript turn over 8000 is refused at /api/response', async () => {
    const res = await postJson({
        token: TOKEN,
        data: payload(),
        transcript: [{ role: 'user', content: 'a'.repeat(8001) }]
    });

    assert.equal(res.status, 400);
    const body = JSON.parse(res.text);
    assert.match(body.error, /message in the conversation/i, 'it names a conversation message');
    assert.match(body.error, /8000/, 'and the bound');
});

test('a transcript turn of exactly 8000 is accepted over HTTP', async () => {
    const res = await postJson({
        token: TOKEN,
        data: payload(),
        transcript: [{ role: 'user', content: 'a'.repeat(8000) }]
    });
    assert.equal(res.status, 200);
});

test('the two endpoints agree on what is too long', () => {
    // /api/chat refuses a message over MAX_CONTENT_CHARS; /api/response must use the same number, or a
    // turn the chat endpoint would refuse can be stored.
    assert.equal(MAX_TRANSCRIPT_CHARS, MAX_CONTENT_CHARS,
        'the write path and the chat endpoint use the same per-turn bound');
    assert.equal(MAX_TRANSCRIPT_CHARS, 8000);
});

// ===========================================================================
// 7. The unchanged rule: a field with no declared shape is NOT sized
// ===========================================================================

test('a field outside FIELD_SHAPES is not sized - deliberate, and pinned here', () => {
    // DELIBERATE, flagged by the builder for the owner: a field the interview carries but no workflow
    // reads as evidence is not refused, because rejecting it would break payloads the interview
    // legitimately carries. Pinned so a future change to this is a decision rather than an accident.
    const unknown = { notAField: 'x'.repeat(100_000) };

    assert.deepEqual(checkAnswerSizes(unknown, FIELD_SHAPES), { ok: true },
        'an unknown field is left alone, however long');
});

test('that rule does not weaken the bound on a KNOWN field beside it', () => {
    // The adjacent case: an unknown long field is ignored, but a known one in the same payload is not.
    const mixed = { notAField: 'x'.repeat(100_000), task: 'y'.repeat(4001) };

    const problem = checkAnswerSizes(mixed, FIELD_SHAPES);
    assert.equal(problem.ok, false);
    assert.equal(problem.field, 'task');
});

test('a nested `workflows` payload is checked, since that is the shape an interview stores', () => {
    assert.deepEqual(
        checkAnswerSizes({ workflows: [payload()] }, FIELD_SHAPES), { ok: true });

    const over = checkAnswerSizes({ workflows: [payload({ task: 'a'.repeat(4001) })] }, FIELD_SHAPES);
    assert.equal(over.ok, false);
    assert.equal(over.field, 'task');
});
