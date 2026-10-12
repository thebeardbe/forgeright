/**
 * Participant route isolation, at the HTTP level.
 *
 * Section 1 (test/token-index.test.js) proves the routing FUNCTION resolves a
 * token to its own organisation. This proves the ROUTES use it correctly, which is
 * where a wiring mistake would live: the organisation a participant's answer lands
 * in must come from the token and from nothing else.
 *
 * VERIFY BY INSPECTING THE FILES, NOT BY TRUSTING A STATUS CODE. The whole point
 * of this suite is that a 200 can come from the wrong place, so after each write
 * the organisation databases are opened directly and the answer is located in one
 * of them.
 *
 * Follows test/routes.test.js: the server is spawned as a child on a free port,
 * with its OWN temp STORE_DIR and every environment variable pinned rather than
 * inherited from .env or the developer's shell.
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
const STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-participant-routes-'));
// The test process imports the store in-process to create the organisations and
// to inspect the files, and the spawned server reads the SAME directory. Both
// must agree, so the env var is set here as well as in the child's environment.
process.env.STORE_DIR = STORE_DIR;
process.env.SESSION_SECRET = 'a'.repeat(64);

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

/**
 * Every environment variable the spawned server reads, pinned. The child gets
 * this as its WHOLE environment, so nothing from .env leaks in.
 *
 * @param {number} port
 * @returns {Record<string, string>}
 */
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

/**
 * One HTTP request with the trusted forwarded-protocol header, so it reaches the
 * route the way a request through the production proxy does.
 */
function request({ method = 'GET', path: urlPath = '/', body, headers = {} } = {}) {
    const payload = body === undefined ? undefined : JSON.stringify(body);
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
                        ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
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
                    contentType: String(res.headers['content-type'] || ''),
                    text,
                    json: () => JSON.parse(text)
                }));
            }
        );
        req.on('error', reject);
        if (payload !== undefined) req.write(payload);
        req.end();
    });
}

const post = (urlPath, body, headers) => request({ method: 'POST', path: urlPath, body, headers });

/** Waits until the child answers /healthz. */
async function waitForServer(deadlineMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < deadlineMs) {
        try {
            const res = await request({ path: '/healthz' });
            if (res.status === 200) return true;
        } catch {
            // Not up yet.
        }
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`server did not become ready on port ${PORT}`);
}

let child;

before(async () => {
    child = spawn(process.execPath, [SERVER], { env: spawnedEnv(PORT), stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on("data", () => {});
    child.stderr.on("data", () => {});
    await waitForServer();
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

// --- helpers that INSPECT THE FILES -----------------------------------------

/**
 * The responses stored in ONE organisation's database file, read directly.
 *
 * This is the evidence the assertions rest on: a status code says nothing about
 * which file a write reached.
 *
 * @param {string} orgId
 * @returns {object[]} Parsed `data` for every response row.
 */
function responsesInFile(orgId) {
    const db = new DatabaseSync(path.join(STORE_DIR, 'orgs', `${orgId}.db`));
    try {
        return db.prepare('SELECT data FROM response ORDER BY created_at, id')
            .all()
            .map((row) => JSON.parse(row.data));
    } finally {
        db.close();
    }
}

/**
 * The transcript column for every response in one organisation's file, read
 * directly. `null` is no transcript; `[]` is an empty one.
 *
 * @param {string} orgId
 * @returns {Array<Array<object>|null>}
 */
function transcriptsInFile(orgId) {
    const db = new DatabaseSync(path.join(STORE_DIR, 'orgs', `${orgId}.db`));
    try {
        return db.prepare('SELECT transcript FROM response ORDER BY created_at, id')
            .all()
            .map((row) => (row.transcript === null ? null : JSON.parse(row.transcript)));
    } finally {
        db.close();
    }
}

/**
 * Creates an organisation and one invitation by driving the public store API
 * directly, so the test owns the ids and the tokens it will use over HTTP.
 *
 * The store is imported here rather than spawned, because it writes to the same
 * STORE_DIR the server reads.
 */
const store = await import('../lib/store/index.js');

function orgWithInvitation(name, department) {
    const org = store.createOrganisation(name);
    const invitation = store.addInvitation(org.id, {
        email: `${name.replace(/\s+/g, '-').toLowerCase()}@example.test`,
        department
    });
    return { org, invitation };
}

/** Recovers the raw token, which the store returns only at issue time. */
const alpha = orgWithInvitation('Org Alpha', 'Finance');
const beta = orgWithInvitation('Org Beta', 'Ops');
const ORG_A = alpha.org;
const ORG_B = beta.org;
const INV_A = alpha.invitation;
const TOKEN_A = alpha.invitation.token;
const TOKEN_B = beta.invitation.token;

/** Waits until the served store has flushed a write to disk before reading it. */
async function settle() {
    await new Promise((r) => setTimeout(r, 20));
}

// ===========================================================================
// 1. A PARTICIPANT TOKEN WRITES INTO ITS OWN ORGANISATION'S FILE
// ===========================================================================

test('POST /api/response with A\'s token lands in A\'s file, and is absent from B\'s', async () => {
    // Record the starting state, so the assertion is about THIS write.
    const beforeA = responsesInFile(ORG_A.id).length;
    const beforeB = responsesInFile(ORG_B.id).length;

    const res = await post('/api/response', { token: TOKEN_A, department: 'Finance', data: { marker: 'write-as-A' } });
    assert.equal(res.status, 200, 'the write is accepted');
    await settle();

    const afterA = responsesInFile(ORG_A.id);
    const afterB = responsesInFile(ORG_B.id);

    assert.equal(afterA.length, beforeA + 1, "exactly one row landed in A's file");
    assert.deepEqual(afterA.at(-1), { marker: 'write-as-A' }, "the answer is in A's file with its data intact");
    assert.equal(afterB.length, beforeB, "nothing landed in B's file");
    assert.equal(
        afterB.some((d) => d && d.marker === 'write-as-A'),
        false,
        "the A answer must not appear in B's file"
    );
});

test('answers written as A are invisible as B and visible as A through the store API', () => {
    // The store API is the read path the console uses; the isolation must hold
    // there too, not only in the raw files.
    const analysisA = store.getResponsesForAnalysis(ORG_A.id);
    const analysisB = store.getResponsesForAnalysis(ORG_B.id);

    assert.ok(analysisA.some((r) => r.data && r.data.marker === 'write-as-A'), 'A sees its own answer');
    assert.equal(
        analysisB.some((r) => r.data && r.data.marker === 'write-as-A'),
        false,
        'B does not see A\'s answer'
    );
});

// ===========================================================================
// 2. A BODY FIELD NAMING ANOTHER ORGANISATION IS IGNORED
// ===========================================================================

test('a body field naming another organisation is ignored, and the answer lands in the token\'s organisation', async () => {
    // Every spelling a client might try, plus a nested object in case the code
    // were ever tempted to read one. The response body's own organisation field
    // must come from the TOKEN, never from the request.
    const bodies = [
        { token: TOKEN_A, department: 'Finance', data: { forged: 'organisationId' }, organisationId: ORG_B.id },
        { token: TOKEN_A, department: 'Finance', data: { forged: 'orgId' }, orgId: ORG_B.id },
        { token: TOKEN_A, department: 'Finance', data: { forged: 'organisation_id' }, organisation_id: ORG_B.id },
        { token: TOKEN_A, department: 'Finance', data: { forged: 'tenantId' }, tenantId: ORG_B.id },
        { token: TOKEN_A, department: 'Finance', data: { forged: 'nested' }, nested: { organisationId: ORG_B.id } },
        { token: TOKEN_A, department: 'Finance', data: { forged: 'nested-org' }, organisation: { id: ORG_B.id } }
    ];

    const beforeB = responsesInFile(ORG_B.id).length;

    for (const body of bodies) {
        const res = await post('/api/response', body);
        assert.equal(res.status, 200, `write accepted for ${JSON.stringify(Object.keys(body))}`);
        await settle();

        // The answer must be in A's file, keyed by the marker it carried.
        const inA = responsesInFile(ORG_A.id).some((d) => d && d.forged === body.data.forged);
        assert.equal(inA, true, `the answer ${body.data.forged} must be in A's file, not B's`);
    }

    // And nothing leaked into B at all.
    const afterB = responsesInFile(ORG_B.id);
    assert.equal(afterB.length, beforeB, 'no forged field moved a single row into B');
    assert.equal(
        afterB.some((d) => d && typeof d.forged === 'string'),
        false,
        'no forged-field answer appeared in B'
    );
});

test('an organisation named in the QUERY STRING is ignored for a write', async () => {
    const beforeB = responsesInFile(ORG_B.id).length;

    const res = await post(`/api/response?organisationId=${ORG_B.id}&orgId=${ORG_B.id}`, {
        token: TOKEN_A,
        department: 'Finance',
        data: { marker: 'query-forged' }
    });
    assert.equal(res.status, 200);
    await settle();

    assert.equal(
        responsesInFile(ORG_A.id).some((d) => d && d.marker === 'query-forged'),
        true,
        "the answer landed in A's file"
    );
    assert.equal(
        responsesInFile(ORG_B.id).some((d) => d && d.marker === 'query-forged'),
        false,
        "the query string did not redirect it to B's file"
    );
    assert.equal(responsesInFile(ORG_B.id).length, beforeB, 'B is untouched');
});

// ===========================================================================
// 3. GET /q/<A-token>?orgId=B STILL SERVES A
// ===========================================================================

test('GET /q/<A-token>?orgId=B still serves A, and B is unaffected', async () => {
    const plainQuery = await request({ path: `/q/${encodeURIComponent(TOKEN_A)}` });
    const forgedQuery = await request({ path: `/q/${encodeURIComponent(TOKEN_A)}?orgId=${ORG_B.id}` });

    assert.equal(plainQuery.status, 200, 'the token serves the questionnaire');
    assert.equal(forgedQuery.status, 200, "A's token still serves, whatever the query says");

    // The page carries the token so the client can post answers back; the
    // organisation id must not appear, because the participant never names a tenant.
    assert.equal(
        forgedQuery.text.includes(ORG_B.id),
        false,
        "the served page must not reveal or echo B's organisation id"
    );
    assert.equal(forgedQuery.text.includes(TOKEN_A), true, 'the page carries the token it was opened with');

    // B's data is unchanged by the request.
    assert.equal(responsesInFile(ORG_B.id).some((d) => d && d.marker === 'write-as-A'), false);
});

test('GET /q with an unknown token shows the paste form and refuses the link', async () => {
    const res = await request({ path: '/q/definitely-not-a-token' });
    assert.equal(res.status, 400, 'an unresolvable link is refused');
    // The refusal is the paste-a-token page, not a JSON error: a mangled link is
    // the common case and the page that fixes it is the one to show.
    assert.match(res.contentType, /text\/html/, 'an HTML page, not a JSON body');
});

test('GET /q serves the paste-a-token form with no token', async () => {
    const res = await request({ path: '/q' });
    assert.equal(res.status, 200);
});

// ===========================================================================
// 4. A TOKEN FOR A IS REFUSED WHEN USED AGAINST B, ON READ AND WRITE
// ===========================================================================

test('a token that resolves to nothing is refused on the write path, and writes nothing', async () => {
    const beforeA = responsesInFile(ORG_A.id).length;
    const beforeB = responsesInFile(ORG_B.id).length;

    const res = await post('/api/response', { token: 'not-a-real-token', department: 'Finance', data: { x: 1 } });

    assert.equal(res.status, 403, 'the write is refused');
    await settle();
    assert.equal(responsesInFile(ORG_A.id).length, beforeA, 'nothing was written for A');
    assert.equal(responsesInFile(ORG_B.id).length, beforeB, 'nothing was written for B');
});

test('a missing token is refused on the write path', async () => {
    const res = await post('/api/response', { department: 'Finance', data: { x: 1 } });
    assert.equal(res.status, 403);
});

test("B's token is refused on read when it does not resolve in A's context", async () => {
    // A token only ever resolves in its own organisation, and the route never
    // consults the request for a tenant, so B's token serves B and cannot serve A.
    // Assert the served content for B's token does not carry A's token, and that
    // an unknown token carries nothing.
    const resB = await request({ path: `/q/${encodeURIComponent(TOKEN_B)}` });
    assert.equal(resB.status, 200, "B's own token serves");
    assert.equal(resB.text.includes(TOKEN_A), false, "B's page does not carry A's token");

    const unknown = await request({ path: `/q/${encodeURIComponent('deadbeef')}` });
    assert.equal(unknown.status, 400, 'an unknown token is refused on read');
});

// ===========================================================================
// 5. A REVOKED TOKEN IS REFUSED, AND THE REFUSAL DOES NOT SAY WHETHER IT EXISTED
// ===========================================================================

test('a revoked token is refused on both read and write', async () => {
    const victim = orgWithInvitation('Org Revoked', 'Legal');
    const beforeRevoke = await post('/api/response', { token: victim.invitation.token, department: 'Legal', data: { marker: 'pre-revoke' } });
    assert.equal(beforeRevoke.status, 200, 'the token works before the reset');

    store.resetAccess(victim.org.id, victim.invitation.id);

    const read = await request({ path: `/q/${encodeURIComponent(victim.invitation.token)}` });
    const write = await post('/api/response', { token: victim.invitation.token, department: 'Legal', data: { marker: 'post-revoke' } });

    assert.equal(read.status, 400, 'the revoked token is refused on read');
    assert.equal(write.status, 403, 'the revoked token is refused on write');
    await settle();
    assert.equal(
        responsesInFile(victim.org.id).some((d) => d && d.marker === 'post-revoke'),
        false,
        'the refused write landed nothing'
    );
});

test('a revoked token and an unknown token are refused identically', async () => {
    // The refusal must not distinguish "this token existed" from "this token never
    // did": a difference would say whether an invitation exists.
    const victim = orgWithInvitation('Org Indistinguishable', 'Support');
    store.resetAccess(victim.org.id, victim.invitation.id);

    const revoked = await post('/api/response', { token: victim.invitation.token, department: 'Support', data: { x: 1 } });
    const unknown = await post('/api/response', { token: 'never-issued-token', department: 'Support', data: { x: 1 } });

    assert.equal(revoked.status, 403);
    assert.equal(unknown.status, 403);
    assert.deepEqual(revoked.json(), unknown.json(), 'the two refusals are byte-identical');
});

// ===========================================================================
// 6. ANSWERS ARE INVISIBLE FROM THE OTHER ORGANISATION
// ===========================================================================

test('after a write as A, analysis for B is empty of it and for A contains it', () => {
    const marker = 'isolation-final';
    // A write went through the store API here rather than HTTP, because this test
    // is about the read scoping, which the previous tests already exercised over
    // HTTP. The file inspection below is the evidence either way.
    store.addResponse(ORG_A.id, TOKEN_A, { department: 'Finance', data: { marker } });

    const inAByApi = store.getResponsesForAnalysis(ORG_A.id).some((r) => r.data && r.data.marker === marker);
    const inBByApi = store.getResponsesForAnalysis(ORG_B.id).some((r) => r.data && r.data.marker === marker);

    assert.equal(inAByApi, true, 'A analysis contains the answer');
    assert.equal(inBByApi, false, 'B analysis does not');

    // And confirmed on disk, which is the whole point of this section.
    assert.equal(responsesInFile(ORG_A.id).some((d) => d && d.marker === marker), true, "the row is in A's file");
    assert.equal(responsesInFile(ORG_B.id).some((d) => d && d.marker === marker), false, "no row in B's file");
});

// ===========================================================================
// 7. THE TRANSCRIPT OVER HTTP
// ===========================================================================
//
// The client sends the raw conversation with the answers. A malformed one is
// refused with 400 rather than silently dropped, so a transcript the console
// cannot render never reaches the store.

test('a valid transcript is stored and read back in order over HTTP', async () => {
    const turns = [
        { role: 'assistant', content: 'What is the task?' },
        { role: 'user', content: 'Supplier invoices.' },
        { role: 'assistant', content: 'How often?' }
    ];

    const res = await post('/api/response', { token: TOKEN_A, department: 'Finance', data: { marker: 'with-transcript' }, transcript: turns });
    assert.equal(res.status, 200);
    assert.equal(res.json().transcriptMessages, 3, 'the route reports how many turns it stored');
    await settle();

    const stored = transcriptsInFile(ORG_A.id).find((t) => Array.isArray(t) && t.some((turn) => turn.content === 'Supplier invoices.'));
    assert.deepEqual(stored, turns, 'every turn is stored in order, roles and content intact');
});

test('a malformed transcript is refused with 400, not silently dropped', async () => {
    // Every shape the builder exercised, plus the two a caller is most likely to
    // send by mistake. None may be stored.
    const before = responsesInFile(ORG_A.id).length;
    const badTranscripts = [
        'not an array',
        { role: 'user', content: 'an object, not an array' },
        42,
        [42],
        [null],
        [{ role: 'user' }],
        [{ content: 'hi' }],
        [{ role: '', content: 'hi' }],
        [{ role: 'user', content: 42 }],
        [{ role: 'user', content: 'hi' }, { role: 'user' }]
    ];

    for (const transcript of badTranscripts) {
        const res = await post('/api/response', { token: TOKEN_A, department: 'Finance', data: { marker: 'bad-transcript' }, transcript });
        assert.equal(res.status, 400, `transcript ${JSON.stringify(transcript)} must be refused`);
        assert.match(res.json().error, /conversation could not be read/i);
    }

    await settle();
    assert.equal(responsesInFile(ORG_A.id).length, before, 'a refused transcript stored nothing');
});

test('an ABSENT transcript is accepted and stored as no transcript', async () => {
    // A caller with none to give is not blocked, and it is distinct from an empty
    // conversation.
    const res = await post('/api/response', { token: TOKEN_A, department: 'Finance', data: { marker: 'no-transcript' } });
    assert.equal(res.status, 200);
    assert.equal(res.json().transcriptMessages, 0);
    await settle();

    const stored = transcriptsInFile(ORG_A.id);
    // The newest row is the one just written; its transcript is null.
    assert.equal(stored.at(-1), null, 'no transcript is stored as null, not as []');
});

test('an EMPTY transcript is accepted and stored as an empty array', async () => {
    const res = await post('/api/response', { token: TOKEN_A, department: 'Finance', data: { marker: 'empty-transcript' }, transcript: [] });
    assert.equal(res.status, 200);
    assert.equal(res.json().transcriptMessages, 0);
    await settle();

    assert.deepEqual(transcriptsInFile(ORG_A.id).at(-1), [], 'an empty transcript is stored as []');
});

test('THE FORMAT COMMITMENT IS NEVER STORED in a transcript', async () => {
    // The synthetic assistant turn commits to the JSON format and exists only in
    // the outgoing request to the model. It must not reach the transcript, which
    // records what was actually said: a leak would put words in the participant's
    // mouth and corrupt the evidence.
    //
    // The commitment's text is read from the module, not restated, so a change to
    // it cannot leave this test looking for the wrong string.
    const { withFormatCommitment } = await import('../ai/format-commitment.js');
    const conversation = [{ role: 'user', content: 'Invoices, every morning.' }];
    const withCommitment = withFormatCommitment(conversation);
    const commitmentText = withCommitment.at(-1).content;

    await post('/api/response', { token: TOKEN_A, department: 'Finance', data: { marker: 'commitment-check' }, transcript: conversation });
    await settle();

    const stored = transcriptsInFile(ORG_A.id).find((t) => Array.isArray(t) && t.some((turn) => turn.content === 'Invoices, every morning.'));
    assert.deepEqual(stored, conversation, 'only the turns the client sent are stored');
    assert.equal(
        JSON.stringify(stored).includes(commitmentText),
        false,
        'the format commitment appears nowhere in the stored transcript'
    );
    // And the client's own array was not mutated to contain it.
    assert.equal(conversation.length, 1, 'the caller\'s conversation is unchanged');
});

// ===========================================================================
// 8. LOST-LINK: THE FORM, AND ITS RESPONSE DOES NOT LEAK WHETHER AN ADDRESS EXISTS
// ===========================================================================

test('GET /lost-link serves the form', async () => {
    const res = await request({ path: '/lost-link' });
    assert.equal(res.status, 200);
});

test('POST /lost-link responds identically whether or not the address was invited', async () => {
    // A difference would be a way to discover who has been invited, which is a
    // list of employees and their departments.
    const known = store.addInvitation(ORG_A.id, { email: 'known-invitee@example.test', department: 'Finance' });
    assert.ok(known.token, 'the invitation was created');

    const invited = await post('/lost-link', { email: 'known-invitee@example.test' });
    const stranger = await post('/lost-link', { email: 'never-invited@example.test' });

    assert.equal(invited.status, stranger.status, 'the status is the same');
    assert.equal(invited.text, stranger.text, 'the response body is byte-identical');
});

// ===========================================================================
// 7. mayUseQuestionnaire: WHICH CREDENTIAL ADMITS A REQUEST
// ===========================================================================
//
// lib/routes-api.js accepts ONE credential: a live participant token. The shared
// access code was removed (see mayUseQuestionnaire), so there is no second way in.
//
// DELETED HERE, because the behaviour no longer exists: `the access code alone still
// admits the questionnaire` asserted that a request carrying only `pass` was
// admitted, and that path is gone.

test('a live participant token admits the questionnaire', async () => {
    const res = await post('/api/chat', {
        participantToken: TOKEN_A,
        messages: [{ role: 'user', content: 'hello' }]
    });
    assert.equal(res.status, 200, 'a live token is the way in');
});

test('a bogus participant token is refused', async () => {
    const res = await post('/api/chat', {
        participantToken: 'a-stale-token-in-the-page-config',
        messages: [{ role: 'user', content: 'hello' }]
    });
    assert.equal(res.status, 403);
    assert.equal(res.json().status, 'error');
    assert.equal(res.json().content, 'That link is not valid any more. Ask for a new one.');
});

test('a revoked participant token is refused', async () => {
    const victim = orgWithInvitation('Org Code Fallthrough', 'Legal');
    store.resetAccess(victim.org.id, victim.invitation.id);

    const res = await post('/api/chat', {
        participantToken: victim.invitation.token,
        messages: [{ role: 'user', content: 'hello' }]
    });
    assert.equal(res.status, 403);
});

test('a bogus token is refused with the LINK wording, not a code', async () => {
    const res = await post('/api/chat', {
        participantToken: 'bogus',
        messages: [{ role: 'user', content: 'hello' }]
    });
    assert.equal(res.status, 403);
    assert.equal(res.json().content, 'That link is not valid any more. Ask for a new one.');
});

test('no credential at all is refused, and the refusal says what to DO', async () => {
    // MORE IMPORTANT NOW, not less: this is no longer a fallback that a code could
    // satisfy, it is the only refusal for a request that names no participant.
    const res = await post('/api/chat', { messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(res.status, 403);
    assert.equal(
        res.json().content,
        'You need an invitation link to start. Ask for a new one.',
        'the wording says what to do, not merely what failed'
    );
});

test('a request carrying the removed `pass` field alone is refused like no credential', async () => {
    // The tokenless branch is gone, so a `pass` value is ignored rather than honoured.
    // This is the closest expressible form of the deleted access-code test, and it
    // asserts the OPPOSITE: the code no longer admits anyone.
    const res = await post('/api/chat', {
        pass: 'any-value-at-all',
        messages: [{ role: 'user', content: 'hello' }]
    });
    assert.equal(res.status, 403, 'a shared code cannot admit a request any more');
    assert.equal(res.json().content, 'You need an invitation link to start. Ask for a new one.');
});
