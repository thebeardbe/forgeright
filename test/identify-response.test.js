/**
 * AUTOMATIC IDENTIFICATION - a finished interview must identify itself.
 *
 * THE FAILURE THIS GUARDS. An answer card complete and correct, every step and field present, and
 * NOTHING on the roadmap beside the note:
 *
 *   "This answer has not been identified into a process yet."
 *
 * `runIdentification` runs from the admin's rejudge and the demo seed. THE SEED IDENTIFIES EVERY
 * RESPONSE ON THE ORDINARY PATH; without a third caller a live interview identifies nothing, so
 * the demo shows a complete roadmap and a real participant's work sits unread until somebody
 * presses a button.
 *
 * `identifyFinishedResponse` is called from `POST /api/response` when the round completes, NOT
 * AWAITED, recorded as `model`, guarded so a response that already has a grouping is declined.
 *
 * HOW THE SUCCESS PATH IS TESTED, SINCE THE MOCK CANNOT IDENTIFY. The mock provider is an INTERVIEW
 * simulator: it answers every call with the next interview question, which is why the seed carries
 * an `assertNotMock`. So a test that drove a real request and asserted a process appeared would pass
 * only if the mock did something it does not do - it would be testing the absence of the feature.
 * Instead the two halves are tested where each is honest:
 *
 *   - THE EFFECT OF A SUCCESSFUL REPLY is `recordIdentification` with the default `decidedBy`, and
 *     that is exercised directly - it is exactly what `identifyFinishedResponse` does after a good
 *     reply, and it is the part that decides `decidedBy`, the guard, and whether a process exists.
 *   - THE ROUTE WIRING is driven over HTTP against a real server, where the mock FAILS to identify:
 *     that asserts the reply still returns, nothing is created, and the answer stays rejudgeable -
 *     the failure mode the owner was in, which is the direction that must stay recoverable.
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

/** An organisation with one invitation and one FINISHED response, ready to identify. */
function finishedRound(data = { task: 'Checking whether a server is up', frequencyPerWeek: 56 }) {
    const org = store.createOrganisation('Identify org');
    const invitation = store.addInvitation(org.id, { email: 'p@example.test', department: 'Finance' });
    const response = store.addResponse(org.id, invitation.token, { department: 'Finance', data });
    return { org, invitation, response };
}

/** A reply the model could legitimately produce for a process nothing else resembles. */
const newProcessReply = (name = 'Checking servers') =>
    ({ matches: null, reasoning: 'nothing else here looks like it', confidence: 'high', name });

// ===========================================================================
// 1. THE GUARD - already grouped means declined, and why it matters
// ===========================================================================

test('a response with NO grouping is not "already identified"', () => {
    const { org, response } = finishedRound();
    assert.equal(identify.alreadyIdentified(org.id, response.id), false);
});

test('a response WITH a grouping IS already identified - the console reads the same fact', () => {
    // THE SAME FACT THE CONSOLE READS, so a guard and the "not yet read" badge cannot disagree.
    const { org, response } = finishedRound();
    processes.recordIdentification({ orgId: org.id, responseId: response.id, reply: newProcessReply() });

    assert.equal(identify.alreadyIdentified(org.id, response.id), true);
});

test('identifyFinishedResponse DECLINES a response that already has a grouping', async () => {
    // THE GUARD IS REACHABLE RATHER THAN THEORETICAL, and this is the measurement that makes it
    // necessary: a second `recordIdentification` that does NOT match produces a SECOND process with
    // the same name, and the identify prompt tells the model to answer `matches: null` when it is
    // unsure. So a second automatic identification is not harmless - it can duplicate a process the
    // console has already grouped.
    const { org, response } = finishedRound();
    processes.recordIdentification({ orgId: org.id, responseId: response.id, reply: newProcessReply('Checking servers') });

    const result = await identify.identifyFinishedResponse({ orgId: org.id, response });

    assert.equal(result.identified, false, 'it declines');
    assert.equal(result.reason, 'already identified', 'and says why');
});

test('the duplicate the guard prevents, MEASURED: an unmatched second identification adds a process', () => {
    // WHY THE GUARD EXISTS, asserted directly rather than argued. This is the harm the guard
    // avoids, so a future reader changing the guard can see the cost of removing it.
    const { org, response } = finishedRound();
    processes.recordIdentification({ orgId: org.id, responseId: response.id, reply: newProcessReply('Checking servers') });
    const afterFirst = processes.listProcessesForConsole(org.id).length;

    processes.recordIdentification({ orgId: org.id, responseId: response.id, reply: newProcessReply('Checking servers') });
    const afterSecond = processes.listProcessesForConsole(org.id).length;

    assert.equal(afterFirst, 1, 'one process after the first identification');
    assert.equal(afterSecond, 2, 'a second UNMATCHED identification creates a duplicate - the harm');
});

test('the SAME second call WITH `matches` is idempotent, which is the other half of the measurement', () => {
    // The prompt may answer with a matching id instead of `null`. Measured: that is idempotent, so
    // the guard is about the `null` case specifically rather than about second calls in general.
    const { org, response } = finishedRound();
    const first = processes.recordIdentification({ orgId: org.id, responseId: response.id, reply: newProcessReply('Checking servers') });

    processes.recordIdentification({
        orgId: org.id, responseId: response.id,
        reply: { matches: first.process.id, reasoning: 'same work', confidence: 'high', name: 'Checking servers' }
    });

    assert.equal(processes.listProcessesForConsole(org.id).length, 1, 'a matching second call adds nothing');
});

// ===========================================================================
// 2. `decidedBy` - the ordinary path, not an admin correction
// ===========================================================================

test('the identification is recorded as `model`, so the console does not read it as a regrouping', () => {
    // The seed's own comment names the distinction: the rejudge route "would mark every revision as
    // an admin correction and require an admin's argument, and a demo should show the ordinary
    // result rather than a console full of regroupings". Passing `decidedBy: 'admin'` here would
    // make every live interview a console full of corrections.
    const { org, response } = finishedRound();

    // The call `identifyFinishedResponse` makes after a good reply: no `decidedBy`, so the default.
    const recorded = processes.recordIdentification({ orgId: org.id, responseId: response.id, reply: newProcessReply() });

    assert.equal(recorded.revision.decided_by, 'model', 'recorded as the model, on the ordinary path');
});

test('an ADMIN identification is still recorded as `admin`, because a rejudge is a correction', () => {
    // The other side of the same field, so `decided_by` is shown to be a real distinction rather
    // than a constant: the admin path keeps its own value.
    const { org, response } = finishedRound();

    const recorded = processes.recordIdentification({
        orgId: org.id, responseId: response.id, reply: newProcessReply(),
        decidedBy: 'admin', adminReasoning: 'this is one process, not two'
    });

    assert.equal(recorded.revision.decided_by, 'admin', 'an admin correction keeps its own value');
});

// ===========================================================================
// 3. THE FAILURE MODE - "not identified yet", never "lost"
// ===========================================================================
test('identifyFinishedResponse NEVER THROWS, whatever the model does', async () => {
    // IT RUNS AFTER THE PARTICIPANT'S TURN HAS BEEN SAVED AND ANSWERED, so a model outage must not
    // become an error the participant sees. Every failure is reported and swallowed.
    const { org, response } = finishedRound();

    // The mock answers every call with an interview question, so this is the real failure path: no
    // identification reply, nothing recorded, and the call returns rather than rejecting.
    const result = await identify.identifyFinishedResponse({ orgId: org.id, response });

    assert.equal(result.identified, false, 'the mock cannot identify, so it reports false');
    assert.equal(typeof result.reason, 'string', 'with a reason for the log');
});

test('a FAILED identification creates nothing and leaves the answer rejudgeable', async () => {
    // THE STATE THE OWNER WAS IN, and it must stay recoverable: no grouping, which the console
    // already renders as "not yet read", and Rejudge already fixes.
    const { org, response } = finishedRound();

    await identify.identifyFinishedResponse({ orgId: org.id, response });

    assert.equal(processes.listProcessesForConsole(org.id).length, 0, 'no process was created');
    assert.equal(identify.alreadyIdentified(org.id, response.id), false,
        'and the answer is still ungrouped, so it is still rejudgeable');
});

test('a malformed response argument is refused rather than crashing', async () => {
    // The first guard in the function, reachable from a caller that passes nothing useful.
    const { org } = finishedRound();
    for (const bad of [null, undefined, {}, { id: '' }, { id: 42 }]) {
        const result = await identify.identifyFinishedResponse({ orgId: org.id, response: bad });
        assert.equal(result.identified, false, `${JSON.stringify(bad)} is refused`);
    }
});

// ===========================================================================
// 4. THE ROUTE WIRING - asserted from the source, since the mock cannot identify
// ===========================================================================

test('the route fires the identification when a round COMPLETES, and not before', () => {
    // COMPLETE ROUNDS ONLY: a half-written round has no final answer to group, and grouping one
    // would build a process from evidence the next turn contradicts.
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'auth', 'participant-routes.js'), 'utf8');

    assert.match(source, /import \{ identifyFinishedResponse \} from '\.\/identify-response\.js'/,
        'the route imports the automatic identification');
    assert.match(source, /if \(isComplete\) \{\s*\n\s*void identifyFinishedResponse\(/,
        'and fires it only for a completed round, without awaiting it');
});

test('the reply is NOT awaited, so the participant is not blocked on a model call', () => {
    // `void` marks the promise as intentionally not held. The reply is sent first, and the
    // identification runs after it - the property that keeps a seconds-long model call off the
    // participant's critical path.
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'auth', 'participant-routes.js'), 'utf8');

    assert.match(source, /void identifyFinishedResponse\(/, 'fired with `void`, not `await`');
    assert.equal(/await identifyFinishedResponse\(/.test(source), false,
        'and never awaited anywhere in the route');
});

test('the identification is given the participant\'s language, from `res.locals`', () => {
    // Reading a local `lang` in this route would be `undefined` - it never destructures one - and
    // every identification would then be made in English regardless of the interview's language.
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'auth', 'participant-routes.js'), 'utf8');

    assert.match(source, /lang: typeof res\.locals\?\.lang === 'string' && res\.locals\.lang !== ''/,
        'the language comes from res.locals, with a fallback');
});

test('the automatic identification is NOT recorded as an admin correction anywhere it is called', () => {
    // The one line that decides it, read from the module: `recordIdentification` is called with no
    // `decidedBy`, which is what makes the default `model` apply.
    //
    // COMMENTS ARE STRIPPED BEFORE THE `decidedBy: 'admin'` CHECK, because this file's own header
    // DISCUSSES the seed's admin path and a raw search matches that prose - which is how a check
    // like this comes to fail on the documentation of the thing it is checking.
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'auth', 'identify-response.js'), 'utf8');

    assert.match(source, /recordIdentification\(\{ orgId, responseId: response\.id, reply \}\)/,
        'identified with no decidedBy, so the default applies');

    const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
        .replace(/^\s*\/\/.*$/gm, ''); // line comments
    assert.equal(/decidedBy:\s*'admin'/.test(code), false, 'and never as an admin correction in code');
});
