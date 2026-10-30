/**
 * The churning-claim fixture and the three-way list distinction.
 *
 * Mid-interview, `missing` is built partly from the model's own `have` CLAIM. A model reshuffling
 * which fields it claims makes `missing` fall while NOTHING is recorded - `have + missing` staying
 * at fifteen - and every fall is read as the participant answering.
 *
 * Three lists that are not the same: `missing` (claimed open), `supplied` (claimed answered, STILL
 * A CLAIM) and `evidenced` (what the PAYLOAD PROVES). `supplied` does NOT fix it: it believes the
 * claim too, so it churns with `missing`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');

const { parseModelResponse } = await import('../ai/audit-core.js');
const matrix = await import('../ai/matrix.js');

const ALL = matrix.ALL_PROCESS_FIELD_NAMES;

/**
 * The fields the model CLAIMS to hold move with `turn`, while `have + missing` stays at fifteen.
 * `K` moves 3..10 and wraps, so a guard reading it sees "progress" constantly.
 */
export function claims(turn) {
    const K = 3 + (turn % 8);
    return { have: ALL.slice(0, K), missing: ALL.slice(K) };
}

/**
 * A constant set of proven fields: only the first three are typed, whatever the claim says.
 */
function constantPayload() {
    const values = {};
    for (const field of ALL.slice(0, 3)) {
        values[field] = field === 'steps'
            ? [Object.fromEntries(matrix.STEP_FIELDS.map((f) => [f, f === 'needsReasoning' ? false : 'v']))]
            : 'v';
    }
    return values;
}

function churnReply(content, turn) {
    const c = claims(turn);
    return JSON.stringify({ status: 'asking', content, processes: [constantPayload()], have: c.have, missing: c.missing });
}

/**
 * Runs a churning conversation; returns the turn it ended on (or null) and the replies. `rate`
 * compresses the turn index: at rate 0 the churn changes every turn.
 */
function runChurn({ rate = 0, maxTurns = 200, sentence = 'How do you keep track of it?' } = {}) {
    const conversation = [];
    const replies = [];
    let incoming = sentence;
    for (let turn = 1; turn <= maxTurns; turn += 1) {
        const churnTurn = rate === 0 ? turn : Math.floor(turn / rate);
        const askedBefore = conversation.map((entry) => ({
            text: entry.content, openCount: entry.missing.length,
            evidencedCount: entry.evidenced, substituted: entry.substituted === true
        }));
        const r = parseModelResponse(churnReply(incoming, churnTurn), { askedBefore });
        conversation.push({ content: r.content, missing: r.missing, evidenced: r.evidenced.length, substituted: r.substituted === true });
        replies.push(r.content);
        if (r.exhausted) return { endedAt: turn, replies };
        incoming = r.content;
    }
    return { endedAt: null, replies };
}

function maxRun(replies) {
    let best = 0; let current = 1;
    for (let i = 1; i < replies.length; i += 1) {
        if (replies[i] === replies[i - 1]) { current += 1; best = Math.max(best, current); } else current = 1;
    }
    return best;
}

test('the fixture reproduces the signature: the claim moves while have + missing stays at fifteen', () => {
    const counts = [];
    for (let turn = 1; turn <= 12; turn += 1) {
        const c = claims(turn);
        assert.equal(c.have.length + c.missing.length, ALL.length, `have + missing is fifteen on turn ${turn}`);
        counts.push(c.have.length);
    }
    assert.ok(new Set(counts).size > 1, `the claimed-hold count moves (saw ${[...new Set(counts)].join(',')})`);
});

test('the three lists on a CHURNING model: only `evidenced` holds still', () => {
    // `supplied` MOVING IS THE POINT: reading `supplied` instead of `missing` does not work.
    const missingCounts = [];
    const suppliedCounts = [];
    const evidencedCounts = [];
    for (let turn = 1; turn <= 10; turn += 1) {
        const c = claims(turn);
        const r = matrix.reconcileMatrix({ processes: [constantPayload()], claimedHave: c.have, claimedMissing: c.missing });
        missingCounts.push(r.missing.length);
        suppliedCounts.push(r.supplied.length);
        evidencedCounts.push(r.evidenced.length);
    }

    assert.ok(new Set(missingCounts).size > 1, `\`missing\` moves with the claim (${missingCounts.join(',')})`);
    assert.ok(new Set(suppliedCounts).size > 1, `\`supplied\` ALSO moves with the claim (${suppliedCounts.join(',')})`);
    assert.equal(new Set(evidencedCounts).size, 1, `\`evidenced\` is constant (${evidencedCounts.join(',')})`);
    assert.equal(evidencedCounts[0], 3, 'and it is the three fields the payload actually proves');
});

test('a CHURNING model TERMINATES, bounded, where a guard that reads the claim would not', () => {
    const { endedAt, replies } = runChurn({ rate: 0 });

    assert.notEqual(endedAt, null, 'the churning conversation terminates');
    assert.ok(endedAt <= 30, `and it is bounded (ended at turn ${endedAt})`);
    assert.ok(maxRun(replies) <= 2, `with at most a short run of the same sentence (got ${maxRun(replies)})`);
});

test('five churn rates all terminate, none running away', () => {
    for (const rate of [0, 1, 2, 3, 5, 7, 8]) {
        const { endedAt, replies } = runChurn({ rate });
        assert.notEqual(endedAt, null, `churn rate ${rate} terminates`);
        assert.ok(endedAt <= 40, `churn rate ${rate} is bounded (ended at ${endedAt})`);
        assert.ok(maxRun(replies) <= 4, `churn rate ${rate} does not stall (max run ${maxRun(replies)})`);
    }
});

test('a guard that reads the claim alone STALLS on this fixture - so the fixture has teeth', () => {
    // A FIXTURE THAT PASSES AGAINST UNGUARDED CODE PROVES NOTHING: forced to read the CLAIM, the
    // conversation runs far longer with long runs of one sentence.
    const simulate = (claimOnly) => {
        const conversation = [];
        const replies = [];
        let incoming = 'How do you keep track of it?';
        for (let turn = 1; turn <= 200; turn += 1) {
            const askedBefore = conversation.map((entry) => ({
                text: entry.content,
                ...(claimOnly ? {} : { evidencedCount: entry.evidenced }),
                openCount: entry.missing.length, substituted: entry.substituted === true
            }));
            const r = parseModelResponse(churnReply(incoming, turn), { askedBefore });
            conversation.push({ content: r.content, missing: r.missing, evidenced: r.evidenced.length, substituted: r.substituted === true });
            replies.push(r.content);
            if (r.exhausted) return { endedAt: turn, replies };
            incoming = r.content;
        }
        return { endedAt: null, replies };
    };

    const fixed = simulate(false);
    const claimOnly = simulate(true);

    assert.notEqual(fixed.endedAt, null, 'the fixed guard terminates');
    // Dramatically longer, which is the stall - not infinite here, since the claim cycles through
    // eight values.
    assert.ok(claimOnly.endedAt > fixed.endedAt * 3,
        `the claim-reading guard runs many times longer (fixed ${fixed.endedAt}, claim ${claimOnly.endedAt})`);
    assert.ok(maxRun(claimOnly.replies) >= 5,
        `and it stalls with a long run of one sentence (got ${maxRun(claimOnly.replies)})`);
    assert.ok(maxRun(claimOnly.replies) > maxRun(fixed.replies),
        'while the fixed guard produces a shorter run');
});

test('EVIDENCE IS AUTHORITATIVE: a churning claim gains nothing from a fallen `missing`', () => {
    // When evidence data is present it decides: twelve "open" fields against a constant payload
    // gets no progress credit.
    const partial = { task: 't', trigger: 'tr', steps: [{ name: 's', whatHappens: 'w', decidedHow: 'd', needsReasoning: false }], frequencyPerWeek: 2 };
    const raw = (c) => JSON.stringify({ status: 'asking', content: c, processes: [partial], have: [], missing: [] });
    const q = 'What systems do you use?';
    const current = matrix.reconcileMatrix({ processes: [partial] }).evidenced.length;

    const r = parseModelResponse(raw(q), {
        askedBefore: [{ text: q, openCount: 12, evidencedCount: current, substituted: false }]
    });
    assert.notEqual(r.content, q, 'the repeat is substituted, because the EVIDENCE has not grown');
});

test('the FALLBACK prevents a wall: an old-shape caller with a fallen `missing` passes', () => {
    // A conversation recorded before `evidenced` existed carries only `openCount`; with no evidence
    // to judge from, the claim-based check applies.
    const partial = { task: 't', trigger: 'tr', steps: [{ name: 's', whatHappens: 'w', decidedHow: 'd', needsReasoning: false }], frequencyPerWeek: 2 };
    const raw = (c) => JSON.stringify({ status: 'asking', content: c, processes: [partial], have: [], missing: [] });
    const q = 'What systems do you use?';

    const r = parseModelResponse(raw(q), { askedBefore: [{ text: q, openCount: 12, substituted: false }] });
    assert.equal(r.content, q, 'the repeat passes, because the fallback reads the claim and sees progress');
});

test('REAL evidence progress passes, so the guard is not a wall for a healthy interview', () => {
    const partial = { task: 't', trigger: 'tr', steps: [{ name: 's', whatHappens: 'w', decidedHow: 'd', needsReasoning: false }], frequencyPerWeek: 2 };
    const raw = (c) => JSON.stringify({ status: 'asking', content: c, processes: [partial], have: [], missing: [] });
    const q = 'What systems do you use?';
    const current = matrix.reconcileMatrix({ processes: [partial] }).evidenced.length;

    const r = parseModelResponse(raw(q), {
        askedBefore: [{ text: q, openCount: 12, evidencedCount: current - 1, substituted: false }]
    });
    assert.equal(r.content, q, 'a repeat with real evidence progress passes through');
});

test('the reply carries `evidenced` forward, so the next turn can compare against it', () => {
    // Without it every repeat falls to the claim-based path.
    const partial = { task: 't', trigger: 'tr', steps: [{ name: 's', whatHappens: 'w', decidedHow: 'd', needsReasoning: false }], frequencyPerWeek: 2 };
    const r = parseModelResponse(JSON.stringify({
        status: 'asking', content: 'Who else is involved in this?', processes: [partial], have: [], missing: []
    }), { askedBefore: [] });

    assert.ok(Array.isArray(r.evidenced), 'the reply carries an `evidenced` array');
    assert.deepEqual(r.evidenced, ['task', 'trigger', 'steps', 'frequencyPerWeek', 'timePerPeriod'],
        'and it is the payload-proven fields, not the claim');
});

test('the residual stall of requiring all fifteen: twelve asked, then stuck', () => {
    // A field the model CLAIMS is never offered, so requiring ALL fifteen questions means
    // exhaustion never fires.
    const { endedAt, replies } = runChurn({ rate: 0 });

    assert.notEqual(endedAt, null, 'the round ends rather than looping on the move-on line');
    const asked = new Set(replies);
    assert.ok(asked.size < ALL.length, `fewer than fifteen questions were asked (asked ${asked.size})`);
});

test('a REPEATED question with one field open always exhausts - the relaxation is not a loophole', () => {
    // The relaxation must not let a single stuck field keep the interview alive.
    const conversation = [];
    let endedAt = null;
    for (let i = 1; i <= 60; i += 1) {
        const r = turnWithChurn('How is this done today, overall?', conversation, i);
        conversation.push(r);
        if (r.exhausted) { endedAt = i; break; }
    }
    assert.notEqual(endedAt, null, 'a repeated question ends the round');
});

function turnWithChurn(content, conversation, turn) {
    const askedBefore = conversation.map((entry) => ({
        text: entry.content, openCount: entry.missing.length,
        evidencedCount: entry.evidenced, substituted: entry.substituted === true
    }));
    const r = parseModelResponse(churnReply(content, turn), { askedBefore });
    return { content: r.content, missing: r.missing, evidenced: r.evidenced.length, substituted: r.substituted === true, exhausted: r.exhausted === true };
}

test('FINDING: a model that REWORDS its question each turn is never caught - the next mechanism', () => {
    // THE ATTACK, and it succeeds: a reworded question is never a match target, so the guard never
    // fires. RECORDED AS TODAY'S BEHAVIOUR; fixing it needs a similarity test or a turn cap.
    const conversation = [];
    let endedAt = null;
    for (let turn = 1; turn <= 100; turn += 1) {
        const reworded = `Who else is involved in this? (${turn})`;
        const entry = turnWithChurn(reworded, conversation, turn);
        conversation.push(entry);
        if (entry.exhausted) { endedAt = turn; break; }
    }

    assert.equal(endedAt, null, 'FINDING: a reworded question never triggers exhaustion');
    assert.equal(conversation.length, 100, 'FINDING: so the interview runs indefinitely');
});

test('FINDING: the reworded attack also defeats the evidence check, because no repeat is seen', () => {
    // The guard only gets the chance on a REPEAT, and unique text is never a repeat.
    const conversation = [];
    for (let turn = 1; turn <= 30; turn += 1) {
        const entry = turnWithChurn(`What about the mail on day ${turn}?`, conversation, turn);
        conversation.push(entry);
        assert.equal(entry.evidenced, 3, `evidence stays at three on turn ${turn}`);
        assert.equal(entry.substituted, false, 'and the reply is never marked as the gate\'s, because nothing matched');
    }
    assert.equal(conversation.length, 30, 'FINDING: thirty novel questions, none intercepted');
});
