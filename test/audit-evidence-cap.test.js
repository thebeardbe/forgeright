/**
 * The evidence cap: its trigger condition, its counter, and what it does to a stalled round.
 *
 * THE CAP MUST NOT PRE-EMPT COMPLETION. It fired on an ALREADY-COMPLETE interview -
 * `evidenced=15, missing=0` - telling the participant the tool had recorded nothing new when it had
 * recorded everything. A suite can pass throughout while that holds, because a cap test using a
 * stalled conversation where `missing` is non-empty never takes the complete path at all.
 *
 * So the first tests here are the ones that matter most: a COMPLETE payload with a plateaued
 * `evidenced` series must NOT be capped.
 *
 * THE COUNTER IS NOT MONOTONIC, AND THIS FILE DOES NOT PRETEND IT IS. A payload does not keep every
 * field it once held: the model rewrites `processes` each turn and drops fields it had filled. So
 * the counter, which measures against a peak, reads a fluctuating series as a long plateau. That is
 * a KNOWN, UNFIXED limitation, and it is tested as what it does rather than as what it ought to do.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');

const { parseModelResponse } = await import('../ai/audit-core.js');
const matrix = await import('../ai/matrix.js');

const ALL = matrix.ALL_PROCESS_FIELD_NAMES;

// ===========================================================================
// FIXTURES
// ===========================================================================

/** The shape a field needs to count as `evidenced`, per field. */
function valueFor(field) {
    if (field === 'steps') {
        return [Object.fromEntries(matrix.STEP_FIELDS.map((s) => [s, s === 'needsReasoning' ? false : 'v']))];
    }
    if (field === 'frequencyPerWeek') return 2;
    if (field === 'timePerPeriod') return { hours: 2, period: 'week' };
    if (field === 'peopleAffected' || field === 'mistakesPerPeriod') return 1;
    if (['handoffTo', 'waitsFor', 'dependsOn', 'systems', 'touchedDepartments'].includes(field)) return ['x'];
    return 'v';
}

/**
 * A payload proving exactly the first `n` fields.
 *
 * The order is chosen so EACH FIELD ADDED RAISES `evidenced` by one, which matters: the naive
 * `ALL.slice(0, n)` types fields whose shapes do not count, so a "gaining" run built that way is
 * not gaining at all. See `evidencedPerField` below for the check.
 */
const EVIDENCE_ORDER = [
    'task', 'trigger', 'steps', 'peopleAffected', 'handoffTo', 'waitsFor', 'dependsOn', 'systems',
    'touchedDepartments', 'mistakesPerPeriod', 'mistakeConsequence', 'currentState', 'frustration',
    'frequencyPerWeek', 'timePerPeriod'
];

function payloadProving(n) {
    const values = {};
    for (const field of EVIDENCE_ORDER.slice(0, n)) values[field] = valueFor(field);
    return values;
}

const askingReply = (n) => JSON.stringify({
    status: 'asking', content: 'What about the mail?', processes: [payloadProving(n)], have: [], missing: []
});

/** A COMPLETE payload: every field required for `evidenced` to reach fifteen. */
const completeReply = (content = 'Anything else?') => JSON.stringify({
    status: 'asking', content, processes: [payloadProving(ALL.length)], have: [], missing: []
});

/**
 * A conversation of assistant turns carrying an `evidenced` length series.
 *
 * `missingCount` and `substituted` make each turn look like one this server wrote, which is what
 * the omitted-`evidenced` rule keys on.
 */
function conversationFrom(series, { missingCount = 3, substituted = false } = {}) {
    return series.map((length, i) => {
        const turn = { role: 'assistant', content: `question ${i}` };
        if (length !== null) turn.evidenced = ALL.slice(0, length);
        if (missingCount !== null) turn.missing = ALL.slice(0, missingCount);
        if (substituted !== null) turn.substituted = substituted;
        return turn;
    });
}

/** A plateau of `n` turns at a constant evidence length. */
const plateau = (n, length) => new Array(n).fill(length);

// ===========================================================================
// 0. THE FIXTURE IS SOUND: a "gaining" run really gains
// ===========================================================================

test('the evidence order is sound: a payload proving `n` fields has `evidenced` of `n` or more', () => {
    // A FIXTURE THAT DOES NOT GAIN PROVES NOTHING about a run that does. This checks the order used
    // by every slow-gain test below. It is NOT strictly +1: the effort pair counts as TWO names, so
    // proving `frequencyPerWeek` without `timePerPeriod` jumps evidenced from 13 to 15. So the
    // property asserted is that `evidenced` never EXCEEDS the fields proved and rises to fifteen at
    // the end - a sound gain, without a false claim about the step size.
    const values = [];
    for (let n = 1; n <= EVIDENCE_ORDER.length; n += 1) {
        const evidenced = matrix.reconcileMatrix({ processes: [payloadProving(n)] }).evidenced.length;
        assert.ok(evidenced >= n, `proving ${n} fields gives at least ${n} evidenced (got ${evidenced})`);
        values.push(evidenced);
    }
    assert.equal(values[values.length - 1], ALL.length, 'and the full payload proves every field');
    // Every step is non-decreasing, which is what makes the slow-gain runs monotonically gain.
    for (let i = 1; i < values.length; i += 1) {
        assert.ok(values[i] >= values[i - 1], `step ${i + 1} does not fall (${values.join(',')})`);
    }
});

// ===========================================================================
// 1. THE MISSING TEST - a COMPLETE interview must NOT be capped
// ===========================================================================

test('a COMPLETE payload with a plateaued series is NOT capped', () => {
    // `evidenced=15, missing=0` with evidence settling. A complete interview must not be closed by
    // the evidence cap: it has recorded everything, so there is nothing left to wait for.
    //
    // A SHORT SERIES ALONE IS NOT A TEST OF THE CONDITION: the series `14,14,13,15,15,15` reads as
    // only two turns without evidence at its end, far below the cap of twenty, so it passes whether
    // or not the `missing > 0` condition exists. The short series is checked for fidelity AND the
    // series is EXTENDED to a real plateau, which is the case that reproduces the defect offline.
    const capture = parseModelResponse(completeReply(), {
        messages: conversationFrom([14, 14, 13, 15, 15, 15], { missingCount: 0 })
    });
    assert.equal(capture.exhausted, false, 'a complete but settled series passes through');

    // THE PLATEAU THAT REPRODUCES IT: a complete payload with twenty-five turns sitting at 15.
    const plateaued = parseModelResponse(completeReply(), {
        messages: conversationFrom([15, 15, ...plateau(25, 15)], { missingCount: 0 })
    });
    assert.equal(plateaued.exhausted, false,
        'a COMPLETE interview with a long plateau is NOT capped, which is the defect');
    assert.equal(plateaued.status, 'asking', 'and it keeps its ordinary asking status');
    assert.equal(/have not been able to record anything new/.test(plateaued.content ?? ''), false,
        'and the participant is NOT told nothing new was recorded');
});

test('two more settling series pass through too, and each is extended to a real plateau', () => {
    // Both are the same shape - evidence high and settling, `missing` at or near zero - and both
    // must pass. As above, each is extended so the plateau genuinely reaches the cap, which is what
    // makes the test exercise the condition.
    const second = parseModelResponse(completeReply(), {
        messages: conversationFrom([12, 13, 15, 13], { missingCount: 2 })
    });
    const third = parseModelResponse(completeReply(), {
        messages: conversationFrom([14, 15, 15, 15, 15], { missingCount: 0 })
    });
    assert.equal(second.exhausted, false, 'the second series is not capped');
    assert.equal(third.exhausted, false, 'the third series is not capped');

    // Both extended to a plateau with `missing` at zero: a complete round cannot be timed out.
    for (const series of [[13, 15, ...plateau(25, 15)], [15, ...plateau(25, 15)]]) {
        const extended = parseModelResponse(completeReply(), {
            messages: conversationFrom(series, { missingCount: 0 })
        });
        assert.equal(extended.exhausted, false, `a complete round with series ${series.length} long is not capped`);
    }
});

test('the trigger REQUIRES `missing` to be non-empty - asserted on the source of the condition', () => {
    // The condition includes `computed.missing.length > 0`, so an interview with every field
    // supplied cannot be closed by a timeout. Asserted structurally because the behavioural tests
    // above depend on this one line.
    const source = fs.readFileSync(path.join(PROJECT_ROOT, 'ai', 'audit-core.js'), 'utf8');
    assert.match(source, /if \(playingTheMatrix && computed\.supplied\.length > 0\s*\n\s*&& computed\.missing\.length > 0\s*\n\s*&& turnsWithoutEvidence\(messages\) >= TURNS_WITHOUT_EVIDENCE_CAP\)/,
        'the cap requires non-empty `missing` as well as supplied fields and the plateau');
});

// ===========================================================================
// 2. A GENUINE STALL STILL FIRES - the condition did not make the cap inert
// ===========================================================================

test('a GENUINE stall still fires: `missing` non-empty with a plateaued series', () => {
    // The other half. The condition must not have made the cap inert, so a real stall - evidence
    // flat for longer than the cap with fields still open - still closes the round.
    const r = parseModelResponse(askingReply(3), {
        messages: conversationFrom(plateau(21, 3), { missingCount: 12 })
    });

    assert.equal(r.exhausted, true, 'a genuine stall is capped');
});

test('a stall at `missing=1` still fires, so the condition is non-empty rather than a large gap', () => {
    // `missing > 0` is the condition, not `missing > some threshold`. One open field is enough for
    // the cap to be allowed to close the round, which is the designer's intent: the placeholder is
    // that there is still work to do.
    const r = parseModelResponse(askingReply(3), {
        messages: conversationFrom(plateau(21, 3), { missingCount: 1 })
    });

    assert.equal(r.exhausted, true, 'a single open field still allows the cap to fire');
});

test('the cap fires after TWENTY turns of plateau and not before', () => {
    // The number itself, pinned. The plateau counts turns AFTER the peak, so a list of twenty
    // assistant turns (peak turn plus nineteen) is not enough and twenty-one is. This is the
    // measured value, so a change to it is a deliberate one.
    const nineteen = parseModelResponse(askingReply(3), {
        messages: conversationFrom(plateau(20, 3), { missingCount: 12 })
    });
    const twenty = parseModelResponse(askingReply(3), {
        messages: conversationFrom(plateau(21, 3), { missingCount: 12 })
    });

    assert.equal(nineteen.exhausted, false, 'twenty turns in the list (peak + 19) does not cap');
    assert.equal(twenty.exhausted, true, 'twenty turns without evidence does');
});

// ===========================================================================
// 3. THE OMITTED-`evidenced` CASES - all five, and the distinction is the point
// ===========================================================================

test('a replayed `evidenced` counts, and the cap fires', () => {
    const r = parseModelResponse(askingReply(3), {
        messages: conversationFrom(plateau(22, 3), { missingCount: 12 })
    });
    assert.equal(r.exhausted, true, 'a replayed series judges normally');
});

test('an EMPTY `evidenced` array counts as no evidence, and the cap fires', () => {
    // `evidenced: []` is present and empty, which is judgeable: nothing has been proven.
    const r = parseModelResponse(askingReply(3), {
        messages: conversationFrom(plateau(22, 0), { missingCount: 12 })
    });
    assert.equal(r.exhausted, true, 'an empty evidenced array counts as no evidence');
});

test('an OMITTED `evidenced` on a SERVER turn counts as no evidence - it does NOT disable the cap', () => {
    // Absence must not SKIP the turn: a client that omits the field would otherwise put every
    // earlier mechanism out of reach and the interview would run forever, silently. Absence of
    // evidence means "cannot judge, use the tightest interpretation" - an empty list - because
    // seeing `missing` proves the server wrote the turn and had an `evidenced` to omit.
    const messages = conversationFrom(plateau(22, 3), { missingCount: 12 });
    for (const turn of messages) delete turn.evidenced; // a client that omits the field

    const r = parseModelResponse(askingReply(3), { messages });
    assert.equal(r.exhausted, true, 'a server turn missing `evidenced` still counts as no evidence');
});

test('`substituted` ALONE also proves a server turn, so an omitted `evidenced` still counts', () => {
    // The rule keys on `missing` OR `substituted`. A turn carrying only `substituted` is still this
    // server's, so its absent `evidenced` is read as empty rather than skipped.
    const messages = conversationFrom(plateau(22, 3), { missingCount: null, substituted: true });
    for (const turn of messages) delete turn.evidenced;

    const r = parseModelResponse(askingReply(3), { messages });
    assert.equal(r.exhausted, true, '`substituted` alone is enough to judge the turn');
});

test('a BARE assistant turn is NOT a server turn, so it stays unjudged', () => {
    // THE DISTINCTION. A hand-built fixture, or a conversation recorded before the field existed,
    // carries neither `missing` nor `substituted`, so nothing proves the server wrote it and its
    // absence proves nothing. It must stay unjudged rather than counting as a stall.
    const messages = Array.from({ length: 30 }, (_, i) => ({ role: 'assistant', content: `bare ${i}` }));

    const r = parseModelResponse(askingReply(3), { messages });
    assert.equal(r.exhausted, false, 'a bare assistant turn does not count toward the cap');
});

test('NO messages at all stays unjudged, so a new interview starts uncapped', () => {
    const r = parseModelResponse(askingReply(3), { messages: [] });
    assert.equal(r.exhausted, false, 'an empty conversation cannot be judged');
});

// ===========================================================================
// 4. THE COUNTER - measured against a peak, on a series that is NOT monotonic
// ===========================================================================

/** The counter, reproduced so its behaviour can be read directly on a series. */
function turnsWithoutEvidence(messages) {
    const counts = [];
    for (const message of messages) {
        if (!message || message.role !== 'assistant') continue;
        if (Array.isArray(message.evidenced)) { counts.push(message.evidenced.length); continue; }
        const fromThisServer = Array.isArray(message.missing) || message.substituted !== undefined;
        if (fromThisServer) counts.push(0);
    }
    if (counts.length === 0) return 0;
    let peak = 0; let since = 0;
    for (const count of counts) {
        if (count > peak) { peak = count; since = 0; } else { since += 1; }
    }
    return since;
}

const seriesMessages = (series) => series.map((length, i) => ({
    role: 'assistant', content: `q${i}`, evidenced: ALL.slice(0, length), missing: ALL.slice(0, 3)
}));

test('a fluent series that falls three times is NOT monotonic', () => {
    // A series that rises overall but FALLS twice is not monotonic: the model rewrites `processes`
    // each turn and drops fields it had filled, so `evidenced` can end a turn below where it
    // started. The counter below assumes a peak rather than a monotonic rise, which is why this
    // property is asserted directly.
    const fluent = [1, 3, 3, 4, 5, 6, 5, 7, 9, 7, 10, 12, 13, 11, 15, 14, 14, 12, 14, 14, 13, 13];

    const falls = fluent.filter((value, i) => i > 0 && value < fluent[i - 1]);
    assert.ok(falls.length > 0, `the series falls, so it is not monotonic (${falls.join(',')})`);
});

test('a series rising overall but below its peak at the end reads as a LONG PLATEAU - the known limitation', () => {
    // WHAT THE COUNTER ACTUALLY DOES, measured rather than assumed. On a series that gains overall
    // but ends below its peak, the counter reports a plateau: at the last turn it reads seven turns
    // without evidence. That is the limitation - a fluctuating series that ends below its peak is
    // read as a stall.
    const fluent = [1, 3, 3, 4, 5, 6, 5, 7, 9, 7, 10, 12, 13, 11, 15, 14, 14, 12, 14, 14, 13, 13];

    const since = turnsWithoutEvidence(seriesMessages(fluent));
    assert.equal(since, 7, 'the counter reads seven turns without evidence at the end of the fluent run');
    assert.ok(since > 0, 'which is the plateau the limitation is about');
});

test('a series FLUCTUATING near its peak is read as an almost total plateau - the limitation, sharpened', () => {
    // THE LIMITATION AT ITS WORST, constructed to make it visible. A series holding steady at
    // thirteen to fifteen fields - plainly not stalled - never exceeds its first value, so the
    // counter reads ALMOST EVERY TURN as without evidence. This is not a defect being fixed; it is
    // the behaviour of a peak-based counter on a non-monotonic series, and it is why the `missing`
    // condition is load-bearing rather than belt-and-braces.
    const fluctuating = [15, 14, 14, 13, 15, 14, 15, 14, 14, 13, 15, 14, 15, 14, 15];

    const since = turnsWithoutEvidence(seriesMessages(fluctuating));
    assert.equal(since, fluctuating.length - 1,
        'a fluctuating near-peak series is read as a plateau on nearly every turn');
    assert.ok(fluctuating.every((v) => v >= 13), 'even though it never drops below thirteen fields');
});

test('a strictly increasing series has no plateau, so a real gain resets the counter', () => {
    const rising = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    assert.equal(turnsWithoutEvidence(seriesMessages(rising)), 0, 'a rising series is never a plateau');
});

// ===========================================================================
// 5. CAN THE CAP STILL CUT OFF WORKING PROGRESS?
// ===========================================================================

/**
 * Runs a conversation gaining one field every `everyTurns` turns, and reports whether the cap cut
 * it off before the payload proved every field.
 */
function slowGain(everyTurns) {
    const messages = [];
    let cappedBeforeFull = null;
    for (let turn = 1; turn <= 600; turn += 1) {
        const proved = Math.min(ALL.length, Math.ceil(turn / everyTurns));
        const r = parseModelResponse(askingReply(proved), { messages });
        if (r.exhausted) {
            if (matrix.reconcileMatrix({ processes: [payloadProving(proved)] }).evidenced.length < ALL.length) {
                cappedBeforeFull = turn;
            }
            return { cappedBeforeFull, maxProved: proved };
        }
        messages.push({
            role: 'assistant', content: `q${turn}`,
            evidenced: r.evidenced ?? [], missing: r.missing ?? [], substituted: false
        });
    }
    return { cappedBeforeFull: null, maxProved: ALL.length };
}

test('a run gaining a field every turn is never cut off before it completes', () => {
    const { cappedBeforeFull } = slowGain(1);
    assert.equal(cappedBeforeFull, null, 'a fast gain completes without being capped');
});

test('a run gaining a field every 5, 10 or 19 turns still completes - the cap clears the real plateau', () => {
    // Each rate is checked with its own fixture; at every one the cap clears a real gain.
    for (const everyTurns of [2, 5, 10, 19]) {
        const { cappedBeforeFull } = slowGain(everyTurns);
        assert.equal(cappedBeforeFull, null, `a run gaining every ${everyTurns} turns is not capped`);
    }
});

test('FINDING: a run gaining every 21+ turns IS cut off - the boundary is the cap itself', () => {
    // WHERE THE CAP STILL CUTS WORKING PROGRESS, and it is not a defect: a gain slower than the cap
    // interval is indistinguishable from a stall by a peak-based counter, so it is capped. The
    // boundary is exact - 20 turns clears it and 21 does not - which is what makes the number
    // meaningful. Recorded so the boundary is known rather than discovered live.
    const ok = slowGain(20);
    const cut = slowGain(21);

    assert.equal(ok.cappedBeforeFull, null, 'a gain within the cap interval completes');
    assert.notEqual(cut.cappedBeforeFull, null, 'FINDING: a gain slower than the cap interval is cut off');
});

// ===========================================================================
// 6. THE HOLE: A TURN CARRYING NEITHER `missing` NOR `substituted`
// ===========================================================================

test('FINDING: a turn carrying NEITHER `missing` NOR `substituted` is still unjudgeable', () => {
    // THE GAP THE RULE LEAVES OPEN. The omitted-`evidenced` rule keys on `missing` being an array
    // or `substituted` being present. A turn carrying NEITHER is read as a bare assistant turn and
    // SKIPPED, so a client that replays turns with only `content` still disables the cap - the same
    // silence, through the remaining door.
    //
    // IT IS NOT REACHABLE THROUGH THIS CLIENT: `public/js/audit.js` always pushes `substituted` and
    // `missing` (as `false` and `[]` when the server omits them) and returns early on `error` and
    // `rejected`, so every turn it replays proves its origin. The gap is reachable only by a client
    // that constructs turns by hand - which is exactly the case the rule intends to leave unjudged,
    // so this is a bounded, understood trade rather than an oversight. Recorded as the residual.
    const messages = Array.from({ length: 30 }, (_, i) => ({ role: 'assistant', content: `q${i}`, evidenced: undefined }));
    for (const turn of messages) delete turn.evidenced;

    const r = parseModelResponse(askingReply(3), { messages });
    assert.equal(r.exhausted, false,
        'FINDING: turns with neither `missing` nor `substituted` are skipped, so the cap stays disabled for that client');
});

test('the real client always replays `missing` and `substituted`, so that door is closed in the app', () => {
    // The evidence that the finding above is bounded: the shipped client pushes both fields on
    // every assistant turn and returns before the push on error and rejected. So no turn it sends
    // can carry neither, and the cap cannot be silenced through this client.
    const client = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'js', 'audit.js'), 'utf8');

    assert.match(client, /state\.conversation\.push\(\{[\s\S]{0,200}?substituted: data\.substituted === true/,
        'every replayed assistant turn carries `substituted`');
    assert.match(client, /missing: Array\.isArray\(data\.missing\) \? data\.missing : \[\]/,
        'and `missing`, defaulting to an empty array');
    // The early return on error/rejected, before the push, so those never enter the conversation.
    assert.match(client, /if \(data\.status === 'error' \|\| data\.status === 'rejected'\) \{[\s\S]{0,200}?return;/,
        'and error/rejected turns are returned before the push');
});
