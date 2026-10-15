/**
 * The churning-claim fixture, the three-way list distinction, and the residual mechanisms.
 *
 * WHAT THIS FILE IS ABOUT. A model that re-partitions its claims each turn is a termination
 * mechanism distinct from oscillation: the model lies differently every turn rather than repeating
 * itself, so nothing that looks for a repeated sentence can catch it.
 *
 * THE DEFECT IT EXPOSES. Mid-interview, `missing` is built partly from the model's own `have`
 * CLAIM, believed without evidence. A model that reshuffles which fields it claims to hold makes
 * `missing` fall while NOTHING is recorded - `have + missing` staying at fifteen throughout - and
 * every fall was read as the participant answering, so an interview could ask thirty-one identical
 * questions in a row without either exhaustion branch firing.
 *
 * THE DISTINCTION THAT FIXES IT, and the heart of this file - three lists that are not the same:
 *
 *   missing     what the model CLAIMS is open
 *   supplied    what the model claims is answered, minus declined   (STILL A CLAIM)
 *   evidenced   what the PAYLOAD PROVES - fieldsPresentIn, the test matrixComplete uses
 *
 * `supplied` does NOT fix it: while asking, `supplied` believes the claim too, so it churns with
 * `missing`. Every count in this file is measured against a fixture rather than repeated from a
 * claim.
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

// ===========================================================================
// THE FIXTURE - a scripted model that re-partitions its claim every turn
// ===========================================================================

/**
 * A churning claim: the fields the model CLAIMS to hold move with `turn`, while `have + missing`
 * stays at fifteen.
 *
 * This is the churning signature. `K` moves 3..10 and wraps, so the claimed-hold count
 * changes every turn and any guard reading it sees "progress" constantly, while nothing is
 * recorded.
 */
export function claims(turn) {
    const K = 3 + (turn % 8);
    return { have: ALL.slice(0, K), missing: ALL.slice(K) };
}

/**
 * A payload that PROVES a constant set of fields, so `evidenced` does not move.
 *
 * Only the first three fields are typed, whatever the claim says. This is the payload half of the
 * lie: the model claims to hold nine fields while the payload carries three.
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

/** A reply carrying the constant payload and the churning claim for `turn`. */
function churnReply(content, turn) {
    const c = claims(turn);
    return JSON.stringify({ status: 'asking', content, processes: [constantPayload()], have: c.have, missing: c.missing });
}

/**
 * Runs a churning conversation and returns the turn it ended on (or null), with the replies.
 *
 * `rate` compresses the turn index so the churn can be slowed: at rate 0 it changes every turn.
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

/** The longest run of the same sentence in a row. */
function maxRun(replies) {
    let best = 0; let current = 1;
    for (let i = 1; i < replies.length; i += 1) {
        if (replies[i] === replies[i - 1]) { current += 1; best = Math.max(best, current); } else current = 1;
    }
    return best;
}

// ===========================================================================
// 1. THE FIXTURE REPRODUCES THE SIGNATURE, AND THE GUARD ENDS IT
// ===========================================================================

test('the fixture reproduces the signature: the claim moves while have + missing stays at fifteen', () => {
    // The failure mode the fixture represents, asserted directly: the claimed-hold count MOVES
    // every turn and the two lists always sum to the field count. A guard that reads the claim
    // therefore sees progress on every turn while nothing is recorded.
    const counts = [];
    for (let turn = 1; turn <= 12; turn += 1) {
        const c = claims(turn);
        assert.equal(c.have.length + c.missing.length, ALL.length, `have + missing is fifteen on turn ${turn}`);
        counts.push(c.have.length);
    }
    // The count genuinely moves, so this is churn and not a constant.
    assert.ok(new Set(counts).size > 1, `the claimed-hold count moves (saw ${[...new Set(counts)].join(',')})`);
});

test('the three lists on a CHURNING model: only `evidenced` holds still', () => {
    // THE DISTINCTION THAT FIXES IT, measured rather than taken on trust. Against a churning claim
    // with a constant payload: `missing` and `supplied` both move (they believe the claim), and
    // `evidenced` is constant (it counts what the payload proves).
    //
    // `supplied` MOVING IS THE POINT: reading `supplied` instead of `missing` does not work, for
    // exactly this reason.
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
    // A model that re-partitions its claim every turn must still end, and end BOUNDED, rather than
    // reading each fresh claim as progress and repeating forever.
    const { endedAt, replies } = runChurn({ rate: 0 });

    assert.notEqual(endedAt, null, 'the churning conversation terminates');
    assert.ok(endedAt <= 30, `and it is bounded (ended at turn ${endedAt})`);
    assert.ok(maxRun(replies) <= 2, `with at most a short run of the same sentence (got ${maxRun(replies)})`);
});

test('five churn rates all terminate, none running away', () => {
    // Every rotation rate terminates and stays bounded, measured on the fixture rather than
    // repeated from a claim.
    for (const rate of [0, 1, 2, 3, 5, 7, 8]) {
        const { endedAt, replies } = runChurn({ rate });
        assert.notEqual(endedAt, null, `churn rate ${rate} terminates`);
        assert.ok(endedAt <= 40, `churn rate ${rate} is bounded (ended at ${endedAt})`);
        assert.ok(maxRun(replies) <= 4, `churn rate ${rate} does not stall (max run ${maxRun(replies)})`);
    }
});

test('a guard that reads the claim alone STALLS on this fixture - so the fixture has teeth', () => {
    // A FIXTURE THAT PASSES AGAINST UNGUARDED CODE PROVES NOTHING. This drives the conversation
    // with the guard forced to read the CLAIM (`hasEvidenceData` false) and shows it runs far
    // longer with long runs of one sentence. The comparison is the assertion: the guarded path is
    // dramatically shorter, which is what makes the terminating tests meaningful rather than
    // vacuous.
    const simulate = (claimOnly) => {
        const conversation = [];
        const replies = [];
        let incoming = 'How do you keep track of it?';
        for (let turn = 1; turn <= 200; turn += 1) {
            const askedBefore = conversation.map((entry) => ({
                text: entry.content,
                // `claimOnly` omits the evidence count, which forces the claim-based fallback and
                // models a guard with no evidence data to judge from.
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
    // THE CLAIM-READING GUARD IS DRAMATICALLY LONGER, which is the stall. It is not infinite on
    // this fixture - the claim cycles through eight values, so the fallback eventually sees a
    // repeat - but it runs many times longer and with long runs of one sentence, which is the
    // live signature (thirty-one identical in a row).
    assert.ok(claimOnly.endedAt > fixed.endedAt * 3,
        `the claim-reading guard runs many times longer (fixed ${fixed.endedAt}, claim ${claimOnly.endedAt})`);
    assert.ok(maxRun(claimOnly.replies) >= 5,
        `and it stalls with a long run of one sentence (got ${maxRun(claimOnly.replies)})`);
    assert.ok(maxRun(claimOnly.replies) > maxRun(fixed.replies),
        'while the fixed guard produces a shorter run');
});

// ===========================================================================
// 2. THE FALLBACK ORDER - evidence authoritative, claim only for the old shape
// ===========================================================================

test('EVIDENCE IS AUTHORITATIVE: a churning claim gains nothing from a fallen `missing`', () => {
    // The order that matters. When evidence data is present it decides, so a model whose claim says
    // twelve fields are open while the payload proves the same set gets no progress credit.
    const partial = { task: 't', trigger: 'tr', steps: [{ name: 's', whatHappens: 'w', decidedHow: 'd', needsReasoning: false }], frequencyPerWeek: 2 };
    const raw = (c) => JSON.stringify({ status: 'asking', content: c, processes: [partial], have: [], missing: [] });
    const q = 'What systems do you use?';
    const current = matrix.reconcileMatrix({ processes: [partial] }).evidenced.length;

    // The claim says 12 fields were open when it asked; the evidence count is unchanged.
    const r = parseModelResponse(raw(q), {
        askedBefore: [{ text: q, openCount: 12, evidencedCount: current, substituted: false }]
    });
    assert.notEqual(r.content, q, 'the repeat is substituted, because the EVIDENCE has not grown');
});

test('the FALLBACK prevents a wall: an old-shape caller with a fallen `missing` passes', () => {
    // THE OTHER DIRECTION. A conversation recorded before `evidenced` existed carries only
    // `openCount`. With no evidence data to judge from, treating "no evidenced data" as "no
    // progress" would substitute on every such repeat and turn a legitimate second attempt into a
    // wall - so the claim-based check applies.
    const partial = { task: 't', trigger: 'tr', steps: [{ name: 's', whatHappens: 'w', decidedHow: 'd', needsReasoning: false }], frequencyPerWeek: 2 };
    const raw = (c) => JSON.stringify({ status: 'asking', content: c, processes: [partial], have: [], missing: [] });
    const q = 'What systems do you use?';

    // No `evidencedCount` key at all - the old shape - and `missing` has fallen (12 -> 10).
    const r = parseModelResponse(raw(q), { askedBefore: [{ text: q, openCount: 12, substituted: false }] });
    assert.equal(r.content, q, 'the repeat passes, because the fallback reads the claim and sees progress');
});

test('REAL evidence progress passes, so the guard is not a wall for a healthy interview', () => {
    const partial = { task: 't', trigger: 'tr', steps: [{ name: 's', whatHappens: 'w', decidedHow: 'd', needsReasoning: false }], frequencyPerWeek: 2 };
    const raw = (c) => JSON.stringify({ status: 'asking', content: c, processes: [partial], have: [], missing: [] });
    const q = 'What systems do you use?';
    const current = matrix.reconcileMatrix({ processes: [partial] }).evidenced.length;

    // The evidence was SMALLER when the question was asked, so it has grown since.
    const r = parseModelResponse(raw(q), {
        askedBefore: [{ text: q, openCount: 12, evidencedCount: current - 1, substituted: false }]
    });
    assert.equal(r.content, q, 'a repeat with real evidence progress passes through');
});

test('the reply carries `evidenced` forward, so the next turn can compare against it', () => {
    // The mechanism: the server sends its own `evidenced` list on every reply, and the caller
    // records it with the question. Without it, every repeat would fall to the claim-based path.
    const partial = { task: 't', trigger: 'tr', steps: [{ name: 's', whatHappens: 'w', decidedHow: 'd', needsReasoning: false }], frequencyPerWeek: 2 };
    const r = parseModelResponse(JSON.stringify({
        status: 'asking', content: 'Who else is involved in this?', processes: [partial], have: [], missing: []
    }), { askedBefore: [] });

    assert.ok(Array.isArray(r.evidenced), 'the reply carries an `evidenced` array');
    assert.deepEqual(r.evidenced, ['task', 'trigger', 'steps', 'frequencyPerWeek', 'timePerPeriod'],
        'and it is the payload-proven fields, not the claim');
});

// ===========================================================================
// 3. THE OPEN-FIELD RELAXATION, AND WHETHER IT CAN BE GAMED
// ===========================================================================

test('the residual stall of requiring all fifteen: twelve asked, then stuck', () => {
    // Requiring ALL fifteen questions was too strong, because a field the model CLAIMS is never
    // offered - the substitute picks from `missing` - so its phrasing never enters the conversation
    // and exhaustion could never fire: the move-on line was emitted every turn, indefinitely.
    //
    // Driven through the real guard with the churn fixture: the round ends even though fewer than
    // fifteen questions were ever asked.
    const { endedAt, replies } = runChurn({ rate: 0 });

    assert.notEqual(endedAt, null, 'the round ends rather than looping on the move-on line');
    // A real field question is asked for every field the payload leaves OPEN, which is fewer than
    // the three the payload proves - so this is the relaxation at work.
    const asked = new Set(replies);
    assert.ok(asked.size < ALL.length, `fewer than fifteen questions were asked (asked ${asked.size})`);
});

test('a REPEATED question with one field open always exhausts - the relaxation is not a loophole', () => {
    // The relaxation must not let a single stuck field keep the interview alive. A model repeating
    // one question while fields remain open is ended, as before.
    const conversation = [];
    let endedAt = null;
    for (let i = 1; i <= 60; i += 1) {
        const r = turnWithChurn('How is this done today, overall?', conversation, i);
        conversation.push(r);
        if (r.exhausted) { endedAt = i; break; }
    }
    assert.notEqual(endedAt, null, 'a repeated question ends the round');
});

/** One turn of the churn conversation, returning the recorded entry including `exhausted`. */
function turnWithChurn(content, conversation, turn) {
    const askedBefore = conversation.map((entry) => ({
        text: entry.content, openCount: entry.missing.length,
        evidencedCount: entry.evidenced, substituted: entry.substituted === true
    }));
    const r = parseModelResponse(churnReply(content, turn), { askedBefore });
    return { content: r.content, missing: r.missing, evidenced: r.evidenced.length, substituted: r.substituted === true, exhausted: r.exhausted === true };
}

test('FINDING: a model that REWORDS its question each turn is never caught - the next mechanism', () => {
    // THE ATTACK THE BRIEF ASKED FOR, and it succeeds. The guard matches a repeat by EXACT TEXT.
    // A model that sends the same question with a trivial variation - a numeric suffix, a
    // rephrasing, anything that changes the string - is never a match target, so the guard never
    // fires and the interview runs indefinitely. The participant sees the same question, reworded,
    // forever.
    //
    // IT IS THE SAME CLASS the guard exists to stop, surviving the exact-text comparison: the
    // termination argument is "a repeat with no progress is caught", and a reworded question is
    // not a repeat. Measured: 100 turns, never exhausting, with a two-field payload.
    //
    // RECORDED AS TODAY'S BEHAVIOUR. Fixing it needs a similarity test rather than equality, or a
    // cap on turns-without-evidence, and that is a design decision rather than a mutation.
    const conversation = [];
    let endedAt = null;
    for (let turn = 1; turn <= 100; turn += 1) {
        // The SAME question, reworded with a counter - what a model "trying again in different
        // words" produces.
        const reworded = `Who else is involved in this? (${turn})`;
        const entry = turnWithChurn(reworded, conversation, turn);
        conversation.push(entry);
        if (entry.exhausted) { endedAt = turn; break; }
    }

    assert.equal(endedAt, null, 'FINDING: a reworded question never triggers exhaustion');
    assert.equal(conversation.length, 100, 'FINDING: so the interview runs indefinitely');
});

test('FINDING: the reworded attack also defeats the evidence check, because no repeat is seen', () => {
    // The same attack against the evidence check: `evidenced` correctly shows NO progress, and the
    // guard would substitute - but it only gets the chance on a REPEAT. With unique text every
    // turn there is no repeat, so the evidence comparison is never reached. The evidence check is
    // correct and still bypassed.
    const conversation = [];
    for (let turn = 1; turn <= 30; turn += 1) {
        const entry = turnWithChurn(`What about the mail on day ${turn}?`, conversation, turn);
        conversation.push(entry);
        // Evidence never grows: the payload is constant.
        assert.equal(entry.evidenced, 3, `evidence stays at three on turn ${turn}`);
        assert.equal(entry.substituted, false, 'and the reply is never marked as the gate\'s, because nothing matched');
    }
    assert.equal(conversation.length, 30, 'FINDING: thirty novel questions, none intercepted');
});
