/**
 * The repeat guard, the narrowed closing matcher, and the derived "nothing answered" console state.
 *
 * The guard marks what it wrote, so a substitute does not become a match target itself - which is
 * why termination is the property most of this file tests. TWO FINDINGS assert today's behaviour,
 * so a fix turns them red on purpose.
 *
 * NOT testable offline: whether a real model produces the stalled conversation in the first place,
 * or how often.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');

// STORE_DIR is captured at FIRST IMPORT and its path guard refuses a second directory, so it is set
// once for the whole file; each test uses its own organisation.
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

const partialProcess = () => ({
    task: 'entering invoices',
    trigger: 'the mail arrives',
    steps: [Object.fromEntries(matrix.STEP_FIELDS.map((f) => [f, f === 'needsReasoning' ? false : 'v']))],
    frequencyPerWeek: 2
});

const askingReply = (content, process = partialProcess()) => JSON.stringify({
    status: 'asking', content, processes: [process], have: [], missing: []
});

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

/** Parses one turn in the shape the client replays it: `{ content, missing, substituted, exhausted }`. */
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

test('a repeated question with NO progress is replaced with a question about another open field', () => {
    const question = 'How do you keep track of it?';
    const conversation = [];

    const first = turn(question, conversation);
    assert.equal(first.content, question, 'the first asking is not a repeat');
    assert.equal(first.substituted, false, 'and is not marked as the gate\'s');

    const second = turn(question, conversation);
    assert.notEqual(second.content, question, 'the repeat is replaced');
    assert.equal(second.substituted, true, 'and marked as the gate\'s own');
    assert.ok(second.content.length > 0, 'replaced by a real question, not blanked');
    assert.notEqual(second.content, second.missing[0], 'and not the raw field name');
});

test('A LEGITIMATE SECOND ATTEMPT PASSES THROUGH - the difference between a guard and a wall', () => {
    // One rephrase is allowed: only a repeat with NOTHING recorded since is a stall, read as
    // `missing` shrinking.
    const question = 'How often does this happen?';
    const conversation = [{ content: question, missing: new Array(12).fill('f'), substituted: false }];

    const result = turn(question, conversation);
    assert.equal(result.content, question, 'a repeat after progress is NOT substituted');
    assert.equal(result.substituted, false, 'and is not marked as the gate\'s');
});

test('the SAME repeat with no progress IS substituted, so progress is the only difference', () => {
    const question = 'How often does this happen?';
    const withProgress = [{ content: question, missing: new Array(12).fill('f'), substituted: false }];
    const noProgress = [{ content: question, missing: new Array(10).fill('f'), substituted: false }];

    assert.equal(turn(question, [...withProgress]).substituted, false, 'progress: passes');
    assert.equal(turn(question, [...noProgress]).substituted, true, 'no progress: substituted');
});

test('TERMINATION: a model stuck on ONE sentence ends the round, with no question repeated', () => {
    // Unmarked, the guard would match its own substitute and replace it forever.
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
    // The model ECHOES back whatever it last received, so it sends the gate's OWN substitute as its
    // next question: the loop the mark defeats.
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
    // What never reaches the participant is a pair of consecutive identical sentences.
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
    // "No duplicate" alone would let a run that never ends pass: it must reach `exhausted` bounded.
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
    // The mark is carried by the TEXT: the gate recognises its own last sentence, while an echo of
    // it is still a match target.
    const substitute = 'Who else is involved in this?';
    const conversation = [{ content: substitute, missing: new Array(10).fill('f'), substituted: true }];

    const result = turn(substitute, conversation);
    assert.notEqual(result.content, substitute, 'the echoed substitute is not re-issued');
    assert.equal(result.substituted, true, 'and the replacement is itself marked as the gate\'s');
});

test('the mark survives a PASS-THROUGH, so the gate never argues with its own next turn', () => {
    // The mark must travel on the TEXT, so the gate recognises its own sentence next turn.
    const substitute = 'Who else is involved in this?';
    const conversation = [{ content: substitute, missing: new Array(12).fill('f'), substituted: true }];

    const result = turn(substitute, conversation);
    assert.equal(result.content, substitute, 'with progress, the substitute passes through');
    assert.equal(result.substituted, true, 'and is STILL marked as the gate\'s, not relabelled as the model\'s');
});

test('every-field-asked ENDS the round as `exhausted`, not `nothing_answered`', () => {
    // Reusing nothing_answered here would tell a participant who answered plenty that nothing was
    // captured.
    const MODEL_SENTENCE = 'How do you keep track of it?';
    const conversation = [];
    for (let i = 1; i <= 40; i += 1) {
        const r = turn(MODEL_SENTENCE, conversation);
        if (r.exhausted) {
            assert.equal(r.exhausted, true, 'the round is marked exhausted');
            assert.notEqual(r.status, 'nothing_answered', 'and is NOT nothing_answered');
            assert.equal(/did not manage to capture any answers/.test(r.content), false,
                'and the participant is not told their answers were not captured');
            return;
        }
    }
    assert.fail('the all-asked path was never reached');
});

test('the two terminal states are DISTINCT: exhausted has supplied fields, nothing_answered has none', () => {
    const allDeclined = {};
    for (const field of matrix.ALL_PROCESS_FIELD_NAMES) allDeclined[field] = { declined: 'no idea' };
    const declinedReply = parseModelResponse(JSON.stringify({
        status: 'asking', content: 'Anything else?', processes: [allDeclined], have: [], missing: []
    }), { askedBefore: [] });

    assert.equal(declinedReply.status, 'nothing_answered', 'declining everything: nothing_answered');
    assert.equal(declinedReply.exhausted, undefined, 'and NOT marked exhausted');

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
    // Asserted by comparing the two literals in the source, not by requiring both to appear:
    // conflating them would either keep a finished interview open or close one that could continue.
    const source = fs.readFileSync(path.join(PROJECT_ROOT, 'ai', 'audit-core.js'), 'utf8');
    const moveOnLine = source.match(/return `[^`]*move on rather than keep circling[^`]*`/);
    const closeLine = source.match(/text: 'Thank you - that gives me a good picture[^']*'/);

    assert.notEqual(moveOnLine, null, 'the move-on line still exists in the code');
    assert.notEqual(closeLine, null, 'and the closing line does');
    assert.notEqual(moveOnLine[0], closeLine[0], 'and they are different sentences');

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

function wasGated(content) {
    const r = parseModelResponse(JSON.stringify({
        status: 'asking', content, processes: [partialProcess()], have: [], missing: []
    }), { askedBefore: [] });
    return r.content !== content;
}

test('ordinary questions are NOT gated - stressing the two over-broad patterns', () => {
    const ordinary = [
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
        'Anything else that makes this hard?',
        'Is there anything else about the timing I should know?',
        'Is there anything else that slows this down?',
        'Is there anything about the process you would change?',
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
    for (const content of [
        'Would you like to move on to the next step?',
        'Do you want to move on to the steps themselves?',
        'Can we move on to how long it takes?'
    ]) {
        assert.equal(wasGated(content), false, `"${content}" is about this work and must pass through`);
    }
    assert.equal(wasGated('Shall we move on?'), true, '"Shall we move on?" is a closing offer');
});

test('FINDING: one ordinary phrasing is still wrongly gated by the anything-else pattern', () => {
    // `add` has no anchor after it, so "anything else you would add to the steps?" (about THIS
    // process) and "anything else you would add?" (a closing offer) are indistinguishable.
    const aboutThisProcess = 'Is there anything else you would add to the steps?';
    assert.equal(wasGated(aboutThisProcess), true,
        'FINDING: this question about the current steps IS gated');
    assert.equal(wasGated('Is there anything else you would add?'), true,
        'and the unqualified form is gated too, which is correct');
});

test('FINDING: a closing offer with the object AFTER the verb is missed', () => {
    // `anything else` after the verb is out of reach of the subject patterns: allowed, as missing a
    // rare closing phrasing beats hitting a common one.
    assert.equal(wasGated('Would you like to add anything else?'), false,
        'FINDING: this closing phrasing is NOT gated');
});

test('the console derives `empty` from the ROW - exercised through its real accessor', async () => {
    // DERIVED, NOT STORED: the round is finished (`submitted_at` set) AND its data has no usable
    // shape.
    const org = store.createOrganisation('Empty org');
    const invitation = store.addInvitation(org.id, { email: 'p@example.test', department: 'Finance' });

    const allDeclined = {};
    for (const field of matrix.ALL_PROCESS_FIELD_NAMES) allDeclined[field] = { declined: 'no idea' };

    store.recordTurn(org.id, invitation.token, { data: allDeclined, transcript: [], complete: true });

    const db = organisations.connectionForOrNull(org.id);
    assert.notEqual(db, null, 'the organisation has an open connection');

    const listed = consoleRead.listResponsesWithGrouping(db);
    assert.equal(listed.length, 1, 'the console sees the round');
    assert.equal(listed[0].empty, true, 'and derives it as empty, from the row');
});

test('contrast all three states through the real accessor: in progress, finished, nothing answered', async () => {
    const org = store.createOrganisation('Three states org');
    const allDeclined = {};
    for (const field of matrix.ALL_PROCESS_FIELD_NAMES) allDeclined[field] = { declined: 'no idea' };

    const a = store.addInvitation(org.id, { email: 'a@example.test', department: 'A' });
    store.recordTurn(org.id, a.token, { data: { task: 'invoices' }, transcript: [] });
    const b = store.addInvitation(org.id, { email: 'b@example.test', department: 'B' });
    store.recordTurn(org.id, b.token, { data: { task: 'invoices' }, transcript: [], complete: true });
    const c = store.addInvitation(org.id, { email: 'c@example.test', department: 'C' });
    store.recordTurn(org.id, c.token, { data: allDeclined, transcript: [], complete: true });
    // D carries no evidence but is UNFINISHED, so `empty` must be false: the round is still in
    // progress.
    const d = store.addInvitation(org.id, { email: 'd@example.test', department: 'D' });
    store.recordTurn(org.id, d.token, { data: allDeclined, transcript: [] });

    const db = organisations.connectionForOrNull(org.id);
    const byDept = new Map(consoleRead.listResponsesWithGrouping(db).map((r) => [r.department, r]));

    assert.equal(byDept.size, 4, 'four rounds listed');
    assert.equal(byDept.get('A').submitted_at, null, 'A is not finalised');
    assert.equal(byDept.get('A').empty, false, 'A is not empty');
    assert.notEqual(byDept.get('B').submitted_at, null, 'B is finalised');
    assert.equal(byDept.get('B').empty, false, 'B has evidence, so it is not empty');
    assert.notEqual(byDept.get('C').submitted_at, null, 'C is finalised');
    assert.equal(byDept.get('C').empty, true, 'C has no evidence, so it is empty');
    assert.equal(byDept.get('D').submitted_at, null, 'D is not finalised');
    assert.equal(byDept.get('D').empty, false, 'D is unfinished, so it is NOT empty');
});

test('the console renders "nothing answered" and withholds the rejudge form on that round', async () => {
    const view = fs.readFileSync(path.join(PROJECT_ROOT, 'views', 'admin-answers.ejs'), 'utf8');

    assert.match(view, /response\.empty/, 'the view knows the derived empty state');
    assert.match(view, />nothing answered</, 'and renders the tag');
    assert.match(view, /if \(response\.submitted_at !== null && !response\.empty\)/,
        'and withholds the rejudge form when there is nothing to rejudge');
});

// ===========================================================================
// 5. EXHAUSTION: MONOTONIC, AND PLACED BEFORE THE SUBSTITUTION
// ===========================================================================
//
// The exhaustion check must run BEFORE substitution, or a rotating `missing` keeps offering fresh
// targets and the check never runs.

/**
 * A payload with a chosen number of OPEN fields. `frequencyPerWeek` is always supplied and
 * `timePerPeriod` always open, so the effort pair is open and the count is controllable.
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
 * Returns the turn it ended on, or null.
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
    // NOT covered: an offline rotation that makes a sentence-based check fail, because the fifteen
    // field questions are a fixed set and any rotation consumes them. This asserts the OUTCOME;
    // the structural test below asserts the MECHANISM.
    for (const period of [1, 2, 3, 5, 7]) {
        const { endedAt } = runRotating(period);
        assert.notEqual(endedAt, null, `rotation period ${period} must terminate, not run indefinitely`);
        assert.ok(endedAt <= 60, `rotation period ${period} terminates in a bounded number of turns (got ${endedAt})`);
    }
});

test('a WIDE rotation - the open set different every turn - still terminates within a bounded run', () => {
    // A co-prime step, so the open SET differs every turn and does not recur for many turns.
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
    // The DECISION, not the parameter list: `FIELD_QUESTIONS` limited to the open fields, satisfied
    // when every one of those has been asked.
    const source = fs.readFileSync(path.join(PROJECT_ROOT, 'ai', 'audit-core.js'), 'utf8');

    assert.match(source, /function asksEveryField\(askedQuestions, openFields\)/,
        'the helper takes the asked questions AND the open fields');
    assert.match(source, /const phrasings = openFields\s*\n?\s*\.map\(\(field\) => FIELD_QUESTIONS\[field\]\)/,
        'it maps the OPEN fields to their phrasings');
    assert.match(source, /if \(phrasings\.length === 0\) return false;/, 'and an empty open set is not its call');
    assert.match(source, /return phrasings\.every\(\(phrasing\) => askedQuestions\.has\(phrasing\)\);/,
        'satisfied when every open field\'s question has been asked');
    assert.match(source, /if \(fresh === undefined && asksEveryField\(askedQuestions, computed\.missing\)\)/,
        'the exhaustion branch passes the currently-open fields');
});

test('the RESIDUAL STALL of requiring all fifteen: the round still ends', () => {
    // Fields the model claims HELD are never offered, so requiring all fifteen could never fire.
    const conversation = [];
    let endedAt = null;
    for (let i = 1; i <= 60; i += 1) {
        const r = turn('How do you keep track of it?', conversation);
        if (r.exhausted) { endedAt = i; break; }
    }

    assert.notEqual(endedAt, null, 'the round ends rather than emitting the move-on line forever');
    const asked = new Set(conversation.map((entry) => entry.content));
    assert.ok(asked.size < matrix.ALL_PROCESS_FIELD_NAMES.length,
        `exhaustion fired with fewer than all fifteen questions asked (asked ${asked.size})`);
});

test('a HEALTHY interview is NOT cut short - exhaustion needs a repeat to trigger', () => {
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

    const repeat = 'How often does this happen?';
    const prior = [{ content: repeat, missing: new Array(12).fill('f'), substituted: false }];
    assert.equal(turn(repeat, prior).exhausted, false, 'a repeat AFTER progress does not exhaust');
});

test('FINDING: ECHO plus ROTATION produces consecutive duplicates the fixes do not catch', () => {
    // Echo AND rotation together: a substitute written for field A reappears as the fresh target
    // when the rotation brings A back. The round still terminates; it costs the participant's
    // patience.
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
