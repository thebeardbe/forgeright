/**
 * The round model, and the split between visible and scored.
 *
 * ONE INVITATION HAS AT MOST ONE OPEN ROUND. `recordTurn` is the single writer that
 * knows the difference between a turn still in progress and one that finished a
 * process, and it has three cases:
 *
 *   1. no open round          -> insert a new round (partial, `submitted_at` null)
 *   2. an open round          -> UPDATE it, carrying the transcript
 *   3. `complete: true`       -> update-or-insert and set `submitted_at`
 *
 * The owner's rule: a PARTIAL round is VISIBLE AND NOT SCORED, "partials are not
 * taken into account for sorting and thus scoring neither". The exclusion lives in
 * the analysis query, so a caller cannot forget it.
 *
 * Every test here is mutation-verified in the report.
 *
 * STORE_DIR is a temp directory per run, set before anything is imported.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-rounds-'));
process.env.STORE_DIR = STORE_DIR;
process.env.SESSION_SECRET = 'a'.repeat(64);

const store = await import('../lib/store/index.js');
const sqlite = await import('../lib/store/sqlite.js');
const registry = await import('../lib/store/registry.js');

after(() => {
    store.closeAll();
    fs.rmSync(STORE_DIR, { recursive: true, force: true });
});

/** An organisation with one invitation, and helpers to record turns against it. */
function orgWithInvitation() {
    const org = store.createOrganisation('Rounds org');
    const invitation = store.addInvitation(org.id, { email: 'p@example.test', department: 'Finance' });
    return {
        org,
        invitation,
        recordTurn: (args) => store.recordTurn(org.id, invitation.token, args)
    };
}

const conversation = (n) => Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `turn ${i}` }));

// ===========================================================================
// 1. THE THREE recordTurn CASES
// ===========================================================================

test('case 1: no open round inserts a PARTIAL round', () => {
    const { org, recordTurn } = orgWithInvitation();

    const turn = recordTurn({ data: { step: 1 } });

    assert.equal(turn.submitted_at, null, 'a new round is open, not finalised');
    assert.equal(store.getAllResponses(org.id).length, 1);
    assert.equal(store.getResponsesForAnalysis(org.id).length, 0, 'a partial is not scored');
});

test('case 2: an OPEN round is UPDATED, not appended', () => {
    // The defect the round model fixes: two rows for one process.
    const { org, recordTurn } = orgWithInvitation();

    const first = recordTurn({ data: { step: 1 }, transcript: conversation(1) });
    const second = recordTurn({ data: { step: 2 }, transcript: conversation(3) });

    assert.equal(second.id, first.id, 'the same row is continued');
    assert.equal(store.getAllResponses(org.id).length, 1, 'ONE row after two turns');
    assert.equal(store.getAllResponses(org.id)[0].data.step, 2, 'holding the latest data');
    assert.equal(store.getAllResponses(org.id)[0].transcript.length, 3, 'and the accumulated conversation');
});

test('case 3: a complete turn sets submitted_at', () => {
    const { org, recordTurn } = orgWithInvitation();

    const open = recordTurn({ data: { step: 1 } });
    const done = recordTurn({ data: { step: 2, finished: true }, complete: true });

    assert.equal(done.id, open.id, 'it finalises the SAME open round');
    assert.equal(typeof done.submitted_at, 'string', 'submitted_at is set');
    assert.equal(store.getResponsesForAnalysis(org.id).length, 1, 'and it is now scored');
});

test('a complete turn with NO open round inserts AND finalises in one step', () => {
    const { org, recordTurn } = orgWithInvitation();

    const done = recordTurn({ data: { single: true }, complete: true });

    assert.equal(typeof done.submitted_at, 'string');
    assert.equal(store.getAllResponses(org.id).length, 1);
    assert.equal(store.getResponsesForAnalysis(org.id).length, 1, 'finalised on insert');
});

test('a completed round keeps its original instant: markResponseSubmitted is idempotent', async () => {
    // A ROUND FINALISED TWICE MUST KEEP ITS ORIGINAL INSTANT, or the console's ordering
    // would depend on when somebody last touched the row. Asserted AT THE LAYER that
    // owns it, because `recordTurn` does not reach here twice on one round (see the
    // test below for what a second complete does).
    const { org, invitation } = orgWithInvitation();
    const db = registry.connectionFor(org.id);
    const invitationId = db.prepare('SELECT id FROM invitation WHERE email = ?').get('p@example.test').id;

    const inserted = sqlite.insertResponse(db, { id: 'row-1', invitationId, department: 'Finance', data: {}, transcript: null });
    assert.equal(inserted.submitted_at, null, 'inserted open');

    const first = sqlite.markResponseSubmitted(db, 'row-1', invitationId);
    await new Promise((r) => setTimeout(r, 30));
    const second = sqlite.markResponseSubmitted(db, 'row-1', invitationId);

    assert.equal(second.submitted_at, first.submitted_at, 'the second call does not move it');
    assert.ok(org.id, 'the organisation was used');
});

test('a second COMPLETE after a round closed OPENS A NEW round, rather than moving the instant', () => {
    // WHAT THE CODE ACTUALLY DOES, measured rather than assumed. `recordTurn` looks for
    // a round with `submitted_at IS NULL`; once the round is closed there is none, so
    // the next complete turn begins a NEW round with its own timestamp. The original
    // round's instant is untouched, which is what "does not move submitted_at" means
    // here - it is not moved, it is a different row.
    const { org, recordTurn } = orgWithInvitation();

    const firstComplete = recordTurn({ data: { n: 1 }, complete: true });
    const secondComplete = recordTurn({ data: { n: 2 }, complete: true });

    assert.notEqual(secondComplete.id, firstComplete.id, 'a new round, not the same one');
    assert.equal(store.getAllResponses(org.id).length, 2, 'two finalised rounds');
    assert.equal(store.getAllResponses(org.id).length, 2, 'and both are scored');
    assert.equal(store.getResponsesForAnalysis(org.id).length, 2);

    // The first round's instant is unchanged by the second turn.
    const firstRow = store.getAllResponses(org.id).find((r) => r.id === firstComplete.id);
    assert.equal(firstRow.submitted_at, firstComplete.submitted_at, 'the original instant stands');
});

// ===========================================================================
// 2. VISIBLE BUT NOT SCORED — BOTH DIRECTIONS
// ===========================================================================

test('getResponsesForAnalysis EXCLUDES a partial while getAllResponses INCLUDES it', () => {
    const { org, recordTurn } = orgWithInvitation();

    recordTurn({ data: { partial: true } }); // open round

    assert.equal(store.getAllResponses(org.id).length, 1, 'the answers view sees the partial');
    assert.equal(store.getResponsesForAnalysis(org.id).length, 0, 'the roadmap does not score it');
});

test('finalising the SAME round moves it from visible-only to scored, with no second row', () => {
    const { org, recordTurn } = orgWithInvitation();

    recordTurn({ data: { partial: true } });
    assert.equal(store.getResponsesForAnalysis(org.id).length, 0);

    recordTurn({ data: { done: true }, complete: true });

    assert.equal(store.getAllResponses(org.id).length, 1, 'still one row');
    assert.equal(store.getResponsesForAnalysis(org.id).length, 1, 'now scored');
});

test('a finalised round and a partial exist side by side, and only the finalised one scores', () => {
    const { org, recordTurn } = orgWithInvitation();
    recordTurn({ data: { done: true }, complete: true });

    // A SECOND invitation with a partial round.
    const second = store.addInvitation(org.id, { email: 'q@example.test', department: 'Ops' });
    store.recordTurn(org.id, second.token, { data: { stillGoing: true } });

    assert.equal(store.getAllResponses(org.id).length, 2, 'both are visible');
    assert.equal(store.getResponsesForAnalysis(org.id).length, 1, 'only the finalised one is scored');
    assert.equal(store.getResponsesForAnalysis(org.id)[0].data.done, true);
});

// ===========================================================================
// 3. THE TRANSCRIPT ON AN UPDATE
// ===========================================================================
//
// A REAL BUG this guards: `updateResponseData` set `data` but not `transcript`, so
// progressive saving kept the conversation on the first write and SILENTLY DROPPED it
// on every update after. Two layers were involved, and the second was the reachable one.

test('an update CARRIES the transcript, at the sqlite layer', () => {
    const { org } = orgWithInvitation();
    const db = registry.connectionFor(org.id);
    const invitationId = db.prepare('SELECT id FROM invitation WHERE email = ?').get('p@example.test').id;

    sqlite.insertResponse(db, { id: 'row-t', invitationId, department: 'Finance', data: { n: 1 }, transcript: conversation(1) });
    const updated = sqlite.updateResponseData(db, 'row-t', invitationId, { n: 2 }, conversation(5));

    assert.equal(updated.transcript.length, 5, 'the update wrote the new transcript');
    assert.equal(updated.data.n, 2);
});

test('an OMITTED transcript PRESERVES the stored one, at the sqlite layer', () => {
    const { org } = orgWithInvitation();
    const db = registry.connectionFor(org.id);
    const invitationId = db.prepare('SELECT id FROM invitation WHERE email = ?').get('p@example.test').id;

    sqlite.insertResponse(db, { id: 'row-p', invitationId, department: 'Finance', data: { n: 1 }, transcript: conversation(3) });
    const updated = sqlite.updateResponseData(db, 'row-p', invitationId, { n: 2 }, undefined);

    assert.equal(updated.transcript.length, 3, 'undefined leaves the column alone');
    assert.equal(updated.data.n, 2, 'while the data still updates');
});

test('an update CARRIES the transcript through updateResponse, the reachable layer', () => {
    // THE LAYER THAT WOULD HAVE BEEN MISSED: fixing sqlite alone left this unreachable,
    // because `updateResponse` did not forward the argument.
    const { org, invitation } = orgWithInvitation();
    const row = store.addResponse(org.id, invitation.token, { department: 'Finance', data: { n: 1 }, transcript: conversation(1) });

    const updated = store.updateResponse(org.id, invitation.token, row.id, { n: 2 }, conversation(4));

    assert.equal(updated.transcript.length, 4, 'updateResponse forwards the transcript');
    assert.equal(store.getResponsesByToken(org.id, invitation.token)[0].transcript.length, 4, 'and it is stored');
});

test('an omitted transcript through updateResponse PRESERVES it', () => {
    const { org, invitation } = orgWithInvitation();
    const row = store.addResponse(org.id, invitation.token, { department: 'Finance', data: { n: 1 }, transcript: conversation(2) });

    const updated = store.updateResponse(org.id, invitation.token, row.id, { n: 2 });

    assert.equal(updated.transcript.length, 2, 'the stored conversation is kept');
});

test('progressive saving through recordTurn accumulates rather than losing the conversation', () => {
    // The end-to-end shape of the bug: several turns against ONE open round, each
    // carrying a longer conversation. The final row must hold the LAST transcript, not
    // the first.
    const { org, recordTurn } = orgWithInvitation();

    recordTurn({ data: { n: 1 }, transcript: conversation(1) });
    recordTurn({ data: { n: 2 }, transcript: conversation(3) });
    const last = recordTurn({ data: { n: 3 }, transcript: conversation(7) });

    assert.equal(last.transcript.length, 7, 'the latest conversation is stored, not the first');
    assert.equal(store.getAllResponses(org.id)[0].transcript.length, 7);
});

// ===========================================================================
// 4. addResponse FINALISES
// ===========================================================================

test('addResponse stores a FINALISED round, not a partial', () => {
    // Its own doc says a second round "adds another response; an earlier round is never
    // overwritten", which is the language of a COMPLETED round. Storing it as partial
    // would make it invisible to every analysis path.
    const { org, invitation } = orgWithInvitation();

    const row = store.addResponse(org.id, invitation.token, { department: 'Finance', data: { seeded: true } });

    assert.equal(typeof row.submitted_at, 'string', 'finalised on insert');
    assert.equal(store.getResponsesForAnalysis(org.id).length, 1, 'and so it is scored immediately');
});

test('addResponse is unaffected by an OPEN round: it always inserts a new finalised row', () => {
    // It is for data that is already final - a seed, an import, a fixture - so it does
    // not join an open round the way `recordTurn` does.
    const { org, invitation, recordTurn } = orgWithInvitation();
    recordTurn({ data: { open: true } });

    const seeded = store.addResponse(org.id, invitation.token, { department: 'Finance', data: { seeded: true } });

    assert.equal(typeof seeded.submitted_at, 'string');
    assert.equal(store.getAllResponses(org.id).length, 2, 'the open round and the finalised one coexist');
    assert.equal(store.getResponsesForAnalysis(org.id).length, 1, 'only the finalised one scores');
});

// ===========================================================================
// 5. THE COMPLETION GATE WITH A SINGLE-PROCESS PAYLOAD
// ===========================================================================
//
// The fresh-start model depends on `processes.every(...)` judging ONLY what the payload
// holds, because a fresh round sends one process rather than every process so far.

const { parseModelResponse } = await import('../ai/audit-core.js');
const matrix = await import('../ai/matrix.js');

/** A fully populated process, built from the field lists rather than hardcoded. */
function completeProcess(overrides = {}) {
    const process = { id: 'p1', title: 'A process' };
    for (const field of matrix.PROCESS_FIELDS) {
        if (field === 'steps') continue;
        if (['handoffTo', 'waitsFor', 'dependsOn', 'systems', 'touchedDepartments'].includes(field)) process[field] = ['x'];
        else if (['mistakesPerPeriod', 'peopleAffected'].includes(field)) process[field] = 2;
        else process[field] = 'a value';
    }
    process.steps = [Object.fromEntries(matrix.STEP_FIELDS.map((f) => [f, f === 'needsReasoning' ? false : 'a value']))];
    process.frequencyPerWeek = 3;
    return { ...process, ...overrides };
}

test('a single complete process reports COMPLETE, with no stepsStillNeed', () => {
    // The fresh-start case: the round holds only the process being worked on.
    const result = parseModelResponse(JSON.stringify({ status: 'complete', content: 'done', processes: [completeProcess()] }));

    assert.equal(result.status, 'complete');
    assert.deepEqual(result.stepsStillNeed, [], 'nothing is still needed');
});

test('a single PARTIAL process reports ASKING, with stepsStillNeed naming what is needed', () => {
    const partial = completeProcess();
    delete partial.steps[0].needsReasoning;

    const result = parseModelResponse(JSON.stringify({ status: 'complete', content: 'done', processes: [partial] }));

    assert.equal(result.status, 'asking', 'the gate does not close on an incomplete step');
    assert.deepEqual(result.stepsStillNeed, ['needsReasoning'], 'and it names the field the step still needs');
});

test('stepsStillNeed is DERIVED, and the model\'s own value is discarded', () => {
    const result = parseModelResponse(JSON.stringify({
        status: 'asking',
        content: 'next question',
        processes: [completeProcess()],
        stepsStillNeed: ['something-the-model-invented']
    }));

    assert.deepEqual(result.stepsStillNeed, [], 'the computed value is used, not the model\'s claim');
});

test('stepsStillNeed is computed across processes but the completion gate judges the payload it holds', () => {
    // Two partial processes in one payload: the union of their gaps is reported, and
    // the round does not close.
    const one = completeProcess({ id: 'p1' });
    delete one.steps[0].needsReasoning;
    const two = completeProcess({ id: 'p2' });
    delete two.steps[0].decidedHow;

    const result = parseModelResponse(JSON.stringify({ status: 'complete', content: 'done', processes: [one, two] }));

    assert.equal(result.status, 'asking');
    assert.deepEqual([...result.stepsStillNeed].sort(), ['decidedHow', 'needsReasoning'].sort());
});

// ===========================================================================
// 6. THE PROMPT'S FRESH-START RULE
// ===========================================================================
//
// The line previously REQUIRED accumulation ("alongside the first"), which contradicts
// the owner's model, so it was changed. Pinned in both languages so it cannot drift back.

const PROMPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'prompts', 'cartiere_audit');

test('the English prompt carries the fresh-start rule', () => {
    const prompt = fs.readFileSync(path.join(PROMPTS_DIR, 'prompt_en.md'), 'utf8');
    assert.match(prompt, /STARTS THE CONVERSATION AGAIN/, 'the rule is stated');
    assert.match(prompt, /report ONLY the new\s+process in `processes`/, 'and says what to send');
    assert.equal(/alongside the first/i.test(prompt), false, 'the accumulation rule is gone');
});

test('the Dutch prompt carries the fresh-start rule', () => {
    const prompt = fs.readFileSync(path.join(PROMPTS_DIR, 'prompt_nl.md'), 'utf8');
    assert.match(prompt, /BEGINT HET GESPREK OPNIEUW/, 'the rule is stated in Dutch');
    assert.equal(/alongside the first/i.test(prompt), false, 'and the accumulation rule is gone');
});

test('neither language prompt requires accumulation', () => {
    for (const file of ['prompt_en.md', 'prompt_nl.md']) {
        const prompt = fs.readFileSync(path.join(PROMPTS_DIR, file), 'utf8');
        assert.equal(/alongside the first/i.test(prompt), false, `${file} must not ask for accumulation`);
    }
});

// ===========================================================================
// 7. THE RESUME STRINGS ARE KEY-FOR-KEY CONSISTENT
// ===========================================================================

test('the three language blocks have the same keys, so a resumed interview renders in all three', async () => {
    // This project has drifted on string keys before, so it is checked rather than
    // assumed. A key missing from one block renders as a blank or an undefined label.
    const { stringsFor } = await import('../lib/strings.js');

    const langs = ['nl', 'en', 'fr'];
    const keySets = langs.map((lang) => ({ lang, keys: Object.keys(stringsFor(lang)).sort() }));

    for (const { lang, keys } of keySets) {
        assert.deepEqual(keys, keySets[0].keys, `${lang} must have exactly the keys en/nl have`);
        assert.ok(keys.includes('resumedNotice'), `${lang} must carry the resume notice`);
    }

    for (const { lang } of keySets) {
        assert.equal(typeof stringsFor(lang).resumedNotice, 'string', `${lang}'s resume notice is a string`);
        assert.ok(stringsFor(lang).resumedNotice.trim() !== '', `${lang}'s resume notice is not blank`);
    }
});
