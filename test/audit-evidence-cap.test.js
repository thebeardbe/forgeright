/**
 * The evidence cap: its trigger condition, its counter, and what it does to a stalled round.
 *
 * THE COUNTER IS NOT MONOTONIC: the model rewrites `processes` each turn and drops fields it had
 * filled, so a peak-based counter reads a fluctuating series as a long plateau. A KNOWN, UNFIXED
 * limitation, tested as what it does rather than as what it ought to do.
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
 * A payload proving exactly the first `n` fields, ordered so each field added raises `evidenced`:
 * the naive `ALL.slice(0, n)` types fields whose shapes do not count.
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

const completeReply = (content = 'Anything else?') => JSON.stringify({
    status: 'asking', content, processes: [payloadProving(ALL.length)], have: [], missing: []
});

/**
 * Assistant turns carrying an `evidenced` length series. `missingCount` and `substituted` make each
 * look like one this server wrote, which the omitted-`evidenced` rule keys on.
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

const plateau = (n, length) => new Array(n).fill(length);

test('the evidence order is sound: a payload proving `n` fields has `evidenced` of `n` or more', () => {
    // NOT strictly +1: the effort pair counts as TWO names, so 13 jumps to 15.
    const values = [];
    for (let n = 1; n <= EVIDENCE_ORDER.length; n += 1) {
        const evidenced = matrix.reconcileMatrix({ processes: [payloadProving(n)] }).evidenced.length;
        assert.ok(evidenced >= n, `proving ${n} fields gives at least ${n} evidenced (got ${evidenced})`);
        values.push(evidenced);
    }
    assert.equal(values[values.length - 1], ALL.length, 'and the full payload proves every field');
    for (let i = 1; i < values.length; i += 1) {
        assert.ok(values[i] >= values[i - 1], `step ${i + 1} does not fall (${values.join(',')})`);
    }
});

test('a COMPLETE payload with a plateaued series is NOT capped', () => {
    // `14,14,13,15,15,15` is only two turns without evidence, far below the cap of twenty, so it
    // passes whether or not the `missing > 0` condition exists. Extended to a real plateau below.
    const capture = parseModelResponse(completeReply(), {
        messages: conversationFrom([14, 14, 13, 15, 15, 15], { missingCount: 0 })
    });
    assert.equal(capture.exhausted, false, 'a complete but settled series passes through');

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
    const second = parseModelResponse(completeReply(), {
        messages: conversationFrom([12, 13, 15, 13], { missingCount: 2 })
    });
    const third = parseModelResponse(completeReply(), {
        messages: conversationFrom([14, 15, 15, 15, 15], { missingCount: 0 })
    });
    assert.equal(second.exhausted, false, 'the second series is not capped');
    assert.equal(third.exhausted, false, 'the third series is not capped');

    for (const series of [[13, 15, ...plateau(25, 15)], [15, ...plateau(25, 15)]]) {
        const extended = parseModelResponse(completeReply(), {
            messages: conversationFrom(series, { missingCount: 0 })
        });
        assert.equal(extended.exhausted, false, `a complete round with series ${series.length} long is not capped`);
    }
});

test('the trigger REQUIRES `missing` to be non-empty - asserted on the source of the condition', () => {
    const source = fs.readFileSync(path.join(PROJECT_ROOT, 'ai', 'audit-core.js'), 'utf8');
    assert.match(source, /if \(playingTheMatrix && computed\.supplied\.length > 0\s*\n\s*&& computed\.missing\.length > 0\s*\n\s*&& turnsWithoutEvidence\(messages\) >= TURNS_WITHOUT_EVIDENCE_CAP\)/,
        'the cap requires non-empty `missing` as well as supplied fields and the plateau');
});

test('a GENUINE stall still fires: `missing` non-empty with a plateaued series', () => {
    const r = parseModelResponse(askingReply(3), {
        messages: conversationFrom(plateau(21, 3), { missingCount: 12 })
    });

    assert.equal(r.exhausted, true, 'a genuine stall is capped');
});

test('a stall at `missing=1` still fires, so the condition is non-empty rather than a large gap', () => {
    const r = parseModelResponse(askingReply(3), {
        messages: conversationFrom(plateau(21, 3), { missingCount: 1 })
    });

    assert.equal(r.exhausted, true, 'a single open field still allows the cap to fire');
});

test('the cap fires after TWENTY turns of plateau and not before', () => {
    // The plateau counts turns AFTER the peak: twenty is not enough, twenty-one is.
    const nineteen = parseModelResponse(askingReply(3), {
        messages: conversationFrom(plateau(20, 3), { missingCount: 12 })
    });
    const twenty = parseModelResponse(askingReply(3), {
        messages: conversationFrom(plateau(21, 3), { missingCount: 12 })
    });

    assert.equal(nineteen.exhausted, false, 'twenty turns in the list (peak + 19) does not cap');
    assert.equal(twenty.exhausted, true, 'twenty turns without evidence does');
});

test('a replayed `evidenced` counts, and the cap fires', () => {
    const r = parseModelResponse(askingReply(3), {
        messages: conversationFrom(plateau(22, 3), { missingCount: 12 })
    });
    assert.equal(r.exhausted, true, 'a replayed series judges normally');
});

test('an EMPTY `evidenced` array counts as no evidence, and the cap fires', () => {
    const r = parseModelResponse(askingReply(3), {
        messages: conversationFrom(plateau(22, 0), { missingCount: 12 })
    });
    assert.equal(r.exhausted, true, 'an empty evidenced array counts as no evidence');
});

test('an OMITTED `evidenced` on a SERVER turn counts as no evidence - it does NOT disable the cap', () => {
    // `missing` proves the server wrote the turn, so absence reads as an empty list.
    const messages = conversationFrom(plateau(22, 3), { missingCount: 12 });
    for (const turn of messages) delete turn.evidenced; // a client that omits the field

    const r = parseModelResponse(askingReply(3), { messages });
    assert.equal(r.exhausted, true, 'a server turn missing `evidenced` still counts as no evidence');
});

test('`substituted` ALONE also proves a server turn, so an omitted `evidenced` still counts', () => {
    const messages = conversationFrom(plateau(22, 3), { missingCount: null, substituted: true });
    for (const turn of messages) delete turn.evidenced;

    const r = parseModelResponse(askingReply(3), { messages });
    assert.equal(r.exhausted, true, '`substituted` alone is enough to judge the turn');
});

test('a BARE assistant turn is NOT a server turn, so it stays unjudged', () => {
    const messages = Array.from({ length: 30 }, (_, i) => ({ role: 'assistant', content: `bare ${i}` }));

    const r = parseModelResponse(askingReply(3), { messages });
    assert.equal(r.exhausted, false, 'a bare assistant turn does not count toward the cap');
});

test('NO messages at all stays unjudged, so a new interview starts uncapped', () => {
    const r = parseModelResponse(askingReply(3), { messages: [] });
    assert.equal(r.exhausted, false, 'an empty conversation cannot be judged');
});

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
    // `evidenced` can end a turn below where it started: the counter assumes a peak.
    const fluent = [1, 3, 3, 4, 5, 6, 5, 7, 9, 7, 10, 12, 13, 11, 15, 14, 14, 12, 14, 14, 13, 13];

    const falls = fluent.filter((value, i) => i > 0 && value < fluent[i - 1]);
    assert.ok(falls.length > 0, `the series falls, so it is not monotonic (${falls.join(',')})`);
});

test('a series rising overall but below its peak at the end reads as a LONG PLATEAU - the known limitation', () => {
    const fluent = [1, 3, 3, 4, 5, 6, 5, 7, 9, 7, 10, 12, 13, 11, 15, 14, 14, 12, 14, 14, 13, 13];

    const since = turnsWithoutEvidence(seriesMessages(fluent));
    assert.equal(since, 7, 'the counter reads seven turns without evidence at the end of the fluent run');
    assert.ok(since > 0, 'which is the plateau the limitation is about');
});

test('a series FLUCTUATING near its peak is read as an almost total plateau - the limitation, sharpened', () => {
    // Holding at thirteen to fifteen fields never exceeds the first value, so the counter reads
    // ALMOST EVERY TURN as without evidence.
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

/**
 * Gains one field every `everyTurns` turns; reports whether the cap cut it off before the payload
 * proved every field.
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
    for (const everyTurns of [2, 5, 10, 19]) {
        const { cappedBeforeFull } = slowGain(everyTurns);
        assert.equal(cappedBeforeFull, null, `a run gaining every ${everyTurns} turns is not capped`);
    }
});

test('FINDING: a run gaining every 21+ turns IS cut off - the boundary is the cap itself', () => {
    // A gain slower than the cap interval is indistinguishable from a stall: 20 turns clears it,
    // 21 does not.
    const ok = slowGain(20);
    const cut = slowGain(21);

    assert.equal(ok.cappedBeforeFull, null, 'a gain within the cap interval completes');
    assert.notEqual(cut.cappedBeforeFull, null, 'FINDING: a gain slower than the cap interval is cut off');
});

test('FINDING: a turn carrying NEITHER `missing` NOR `substituted` is still unjudgeable', () => {
    // A turn carrying NEITHER field is SKIPPED, disabling the cap. NOT reachable through the
    // shipped client, which always pushes both - a bounded, understood trade.
    const messages = Array.from({ length: 30 }, (_, i) => ({ role: 'assistant', content: `q${i}`, evidenced: undefined }));
    for (const turn of messages) delete turn.evidenced;

    const r = parseModelResponse(askingReply(3), { messages });
    assert.equal(r.exhausted, false,
        'FINDING: turns with neither `missing` nor `substituted` are skipped, so the cap stays disabled for that client');
});

test('the real client always replays `missing` and `substituted`, so that door is closed in the app', () => {
    const client = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'js', 'audit.js'), 'utf8');

    assert.match(client, /state\.conversation\.push\(\{[\s\S]{0,200}?substituted: data\.substituted === true/,
        'every replayed assistant turn carries `substituted`');
    assert.match(client, /missing: Array\.isArray\(data\.missing\) \? data\.missing : \[\]/,
        'and `missing`, defaulting to an empty array');
    assert.match(client, /if \(data\.status === 'error' \|\| data\.status === 'rejected'\) \{[\s\S]{0,200}?return;/,
        'and error/rejected turns are returned before the push');
});
