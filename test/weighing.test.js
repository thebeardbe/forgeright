/**
 * Workflow 3: weighing.
 *
 * The model composes ONE number for a process from ten terms and writes a paragraph explaining it;
 * the code validates the shape, stores the score against the REVISION, and sorts the roadmap.
 *
 * WHAT THE CODE DOES NOT DO, pinned deliberately: it does not compute the score from the terms, and
 * it does not enforce the direction of a cost term. See the boundary test near the end.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-weighing-test-'));
process.env.STORE_DIR = STORE_DIR;
process.env.SESSION_SECRET = 'a'.repeat(64);

const store = await import('../lib/store/index.js');
const processes = await import('../lib/store/processes.js');
const weighing = await import('../lib/store/weighing.js');
const weighCore = await import('../ai/weigh-core.js');

after(() => {
    store.closeAll();
    fs.rmSync(STORE_DIR, { recursive: true, force: true });
});

/** The ten terms at one value, which is enough for every shape test. */
function termsAt(value = 5) {
    return Object.fromEntries(weighing.TERMS.map((term) => [term, value]));
}

/** A weighing reply that passes the gate, with overrides. */
function validReply(overrides = {}) {
    return { score: 50, terms: termsAt(5), reasoning: 'because the work repeats and is plain', ...overrides };
}

/** An org with one identified process, ready to weigh. */
function orgWithProcess(name = 'Invoices') {
    const org = store.createOrganisation(`Org ${name}`);
    const invitation = store.addInvitation(org.id, { email: 'p@example.test', department: 'Finance' });
    const response = store.addResponse(org.id, invitation.token, { department: 'Finance', data: { task: name } });
    const identified = processes.recordIdentification({
        orgId: org.id,
        reply: { matches: null, reasoning: 'nobody has described this', confidence: 'high', name },
        responseId: response.id
    });
    return { org, invitation, response, processId: identified.process.id, revisionId: identified.revision.id };
}

// ===========================================================================
// 1. validateWeighing — THE SHAPE GATE
// ===========================================================================

test('a valid weighing is accepted, trimmed, and keeps only the required terms', () => {
    const result = weighing.validateWeighing(validReply({ reasoning: '  spaced  ', terms: { ...termsAt(3), invented: 99 } }));

    assert.equal(result.ok, true);
    assert.equal(result.score, 50);
    assert.equal(result.reasoning, 'spaced', 'the reasoning is trimmed');
    assert.deepEqual(Object.keys(result.terms).sort(), [...weighing.TERMS].sort(), 'only the required terms are stored');
    assert.equal('invented' in result.terms, false, 'an invented term cannot enter the breakdown');
});

test('a MISSING term is refused, and the reason names it', () => {
    const terms = termsAt();
    delete terms.complexity;

    const result = weighing.validateWeighing(validReply({ terms }));

    assert.equal(result.ok, false);
    assert.match(result.reason, /complexity/, 'the missing term is named');
    assert.match(result.reason, /missing/);
});

test('SEVERAL missing terms are ALL named', () => {
    const terms = termsAt();
    delete terms.complexity;
    delete terms.buildEffort;
    delete terms.departments;

    const result = weighing.validateWeighing(validReply({ terms }));

    assert.equal(result.ok, false);
    for (const term of ['complexity', 'buildEffort', 'departments']) {
        assert.match(result.reason, new RegExp(term), `${term} must be named`);
    }
});

test('a term that is a STRING is refused as not-a-number, never coerced', () => {
    // Coercion is the quiet failure this gate prevents: "5" is a reply that ignored the contract.
    const result = weighing.validateWeighing(validReply({ terms: { ...termsAt(), time: '5' } }));

    assert.equal(result.ok, false);
    assert.match(result.reason, /not numbers/);
    assert.match(result.reason, /time/);
});

test('a NON-NUMERIC, MISSING or INFINITE score is refused, and a string score is NOT coerced', () => {
    for (const score of ['42', undefined, null, Infinity, -Infinity, NaN, {}, []]) {
        const result = weighing.validateWeighing(validReply({ score }));
        assert.equal(result.ok, false, `score ${JSON.stringify(score)} must be refused`);
        assert.match(result.reason, /score must be a finite number/);
    }

    // The specific coercion the code refuses to make.
    const coerced = weighing.validateWeighing(validReply({ score: '42' }));
    assert.equal(coerced.ok, false);
    assert.equal(coerced.score, undefined, 'no number is returned for a string score');
});

test('missing, empty, whitespace and non-string reasoning are ALL refused', () => {
    // A score nobody can explain cannot be reviewed, which is the protection for this step.
    for (const reasoning of [undefined, '', '   ', '\t\n', 42, null, {}]) {
        const result = weighing.validateWeighing(validReply({ reasoning }));
        assert.equal(result.ok, false, `reasoning ${JSON.stringify(reasoning)} must be refused`);
        assert.match(result.reason, /reasoning/);
    }
});

test('terms missing entirely, or not an object, is refused', () => {
    for (const terms of [undefined, null, [], 'terms', 42]) {
        const result = weighing.validateWeighing(validReply({ terms }));
        assert.equal(result.ok, false, `terms ${JSON.stringify(terms)} must be refused`);
        assert.match(result.reason, /terms are missing or are not an object/);
    }
});

test('a reply that is not an object, or is an array, is refused', () => {
    for (const reply of [null, undefined, 'a string', 42, [], [validReply()]]) {
        const result = weighing.validateWeighing(reply);
        assert.equal(result.ok, false, `reply ${JSON.stringify(reply)} must be refused`);
        assert.match(result.reason, /not an object/);
    }
});

test('a missing term is treated the same as an explicit null', () => {
    const terms = termsAt();
    terms.people = null;

    const result = weighing.validateWeighing(validReply({ terms }));
    assert.equal(result.ok, false);
    assert.match(result.reason, /people/);
});

// --- the term RANGE, inclusive at both ends --------------------------------
//
// The whole feature is on one 0-100 scale: the ten terms AND the composite score. The live bound is
// TERM_MIN/TERM_MAX, inclusive, PER TERM. See the score's own bound below.

test('the range constants are 0 and 100', () => {
    assert.equal(weighing.TERM_MIN, 0);
    assert.equal(weighing.TERM_MAX, 100);
});

test('0 and 100 are both ACCEPTED, so the bound is inclusive at both ends', () => {
    for (const value of [weighing.TERM_MIN, weighing.TERM_MAX, 0, 100]) {
        const result = weighing.validateWeighing(validReply({ terms: termsAt(value) }));
        assert.equal(result.ok, true, `terms at ${value} must be accepted`);
    }
});

test('a SINGLE term below the minimum is refused, AND the term is named', () => {
    const terms = termsAt(50);
    terms.complexity = -1;

    const result = weighing.validateWeighing(validReply({ terms }));
    assert.equal(result.ok, false);
    assert.match(result.reason, /complexity=-1/, 'the reason names the term and its value');
    assert.match(result.reason, /outside 0 to 100/);
});

test('a SINGLE term above the maximum is refused, AND the term is named', () => {
    const terms = termsAt(50);
    terms.buildEffort = 101;

    const result = weighing.validateWeighing(validReply({ terms }));
    assert.equal(result.ok, false);
    assert.match(result.reason, /buildEffort=101/);
});

test('several out-of-range terms are ALL named', () => {
    const terms = termsAt(50);
    terms.complexity = -1;
    terms.buildEffort = 101;

    const result = weighing.validateWeighing(validReply({ terms }));
    assert.equal(result.ok, false);
    assert.match(result.reason, /complexity=-1/);
    assert.match(result.reason, /buildEffort=101/);
});

test('the bound is on the VALUE, so a fraction just outside is refused', () => {
    for (const value of [-0.0001, 100.0001, 100.5, -0.5]) {
        const result = weighing.validateWeighing(validReply({ terms: termsAt(value) }));
        assert.equal(result.ok, false, `terms at ${value} must be refused`);
    }
});

test('the SCORE is bounded on the SAME 0-100 scale as the terms', () => {
    // The score must be bounded exactly as the terms are: the prompt says "0 to 100, the same
    // scale as the terms", and a validator that checked only that the score was finite would let a
    // model return 250 and have it stored, displayed and ranked by. This pins the bound.
    //
    // `TERM_MIN`/`TERM_MAX` ARE REUSED for both on purpose: a second pair with the
    // same values is how the two get out of step.

    // Inclusive at both ends.
    for (const score of [0, 100]) {
        const result = weighing.validateWeighing(validReply({ score, terms: termsAt(50) }));
        assert.equal(result.ok, true, `score ${score} must be accepted: the bound is inclusive`);
        assert.equal(result.score, score);
    }

    // Out of range is refused including a fraction just outside, so the bound is on the value.
    for (const score of [-5, 250, 1_000_000, 100.5, -0.5]) {
        const result = weighing.validateWeighing(validReply({ score, terms: termsAt(50) }));
        assert.equal(result.ok, false, `score ${score} must be refused`);
        assert.match(result.reason, /score/, 'the refusal names the SCORE');
        assert.match(result.reason, /between 0 and 100/, 'and the range it wanted');
        assert.ok(result.reason.includes(String(score)), 'and the value it got');
    }
});

test('the SCORE refusal is distinguishable from the TERM refusal', () => {
    // A reader who saw the term wording for a bad score would look for a term to fix, so the two
    // messages must not collapse into one.
    const badScore = weighing.validateWeighing(validReply({ score: 250, terms: termsAt(50) }));
    const badTerm = weighing.validateWeighing(validReply({ score: 50, terms: { ...termsAt(50), complexity: 140 } }));

    assert.match(badScore.reason, /the score must be between 0 and 100, got 250/);
    assert.match(badTerm.reason, /these terms are outside 0 to 100: complexity=140/);
    assert.notEqual(badScore.reason, badTerm.reason, 'the two refusals are not the same message');
    assert.equal(/\bthese terms\b/.test(badScore.reason), false, 'a score refusal does not talk about terms');
    assert.equal(/\bscore must be between\b/.test(badTerm.reason), false, 'and a term refusal does not talk about the score');
});

test('TYPE is checked BEFORE RANGE, so a numeric string is a type error, not a range error', () => {
    // A string is refused as a TYPE error even when its value is also out of range, so the message
    // says what is wrong rather than sending the model to adjust a number it never sent.
    for (const score of ['42', '5', '250', '999']) {
        const result = weighing.validateWeighing(validReply({ score, terms: termsAt(50) }));
        assert.equal(result.ok, false, `score ${JSON.stringify(score)} must be refused`);
        assert.match(result.reason, /finite number/, 'refused as a TYPE error');
        assert.equal(/between 0 and 100/.test(result.reason), false, 'and NOT as a range error');
    }
});

// ===========================================================================
// 2. COST_TERMS AND isCostTerm — THE CLASSIFICATION
// ===========================================================================
// The classification is what the code holds; the DIRECTION (a high cost term counting against the
// process) is applied by the model in the prompt. See the boundary test at the end.

test('isCostTerm is true for exactly the four cost terms', () => {
    assert.deepEqual([...weighing.COST_TERMS], ['departments', 'complexity', 'reasoningSteps', 'buildEffort']);

    for (const term of ['departments', 'complexity', 'reasoningSteps', 'buildEffort']) {
        assert.equal(weighing.isCostTerm(term), true, `${term} is a cost`);
    }
});

test('isCostTerm is false for the six reward terms', () => {
    for (const term of ['frequency', 'time', 'people', 'results', 'consequences', 'automatableShare']) {
        assert.equal(weighing.isCostTerm(term), false, `${term} is a reward`);
    }
});

test('EVERY term in TERMS is classified, so a new term cannot be silently unclassified', () => {
    // The property that keeps the classification honest: if a term is added to
    // TERMS and not to COST_TERMS, this still holds (it is a reward by default),
    // but the count assertion below makes that a deliberate change rather than an
    // accident.
    assert.equal(weighing.TERMS.every((term) => typeof weighing.isCostTerm(term) === 'boolean'), true);

    const costs = weighing.TERMS.filter((term) => weighing.isCostTerm(term));
    assert.equal(costs.length, 4, 'exactly four of the ten terms are costs');

    // Every cost is a real term, and every term appears exactly once.
    for (const cost of weighing.COST_TERMS) {
        assert.ok(weighing.TERMS.includes(cost), `${cost} must be one of the ten terms`);
    }
    assert.equal(new Set(weighing.TERMS).size, weighing.TERMS.length, 'no duplicate terms');
    assert.equal(new Set(weighing.COST_TERMS).size, weighing.COST_TERMS.length, 'no duplicate costs');
});

test('an unknown term is not a cost, and does not throw', () => {
    for (const term of ['', 'complexity2', 'DEPARTMENTS', null, undefined, 42]) {
        assert.equal(weighing.isCostTerm(term), false, `${JSON.stringify(term)} is not a cost term`);
    }
});

// ===========================================================================
// 3. THE SCORE FOLLOWS THE REVISION
// ===========================================================================

test('a scored process reads back with its number, its ten terms and its paragraph', () => {
    const { org, processId } = orgWithProcess('readable');
    weighing.recordWeighing({ orgId: org.id, processId, reply: validReply({ score: 42, terms: termsAt(7), reasoning: 'it repeats daily and is plain' }) });

    const entry = weighing.listRoadmap(org.id).find((e) => e.id === processId);
    assert.equal(entry.score.value, 42);
    assert.equal(entry.score.reasoning, 'it repeats daily and is plain');
    assert.equal(Object.keys(entry.score.terms).length, weighing.TERMS.length, 'all ten terms are stored');
    assert.deepEqual(entry.score.terms, termsAt(7));
    assert.equal(entry.score.weighing, 1, 'this is the first weighing');
});

test('a re-weighing of the SAME revision adds a weighing rather than editing one', () => {
    const { org, processId } = orgWithProcess('two weighings');
    weighing.recordWeighing({ orgId: org.id, processId, reply: validReply({ score: 10, terms: termsAt(1), reasoning: 'first reading' }) });
    weighing.recordWeighing({ orgId: org.id, processId, reply: validReply({ score: 90, terms: termsAt(9), reasoning: 'second reading' }) });

    const entry = weighing.listRoadmap(org.id).find((e) => e.id === processId);
    assert.equal(entry.score.value, 90, 'the latest is the current one');
    assert.equal(entry.score.weighing, 2);
    assert.equal(entry.scoreHistory.length, 2, 'both weighings are kept');

    const reasonings = entry.scoreHistory.map((s) => s.reasoning);
    assert.ok(reasonings.includes('first reading'), 'the earlier weighing is still readable');
    assert.ok(reasonings.includes('second reading'));
});

test('the earlier weighing keeps ITS OWN terms', () => {
    const { org, processId } = orgWithProcess('own terms');
    weighing.recordWeighing({ orgId: org.id, processId, reply: validReply({ score: 10, terms: termsAt(1), reasoning: 'first' }) });
    weighing.recordWeighing({ orgId: org.id, processId, reply: validReply({ score: 90, terms: termsAt(9), reasoning: 'second' }) });

    const history = weighing.listRoadmap(org.id).find((e) => e.id === processId).scoreHistory;
    const first = history.find((s) => s.revision_no === 1);
    const second = history.find((s) => s.revision_no === 2);

    assert.equal(first.terms.frequency, 1, 'the earlier weighing keeps its own value');
    assert.equal(second.terms.frequency, 9, 'the later one has its own');
    assert.notDeepEqual(first.terms, second.terms, 'they are not the same object copied twice');
});

test('exactly one weighing is current for a revision', () => {
    const { org, processId } = orgWithProcess('one current');
    weighing.recordWeighing({ orgId: org.id, processId, reply: validReply({ score: 10 }) });
    weighing.recordWeighing({ orgId: org.id, processId, reply: validReply({ score: 20 }) });
    weighing.recordWeighing({ orgId: org.id, processId, reply: validReply({ score: 30 }) });

    const history = weighing.listRoadmap(org.id).find((e) => e.id === processId).scoreHistory;
    assert.equal(history.filter((s) => s.is_current).length, 1);
});

test('a process with NO current grouping cannot be weighed → refused, not scored as zero', () => {
    // An unscored process and a scoreless one must not look alike. This is a
    // grouping fault, so it is a loud error rather than a 0.
    const org = store.createOrganisation('Bare org');
    store.closeAll();
    const db = new DatabaseSync(store.orgDbPath(org.id));
    db.prepare('INSERT INTO process (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run('bare', 'Bare process', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    db.close();

    assert.throws(
        () => weighing.recordWeighing({ orgId: org.id, processId: 'bare', reply: validReply() }),
        /no current grouping/,
        'there is nothing to weigh, and that is an error, not a zero'
    );
});

test('weighing a process that does not exist is refused', () => {
    const { org } = orgWithProcess('ghost');
    assert.throws(
        () => weighing.recordWeighing({ orgId: org.id, processId: 'no-such-process', reply: validReply() }),
        /not in organisation/
    );
});

test('a weighing with an unusable reply is refused, naming the problem', () => {
    const { org, processId } = orgWithProcess('bad reply');

    assert.throws(
        () => weighing.recordWeighing({ orgId: org.id, processId, reply: validReply({ reasoning: '' }) }),
        /no reasoning/
    );
    assert.throws(
        () => weighing.recordWeighing({ orgId: org.id, processId, reply: validReply({ terms: termsAt(), score: '50' }) }),
        /finite number/
    );
});

test('an unscored process still appears in the roadmap, last rather than dropped', () => {
    const scored = orgWithProcess('scored one');
    weighing.recordWeighing({ orgId: scored.org.id, processId: scored.processId, reply: validReply({ score: 50 }) });

    // A second process in the same organisation, never weighed.
    const second = store.addResponse(scored.org.id, scored.invitation.token, { department: 'Finance', data: { task: 'unweighed' } });
    const identified = processes.recordIdentification({
        orgId: scored.org.id,
        reply: { matches: null, reasoning: 'different work', confidence: 'high', name: 'Unweighed' },
        responseId: second.id
    });

    const roadmap = weighing.listRoadmap(scored.org.id);
    assert.equal(roadmap.length, 2, 'both processes are present');
    assert.equal(roadmap.at(-1).id, identified.process.id, 'the unscored one sorts last');
    assert.equal(roadmap.at(-1).score, null, 'and its score is null, not zero');
});

// ===========================================================================
// 4. listRoadmap — THE RANKING
// ===========================================================================

test('the roadmap sorts highest score first', () => {
    const { org, invitation } = orgWithProcess('sorting');

    const make = (name, score) => {
        const response = store.addResponse(org.id, invitation.token, { department: 'Finance', data: { task: name } });
        const identified = processes.recordIdentification({
            orgId: org.id,
            reply: { matches: null, reasoning: 'new work', confidence: 'high', name },
            responseId: response.id
        });
        weighing.recordWeighing({ orgId: org.id, processId: identified.process.id, reply: validReply({ score }) });
    };
    make('Alpha', 50);
    make('Bravo', 10);
    make('Charlie', 90);

    // Only the SCORED entries, since the setup leaves one unscored process.
    const values = weighing.listRoadmap(org.id).filter((e) => e.score !== null).map((e) => e.score.value);
    assert.deepEqual(values, [...values].sort((a, b) => b - a), 'the list is in descending score order');
    assert.deepEqual(values, [90, 50, 10], 'and the highest is first');
});

test('each roadmap entry carries the grouping, the terms, the paragraph and both histories', () => {
    const { org, processId } = orgWithProcess('entry shape');
    weighing.recordWeighing({ orgId: org.id, processId, reply: validReply({ score: 42, reasoning: 'paragraph' }) });

    const entry = weighing.listRoadmap(org.id)[0];
    assert.ok(entry.grouping, 'the grouping is carried');
    assert.equal(entry.grouping.revision, 1);
    assert.equal(entry.grouping.reasoning, 'nobody has described this', 'the grouping reasoning is the identification one');
    assert.equal(entry.grouping.responses.length, 1);
    assert.equal(Object.keys(entry.score.terms).length, weighing.TERMS.length);
    assert.equal(entry.score.reasoning, 'paragraph');
    assert.ok(Array.isArray(entry.scoreHistory));
});

test('ties break on the name, so the order is stable and not whatever the database returns', () => {
    const { org, invitation } = orgWithProcess('ties');
    for (const name of ['Zulu', 'Alpha', 'Mike']) {
        const response = store.addResponse(org.id, invitation.token, { department: 'Finance', data: { task: name } });
        const identified = processes.recordIdentification({
            orgId: org.id, reply: { matches: null, reasoning: 'new', confidence: 'high', name }, responseId: response.id
        });
        weighing.recordWeighing({ orgId: org.id, processId: identified.process.id, reply: validReply({ score: 50 }) });
    }

    const names = weighing.listRoadmap(org.id).map((e) => e.name);
    const equal = names.filter((n) => n === 'Alpha' || n === 'Zulu' || n === 'Mike');
    assert.deepEqual(equal, ['Alpha', 'Mike', 'Zulu'], 'equal scores are ordered by name');
});

test('the ordering is DETERMINISTIC: two calls give the same result', () => {
    const { org, invitation } = orgWithProcess('determinism');
    for (const [name, score] of [['Zulu', 50], ['Alpha', 50], ['Mike', 50], ['Solo', null]]) {
        const response = store.addResponse(org.id, invitation.token, { department: 'Finance', data: { task: name } });
        const identified = processes.recordIdentification({
            orgId: org.id, reply: { matches: null, reasoning: 'new', confidence: 'high', name }, responseId: response.id
        });
        if (score !== null) weighing.recordWeighing({ orgId: org.id, processId: identified.process.id, reply: validReply({ score }) });
    }

    const first = JSON.stringify(weighing.listRoadmap(org.id));
    const second = JSON.stringify(weighing.listRoadmap(org.id));
    assert.equal(second, first, 'the same input gives the same order twice');
});

test('an empty organisation has an empty roadmap, not an error', () => {
    const org = store.createOrganisation('Empty org');
    assert.deepEqual(weighing.listRoadmap(org.id), []);
});

// ===========================================================================
// 5. REFUSALS AND THE SHARED EXTRACTION PATH
// ===========================================================================

test('there is exactly ONE JSON extractor, imported by all three workflows', () => {
    // Verified by grep as much as by test: a second hand-rolled brace scanner is
    // how the three workflows would drift apart.
    const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
    const cores = ['ai/audit-core.js', 'ai/identify-core.js', 'ai/weigh-core.js'];
    for (const core of cores) {
        const source = fs.readFileSync(path.join(projectRoot, core), 'utf8');
        assert.match(source, /from '\.\/json-extract\.js'/, `${core} imports the shared extractor`);
        assert.match(source, /from '\.\/format-commitment\.js'/, `${core} imports the shared format turn`);
        // No hand-rolled scanning: no brace-depth counter outside json-extract.js.
        assert.equal(/inString|depth \+= 1|lastIndexOf\('\}'\)/.test(source), false, `${core} must not scan braces itself`);
    }

    // And only one module defines the scanner.
    const aiDir = path.join(projectRoot, 'ai');
    const definers = fs.readdirSync(aiDir)
        .filter((name) => name.endsWith('.js'))
        .filter((name) => /function extractJsonObject/.test(fs.readFileSync(path.join(aiDir, name), 'utf8')));
    assert.deepEqual(definers, ['json-extract.js'], 'one extractor, in one module');
});

test('a malformed weighing reply is a clear error, not a fragment', () => {
    const noJson = weighCore.parseWeighingResponse('I think this process is quite quick.');
    assert.equal(noJson.status, 'error');
    assert.match(noJson.reason, /no JSON object/);

    // A truncated mid-object reply is NOT parsed as a fragment.
    const truncated = weighCore.parseWeighingResponse('{"score": 42, "terms": {"frequency": 3, "time":');
    assert.equal(truncated.status, 'error', 'a truncated object is refused, not partially parsed');
    assert.match(truncated.reason, /no JSON object/);

    const blank = weighCore.parseWeighingResponse('');
    assert.equal(blank.status, 'error');
});

test('a well-formed or fenced weighing reply is parsed', () => {
    assert.deepEqual(weighCore.parseWeighingResponse('{"score":42}'), { score: 42 });
    assert.deepEqual(weighCore.parseWeighingResponse('```json\n{"score":42}\n```'), { score: 42 });
});

test('the weighing message carries the process and its steps, and NOT the transcript', () => {
    const grouping = {
        revision: { id: 'rev' },
        responses: [{
            responseId: 'r1',
            department: 'Finance',
            data: {
                task: 'invoices',
                steps: [{ name: 'open', decidedHow: 'the inbox', needsReasoning: false }],
                transcript: [{ role: 'user', content: 'A SECRET TRANSCRIPT' }]
            }
        }]
    };
    const message = weighCore.buildWeighingMessage({ process: { name: 'Invoices' }, grouping });

    assert.ok(message.includes('Invoices'), 'the process name is present');
    assert.ok(message.includes('decidedHow'), 'the steps are included with their basis');
    assert.ok(message.includes('needsReasoning'), 'and the flag, which is where automation stops');
    assert.equal(message.includes('A SECRET TRANSCRIPT'), false, 'the transcript is not shipped to the model');
    assert.ok(message.includes('Described by 1'), 'the participant count is stated');
});

test('the admin\'s argument appears only when given', () => {
    const grouping = { revision: { id: 'rev' }, responses: [] };
    const without = weighCore.buildWeighingMessage({ process: { name: 'P' }, grouping, adminReasoning: null });
    assert.equal(without.toLowerCase().includes('disputes'), false);

    const withArg = weighCore.buildWeighingMessage({ process: { name: 'P' }, grouping, adminReasoning: 'I disagree with the grouping.' });
    assert.ok(withArg.includes('I disagree with the grouping.'));
    assert.ok(withArg.toLowerCase().includes('disputes'));
});

// ===========================================================================
// THE BOUNDARY: THE DIRECTION IS NOT ENFORCED BY THIS CODE
// ===========================================================================

test('BOUNDARY: a score whose cost terms all point the wrong way is ACCEPTED, because nothing recomputes it', () => {
    // THIS IS A TEST OF THE DESIGN, NOT A DEFECT. The score is composed by the
    // model in the prompt; this code validates only that the score is a finite
    // number and that the ten terms are present, numeric and in range. It does not
    // recompute the score from the terms, and it does not check that a high
    // `complexity` was treated as a cost.
    //
    // So a reply whose four cost terms are all at their WORST (100 on the 0-100
    // scale) and whose score is also at the top is accepted, even though the prompt
    // says a high complexity should pull the process DOWN. Nothing here can fail on
    // that, and this test records it so the next reader does not assume the
    // direction is enforced.
    //
    // THE VALUES WERE 10 UNDER THE OLD 1-5 SCALE, where 10 was out of range but
    // still accepted because nothing checked. The scale is now 0-100 per term, so
    // 100 is the genuine worst value and valid: the point is unchanged and now
    // stated on the scale that exists. The range itself is pinned beside it.
    const wrongWayRound = {
        score: 100,
        terms: {
            frequency: 100, time: 100, people: 100, results: 100, consequences: 100, automatableShare: 100,
            // The four costs, all set to their WORST value, alongside a top score.
            departments: 100, complexity: 100, reasoningSteps: 100, buildEffort: 100
        },
        reasoning: 'a high complexity, which the prompt says counts against it, but a high score anyway'
    };

    const result = weighing.validateWeighing(wrongWayRound);
    assert.equal(result.ok, true, 'the gate accepts it: the direction is not its business');
    assert.equal(result.score, 100);

    // THE HONEST PAIRING WITH THE RANGE TESTS BESIDE THIS ONE: every value here is
    // IN RANGE, so the acceptance is about the direction alone and does not lean on
    // an invalid number. If a future change made these out of range, the test would
    // be proving the wrong thing and this assertion would fail.
    assert.equal(result.score >= weighing.TERM_MIN && result.score <= weighing.TERM_MAX, true, 'the score is in range');
    for (const [term, value] of Object.entries(result.terms)) {
        assert.equal(value >= weighing.TERM_MIN && value <= weighing.TERM_MAX, true, `the term ${term} is in range`);
    }

    // And it is stored and read back, so the acceptance is not merely the gate's.
    const { org, processId } = orgWithProcess('wrong way round');
    const recorded = weighing.recordWeighing({ orgId: org.id, processId, reply: wrongWayRound });
    assert.equal(recorded.score.score, 100);
    const entry = weighing.listRoadmap(org.id).find((e) => e.id === processId);
    assert.equal(entry.score.value, 100, 'a wrong-direction score reaches the roadmap unchanged');
    assert.equal(entry.score.terms.complexity, 100, 'and the terms it was given are stored as they were');
});

test('THE RANGE, paired with the boundary above: 100 is accepted and 101 refused', () => {
    // The honest pairing: this test says what the terms ARE checked for, right
    // beside the test that says what they are not. Direction: unchecked. Range:
    // checked, per term, inclusive.
    assert.equal(weighing.validateWeighing(validReply({ terms: termsAt(100) })).ok, true, '100 is the top of the range');

    const over = weighing.validateWeighing(validReply({ terms: termsAt(101) }));
    assert.equal(over.ok, false, '101 is refused');
    assert.match(over.reason, /complexity=101/, 'and the refusal names a term and its value');
});

// ===========================================================================
// THE SCORE FOLLOWS THE REVISION ACROSS A REJUDGE
// ===========================================================================
//
// A rejudge creates a NEW revision (workflow 2 re-identifies first), and the score
// is keyed on the revision, so the roadmap reads the CURRENT revision's weighing.
// A score keyed on the PROCESS would keep showing the old number after a rejudge,
// which is exactly the drift this keying prevents.

test('after a rejudge, the roadmap shows the score of the CURRENT revision', () => {
    const { org, response, processId } = orgWithProcess('revision keying');

    // First grouping, weighed at 10.
    weighing.recordWeighing({ orgId: org.id, processId, reply: validReply({ score: 10, reasoning: 'before the rejudge' }) });
    assert.equal(weighing.listRoadmap(org.id).find((e) => e.id === processId).score.value, 10);

    // The admin disputes it: workflow 2 re-identifies, adding revision 2.
    processes.recordIdentification({
        orgId: org.id,
        reply: { matches: processId, reasoning: 'regrouped on the argument', confidence: 'high' },
        responseId: response.id,
        adminReasoning: 'the grouping was wrong',
        decidedBy: processes.DECIDED_BY.ADMIN
    });

    // Workflow 3 regenerates from the corrected grouping, at 90.
    weighing.recordWeighing({ orgId: org.id, processId, reply: validReply({ score: 90, reasoning: 'after the rejudge' }) });

    const entry = weighing.listRoadmap(org.id).find((e) => e.id === processId);
    assert.equal(entry.grouping.revision, 2, 'the current grouping is the rejudged one');
    assert.equal(entry.score.value, 90, 'the roadmap shows the CURRENT revision\'s score, not the process\'s first');
    assert.equal(entry.score.reasoning, 'after the rejudge');

    // The earlier score is not lost: it belongs to revision 1, and the console
    // history still carries both revisions.
    const consoleRow = processes.listProcessesForConsole(org.id).find((p) => p.id === processId);
    assert.equal(consoleRow.history.length, 2, 'both groupings are kept');
    assert.equal(consoleRow.current.revision, 2);
});

test('a rendering of the score keyed on the process would show the wrong number after a rejudge', () => {
    // The property stated as its consequence: if the score were read from the
    // process's FIRST revision, the roadmap would still say 10 here.
    const { org, response, processId } = orgWithProcess('keying consequence');
    weighing.recordWeighing({ orgId: org.id, processId, reply: validReply({ score: 10, reasoning: 'first' }) });
    processes.recordIdentification({
        orgId: org.id,
        reply: { matches: processId, reasoning: 'regrouped', confidence: 'high' },
        responseId: response.id,
        adminReasoning: 'disagree',
        decidedBy: processes.DECIDED_BY.ADMIN
    });
    weighing.recordWeighing({ orgId: org.id, processId, reply: validReply({ score: 90, reasoning: 'second' }) });

    const roadmapScore = weighing.listRoadmap(org.id).find((e) => e.id === processId).score.value;
    assert.notEqual(roadmapScore, 10, 'the roadmap must not read a stale, first-revision score');
    assert.equal(roadmapScore, 90);
});
