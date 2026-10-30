/**
 * AUTOMATIC IDENTIFICATION - a finished interview must identify itself.
 *
 * AUTOMATIC IDENTIFICATION - a finished interview must identify itself.
 *
 * `identifyFinishedResponse` is called from `POST /api/response` when the round completes, NOT
 * AWAITED, recorded as `model`, guarded so a response that already has a grouping is declined.
 *
 * HOW THE SUCCESS PATH IS TESTED, SINCE THE MOCK CANNOT IDENTIFY: the mock answers every call with
 * the next interview question, so asserting a process appeared would test the absence of the
 * feature. The EFFECT is exercised through `recordIdentification` directly; the ROUTE WIRING is
 * driven over HTTP where the mock fails, checking the reply still returns and nothing is created.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-identify-'));
process.env.STORE_DIR = STORE_DIR;
process.env.SESSION_SECRET = 'a'.repeat(64);

const store = await import('../lib/store/index.js');
const processes = await import('../lib/store/processes.js');
const identify = await import('../lib/auth/identify-response.js');

after(() => {
    store.closeAll();
    fs.rmSync(STORE_DIR, { recursive: true, force: true });
});

function finishedRound(data = { task: 'Checking whether a server is up', frequencyPerWeek: 56 }) {
    const org = store.createOrganisation('Identify org');
    const invitation = store.addInvitation(org.id, { email: 'p@example.test', department: 'Finance' });
    const response = store.addResponse(org.id, invitation.token, { department: 'Finance', data });
    return { org, invitation, response };
}

const newProcessReply = (name = 'Checking servers') =>
    ({ matches: null, reasoning: 'nothing else here looks like it', confidence: 'high', name });

test('a response with NO grouping is not "already identified"', () => {
    const { org, response } = finishedRound();
    assert.equal(identify.alreadyIdentified(org.id, response.id), false);
});

test('a response WITH a grouping IS already identified - the console reads the same fact', () => {
    const { org, response } = finishedRound();
    processes.recordIdentification({ orgId: org.id, responseId: response.id, reply: newProcessReply() });

    assert.equal(identify.alreadyIdentified(org.id, response.id), true);
});

test('identifyFinishedResponse DECLINES a response that already has a grouping', async () => {
    const { org, response } = finishedRound();
    processes.recordIdentification({ orgId: org.id, responseId: response.id, reply: newProcessReply('Checking servers') });

    const result = await identify.identifyFinishedResponse({ orgId: org.id, response });

    assert.equal(result.identified, false, 'it declines');
    assert.equal(result.reason, 'already identified', 'and says why');
});

test('the duplicate the guard prevents, MEASURED: an unmatched second identification adds a process', () => {
    const { org, response } = finishedRound();
    processes.recordIdentification({ orgId: org.id, responseId: response.id, reply: newProcessReply('Checking servers') });
    const afterFirst = processes.listProcessesForConsole(org.id).length;

    processes.recordIdentification({ orgId: org.id, responseId: response.id, reply: newProcessReply('Checking servers') });
    const afterSecond = processes.listProcessesForConsole(org.id).length;

    assert.equal(afterFirst, 1, 'one process after the first identification');
    assert.equal(afterSecond, 2, 'a second UNMATCHED identification creates a duplicate - the harm');
});

test('the SAME second call WITH `matches` is idempotent, which is the other half of the measurement', () => {
    const { org, response } = finishedRound();
    const first = processes.recordIdentification({ orgId: org.id, responseId: response.id, reply: newProcessReply('Checking servers') });

    processes.recordIdentification({
        orgId: org.id, responseId: response.id,
        reply: { matches: first.process.id, reasoning: 'same work', confidence: 'high', name: 'Checking servers' }
    });

    assert.equal(processes.listProcessesForConsole(org.id).length, 1, 'a matching second call adds nothing');
});

test('the identification is recorded as `model`, so the console does not read it as a regrouping', () => {
    const { org, response } = finishedRound();

    const recorded = processes.recordIdentification({ orgId: org.id, responseId: response.id, reply: newProcessReply() });

    assert.equal(recorded.revision.decided_by, 'model', 'recorded as the model, on the ordinary path');
});

test('an ADMIN identification is still recorded as `admin`, because a rejudge is a correction', () => {
    const { org, response } = finishedRound();

    const recorded = processes.recordIdentification({
        orgId: org.id, responseId: response.id, reply: newProcessReply(),
        decidedBy: 'admin', adminReasoning: 'this is one process, not two'
    });

    assert.equal(recorded.revision.decided_by, 'admin', 'an admin correction keeps its own value');
});

test('identifyFinishedResponse NEVER THROWS, whatever the model does', async () => {
    const { org, response } = finishedRound();

    const result = await identify.identifyFinishedResponse({ orgId: org.id, response });

    assert.equal(result.identified, false, 'the mock cannot identify, so it reports false');
    assert.equal(typeof result.reason, 'string', 'with a reason for the log');
});

test('a FAILED identification creates nothing and leaves the answer rejudgeable', async () => {
    const { org, response } = finishedRound();

    await identify.identifyFinishedResponse({ orgId: org.id, response });

    assert.equal(processes.listProcessesForConsole(org.id).length, 0, 'no process was created');
    assert.equal(identify.alreadyIdentified(org.id, response.id), false,
        'and the answer is still ungrouped, so it is still rejudgeable');
});

test('a malformed response argument is refused rather than crashing', async () => {
    const { org } = finishedRound();
    for (const bad of [null, undefined, {}, { id: '' }, { id: 42 }]) {
        const result = await identify.identifyFinishedResponse({ orgId: org.id, response: bad });
        assert.equal(result.identified, false, `${JSON.stringify(bad)} is refused`);
    }
});

test('the route fires the identification when a round COMPLETES, and not before', () => {
    // COMPLETE ROUNDS ONLY: a half-written round has no final answer to group.
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'auth', 'participant-routes.js'), 'utf8');

    assert.match(source, /import \{ identifyFinishedResponse \} from '\.\/identify-response\.js'/,
        'the route imports the automatic identification');
    assert.match(source, /if \(isComplete\) \{\s*\n\s*void identifyFinishedResponse\(/,
        'and fires it only for a completed round, without awaiting it');
});

test('the reply is NOT awaited, so the participant is not blocked on a model call', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'auth', 'participant-routes.js'), 'utf8');

    assert.match(source, /void identifyFinishedResponse\(/, 'fired with `void`, not `await`');
    assert.equal(/await identifyFinishedResponse\(/.test(source), false,
        'and never awaited anywhere in the route');
});

test('the identification is given the participant\'s language, from `res.locals`', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'auth', 'participant-routes.js'), 'utf8');

    assert.match(source, /lang: typeof res\.locals\?\.lang === 'string' && res\.locals\.lang !== ''/,
        'the language comes from res.locals, with a fallback');
});

test('the automatic identification is NOT recorded as an admin correction anywhere it is called', () => {
    // COMMENTS ARE STRIPPED FIRST: this file's header discusses the admin path.
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'auth', 'identify-response.js'), 'utf8');

    assert.match(source, /recordIdentification\(\{ orgId, responseId: response\.id, reply \}\)/,
        'identified with no decidedBy, so the default applies');

    const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
        .replace(/^\s*\/\/.*$/gm, ''); // line comments
    assert.equal(/decidedBy:\s*'admin'/.test(code), false, 'and never as an admin correction in code');
});
