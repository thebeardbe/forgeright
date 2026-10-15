/**
 * The repeat guard, the narrowed closing matcher, and the derived "nothing answered" console state.
 *
 * WHAT THE GUARD IS FOR. A model can ask the same question turn after turn, byte-identically, and
 * the round never moves: frustration, then abandonment. The guard replaces a repeated question
 * with a fresh one from the open fields.
 *
 * THE GUARD'S OWN LOOP IS THE INTERESTING PART, and it is why this file is shaped the way it is.
 * A guard that replaces a repeated question with a fixed substitute makes the SUBSTITUTE the
 * question of record, so it matches its own sentence next turn and replaces it again - the loop
 * moves from the model to the gate. The fix marks a substitute so only the model's own repeats are
 * match targets. Termination is therefore the property most of this file tests, because it is the
 * property that loop threatens.
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
    // OWN substitute as its next question. That is the loop the mark defeats: a
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

test('an ECHOING model NEVER sends the same question twice in a row, and the round terminates', () => {
    // The property is NO CONSECUTIVE DUPLICATE. An echoing model sends back whatever it last saw,
    // so it re-issues the gate's own substitute; the mark on a substitute keeps it from being
    // matched as if it were the model's, and the conversation still advances to a fresh field
    // each round rather than circling. The echo still reaches the server; what never reaches the
    // participant is a pair of consecutive identical sentences.
    const conversation = [];
    const replies = [];
    let incoming = 'How do you keep track of it?';

    for (let i = 1; i <= 60; i += 1) {
        const r = turn(incoming, conversation);
        replies.push(r.content);
        if (r.exhausted) break;
        incoming = r.content; // echo: the model repeats whatever it was just shown
    }

    const consecutiveDuplicates = replies.filter((text, i) => i > 0 && text === replies[i - 1]);
    assert.deepEqual(consecutiveDuplicates, [],
        `no question may reach the participant twice in a row (got ${JSON.stringify(consecutiveDuplicates)}`);
    assert.ok(replies.length > 1, 'and the conversation actually ran, so the check is not vacuous');
});

test('and an ECHOING model TERMINATES - the two fixes together, which is where it was fragile', () => {
    // THE OTHER PROPERTY THE OLD TEST PROTECTED, from the other side. Pinning "no duplicate"
    // without this would let a fix that never repeats but also never ends pass. So the echo run
    // must both avoid duplicates AND reach `exhausted` in a bounded number of turns. The builder
    // measured 12 turns and 12 distinct; the assertions are the bounded end and the distinctness
    // so a different starting sentence does not make this brittle.
    const conversation = [];
    const replies = [];
    let incoming = 'How do you keep track of it?';
    let endedAt = null;

    for (let i = 1; i <= 60; i += 1) {
        const r = turn(incoming, conversation);
        replies.push(r.content);
        if (r.exhausted) { endedAt = i; break; }
        incoming = r.content;
    }

    assert.notEqual(endedAt, null, 'the echo run terminates rather than looping');
    assert.ok(endedAt <= 20, `termination is bounded, not merely eventual (ended at turn ${endedAt})`);
    assert.ok(new Set(replies).size >= 10, `the conversation still advances (got ${new Set(replies).size} distinct)`);
});

test('a SUBSTITUTE the model ECHOES is REPLACED, not re-issued - and the round still terminates', () => {
    // TERMINATION AND NO CONSECUTIVE DUPLICATE, in the same case. A substitute the model echoes
    // must be REPLACED, so no sentence reaches the participant twice; and the replacement must not
    // be re-argued on the gate's next turn, so the conversation terminates rather than the gate
    // replacing its own sentence forever. The mark is carried by the TEXT, so the gate recognises
    // its own last sentence while an echo of it is still a match target.
    const substitute = 'Who else is involved in this?';
    const conversation = [{ content: substitute, missing: new Array(10).fill('f'), substituted: true }];

    const result = turn(substitute, conversation);
    assert.notEqual(result.content, substitute, 'the echoed substitute is not re-issued');
    assert.equal(result.substituted, true, 'and the replacement is itself marked as the gate\'s');
});

test('the mark survives a PASS-THROUGH, so the gate never argues with its own next turn', () => {
    // THE HALF THAT KEEPS TERMINATION. A substitute can be echoed back and, if there is progress,
    // passed through. The mark must travel with it on the TEXT, so the gate recognises its own
    // sentence next turn rather than treating it as the model's and substituting again.
    const substitute = 'Who else is involved in this?';
    // The substitute is the gate's own, and one field has been answered since, so the repeat is a
    // legitimate pass-through rather than a substitution.
    const conversation = [{ content: substitute, missing: new Array(12).fill('f'), substituted: true }];

    const result = turn(substitute, conversation);
    assert.equal(result.content, substitute, 'with progress, the substitute passes through');
    assert.equal(result.substituted, true, 'and is STILL marked as the gate\'s, not relabelled as the model\'s');
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
    // REWRITTEN. It used to require BOTH sentences to appear in one run, which was true when the
    // round ran out of fresh targets before it ran out of questions. The exhaustion fix now closes
    // the round BEFORE the move-on branch, so the move-on line is not said in a simple run - the
    // old assertion fails for the right reason, because the fix removed the path that reached it.
    //
    // THE TWO MESSAGES ARE STILL DIFFERENT, and that is the property, so it is asserted by
    // comparing the two literals in the source rather than by requiring both to appear. Conflating
    // them would either keep a finished interview open or close one that could still continue - the
    // reason the distinction exists, unaffected by which path is now reached.
    const source = fs.readFileSync(path.join(PROJECT_ROOT, 'ai', 'audit-core.js'), 'utf8');
    const moveOnLine = source.match(/return `[^`]*move on rather than keep circling[^`]*`/);
    const closeLine = source.match(/text: 'Thank you - that gives me a good picture[^']*'/);

    assert.notEqual(moveOnLine, null, 'the move-on line still exists in the code');
    assert.notEqual(closeLine, null, 'and the closing line does');
    assert.notEqual(moveOnLine[0], closeLine[0], 'and they are different sentences');

    // And a run DOES end, on the close, which is the termination behaviour the exhaustion check
    // runs ahead of.
    const conversation = [];
    let final = null;
    for (let i = 1; i <= 40; i += 1) {
        const r = turn('How do you keep track of it?', conversation);
        if (r.exhausted) { final = r; break; }
    }
    assert.notEqual(final, null, 'the run terminates');
    assert.match(final.content, /stop there rather than keep asking/i, 'on the closing line');
    assert.equal(/move on rather than keep circling/i.test(final.content), false,
        'and NOT on the move-on line, which the exhaustion fix now runs ahead of');
});

// ===========================================================================
// 3. THE NARROWED MATCHER - BOTH DIRECTIONS
// ===========================================================================

/** Whether the reply's content was replaced by a gate (substituted), given a partial matrix. */
function wasGated(content) {
    const r = parseModelResponse(JSON.stringify({
        status: 'asking', content, processes: [partialProcess()], have: [], missing: []
    }), { askedBefore: [] });
    return r.content !== content;
}

// The set below stresses the two patterns that are over-broad in principle - bare `anything else`
// and bare `shall`/`should`/`may` - with realistic phrasings about THIS process.

test('ordinary questions are NOT gated - stressing the two over-broad patterns', () => {
    const ordinary = [
        // The two patterns the matcher narrows, with realistic phrasings that are about THIS process.
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
    assert.ok(ordinary.length >= 28, `the set holds at least 28 ordinary questions (checked ${ordinary.length})`);
});

test('closing phrasings ARE gated - including ones that quote no prompt verbatim', () => {
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
    assert.ok(closings.length >= 12, `the set holds at least 12 closing phrasings (checked ${closings.length})`);
});

test('a legitimately-asked question is not gated even when it contains "move on"', () => {
    // The two patterns in the matcher are over-broad in principle (bare `anything else` and a bare
    // modal `shall`/`should`/`may`), so both directions are stressed below: a legitimate question
    // about THIS process must not be gated, and a genuine closing offer must be.
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
    // A RESIDUAL FALSE POSITIVE: a legitimate question about THIS process being replaced by a
    // generic one. The pattern is
    // `/\banything else\s+(?:you|we)...\s+(?:like|want|wish|add|cover)\b/`, and `add` has no
    // anchor after it, so:
    //
    //   "Is there anything else you would add to the steps?"   -> about THIS process, GATED
    //   "Is there anything else you would add?"                -> a closing offer, gated
    //
    // are indistinguishable to the pattern. The first is rarer than the false positives the
    // narrowing removed, and "add" with a trailing qualifier is exactly how a model phrases a
    // question about the current steps. RECORDED AS TODAY'S BEHAVIOUR so narrowing it turns this
    // red on purpose.
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
    // the matrix unsatisfied. This direction is accepted, and recording it pins how far the miss
    // goes rather than leaving it to be discovered live.
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

// ===========================================================================
// 5. EXHAUSTION: MONOTONIC, AND PLACED BEFORE THE SUBSTITUTION
// ===========================================================================
//
// THE PLACEMENT IS WHAT MATTERS, more than what the check compares. A check that lives in the
// `no fresh target` branch never runs when a rotating `missing` keeps offering fresh targets, so
// the interviewer keeps asking and never closes. The check therefore runs before substitution,
// on a repeat with no fresh target, so a rotating open set cannot keep it out of reach.
//
// So these build conversations where `missing` ROTATES, which is what defeats a check that
// compares against the open set, and assert the round still closes.

/**
 * A payload with a chosen number of OPEN fields, so `missing` can be varied turn by turn.
 *
 * The open fields are the tail of the field list, and `frequencyPerWeek` is always supplied while
 * `timePerPeriod` is always left open - so the effort pair is open and the count is controllable.
 */
function processWithOpenFields(openCount) {
    const typed = matrix.ALL_PROCESS_FIELD_NAMES
        .slice(0, matrix.ALL_PROCESS_FIELD_NAMES.length - openCount)
        .filter((f) => f !== 'timePerPeriod' && f !== 'frequencyPerWeek');
    const values = Object.fromEntries(typed.map((f) => [
        f, f === 'steps'
            ? [Object.fromEntries(matrix.STEP_FIELDS.map((s) => [s, s === 'needsReasoning' ? false : 'v']))]
            : (f === 'needsReasoning' ? false : 'v')
    ]));
    return { ...values, frequencyPerWeek: 2 };
}

/**
 * Runs a conversation where the model repeats one sentence and `missing` ROTATES every turn.
 *
 * Returns the turn at which the round ended, or null. The rotation is the point: a check that
 * compares against the open SET needs each set to be seen twice before it fires, so a rotating set
 * needs one extra cycle per set - and at a fast rotation the set is never the same twice.
 */
function runRotating(period, sentence = 'How do you keep track of it?', maxTurns = 200) {
    const conversation = [];
    const replies = [];
    for (let t = 1; t <= maxTurns; t += 1) {
        const openCount = (Math.floor(t / period) % 3) + 3;
        const askedBefore = conversation.map((entry) => ({
            text: entry.content, openCount: entry.missing.length, substituted: entry.substituted === true
        }));
        const raw = JSON.stringify({
            status: 'asking', content: sentence, processes: [processWithOpenFields(openCount)], have: [], missing: []
        });
        const r = parseModelResponse(raw, { askedBefore });
        conversation.push({ content: r.content, missing: r.missing, substituted: r.substituted === true });
        replies.push(r.content);
        if (r.exhausted) return { endedAt: t, replies };
    }
    return { endedAt: null, replies };
}

test('an OSCILLATING `missing` still terminates - the placement fix', () => {
    // The shape that would defeat a check placed out of reach of a rotating open set: the model
    // varies its payload so `missing` rotates, and every rotation rate must still close the
    // interview.
    //
    // HONEST LIMIT: an offline rotation cannot be constructed that makes the old sentence-based
    // check fail - the field QUESTIONS are a fixed set of fifteen, so any rotation consumes them
    // within a bounded number of turns and both checks then fire. What this test can assert
    // offline is the OUTCOME the placement owes - every rotation terminates, bounded - and the
    // structural test below asserts the MECHANISM. So a misplaced check passes this test but
    // fails the structural one, which is stated rather than hidden.
    for (const period of [1, 2, 3, 5, 7]) {
        const { endedAt } = runRotating(period);
        assert.notEqual(endedAt, null, `rotation period ${period} must terminate, not run indefinitely`);
        assert.ok(endedAt <= 60, `rotation period ${period} terminates in a bounded number of turns (got ${endedAt})`);
    }
});

test('a WIDE rotation - the open set different every turn - still terminates within a bounded run', () => {
    // The harsher rotation: the window slides by a co-prime step so the open SET differs every
    // turn and does not recur for many turns. This is the shape that makes a check against the
    // open set need one extra cycle PER SET, and it is bounded here rather than unbounded.
    const ALL = matrix.ALL_PROCESS_FIELD_NAMES;
    const payloadFor = (t) => {
        const open = new Set([t % ALL.length, (t + 4) % ALL.length, (t + 9) % ALL.length, (t + 13) % ALL.length]);
        const values = {};
        for (let i = 0; i < ALL.length; i += 1) {
            const field = ALL[i];
            if (field === 'frequencyPerWeek') { values[field] = 2; continue; }
            if (open.has(i)) continue;
            values[field] = field === 'steps'
                ? [Object.fromEntries(matrix.STEP_FIELDS.map((f) => [f, f === 'needsReasoning' ? false : 'v']))]
                : (field === 'needsReasoning' ? false : 'v');
        }
        return values;
    };

    const conversation = [];
    const sentence = 'How do you keep track of it?';
    let endedAt = null;
    for (let t = 1; t <= 300; t += 1) {
        const askedBefore = conversation.map((entry) => ({
            text: entry.content, openCount: entry.missing.length, substituted: entry.substituted === true
        }));
        const r = parseModelResponse(JSON.stringify({
            status: 'asking', content: sentence, processes: [payloadFor(t)], have: [], missing: []
        }), { askedBefore });
        conversation.push({ content: r.content, missing: r.missing, substituted: r.substituted === true });
        if (r.exhausted) { endedAt = t; break; }
    }

    assert.notEqual(endedAt, null, 'a wide rotation terminates rather than running forever');
    assert.ok(endedAt <= 200, `and it is bounded (ended at ${endedAt})`);
});

test('exhaustion asks whether every question about an OPEN field has been asked', () => {
    // The DECISION, not the parameter list. Requiring all fifteen was too strong: a field the model
    // CLAIMS is never offered, so its phrasing never enters the conversation and exhaustion can
    // never fire - a loop of its own. The monotonic INTENT holds with the open set instead:
    //   - the set is `FIELD_QUESTIONS` LIMITED TO the currently-open fields, and
    //   - it is satisfied when every one of those has been asked, and
    //   - the decision uses it, on a repeat with no fresh target.
    const source = fs.readFileSync(path.join(PROJECT_ROOT, 'ai', 'audit-core.js'), 'utf8');

    // The helper exists and takes the open fields.
    assert.match(source, /function asksEveryField\(askedQuestions, openFields\)/,
        'the helper takes the asked questions AND the open fields');
    // The set is the open fields' phrasings, not all fifteen.
    assert.match(source, /const phrasings = openFields\s*\n?\s*\.map\(\(field\) => FIELD_QUESTIONS\[field\]\)/,
        'it maps the OPEN fields to their phrasings');
    assert.match(source, /if \(phrasings\.length === 0\) return false;/, 'and an empty open set is not its call');
    assert.match(source, /return phrasings\.every\(\(phrasing\) => askedQuestions\.has\(phrasing\)\);/,
        'satisfied when every open field\'s question has been asked');
    // And the decision passes the open fields, on a repeat with no fresh target.
    assert.match(source, /if \(fresh === undefined && asksEveryField\(askedQuestions, computed\.missing\)\)/,
        'the exhaustion branch passes the currently-open fields');
});

test('the RESIDUAL STALL of requiring all fifteen: the round still ends', () => {
    // THE CASE THAT PRODUCED A SECOND LOOP: the model claims task/trigger/steps HELD, so those
    // questions are never offered, their phrasings never enter the conversation, and a check
    // requiring all fifteen could never fire - the move-on line emitted every turn, indefinitely.
    // With the open-field relaxation the round ends.
    //
    // Driven by the real guard: a payload proving four fields, and a model repeating one question.
    // The open set is the ten-or-eleven fields the payload does not carry, all of whose questions
    // are offered by substitution, so `asksEveryField` is satisfied on the open set even though
    // three of the fifteen questions were never asked at all.
    const conversation = [];
    let endedAt = null;
    for (let i = 1; i <= 60; i += 1) {
        const r = turn('How do you keep track of it?', conversation);
        if (r.exhausted) { endedAt = i; break; }
    }

    assert.notEqual(endedAt, null, 'the round ends rather than emitting the move-on line forever');
    // Count the questions actually used, to show it is FEWER than fifteen - which is the point:
    // exhaustion fired without every field question having been asked.
    const asked = new Set(conversation.map((entry) => entry.content));
    assert.ok(asked.size < matrix.ALL_PROCESS_FIELD_NAMES.length,
        `exhaustion fired with fewer than all fifteen questions asked (asked ${asked.size})`);
});

test('a HEALTHY interview is NOT cut short - exhaustion needs a repeat to trigger', () => {
    // The guard must not end an interview that is still moving. Two things are asserted: a
    // conversation of DISTINCT questions never exhausts, and a repeat WITH progress (a legitimate
    // second attempt) does not either.
    const conversation = [];
    const asked = [
        'What is the work, in your own words?',
        'What starts one instance of this work?',
        'What are the steps, from beginning to end?',
        'Who else is involved in this?',
        'Who does this go to next?'
    ];
    for (const question of asked) {
        const r = turn(question, conversation);
        assert.equal(r.exhausted, false, `a distinct question must not end the round: ${JSON.stringify(question)}`);
        assert.equal(r.content, question, 'and is passed through unchanged');
    }

    // And a repeat after progress is left alone, which is the legitimate second attempt.
    const repeat = 'How often does this happen?';
    const prior = [{ content: repeat, missing: new Array(12).fill('f'), substituted: false }];
    assert.equal(turn(repeat, prior).exhausted, false, 'a repeat AFTER progress does not exhaust');
});

test('FINDING: ECHO plus ROTATION produces consecutive duplicates the fixes do not catch', () => {
    // THE INTERACTION, and it is the thing the brief asked for. The two fixes act on different
    // paths: the echo fix makes a substitute MATCHABLE again, and the placement fix moves the
    // exhaustion check ahead of the substitution. Neither handles the case where the model ECHOES
    // AND the open set ROTATES at the same time.
    //
    // The cascade: the model echoes the substitute; the rotation makes a DIFFERENT field the
    // `fresh` target each turn; a substitute written for field A reappears as the fresh target
    // for field A when the rotation brings A back, so the gate re-issues a sentence it already
    // wrote. Measured with an echoing model and a rotation of period 1: the participant sees the
    // SAME question three times in a row (max run 3), across 25 consecutive duplicate pairs.
    //
    // IT STILL TERMINATES, which is why this is a FINDING and not a termination defeat: the round
    // closes at turn 41. What it costs is the participant's patience - the symptom the guard
    // exists to remove, surviving in the interaction of the two fixes rather than in either one.
    // RECORDED AS TODAY'S BEHAVIOUR so a fix turns it red on purpose.
    const { endedAt, replies } = runRotatingEcho(1);

    const maxRun = (() => {
        let best = 0; let current = 1;
        for (let i = 1; i < replies.length; i += 1) {
            if (replies[i] === replies[i - 1]) { current += 1; best = Math.max(best, current); } else current = 1;
        }
        return best;
    })();

    assert.notEqual(endedAt, null, 'FINDING: the interaction still terminates');
    assert.ok(maxRun >= 3, `FINDING: the same question reaches the participant ${maxRun} times in a row`);
});

/** Runs the echo model with a rotating open set: the model sends back what it last received. */
function runRotatingEcho(period, maxTurns = 200) {
    const conversation = [];
    const replies = [];
    let incoming = 'How do you keep track of it?';
    for (let t = 1; t <= maxTurns; t += 1) {
        const openCount = (Math.floor(t / period) % 3) + 3;
        const askedBefore = conversation.map((entry) => ({
            text: entry.content, openCount: entry.missing.length, substituted: entry.substituted === true
        }));
        const raw = JSON.stringify({
            status: 'asking', content: incoming, processes: [processWithOpenFields(openCount)], have: [], missing: []
        });
        const r = parseModelResponse(raw, { askedBefore });
        conversation.push({ content: r.content, missing: r.missing, substituted: r.substituted === true });
        replies.push(r.content);
        if (r.exhausted) return { endedAt: t, replies };
        incoming = r.content;
    }
    return { endedAt: null, replies };
}
