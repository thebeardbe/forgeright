/**
 * ONE PROCESS THE MODEL RE-EMITTED WAS SCORED AS TWO.
 *
 * THE PAYLOAD THIS GUARDS AGAINST, from a real transcript - this is the artefact, not a
 * reconstruction:
 *
 *   [ { task: "Testing whether a server is up",    frequencyPerWeek: 56,
 *       steps: [Open the URL, Check if it is up, Log it in Excel, Notify IT] },
 *     { task: "Checking whether servers are up",   frequencyPerWeek: 7,
 *       steps: [Open the server URL, Check if the site loads, Log the result in Excel,
 *               Notify IT if down] } ]
 *
 * ONE process, described twice in reworded steps, with `frequencyPerWeek` 56 in one entry and 7 in
 * the other because the model had forgotten it had already recorded 56 servers. The prompt states
 * the contract - "`processes` holds the process you are working on NOW, not every process of the
 * interview" (`prompt_en.md` line 515) - and NOTHING enforced it: the only test on the reply's
 * arity anywhere was `length > 0`, which accepts any number.
 *
 * THE FIX ENFORCES IT WHERE THE ROUND IS KNOWN. The client sends `roundProcesses` with `/api/chat`
 * - the one fact the reply cannot carry - and `reconcileWithHeld` folds a reply that re-describes
 * the round's process, KEEPING THE ROUND'S RECORDED VALUES.
 *
 * BOTH DIRECTIONS ARE TESTED, and the second is the harm direction: folding must never discard a
 * process the participant has just named.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { reconcileWithHeld } from '../ai/workflow-identity.js';

/** The owner's payload, exactly as his transcript carried it. */
const OWNER_PAYLOAD = [
    {
        task: 'Testing whether a server is up',
        frequencyPerWeek: 56,
        steps: [{ name: 'Open the URL' }, { name: 'Check if it is up' }, { name: 'Log it in Excel' }, { name: 'Notify IT' }],
        peopleAffected: { said: 'nobody else is involved' }
    },
    {
        task: 'Checking whether servers are up',
        frequencyPerWeek: 7,
        steps: [{ name: 'Open the server URL' }, { name: 'Check if the site loads' }, { name: 'Log the result in Excel' }, { name: 'Notify IT if down' }],
        peopleAffected: { said: 'nobody else is involved' }
    }
];

/** The round's recorded process: the FIRST entry, which is what the client would have sent. */
const HELD_FIRST_ENTRY = [
    {
        id: 'testing-whether-a-server-is-up',
        task: 'Testing whether a server is up',
        frequencyPerWeek: 56,
        steps: [{ name: 'Open the URL' }, { name: 'Check if it is up' }, { name: 'Log it in Excel' }, { name: 'Notify IT' }],
        peopleAffected: { said: 'nobody else is involved' }
    }
];

test('the REAL payload folds to ONE process, keeping the round\'s `frequencyPerWeek` 56', () => {
    // The two entries are one process described twice, and the value that survives is the ROUND'S
    // recorded 56 - not the model's re-derived 7, which it produced because it had forgotten it
    // already recorded 56 servers.
    const { workflows, folded } = reconcileWithHeld(OWNER_PAYLOAD, HELD_FIRST_ENTRY);

    assert.equal(workflows.length, 1, 'the two reworded entries are ONE process');
    assert.equal(workflows[0].frequencyPerWeek, 56, 'and the ROUND\'S recorded value survives, not the model\'s 7');
    assert.notEqual(workflows[0].frequencyPerWeek, 7, 'the re-derived figure does not win');
    assert.ok(folded >= 1, 'and the fold is reported rather than silent');
});

test('the surviving entry carries the STEPS and the prose the participant gave', () => {
    // The fold keeps a whole account, not a bare id: the steps and the answer in words must be
    // present, or the score would be computed from a stub while the real process sat beside it.
    const { workflows } = reconcileWithHeld(OWNER_PAYLOAD, HELD_FIRST_ENTRY);
    const kept = workflows[0];

    assert.ok(Array.isArray(kept.steps) && kept.steps.length > 0, 'the steps survive');
    assert.deepEqual(kept.peopleAffected, { said: 'nobody else is involved' },
        'and the answer in words, unchanged');
});

test('THE HARM DIRECTION: a NEWLY NAMED process beside a finished one still yields TWO', () => {
    // THE TEST THAT CAUGHT THE IMPLEMENTER'S FIRST ATTEMPT, which folded the step-less entry and
    // DISCARDED the new process. A participant naming a second process produces `[the finished
    // process, the new one with NO steps]`, and the entry with no content is the NEW one - the
    // exact inverse of the by-absence arm that was removed from the client.
    const finished = {
        id: 'checking-servers',
        task: 'Checking whether servers are up',
        frequencyPerWeek: 56,
        steps: [{ name: 'Open the URL' }, { name: 'Check if it is up' }]
    };
    const namingTurn = [
        finished,
        { id: 'onboarding-a-new-supplier', task: 'Onboarding a new supplier', trigger: 'a supplier is agreed' }
    ];

    const { workflows, folded } = reconcileWithHeld(namingTurn, [finished]);

    assert.equal(workflows.length, 2, 'both entries survive');
    const ids = workflows.map((w) => w.id).sort();
    assert.deepEqual(ids, ['checking-servers', 'onboarding-a-new-supplier'],
        'the newly named process is KEPT, not folded away');
    assert.equal(folded, 0, 'and nothing was folded');
});

test('the newly named process is kept even though it carries NO steps', () => {
    // Stated separately because it is the property the first attempt broke: the new process arrives
    // step-less BY DESIGN ("a fresh matrix from its `task` and `trigger` onward"), so emptiness must
    // not be read as evidence of being the round's process.
    const finished = { id: 'p1', task: 'Checking servers', frequencyPerWeek: 56, steps: [{ name: 'Open the URL' }] };
    const newlyNamed = { id: 'p2', task: 'Onboarding a new supplier', trigger: 'a supplier is agreed' };

    const { workflows } = reconcileWithHeld([finished, newlyNamed], [finished]);

    assert.ok(workflows.some((w) => w.id === 'p2'), 'the step-less new process survives');
});

// ===========================================================================
// THE DECLINE CASES - no basis to decide means the reply is left alone
// ===========================================================================

test('an EMPTY held set DECLINES, leaving the reply exactly as it stands', () => {
    // The safe direction: no round history means no basis for deciding, so nothing is folded.
    const { workflows, folded } = reconcileWithHeld(OWNER_PAYLOAD, []);
    assert.equal(workflows.length, 2, 'both entries are passed through');
    assert.equal(folded, 0, 'nothing folded');
});

test('a held set with MORE THAN ONE process DECLINES', () => {
    // A round holds one process at a time, so with several held, position and step sharing are not
    // evidence enough to say WHICH one is being reworded.
    const held = [
        { id: 'a', task: 'A', steps: [{ name: 'Open the URL' }] },
        { id: 'b', task: 'B', steps: [{ name: 'Something else' }] }
    ];
    const { workflows, folded } = reconcileWithHeld(OWNER_PAYLOAD, held);

    assert.equal(workflows.length, 2, 'the reply is left alone');
    assert.equal(folded, 0, 'nothing folded');
});

test('a reply sharing NO step name with the round is left alone', () => {
    // Nothing in the reply names the round's process and no step matches, so it is something else.
    const held = [{ id: 'p1', task: 'Checking servers', steps: [{ name: 'Open the URL' }] }];
    const unrelated = [
        { id: 'x', task: 'Answering the phone', steps: [{ name: 'Pick up the handset' }] }
    ];
    const { workflows, folded } = reconcileWithHeld(unrelated, held);

    assert.equal(workflows.length, 1, 'the unrelated process is kept');
    assert.equal(folded, 0, 'and nothing folded');
});

test('an EMPTY reply is passed through unchanged', () => {
    const { workflows, folded } = reconcileWithHeld([], HELD_FIRST_ENTRY);
    assert.deepEqual(workflows, []);
    assert.equal(folded, 0);
});

test('a malformed reply is not crashed on', () => {
    // The route may hand this anything; a throw here would reach the participant's reply.
    for (const bad of [null, undefined, 'nope', 42]) {
        const { workflows, folded } = reconcileWithHeld(bad, HELD_FIRST_ENTRY);
        assert.equal(folded, 0, `${JSON.stringify(bad)} folds nothing`);
        assert.deepEqual(workflows, bad, 'and is returned as it came');
    }
});

// ===========================================================================
// THE BOUNDARY THE CLIENT DEPENDS ON
// ===========================================================================

test('the fold is IDENTITY-WISE on a step name, so a reworded step does not match', () => {
    // The rule is an EXACT co-test: "Open the URL" and "Open the server URL" are different names.
    // The owner's payload still folds because THREE of its eight names are exactly equal
    // ("Log it in Excel" and "Notify IT" differ slightly, but "Check if it is up" vs "Check if the
    // site loads" do not - the shared names are what carry it). This asserts the boundary: with NO
    // exactly equal name, nothing folds.
    const held = [{ id: 'p1', task: 'A', steps: [{ name: 'Open the URL' }] }];
    const rewordedOnly = [{ task: 'B', steps: [{ name: 'Open the server URL' }] }];

    const { folded } = reconcileWithHeld(rewordedOnly, held);
    assert.equal(folded, 0, 'a reworded step name is not an exact match');
});

test('the route only reconciles when the client sent a held set, and declines otherwise', () => {
    // The wiring: `roundProcesses` is the one fact the reply cannot carry, and without it the route
    // passes the reply through rather than guessing. Asserted from the source, since the client
    // omitting the field is the case that must not error or crash.
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'routes-api.js'), 'utf8');

    assert.match(source, /import \{ reconcileWithHeld \} from '\.\.\/ai\/workflow-identity\.js'/,
        'the route imports the fold');
    assert.match(source, /const held = Array\.isArray\(roundProcesses\) \? roundProcesses : \[\]/,
        'and treats a missing `roundProcesses` as an empty held set');
    assert.match(source, /held\.length > 0\) \{/, 'so an omitted field declines rather than folding');
});
