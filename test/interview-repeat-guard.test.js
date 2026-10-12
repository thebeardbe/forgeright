/**
 * The repeat guard, the narrowed closing matcher, and the derived "nothing answered" console state.
 *
 * WHY THIS FILE EXISTS. The reviewer ran eight live interviews and one completed. Seven stalled
 * with the same question repeated, one byte-identically for six turns - a loop neither of the two
 * earlier fixes addressed. It is the pre-existing PER-FIELD repeat, and it is the symptom the
 * owner reported from the start: frustration, then abandonment.
 *
 * THE GUARD'S OWN LOOP IS THE INTERESTING PART, and it is why this file is shaped the way it is.
 * A guard that replaces a repeated question with a fixed substitute makes the SUBSTITUTE the
 * question of record, so it matches its own sentence next turn and replaces it again - the loop
 * moves from the model to the gate. The builder measured that at turn 18 of a simulation and
 * fixed it by marking a substitute so only the model's own repeats are match targets. Termination
 * is therefore the property most of this file tests, because it is the one that failed twice.
 *
 * TWO FINDINGS ARE RECORDED AS ASSERTIONS ON TODAY'S BEHAVIOUR, NOT AS PASSING CLAIMS. They are
 * localised with "FINDING" and they assert what the code does, so a fix turns them red on purpose.
 *
 * A NOTE ON WHAT NEEDS A LIVE PROVIDER: the guard's behaviour is testable offline because it runs
 * on the server against a conversation, which is why these are real tests rather than source
 * greps. What is NOT testable offline is whether a real model produces the stalled conversation
 * in the first place, or how often.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');

// THE STORE IS A SINGLETON THAT CAPTURES STORE_DIR AT FIRST IMPORT, and the store's own path
// guard refuses a second, different directory rather than opening the wrong database. So the
// directory is set ONCE for the whole file, before the store is imported, and every store test
// below shares it. Each test uses its OWN organisation, which is enough isolation.
const STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-guard-'));
process.env.STORE_DIR = STORE_DIR;
process.env.SESSION_SECRET = 'c'.repeat(64);

const { parseModelResponse } = await import('../ai/audit-core.js');
const matrix = await import('../ai/matrix.js');
const store = await import('../lib/store/index.js');
const consoleRead = await import('../lib/store/console-read.js');
const organisations = await import('../lib/store/organisations.js');

after(() => {
    store.closeAll();
    fs.rmSync(STORE_DIR, { recursive: true, force: true });
});

/**
 * A process with only the four required-ish fields typed, so `missing` is a known, non-empty
 * set and there is something for the guard to substitute.
 */
const partialProcess = () => ({
    task: 'entering invoices',
    trigger: 'the mail arrives',
    steps: [Object.fromEntries(matrix.STEP_FIELDS.map((f) => [f, f === 'needsReasoning' ? false : 'v']))],
    frequencyPerWeek: 2
});

/** An honest `asking` reply: it does not claim fields it did not send, so `missing` is real. */
const askingReply = (content, process = partialProcess()) => JSON.stringify({
    status: 'asking', content, processes: [process], have: [], missing: []
});

/** A full process, so a reply with all fields present can complete the matrix. */
const fullProcess = () => ({
    ...partialProcess(),
    timePerPeriod: { hours: 2, period: 'week' },
    peopleAffected: 3,
    handoffTo: ['the team'],
    waitsFor: ['approval'],
    dependsOn: ['the advert being live'],
    systems: ['email'],
    touchedDepartments: ['Finance'],
    mistakesPerPeriod: 1,
    mistakeConsequence: 'a delay',
    currentState: 'by hand',
    frustration: 'the waiting'
});

/**
 * Parses one turn with the conversation so far, in the shape the client replays it.
 *
 * `conversation` is a list of `{ content, missing, substituted, exhausted }` for assistant turns,
 * which is exactly what `assistantQuestionsWithOpenCounts` reads.
 */
function turn(content, conversation = [], { process = partialProcess(), status = 'asking' } = {}) {
    const askedBefore = conversation.map((t) => ({
        text: t.content, openCount: (t.missing ?? []).length, substituted: t.substituted === true
    }));
    const raw = JSON.stringify({ status, content, processes: [process], have: [], missing: [] });
    const result = parseModelResponse(raw, { askedBefore });
    conversation.push({
        content: result.content, missing: result.missing,
        substituted: result.substituted === true, exhausted: result.exhausted === true
    });
    return result;
}

// ===========================================================================
// 1. THE REPEAT GUARD
// ===========================================================================

test('a repeated question with NO progress is replaced with a question about another open field', () => {
    const question = 'How do you keep track of it?';
    const conversation = [];

    // Turn 1: the model's question is passed through, because nothing precedes it.
    const first = turn(question, conversation);
    assert.equal(first.content, question, 'the first asking is not a repeat');
    assert.equal(first.substituted, false, 'and is not marked as the gate\'s');

    // Turn 2: the same question, with the same number of fields open. This is the stall.
    const second = turn(question, conversation);
    assert.notEqual(second.content, question, 'the repeat is replaced');
    assert.equal(second.substituted, true, 'and marked as the gate\'s own');
    assert.ok(second.content.length > 0, 'replaced by a real question, not blanked');
    assert.notEqual(second.content, second.missing[0], 'and not the raw field name');
});

test('A LEGITIMATE SECOND ATTEMPT PASSES THROUGH - the difference between a guard and a wall', () => {
    // The prompt allows one rephrase, so asking the same field twice is legitimate. It is only a
    // stall when NOTHING was recorded since. The guard reads `missing` shrinking as that progress,
    // so a repeat after progress is left alone. This is the line the guard must not cross.
    const question = 'How often does this happen?';
    const conversation = [{ content: question, missing: new Array(12).fill('f'), substituted: false }];

    // NOW there are 10 open fields, so 2 were answered since the question was asked.
    const result = turn(question, conversation);
    assert.equal(result.content, question, 'a repeat after progress is NOT substituted');
    assert.equal(result.substituted, false, 'and is not marked as the gate\'s');
});

test('the SAME repeat with no progress IS substituted, so progress is the only difference', () => {
    // The contrast for the test above: identical question, identical conversation, and the ONLY
    // difference is the open-field count. This is what makes the guard's condition meaningful.
    const question = 'How often does this happen?';
    const withProgress = [{ content: question, missing: new Array(12).fill('f'), substituted: false }];
    const noProgress = [{ content: question, missing: new Array(10).fill('f'), substituted: false }];

    assert.equal(turn(question, [...withProgress]).substituted, false, 'progress: passes');
    assert.equal(turn(question, [...noProgress]).substituted, true, 'no progress: substituted');
});

test('TERMINATION: a model stuck on ONE sentence ends the round, with no question repeated', () => {
    // THE PROPERTY THAT FAILED TWICE. The model sends the same sentence every turn; the guard
    // substitutes; the substitute becomes the question of record. If the guard matched its own
    // substitute, it would replace it forever. It does not, because a substitute is marked, so
    // each turn moves to a field not yet asked and the round terminates.
    //
    // Measured here: the model repeats one sentence, and the conversation reaches `exhausted`
    // with every question distinct. The bound is generous (40 turns; 15 fields exist).
    const MODEL_SENTENCE = 'How do you keep track of it?';
    const conversation = [];
    const distinct = new Set();
    let exhaustedAt = null;

    for (let i = 1; i <= 40; i += 1) {
        const r = turn(MODEL_SENTENCE, conversation);
        assert.equal(distinct.has(r.content), false,
            `turn ${i} repeated a question already asked: ${JSON.stringify(r.content)}`);
        distinct.add(r.content);
        if (r.exhausted) { exhaustedAt = i; break; }
    }

    assert.notEqual(exhaustedAt, null, 'the conversation terminated rather than looping');
    assert.ok(distinct.size >= 12, `at least the open fields were asked once (got ${distinct.size})`);
});

test('TERMINATION under an ECHOING model - the case that stresses the substitute mark', () => {
    // THE HARSHER MODEL, and the one that actually exercises the mark. Instead of repeating one
    // fixed sentence, this model ECHOES back whatever it last received - so it sends the gate's
    // OWN substitute as its next question. That is exactly the loop the builder measured: a
    // substitute that the gate then matches and replaces again.
    //
    // It must still terminate: the mark stops the gate matching its own sentence, so the
    // conversation advances to a fresh field each round rather than circling. The assertions are
    // termination and a variety of questions, not the absence of every duplicate - see the
    // FINDING below for what an echoing model does see.
    const conversation = [];
    const distinct = new Set();
    let incoming = 'How do you keep track of it?';
    let exhaustedAt = null;

    for (let i = 1; i <= 60; i += 1) {
        const r = turn(incoming, conversation);
        distinct.add(r.content);
        if (r.exhausted) { exhaustedAt = i; break; }
        incoming = r.content; // echo: the model repeats whatever it was just shown
    }

    assert.notEqual(exhaustedAt, null, 'an echoing model still terminates rather than looping forever');
    assert.ok(distinct.size >= 10, `and the conversation still advances (got ${distinct.size} distinct)`);
    assert.ok(exhaustedAt <= 40, `termination is bounded, not merely eventual (ended at turn ${exhaustedAt})`);
});

test('FINDING: an ECHOING model sees each substituted question TWICE', () => {
    // A REAL WEAKNESS, recorded as today's behaviour rather than asserted as correct. When the
    // gate substitutes, it records the substitute as `substituted: true`. If the model then ECHOES
    // that substitute back, the guard correctly passes it through (it is the gate's own sentence)
    // - but the pass-through is recorded as `substituted: false`, so the model's echo of it is
    // treated as the model's OWN question and replaced on the NEXT turn. The result: each
    // substituted question appears twice in a row to the participant.
    //
    // IT TERMINATES, which is why this is a FINDING and not the loop the commit fixed: the
    // conversation still advances a field at a time and reaches `exhausted`. But a participant
    // answering an echoing model is asked every one of those questions twice, which is half the
    // symptom the guard exists to remove. The common case (a model repeating ONE sentence) does
    // not do this; the assertions for that are in the test above.
    const conversation = [];
    const replies = [];
    let incoming = 'How do you keep track of it?';

    for (let i = 1; i <= 60; i += 1) {
        const r = turn(incoming, conversation);
        replies.push(r.content);
        if (r.exhausted) break;
        incoming = r.content;
    }

    const consecutiveDuplicates = replies.filter((text, i) => i > 0 && text === replies[i - 1]).length;
    assert.ok(consecutiveDuplicates > 0,
        'FINDING: an echoing model produces consecutive duplicate questions');
});

test('a SUBSTITUTE is never itself substituted - the mark that makes it terminate', () => {
    // The mechanism directly: the conversation holds a question marked `substituted`, and the
    // model repeats THAT sentence. The guard must pass it through, not replace the gate's own
    // question, which is the loop moving from the model to the gate.
    const substitute = 'Who else is involved in this?';
    const conversation = [{ content: substitute, missing: new Array(10).fill('f'), substituted: true }];

    const result = turn(substitute, conversation);
    assert.equal(result.content, substitute, 'a marked substitute is not a match target');
    assert.equal(result.substituted, false, 'and is not re-marked as a fresh substitution');
});

// ===========================================================================
// 2. WHEN EVERY FIELD HAS BEEN ASKED
// ===========================================================================

test('every-field-asked ENDS the round as `exhausted`, not `nothing_answered`', () => {
    // The two states are DIFFERENT and this is the whole point of not reusing the other:
    //   nothing_answered  the participant declined EVERYTHING, so there is no evidence
    //   exhausted         the participant ANSWERED, and the questions simply ran out
    // Reusing nothing_answered here would tell a participant who answered plenty that no answers
    // were captured - a lie about their own interview.
    const MODEL_SENTENCE = 'How do you keep track of it?';
    const conversation = [];
    for (let i = 1; i <= 40; i += 1) {
        const r = turn(MODEL_SENTENCE, conversation);
        if (r.exhausted) {
            assert.equal(r.exhausted, true, 'the round is marked exhausted');
            assert.notEqual(r.status, 'nothing_answered', 'and is NOT nothing_answered');
            // The decline message must not appear: it says no answers were captured.
            assert.equal(/did not manage to capture any answers/.test(r.content), false,
                'and the participant is not told their answers were not captured');
            return;
        }
    }
    assert.fail('the all-asked path was never reached');
});

test('the two terminal states are DISTINCT: exhausted has supplied fields, nothing_answered has none', () => {
    // Same comparison from the other side. An all-declined round supplies nothing and gets
    // nothing_answered; an exhausted round supplies what was answered and gets exhausted. The
    // supplied count is what separates them, and it is asserted for both.
    const allDeclined = {};
    for (const field of matrix.ALL_PROCESS_FIELD_NAMES) allDeclined[field] = { declined: 'no idea' };
    const declinedReply = parseModelResponse(JSON.stringify({
        status: 'asking', content: 'Anything else?', processes: [allDeclined], have: [], missing: []
    }), { askedBefore: [] });

    assert.equal(declinedReply.status, 'nothing_answered', 'declining everything: nothing_answered');
    assert.equal(declinedReply.exhausted, undefined, 'and NOT marked exhausted');

    // And the exhausted path: reached via the real guard, which is asserted by the two tests above.
    const conversation = [];
    let exhaustedResult = null;
    for (let i = 1; i <= 40; i += 1) {
        const r = turn('How do you keep track of it?', conversation);
        if (r.exhausted) { exhaustedResult = r; break; }
    }
    assert.notEqual(exhaustedResult, null, 'the exhausted state is reachable');
    assert.notEqual(exhaustedResult.status, 'nothing_answered', 'and is not the decline state');
});

test('the move-on line and the exhausted close are DIFFERENT messages', () => {
    // Two endings, two sentences. The move-on line asks the participant to move on; the close
    // ends the round. Conflating them would either keep a finished interview open or close one
    // that could still continue.
    const conversation = [];
    const messages = new Set();
    for (let i = 1; i <= 40; i += 1) {
        const r = turn('How do you keep track of it?', conversation);
        messages.add(r.content);
        if (r.exhausted) break;
    }
    const moveOn = [...messages].find((m) => /move on rather than keep circling/i.test(m));
    const close = [...messages].find((m) => /stop there rather than keep asking/i.test(m));

    assert.notEqual(moveOn, undefined, 'the move-on line is said at least once');
    assert.notEqual(close, undefined, 'and the closing line is said');
    assert.notEqual(moveOn, close, 'they are different sentences');
});

// ===========================================================================
// 3. THE NARROWED MATCHER - BOTH DIRECTIONS, WITH MY OWN QUESTIONS
// ===========================================================================

/** Whether the reply's content was replaced by a gate (substituted), given a partial matrix. */
function wasGated(content) {
    const r = parseModelResponse(JSON.stringify({
        status: 'asking', content, processes: [partialProcess()], have: [], missing: []
    }), { askedBefore: [] });
    return r.content !== content;
}

// THE BUILDER CLAIMED 28 ORDINARY QUESTIONS WITH 0 WRONGLY GATED AND 12 CLOSING PHRASINGS WITH 0
// MISSED. The previous claim in this area was 17-of-17 and the reviewer found 8 false positives
// in 22, so the numbers are checked with my own sets rather than accepted. The two patterns that
// were over-broad - bare `anything else` and bare `shall`/`should`/`may` - are stressed hardest.

test('ordinary questions are NOT gated - my own set, stressing the two over-broad patterns', () => {
    const ordinary = [
        // The two patterns the fix narrowed, with realistic phrasings that are about THIS process.
        'Is there anything else you would change about this step?',
        'Is there anything else that regularly goes wrong here?',
        'Is there anything else you do before this starts?',
        'Should I record the buyer as a separate process?',
        'Should we treat this as one task or several?',
        'Should the buyer be involved earlier?',
        'Should the same reference be used twice?',
        'Should this be measured in hours or days?',
        'May I ask how often mistakes happen?',
        'May the same person do both steps?',
        'May I ask who approves it?',
        'Shall I take that as the trigger?',
        'Shall I note that as a separate step?',
        'Do you think we should split this?',
        'Do you think there is more to it than that?',
        // Anything-else phrasings that ask about the CURRENT work.
        'Anything else that makes this hard?',
        'Is there anything else about the timing I should know?',
        'Is there anything else that slows this down?',
        'Is there anything about the process you would change?',
        // Ordinary questions with no closing flavour.
        'What systems do you use for this?',
        'How often does this happen?',
        'Who else is involved in this process?',
        'What happens next after you send it?',
        'Can you describe the steps you take?',
        'Is this process something you do alone?',
        'Do you want to describe the steps in more detail?',
        'How long does it usually take?',
        'What goes wrong most often?',
        'Where does the information come from?',
        'What do you do when it is busy?',
        'Who decides what happens next?',
        'Which tool do you open first?',
        'What makes this frustrating?',
        'How many mistakes happen in a month?',
        'What would you change if you could?',
        'Do you check the work yourself?',
        'Can you walk me through a typical day?',
        'What is the hardest part of this?',
        'Who signs this off?',
        'Would you mind walking me through one example?',
        'Could you tell me who the buyer is?'
    ];

    const wronglyGated = ordinary.filter(wasGated);
    // REPORT EVERY FALSE POSITIVE by name, so a failure says which phrasing and not just a count.
    assert.deepEqual(wronglyGated, [], `these ordinary questions were wrongly gated: ${JSON.stringify(wronglyGated)}`);
    assert.ok(ordinary.length >= 28, `checked at least the builder's 28 (checked ${ordinary.length})`);
});

test('closing phrasings ARE gated - my own set, including ones neither party wrote', () => {
    const closings = [
        'Is there another process you would like to improve?',
        "Is there another process you'd like to improve?",
        'Is there any other process involved here?',
        'Any other process we should look at?',
        'Anything else you would like to look at?',
        'Anything else you want to cover?',
        "Is there anything else you'd like to add?",
        'Is there anything else you would like to cover?',
        'Would you like to tell me about another process?',
        'Would you like to move on to a new one?',
        'Shall we move on?',
        'Shall we stop here?',
        'Shall we wrap up?',
        'Shall we continue with another?',
        'Should we finish for now?',
        'Should we move on?',
        'Something else you want to look at?',
        'Anything else to add?'
    ];

    const missed = closings.filter((c) => !wasGated(c));
    assert.deepEqual(missed, [], `these closing phrasings were NOT gated: ${JSON.stringify(missed)}`);
    assert.ok(closings.length >= 12, `checked at least the builder's 12 (checked ${closings.length})`);
});

test('a legitimately-asked question is not gated even when it contains "move on"', () => {
    // The regression the builder found in its own narrowing was in this family: "move on" is
    // ordinary when the target is the NEXT STEP of the current work, and a closing offer when the
    // target is ANOTHER process. The subject of the sentence is the distinction.
    for (const content of [
        'Would you like to move on to the next step?',
        'Do you want to move on to the steps themselves?',
        'Can we move on to how long it takes?'
    ]) {
        assert.equal(wasGated(content), false, `"${content}" is about this work and must pass through`);
    }
    // The closing counterpart, which must be gated.
    assert.equal(wasGated('Shall we move on?'), true, '"Shall we move on?" is a closing offer');
});

test('FINDING: one ordinary phrasing is still wrongly gated by the anything-else pattern', () => {
    // THE RESIDUAL FALSE POSITIVE, and it is the same defect class the commit fixed - a legitimate
    // question about THIS process being replaced by a generic one. The pattern is
    // `/\banything else\s+(?:you|we)...\s+(?:like|want|wish|add|cover)\b/`, and `add` has no
    // anchor after it, so:
    //
    //   "Is there anything else you would add to the steps?"   -> about THIS process, GATED
    //   "Is there anything else you would add?"                -> a closing offer, gated
    //
    // are indistinguishable to the pattern. The first is less common than the false positives the
    // commit removed, so this is a residual rather than a regression - but it is the same shape,
    // and "add" with a trailing qualifier is exactly how a model phrases a question about the
    // current steps. RECORDED AS TODAY'S BEHAVIOUR so narrowing it turns this red on purpose.
    const aboutThisProcess = 'Is there anything else you would add to the steps?';
    assert.equal(wasGated(aboutThisProcess), true,
        'FINDING: this question about the current steps IS gated');
    // The unqualified form is genuinely a closing offer, so the pair is the ambiguous one.
    assert.equal(wasGated('Is there anything else you would add?'), true,
        'and the unqualified form is gated too, which is correct');
});

test('FINDING: a closing offer with the object AFTER the verb is missed', () => {
    // THE OTHER DIRECTION, and the accepted one: the pattern is allowed to miss a rare closing
    // phrasing rather than hit a common one. "Would you like to add anything else?" puts `anything
    // else` after the verb, where none of the subject patterns reach it, so it passes through with
    // the matrix unsatisfied. The commit accepts this direction; recording it pins how far the
    // miss goes rather than leaving it to be discovered live.
    assert.equal(wasGated('Would you like to add anything else?'), false,
        'FINDING: this closing phrasing is NOT gated');
});

// ===========================================================================
// 4. THE DERIVED "NOTHING ANSWERED" CONSOLE STATE
// ===========================================================================

test('the console derives `empty` from the ROW - exercised through its real accessor', async () => {
    // DERIVED, NOT STORED, and the derivation is exactly two conditions: the round is finished
    // (`submitted_at` set) and NOTHING in its data has a shape the analysis can use.
    // `fieldsPresentIn` returns nothing for a declined field, which is what makes "no evidence at
    // all" computable from the row rather than needing a column.
    //
    // THE REAL ACCESSOR IS USED, `listResponsesWithGrouping`, rather than a reimplementation of
    // its rule: it takes a connection, which is reachable through the store's own
    // `connectionForOrNull`, so the answer comes from the module that renders the console.
    const org = store.createOrganisation('Empty org');
    const invitation = store.addInvitation(org.id, { email: 'p@example.test', department: 'Finance' });

    const allDeclined = {};
    for (const field of matrix.ALL_PROCESS_FIELD_NAMES) allDeclined[field] = { declined: 'no idea' };

    // Finalise it with an all-declined payload, which is the empty state.
    store.recordTurn(org.id, invitation.token, { data: allDeclined, transcript: [], complete: true });

    const db = organisations.connectionForOrNull(org.id);
    assert.notEqual(db, null, 'the organisation has an open connection');

    const listed = consoleRead.listResponsesWithGrouping(db);
    assert.equal(listed.length, 1, 'the console sees the round');
    assert.equal(listed[0].empty, true, 'and derives it as empty, from the row');
});

test('contrast all three states through the real accessor: in progress, finished, nothing answered', async () => {
    // THE PROPERTY THAT MATTERS, side by side: no row looks finished with nothing in it. Three
    // rounds, three DIFFERENT answers from the same accessor, which is what the console renders.
    const org = store.createOrganisation('Three states org');
    const allDeclined = {};
    for (const field of matrix.ALL_PROCESS_FIELD_NAMES) allDeclined[field] = { declined: 'no idea' };

    // A: unfinished (no `complete`), with some evidence.
    const a = store.addInvitation(org.id, { email: 'a@example.test', department: 'A' });
    store.recordTurn(org.id, a.token, { data: { task: 'invoices' }, transcript: [] });
    // B: finished, WITH evidence.
    const b = store.addInvitation(org.id, { email: 'b@example.test', department: 'B' });
    store.recordTurn(org.id, b.token, { data: { task: 'invoices' }, transcript: [], complete: true });
    // C: finished, with NO evidence (the empty state).
    const c = store.addInvitation(org.id, { email: 'c@example.test', department: 'C' });
    store.recordTurn(org.id, c.token, { data: allDeclined, transcript: [], complete: true });
    // D: UNFINISHED with NO evidence - the case that separates `empty` from "there is no data".
    //    A participant who declined everything and then abandoned the round carries no evidence
    //    either, so `empty` must be false here: the round is still in progress, and "nothing
    //    answered" would tell the admin a finished round ended with nothing when it has not ended.
    const d = store.addInvitation(org.id, { email: 'd@example.test', department: 'D' });
    store.recordTurn(org.id, d.token, { data: allDeclined, transcript: [] });

    const db = organisations.connectionForOrNull(org.id);
    const byDept = new Map(consoleRead.listResponsesWithGrouping(db).map((r) => [r.department, r]));

    assert.equal(byDept.size, 4, 'four rounds listed');
    // A: not finalised, so NOT empty, and the view shows the partial tag.
    assert.equal(byDept.get('A').submitted_at, null, 'A is not finalised');
    assert.equal(byDept.get('A').empty, false, 'A is not empty');
    // B: finalised WITH evidence, so NOT empty.
    assert.notEqual(byDept.get('B').submitted_at, null, 'B is finalised');
    assert.equal(byDept.get('B').empty, false, 'B has evidence, so it is not empty');
    // C: finalised with NO evidence, so empty.
    assert.notEqual(byDept.get('C').submitted_at, null, 'C is finalised');
    assert.equal(byDept.get('C').empty, true, 'C has no evidence, so it is empty');
    // D: NOT finalised with NO evidence, so NOT empty - the round is unfinished, not empty. This is
    // the case that proves `empty` needs the `submitted_at` half and not only "no evidence".
    assert.equal(byDept.get('D').submitted_at, null, 'D is not finalised');
    assert.equal(byDept.get('D').empty, false, 'D is unfinished, so it is NOT empty');
});

test('the console renders "nothing answered" and withholds the rejudge form on that round', async () => {
    // THE DEFECT THE CONSOLE FIX ADDRESSES: a finalised empty round rendered as `Untitled answer`
    // with no tag, and offered a Rejudge button that could only fail. Both halves are read from
    // the view: the tag must exist for the empty state, and the rejudge form must exclude it.
    const view = fs.readFileSync(path.join(PROJECT_ROOT, 'views', 'admin-answers.ejs'), 'utf8');

    assert.match(view, /response\.empty/, 'the view knows the derived empty state');
    assert.match(view, />nothing answered</, 'and renders the tag');
    // The rejudge form is gated on there being something to rejudge, not only on being finalised.
    assert.match(view, /if \(response\.submitted_at !== null && !response\.empty\)/,
        'and withholds the rejudge form when there is nothing to rejudge');
});
