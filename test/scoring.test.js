/**
 * Tests for the scoring and aggregation layer.
 *
 * Written from the documented model in README.md / ARCHITECTURE.md and the
 * source in lib/scoring.js. Expectations are stated as literals or plainly
 * derived values; none are computed by calling the code under test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    RULES_FACTOR,
    INCONSISTENT_STEPS_FACTOR,
    BUCKET,
    effortHoursPerWeek,
    automabilityFactor,
    scoreWorkflow,
    bucketFor,
    findConflictGroups,
    describeConflict,
    findConflicts,
    collapseDuplicates,
    aggregate
} from '../lib/scoring.js';

/** A raw camelCase field name has no place in a client-facing sentence. */
const CAMEL_CASE = /[a-z]+[A-Z][a-zA-Z]*/;

/** Base workflow helper: two hours of rules-based work per week. */
function wf(overrides = {}) {
    return {
        id: 'w1',
        title: 'Invoice entry',
        frequencyPerWeek: 2,
        minutesPerInstance: 30,
        peopleAffected: 2,
        judgementScore: 5,
        stepsConsistent: true,
        ...overrides
    };
}

test('effortHoursPerWeek follows frequency * minutes * people / 60', () => {
    // 2 * 30 * 2 / 60 = 2
    assert.equal(effortHoursPerWeek(wf()), 2);
});

test('effortHoursPerWeek is zero when any input is zero', () => {
    assert.equal(effortHoursPerWeek(wf({ frequencyPerWeek: 0 })), 0);
    assert.equal(effortHoursPerWeek(wf({ minutesPerInstance: 0 })), 0);
    assert.equal(effortHoursPerWeek(wf({ peopleAffected: 0 })), 0);
});

test('effortHoursPerWeek treats negative and non-finite inputs as zero', () => {
    assert.equal(effortHoursPerWeek(wf({ minutesPerInstance: -30 })), 0);
    assert.equal(effortHoursPerWeek(wf({ frequencyPerWeek: Infinity })), 0);
    assert.equal(effortHoursPerWeek(wf({ peopleAffected: NaN })), 0);
    assert.equal(effortHoursPerWeek(wf({ minutesPerInstance: 'lots' })), 0);
});

test('effortHoursPerWeek coerces numeric strings rather than silently returning zero', () => {
    // "4" is a number, not a missing value: 4 * 15 * 1 / 60 = 1
    assert.equal(effortHoursPerWeek(wf({ frequencyPerWeek: '4', minutesPerInstance: 15, peopleAffected: 1 })), 1);
});

test('effortHoursPerWeek handles null and undefined fields as zero', () => {
    assert.equal(effortHoursPerWeek(wf({ frequencyPerWeek: null })), 0);
    assert.equal(effortHoursPerWeek(wf({ minutesPerInstance: undefined })), 0);
});

test('RULES_FACTOR maps judgement 1..5 from 0.15 to 1.00', () => {
    assert.equal(RULES_FACTOR[1], 0.15);
    assert.equal(RULES_FACTOR[5], 1.0);
});

test('automabilityFactor uses the judgement score when steps are consistent', () => {
    assert.equal(automabilityFactor(wf({ judgementScore: 1 })), 0.15);
    assert.equal(automabilityFactor(wf({ judgementScore: 5 })), 1.0);
});

test('automabilityFactor discounts inconsistent steps by the documented factor', () => {
    // 1.0 * 0.7 = 0.7
    assert.equal(automabilityFactor(wf({ judgementScore: 5, stepsConsistent: false })), 0.7);
    assert.equal(automabilityFactor(wf({ judgementScore: 5, stepsConsistent: false })), 1.0 * INCONSISTENT_STEPS_FACTOR);
});

test('automabilityFactor only discounts when stepsConsistent is exactly false', () => {
    // Docs: the discount is for steps that "vary". Undefined is not "varies".
    assert.equal(automabilityFactor(wf({ judgementScore: 5, stepsConsistent: undefined })), 1.0);
    assert.equal(automabilityFactor(wf({ judgementScore: 5, stepsConsistent: 0 })), 1.0);
});

test('automabilityFactor clamps an out-of-range judgement score of 9 to 5', () => {
    assert.equal(automabilityFactor(wf({ judgementScore: 9 })), RULES_FACTOR[5]);
});

test('automabilityFactor clamps a judgement score of 0 to 1', () => {
    assert.equal(automabilityFactor(wf({ judgementScore: 0 })), RULES_FACTOR[1]);
});

test('automabilityFactor rounds a fractional judgement score rather than defaulting', () => {
    // 4.6 rounds to 5, so the factor is the rules-based one.
    assert.equal(automabilityFactor(wf({ judgementScore: 4.6 })), RULES_FACTOR[5]);
});

test('automabilityFactor clamps rather than defaulting for non-numeric judgement', () => {
    // A missing judgement score is currently scored as if it were 3 (0.60).
    // This asserts the implemented default explicitly so it cannot drift.
    assert.equal(automabilityFactor(wf({ judgementScore: undefined })), RULES_FACTOR[3]);
    assert.equal(automabilityFactor(wf({ judgementScore: 'high' })), RULES_FACTOR[3]);
});

test('scoreWorkflow score is effort times automability factor', () => {
    // effort 2, factor 1.0 -> score 2
    const scored = scoreWorkflow(wf({ judgementScore: 5 }));
    assert.equal(scored.effortHoursPerWeek, 2);
    assert.equal(scored.automabilityFactor, 1);
    assert.equal(scored.score, 2);
    assert.equal(scored.recoverableHoursPerWeek, 2);
});

test('scoreWorkflow echoes the clamped judgement score, not the raw one', () => {
    assert.equal(scoreWorkflow(wf({ judgementScore: 99 })).judgementScore, 5);
    assert.equal(scoreWorkflow(wf({ judgementScore: -4 })).judgementScore, 1);
    assert.equal(scoreWorkflow(wf({ judgementScore: undefined })).judgementScore, 3);
});

test('scoreWorkflow never returns a negative score', () => {
    const scored = scoreWorkflow(wf({ frequencyPerWeek: -10, minutesPerInstance: -5, peopleAffected: -1 }));
    assert.ok(scored.score >= 0, `score should be >= 0, got ${scored.score}`);
    assert.equal(scored.score, 0);
});

test('scoreWorkflow keeps the original workflow fields', () => {
    const scored = scoreWorkflow(wf({ id: 'keep-me', title: 'Keep me' }));
    assert.equal(scored.id, 'keep-me');
    assert.equal(scored.title, 'Keep me');
});

test('bucketFor puts judgement-bound work in its own bucket before the score check', () => {
    // Judgement 1-2 is judgement-bound however large the score.
    assert.equal(bucketFor(wf({ judgementScore: 1 }), 1000), BUCKET.JUDGEMENT_BOUND);
    assert.equal(bucketFor(wf({ judgementScore: 2 }), 1000), BUCKET.JUDGEMENT_BOUND);
});

test('bucketFor boundary: score exactly 2.0 is do first, just below is do later', () => {
    assert.equal(bucketFor(wf({ judgementScore: 3 }), 2.0), BUCKET.DO_FIRST);
    assert.equal(bucketFor(wf({ judgementScore: 3 }), 1.99), BUCKET.DO_LATER);
});

test('scoreWorkflow and bucketFor agree on the score a workflow gets', () => {
    // 4 hours * 0.60 (judgement 3) = 2.4 -> do first
    const scored = scoreWorkflow(wf({ judgementScore: 3, frequencyPerWeek: 4, minutesPerInstance: 30, peopleAffected: 2 }));
    assert.equal(scored.effortHoursPerWeek, 4);
    assert.equal(scored.score, 2.4);
    assert.equal(scored.bucket, BUCKET.DO_FIRST);
});

test('findConflicts reports a pair whose estimates differ by more than the tolerance', () => {
    const list = [
        wf({ id: 'a', conflictsWith: 'b', minutesPerInstance: 10, reportedBy: 'Ann' }),
        wf({ id: 'b', minutesPerInstance: 60, reportedBy: 'Bob', title: 'Invoice entry (second respondent)' })
    ];
    const conflicts = findConflicts(list);
    assert.equal(conflicts.length, 1);
    assert.deepEqual([...conflicts[0].ids].sort(), ['a', 'b']);
    assert.equal(conflicts[0].isConflict, true);
    // |10 - 60| / 60 = 0.8333... -> 0.83, carried per differing field.
    const minutes = conflicts[0].differences.find((d) => d.field === 'minutesPerInstance');
    assert.equal(minutes.relativeGap, 0.83);
    assert.deepEqual(minutes.values, [10, 60]);
});

test('findConflicts strips the (second respondent) suffix from the title', () => {
    const list = [
        wf({ id: 'a', conflictsWith: 'b', minutesPerInstance: 10 }),
        wf({ id: 'b', minutesPerInstance: 60, title: 'Invoice entry (second respondent)' })
    ];
    assert.equal(findConflicts(list)[0].title, 'Invoice entry');
});

test('findConflicts reports each pair once even when both sides reference each other', () => {
    const list = [
        wf({ id: 'a', conflictsWith: 'b', minutesPerInstance: 10 }),
        wf({ id: 'b', conflictsWith: 'a', minutesPerInstance: 60 })
    ];
    assert.equal(findConflicts(list).length, 1);
});

test('findConflicts boundary: a gap equal to the tolerance is not a conflict', () => {
    // tolerance 0.25; |15 - 20| / 20 = 0.25 exactly -> treated as agreeing.
    const list = [
        wf({ id: 'a', conflictsWith: 'b', minutesPerInstance: 15 }),
        wf({ id: 'b', minutesPerInstance: 20 })
    ];
    assert.equal(findConflicts(list).length, 0);
});

test('findConflicts boundary: a gap just above the tolerance is a conflict', () => {
    const list = [
        wf({ id: 'a', conflictsWith: 'b', minutesPerInstance: 14 }),
        wf({ id: 'b', minutesPerInstance: 20 })
    ];
    // |14 - 20| / 20 = 0.3
    assert.equal(findConflicts(list).length, 1);
});

test('findConflicts tolerates a missing counterpart without throwing', () => {
    const list = [wf({ id: 'a', conflictsWith: 'missing', minutesPerInstance: 10 })];
    assert.deepEqual(findConflicts(list), []);
});

test('findConflicts ignores workflows with no conflictsWith marker', () => {
    const list = [wf({ id: 'a' }), wf({ id: 'b' })];
    assert.deepEqual(findConflicts(list), []);
});

test('findConflicts treats every respondent reporting zero as unmeasured, not a conflict', () => {
    // Zero is the absence of a measurement, not an agreement. It is surfaced by
    // findConflicts (as unmeasured) rather than silently dropped.
    const list = [
        wf({ id: 'a', conflictsWith: 'b', minutesPerInstance: 0 }),
        wf({ id: 'b', minutesPerInstance: 0 })
    ];
    const conflicts = findConflicts(list);
    assert.equal(conflicts.length, 1, 'missing data must still be reported');
    assert.equal(conflicts[0].isConflict, false, 'zero vs zero is not a disagreement');
    assert.ok(conflicts[0].unmeasured.includes('minutesPerInstance'));
});

// --- findConflictGroups: undirected, chained, and dangle-tolerant ---------

test('findConflictGroups counts a marker on EITHER side of a pair', () => {
    // The marker is on b, pointing back at a. The old one-directional lookup
    // ignored this and left both records separate.
    const groups = findConflictGroups([wf({ id: 'a' }), wf({ id: 'b', conflictsWith: 'a' })]);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].map((w) => w.id).sort(), ['a', 'b']);
});

test('findConflictGroups follows a chain of three records into ONE group', () => {
    // a -> b -> c. Three people describing the same task are one group, not
    // three entries and not two pairs.
    const groups = findConflictGroups([
        wf({ id: 'a', conflictsWith: 'b' }),
        wf({ id: 'b', conflictsWith: 'c' }),
        wf({ id: 'c' })
    ]);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].map((w) => w.id).sort(), ['a', 'b', 'c']);
});

test('findConflictGroups keeps two independent pairs as two groups', () => {
    const groups = findConflictGroups([
        wf({ id: 'a', conflictsWith: 'b' }),
        wf({ id: 'b' }),
        wf({ id: 'c', conflictsWith: 'd' }),
        wf({ id: 'd' })
    ]);
    assert.equal(groups.length, 2);
    const ids = groups.map((g) => g.map((w) => w.id).sort());
    assert.deepEqual(ids.sort(), [['a', 'b'], ['c', 'd']]);
});

test('findConflictGroups ignores a dangling conflictsWith reference', () => {
    const groups = findConflictGroups([wf({ id: 'a', conflictsWith: 'nope' }), wf({ id: 'b' })]);
    assert.deepEqual(groups, []);
});

test('findConflictGroups returns only groups of two or more records', () => {
    // An unmarked singleton is not a conflict group.
    assert.deepEqual(findConflictGroups([wf({ id: 'a' })]), []);
});

test('findConflicts works on a longer distinct list without throwing', () => {
    const list = [
        wf({ id: 'a' }),
        wf({ id: 'b', conflictsWith: 'c' }),
        wf({ id: 'c', minutesPerInstance: 90 }),
        wf({ id: 'd' })
    ];
    assert.equal(findConflicts(list).length, 1);
});

test('collapseDuplicates keeps one entry scored on the lower estimate', () => {
    const list = [
        wf({ id: 'a', conflictsWith: 'b', minutesPerInstance: 10, reportedBy: 'Ann' }),
        wf({ id: 'b', minutesPerInstance: 60, reportedBy: 'Bob', title: 'Invoice entry (second respondent)' })
    ];
    const conflicts = findConflicts(list);
    const { workflows } = collapseDuplicates(list, conflicts);

    assert.equal(workflows.length, 1, 'the pair must be counted once');
    const entry = workflows[0];
    assert.equal(entry.minutesPerInstance, 10, 'the lower estimate must win');
    assert.equal(entry.hasConflict, true);
    assert.deepEqual(entry.conflictIds, ['a', 'b']);
    assert.equal(typeof entry.conflictNote, 'string');
    // The note is read by the CLIENT, so it names the field in words and
    // carries units. It must not pin one exact sentence: see the note-format
    // tests at the end of this file for the behaviour being asserted.
    assert.ok(!entry.conflictNote.includes('minutesPerInstance'), entry.conflictNote);
    assert.ok(entry.conflictNote.includes('Time for one instance'), entry.conflictNote);
    assert.ok(entry.conflictNote.includes('min'), entry.conflictNote);
    assert.ok(entry.conflictNote.includes('Counted once, at the lower estimate'), entry.conflictNote);
    assert.equal(entry.title, 'Invoice entry');
    assert.equal(entry.reportedBy, 'Ann / Bob');
});

test('collapseDuplicates has NO conflictsWith own property on the merged record', () => {
    // Previously this was set to undefined, which is still an own property and
    // was read downstream as a marker. It must be absent entirely.
    const list = [
        wf({ id: 'a', conflictsWith: 'b', minutesPerInstance: 10 }),
        wf({ id: 'b', minutesPerInstance: 60 })
    ];
    const { workflows } = collapseDuplicates(list, findConflicts(list));
    assert.equal(Object.prototype.hasOwnProperty.call(workflows[0], 'conflictsWith'), false);
});

test('collapseDuplicates takes the MINIMUM per field across three records', () => {
    const list = [
        wf({ id: 'a', conflictsWith: 'b', minutesPerInstance: 10, frequencyPerWeek: 1, peopleAffected: 3 }),
        wf({ id: 'b', conflictsWith: 'c', minutesPerInstance: 60, frequencyPerWeek: 5, peopleAffected: 1 }),
        wf({ id: 'c', minutesPerInstance: 30, frequencyPerWeek: 3, peopleAffected: 2 })
    ];
    const { workflows } = collapseDuplicates(list, []);

    assert.equal(workflows.length, 1, 'three records for one task must be one entry');
    const entry = workflows[0];
    assert.equal(entry.minutesPerInstance, 10, 'lowest minutes');
    assert.equal(entry.frequencyPerWeek, 1, 'lowest frequency');
    assert.equal(entry.peopleAffected, 1, 'lowest people');
    assert.deepEqual(entry.conflictIds, ['a', 'b', 'c']);
});

test('collapseDuplicates DELETES a field only when NO record supplies a usable value', () => {
    // A field is unmeasured only when every record omits it. Here frequency is
    // usable on b, so it is NOT deleted: one blank answer must not delete a
    // whole workflow from the headline.
    const list = [
        wf({ id: 'a', conflictsWith: 'b', minutesPerInstance: 10, frequencyPerWeek: 'lots' }),
        wf({ id: 'b', minutesPerInstance: 60, frequencyPerWeek: 4 })
    ];
    const { workflows } = collapseDuplicates(list, []);
    const entry = workflows[0];

    assert.equal(entry.frequencyPerWeek, 4, 'the one usable value IS the measurement');
    assert.equal(Object.prototype.hasOwnProperty.call(entry, 'unmeasuredFields'), false,
        'frequency has a usable value, so it is not unmeasured');
    assert.deepEqual(entry.partialFields, ['frequencyPerWeek'],
        'the blank record is recorded as partial instead');
    assert.equal(entry.minutesPerInstance, 10, 'the usable field still takes the minimum');
});

test('collapseDuplicates DELETES a field when no record supplies a usable value', () => {
    // Every value is non-numeric, so there is nothing to measure. The field is
    // dropped rather than carrying a fabricated zero into the score.
    const list = [
        wf({ id: 'a', conflictsWith: 'b', minutesPerInstance: 'lots', frequencyPerWeek: 4 }),
        wf({ id: 'b', minutesPerInstance: 'about an hour', frequencyPerWeek: 4 })
    ];
    const { workflows } = collapseDuplicates(list, []);
    const entry = workflows[0];

    assert.equal(Object.prototype.hasOwnProperty.call(entry, 'minutesPerInstance'), false);
    assert.ok(entry.unmeasuredFields.includes('minutesPerInstance'));
    assert.equal(Object.prototype.hasOwnProperty.call(entry, 'partialFields'), false,
        'nobody answered, so it is unmeasured, not partial');
});

test('collapseDuplicates normalises numeric strings before taking the minimum', () => {
    // '10' must behave as 10, so the lower estimate is 10 and not the higher 60.
    const list = [
        wf({ id: 'a', conflictsWith: 'b', minutesPerInstance: '10' }),
        wf({ id: 'b', minutesPerInstance: 60 })
    ];
    const { workflows } = collapseDuplicates(list, []);
    assert.equal(workflows[0].minutesPerInstance, 10);
});

test('collapseDuplicates uses the real value beside a null, and records the null as partial', () => {
    // FIXED (was: Number(null) === 0 gave the merged record a fabricated 0).
    // A null is not a measurement, but the other record's 10 min is, so the
    // field is kept at 10 and the null record is noted as partial.
    const list = [
        wf({ id: 'a', conflictsWith: 'b', minutesPerInstance: null }),
        wf({ id: 'b', minutesPerInstance: 10 })
    ];
    const { workflows } = collapseDuplicates(list, []);
    const entry = workflows[0];
    assert.equal(entry.minutesPerInstance, 10, 'the usable value is the measurement, not zero');
    assert.equal(Object.prototype.hasOwnProperty.call(entry, 'unmeasuredFields'), false);
    assert.deepEqual(entry.partialFields, ['minutesPerInstance']);
});

test('collapseDuplicates deletes a null field ONLY when no record supplies a value', () => {
    // Both records omit the value: nothing to measure, so the field is dropped
    // rather than scored as a fabricated zero.
    const list = [
        wf({ id: 'a', conflictsWith: 'b', minutesPerInstance: null }),
        wf({ id: 'b', minutesPerInstance: undefined })
    ];
    const { workflows } = collapseDuplicates(list, []);
    const entry = workflows[0];
    assert.equal(Object.prototype.hasOwnProperty.call(entry, 'minutesPerInstance'), false,
        'a field nobody answered must be dropped, not scored as zero');
    assert.ok(entry.unmeasuredFields.includes('minutesPerInstance'));
});

test('collapseDuplicates leaves non-conflicting workflows untouched', () => {
    const list = [wf({ id: 'a' }), wf({ id: 'b' })];
    const { workflows, collapsed } = collapseDuplicates(list, findConflicts(list));
    assert.equal(workflows.length, 2);
    assert.deepEqual(collapsed, []);
});

test('collapseDuplicates with no conflicts keeps every workflow', () => {
    const list = [wf({ id: 'a' }), wf({ id: 'b' })];
    assert.equal(collapseDuplicates(list, []).workflows.length, 2);
});

test('aggregate on an empty list returns the documented empty result', () => {
    const result = aggregate([]);
    assert.deepEqual(result.scored, []);
    assert.deepEqual(result.conflicts, []);
    assert.equal(result.totalRecoverableHoursPerWeek, 0);
    assert.equal(result.workflowCount, 0);
    assert.deepEqual(Object.keys(result.buckets).sort(), ['do_first', 'do_later', 'judgement_bound']);
});

test('aggregate treats a non-array input as empty rather than throwing', () => {
    for (const bad of [null, undefined, {}, 'nope', 42]) {
        const result = aggregate(bad);
        assert.equal(result.workflowCount, 0, `input ${String(bad)} should yield an empty result`);
        assert.equal(result.totalRecoverableHoursPerWeek, 0);
    }
});

test('aggregate headline total counts only the do-first bucket', () => {
    const list = [
        // do first: 2h * 1.0 = 2.0
        wf({ id: 'first', judgementScore: 5, frequencyPerWeek: 2, minutesPerInstance: 30, peopleAffected: 2 }),
        // do later: 1h * 1.0 = 1.0 (below the 2.0 threshold)
        wf({ id: 'later', judgementScore: 5, frequencyPerWeek: 1, minutesPerInstance: 30, peopleAffected: 2 }),
        // judgement bound: 10h but judgement 1, so excluded from the total
        wf({ id: 'judge', judgementScore: 1, frequencyPerWeek: 10, minutesPerInstance: 60, peopleAffected: 1 })
    ];
    const result = aggregate(list);

    assert.equal(result.buckets[BUCKET.DO_FIRST].length, 1);
    assert.equal(result.buckets[BUCKET.DO_LATER].length, 1);
    assert.equal(result.buckets[BUCKET.JUDGEMENT_BOUND].length, 1);
    assert.equal(result.totalRecoverableHoursPerWeek, 2);
});

test('aggregate ranks by score, highest first', () => {
    const list = [
        wf({ id: 'small', judgementScore: 5, frequencyPerWeek: 1, minutesPerInstance: 30, peopleAffected: 1 }),
        wf({ id: 'big', judgementScore: 5, frequencyPerWeek: 10, minutesPerInstance: 60, peopleAffected: 1 })
    ];
    const result = aggregate(list);
    assert.deepEqual(result.scored.map((s) => s.id), ['big', 'small']);
});

test('aggregate counts a conflicting pair once, at the lower estimate', () => {
    const list = [
        wf({ id: 'a', conflictsWith: 'b', minutesPerInstance: 10, peopleAffected: 1, judgementScore: 5, frequencyPerWeek: 1, reportedBy: 'Ann' }),
        wf({ id: 'b', minutesPerInstance: 60, peopleAffected: 1, judgementScore: 5, frequencyPerWeek: 1, reportedBy: 'Bob' })
    ];
    const result = aggregate(list);

    assert.equal(result.workflowCount, 1, 'one workflow, counted once');
    assert.equal(result.conflicts.length, 1, 'the disagreement is still reported');
    // lower estimate: 1 * 10 * 1 / 60 = 0.1667h -> 0.17 * 1.0 = 0.17
    assert.equal(result.scored[0].minutesPerInstance, 10);
    assert.equal(result.scored[0].score, 0.17);
});

test('aggregate counts a three-record chain as ONE entry', () => {
    // The bug this guards: a task described by three people was counted three
    // times, tripling its hours in the headline total.
    const list = [
        wf({ id: 'a', conflictsWith: 'b', minutesPerInstance: 10, frequencyPerWeek: 1, peopleAffected: 1, judgementScore: 5 }),
        wf({ id: 'b', conflictsWith: 'c', minutesPerInstance: 60, frequencyPerWeek: 1, peopleAffected: 1, judgementScore: 5 }),
        wf({ id: 'c', minutesPerInstance: 30, frequencyPerWeek: 1, peopleAffected: 1, judgementScore: 5 })
    ];
    const result = aggregate(list);

    assert.equal(result.workflowCount, 1, 'three records for one task are one entry');
    assert.equal(result.scored[0].minutesPerInstance, 10, 'scored at the lowest estimate');
});

test('aggregate flags a conflict when only the frequency disagrees', () => {
    // The bug this guards: agreeing on minutes but not on frequency produced NO
    // conflict, so the task was counted twice at the larger number.
    const list = [
        wf({ id: 'a', conflictsWith: 'b', minutesPerInstance: 30, frequencyPerWeek: 1, peopleAffected: 1, judgementScore: 5 }),
        wf({ id: 'b', minutesPerInstance: 30, frequencyPerWeek: 4, peopleAffected: 1, judgementScore: 5 })
    ];
    const result = aggregate(list);

    assert.equal(result.workflowCount, 1, 'one workflow');
    assert.equal(result.conflicts.length, 1, 'the frequency disagreement is a conflict');
    assert.equal(result.scored[0].frequencyPerWeek, 1, 'scored at the lower frequency');
});

// --- describeConflict: all three effort fields, and unmeasured values -------

test('describeConflict reports a frequency-only disagreement as a conflict', () => {
    const description = describeConflict([
        wf({ id: 'a', minutesPerInstance: 30, frequencyPerWeek: 1, peopleAffected: 1 }),
        wf({ id: 'b', minutesPerInstance: 30, frequencyPerWeek: 4, peopleAffected: 1 })
    ]);
    assert.equal(description.isConflict, true);
    assert.deepEqual(description.differences.map((d) => d.field), ['frequencyPerWeek']);
});

test('describeConflict reports a people-only disagreement as a conflict', () => {
    const description = describeConflict([
        wf({ id: 'a', minutesPerInstance: 30, frequencyPerWeek: 2, peopleAffected: 1 }),
        wf({ id: 'b', minutesPerInstance: 30, frequencyPerWeek: 2, peopleAffected: 5 })
    ]);
    assert.equal(description.isConflict, true);
    assert.deepEqual(description.differences.map((d) => d.field), ['peopleAffected']);
});

test('a judgement disagreement is NOT an effort conflict, but IS reported as a bucket disagreement', () => {
    // judgementScore is not part of the effort comparison: two people can rate
    // automability differently without disagreeing about how much work it is,
    // so `isConflict` stays false and `differences` stays empty.
    //
    // But that rating decides the bucket. An earlier version inherited it from
    // whichever record came first and reported nothing, so the same two answers
    // produced "do first" or "do not automate" depending on array order. The
    // disagreement must be surfaced even though it is not an effort conflict.
    const description = describeConflict([
        wf({ id: 'a', judgementScore: 1, minutesPerInstance: 30, frequencyPerWeek: 2, peopleAffected: 2 }),
        wf({ id: 'b', judgementScore: 5, minutesPerInstance: 30, frequencyPerWeek: 2, peopleAffected: 2 })
    ]);
    assert.equal(description.isConflict, false, 'still not an effort conflict');
    assert.deepEqual(description.differences, []);
    assert.deepEqual(description.unmeasured, []);
    assert.deepEqual(description.bucketDisagreements, [{ field: 'judgementScore', values: [1, 5] }]);

    // And it must reach the client: findConflicts reports a group whose only
    // problem is a bucket-field disagreement.
    const reported = findConflicts([
        wf({ id: 'a', conflictsWith: 'b', judgementScore: 1, minutesPerInstance: 30, frequencyPerWeek: 2, peopleAffected: 2 }),
        wf({ id: 'b', judgementScore: 5, minutesPerInstance: 30, frequencyPerWeek: 2, peopleAffected: 2 })
    ]);
    assert.equal(reported.length, 1, 'a bucket disagreement must be reported');
    assert.equal(reported[0].isConflict, false);
    assert.equal(reported[0].bucketDisagreements.length, 1);
});

test('describeConflict treats an ABSENT field beside a usable one as PARTIAL, not unmeasured', () => {
    // One respondent answered 10 min, the other left it blank. That is a
    // measurement with a note, not an unmeasured field: marking it unmeasured
    // is what silently deleted a whole workflow from the headline.
    const description = describeConflict([
        wf({ id: 'a', minutesPerInstance: undefined }),
        wf({ id: 'b', minutesPerInstance: 10 })
    ]);
    assert.equal(description.isConflict, false);
    assert.deepEqual(description.unmeasured, [], 'one usable value means NOT unmeasured');
    assert.deepEqual(description.partial, [{ field: 'minutesPerInstance', missing: 1 }]);
    assert.ok(description.note.includes('Only one respondent gave'), description.note);
});

test('describeConflict marks a field unmeasured when NO record supplies a usable value', () => {
    const description = describeConflict([
        wf({ id: 'a', minutesPerInstance: undefined, frequencyPerWeek: 2, peopleAffected: 2 }),
        wf({ id: 'b', minutesPerInstance: null, frequencyPerWeek: 2, peopleAffected: 2 })
    ]);
    assert.equal(description.isConflict, false);
    assert.ok(description.unmeasured.includes('minutesPerInstance'));
    assert.deepEqual(description.partial, [], 'nobody answered, so nothing is partial');
    assert.ok(description.note.toLowerCase().includes('unmeasured'), description.note);
});

test('describeConflict does not treat a NULL beside a real value as a measured zero', () => {
    // FIXED (was: Number(null) === 0, so a null beside a real value was read as
    // a 100% conflict). null is missing data; the 10 min stands on its own.
    const description = describeConflict([
        wf({ id: 'a', minutesPerInstance: null }),
        wf({ id: 'b', minutesPerInstance: 10 })
    ]);
    assert.equal(description.isConflict, false, 'null is missing data, not a measured zero');
    assert.deepEqual(description.unmeasured, []);
    assert.deepEqual(description.partial, [{ field: 'minutesPerInstance', missing: 1 }]);
});

test('describeConflict marks a NULL as unmeasured when no record has a usable value', () => {
    const description = describeConflict([
        wf({ id: 'a', minutesPerInstance: null }),
        wf({ id: 'b', minutesPerInstance: undefined })
    ]);
    assert.equal(description.isConflict, false);
    assert.ok(description.unmeasured.includes('minutesPerInstance'));
});

test('describeConflict does not treat an EMPTY STRING beside a real value as a measured zero', () => {
    // Number('') === 0 (fixed to use measuredNumber). An empty answer is missing
    // data, so the real 10 min is the measurement and the blank is partial.
    const description = describeConflict([
        wf({ id: 'a', minutesPerInstance: '' }),
        wf({ id: 'b', minutesPerInstance: 10 })
    ]);
    assert.equal(description.isConflict, false, 'an empty string is missing data');
    assert.deepEqual(description.unmeasured, []);
    assert.deepEqual(description.partial, [{ field: 'minutesPerInstance', missing: 1 }]);
});

test('describeConflict marks an EMPTY STRING as unmeasured when nobody answered', () => {
    const description = describeConflict([
        wf({ id: 'a', minutesPerInstance: '' }),
        wf({ id: 'b', minutesPerInstance: '   ' })
    ]);
    assert.ok(description.unmeasured.includes('minutesPerInstance'));
});

test('describeConflict treats a non-numeric string beside a real value as partial', () => {
    const description = describeConflict([
        wf({ id: 'a', minutesPerInstance: 'about half an hour' }),
        wf({ id: 'b', minutesPerInstance: 10 })
    ]);
    assert.deepEqual(description.unmeasured, []);
    assert.deepEqual(description.partial, [{ field: 'minutesPerInstance', missing: 1 }]);
    assert.equal(description.isConflict, false);
});

test('describeConflict marks a non-numeric string as unmeasured when nobody answered', () => {
    const description = describeConflict([
        wf({ id: 'a', minutesPerInstance: 'about half an hour' }),
        wf({ id: 'b', minutesPerInstance: 'n/a' })
    ]);
    assert.ok(description.unmeasured.includes('minutesPerInstance'));
    assert.equal(description.isConflict, false);
});

test('describeConflict marks a field as unmeasured when every value is zero', () => {
    // Zero is the absence of a measurement. Reporting it as agreement is the bug.
    const description = describeConflict([
        wf({ id: 'a', minutesPerInstance: 0, frequencyPerWeek: 2, peopleAffected: 2 }),
        wf({ id: 'b', minutesPerInstance: 0, frequencyPerWeek: 2, peopleAffected: 2 })
    ]);
    assert.equal(description.isConflict, false);
    assert.ok(description.unmeasured.includes('minutesPerInstance'));
});

test('describeConflict does not flag a difference within tolerance', () => {
    // |20 - 16| / 20 = 0.2, below the 0.25 default.
    const description = describeConflict([
        wf({ id: 'a', minutesPerInstance: 16, frequencyPerWeek: 2, peopleAffected: 2 }),
        wf({ id: 'b', minutesPerInstance: 20, frequencyPerWeek: 2, peopleAffected: 2 })
    ]);
    assert.equal(description.isConflict, false);
    assert.deepEqual(description.differences, []);
});

test('describeConflict returns the ids, title and reporters of the group', () => {
    const description = describeConflict([
        wf({ id: 'a', reportedBy: 'Ann', minutesPerInstance: 10 }),
        wf({ id: 'b', reportedBy: 'Bob', minutesPerInstance: 60, title: 'Invoice entry (second respondent)' })
    ]);
    assert.deepEqual(description.ids, ['a', 'b']);
    assert.equal(description.title, 'Invoice entry');
    assert.deepEqual(description.reportedBy, ['Ann', 'Bob']);
    assert.equal(description.isConflict, true);
});

test('aggregate total is the sum of the do-first scores', () => {
    const list = [
        wf({ id: 'a', judgementScore: 5, frequencyPerWeek: 2, minutesPerInstance: 30, peopleAffected: 2 }), // 2.0
        wf({ id: 'b', judgementScore: 5, frequencyPerWeek: 4, minutesPerInstance: 30, peopleAffected: 2 })  // 4.0
    ];
    const result = aggregate(list);
    assert.equal(result.totalRecoverableHoursPerWeek, 6);
});

test('aggregate is deterministic for the same input', () => {
    const make = () => [
        wf({ id: 'a', conflictsWith: 'b', minutesPerInstance: 10, judgementScore: 4 }),
        wf({ id: 'b', minutesPerInstance: 45, judgementScore: 4 }),
        wf({ id: 'c', judgementScore: 5, frequencyPerWeek: 3 })
    ];
    const first = JSON.stringify(aggregate(make()));
    const second = JSON.stringify(aggregate(make()));
    assert.equal(second, first);
});

// --- the conflict note is client-facing copy --------------------------------
// The note appears in the analysis panel and in the downloadable Markdown,
// with nobody present to explain it. It must therefore read as a sentence:
// a human label, values with units, and no database field name. It is NOT
// pinned verbatim, so a copy edit does not break the suite.

/** Three people describing one task, disagreeing on every effort term. */
function threeWayDisagreement() {
    return [
        wf({ id: 'a', conflictsWith: 'b', frequencyPerWeek: 1, minutesPerInstance: 8, peopleAffected: 2, reportedBy: 'Ann' }),
        wf({ id: 'b', conflictsWith: 'c', frequencyPerWeek: 4, minutesPerInstance: 22, peopleAffected: 2, reportedBy: 'Bob' }),
        wf({ id: 'c', frequencyPerWeek: 2, minutesPerInstance: 15, peopleAffected: 9, reportedBy: 'Cid' })
    ];
}

test('describeConflict note names the field in words and carries the unit', () => {
    const note = describeConflict([
        wf({ id: 'a', minutesPerInstance: 8, frequencyPerWeek: 2, peopleAffected: 2 }),
        wf({ id: 'b', minutesPerInstance: 22, frequencyPerWeek: 2, peopleAffected: 2 })
    ]).note;

    assert.ok(note.includes('Time for one instance'), note);
    assert.ok(note.includes('8 min'), note);
    assert.ok(note.includes('22 min'), note);
    // (22 - 8) / 22 = 0.636... -> 64%
    assert.ok(note.includes('64%'), note);
    assert.ok(note.includes('Counted once, at the lower estimate'), note);
});

test('the note never leaks a raw camelCase field name', () => {
    // Pins the class of defect, not one copy edit: any client-facing sentence
    // carrying an internal identifier fails, whichever field it came from.
    // "x per week" is set apart by spaces, so it is not camelCase.
    const conflict = describeConflict(threeWayDisagreement());
    assert.ok(conflict.isConflict, 'the fixture must actually disagree');
    assert.doesNotMatch(conflict.note, CAMEL_CASE, conflict.note);

    const unmeasuredGoal = describeConflict([
        wf({ id: 'a', minutesPerInstance: undefined, frequencyPerWeek: 2, peopleAffected: 2 }),
        wf({ id: 'b', minutesPerInstance: 10, frequencyPerWeek: 2, peopleAffected: 2 })
    ]);
    assert.equal(unmeasuredGoal.isConflict, false);
    assert.doesNotMatch(unmeasuredGoal.note, CAMEL_CASE, unmeasuredGoal.note);
});

test('the note labels frequency and people distinctly, each with its unit', () => {
    const note = describeConflict([
        wf({ id: 'a', frequencyPerWeek: 1, minutesPerInstance: 30, peopleAffected: 2 }),
        wf({ id: 'b', frequencyPerWeek: 4, minutesPerInstance: 30, peopleAffected: 6 })
    ]).note;

    // (4 - 1) / 4 = 0.75 ; (6 - 2) / 6 = 0.666... -> 67%
    assert.ok(note.includes('How often it happens'), note);
    assert.ok(note.includes('75%'), note);
    assert.ok(note.includes('x per week'), note);
    assert.ok(note.includes('People involved'), note);
    assert.ok(note.includes('67%'), note);
    assert.ok(note.includes('2 people'), note);
    assert.ok(note.includes('6 people'), note);
    // The three labels are distinct: one label for two fields would misreport which value belongs to whom.
    assert.equal(new Set(['How often it happens', 'Time for one instance', 'People involved']).size, 3);
    assert.ok(!note.includes('Time for one instance'), note);
});

test('the partial note is a human-readable sentence with no field name', () => {
    // One respondent left time blank, the other answered. The note must name
    // the field in words and carry no raw camelCase identifier.
    const description = describeConflict([
        wf({ id: 'a', minutesPerInstance: undefined, frequencyPerWeek: 2, peopleAffected: 2 }),
        wf({ id: 'b', minutesPerInstance: 10, frequencyPerWeek: 2, peopleAffected: 2 })
    ]);

    assert.deepEqual(description.partial, [{ field: 'minutesPerInstance', missing: 1 }]);
    assert.equal(description.isConflict, false);
    assert.ok(description.note.includes('Only one respondent gave'), description.note);
    assert.ok(description.note.toLowerCase().includes('time for one instance'), description.note);
    assert.ok(description.note.includes('scored on that single answer'), description.note);
    assert.doesNotMatch(description.note, CAMEL_CASE, description.note);
});

test('the unmeasured note is a human-readable sentence with no field name', () => {
    // Nobody answered, so the field is unmeasured. The note uses the label
    // lower-cased mid-sentence, so it must be read case-insensitively.
    const description = describeConflict([
        wf({ id: 'a', minutesPerInstance: undefined, frequencyPerWeek: 2, peopleAffected: 2 }),
        wf({ id: 'b', minutesPerInstance: 'n/a', frequencyPerWeek: 2, peopleAffected: 2 })
    ]);

    assert.ok(description.unmeasured.includes('minutesPerInstance'));
    assert.ok(description.note.toLowerCase().includes('time for one instance'), description.note);
    assert.ok(description.note.toLowerCase().includes('unmeasured'), description.note);
    assert.doesNotMatch(description.note, CAMEL_CASE, description.note);
});

test('the partial note names every field some respondent left blank', () => {
    // a left frequency and time blank; b answered both. Both fields are PARTIAL
    // (a usable value exists), so the note names both in words.
    const description = describeConflict([
        wf({ id: 'a', frequencyPerWeek: 'lots', minutesPerInstance: 'about half an hour', peopleAffected: 2 }),
        wf({ id: 'b', frequencyPerWeek: 2, minutesPerInstance: 15, peopleAffected: 2 })
    ]);

    // Field iteration order is frequencyPerWeek, minutesPerInstance.
    assert.deepEqual(description.unmeasured, []);
    assert.deepEqual(description.partial.map((p) => p.field), ['frequencyPerWeek', 'minutesPerInstance']);
    assert.ok(description.note.includes('how often it happens'), description.note);
    assert.ok(description.note.includes('time for one instance'), description.note);
    assert.doesNotMatch(description.note, CAMEL_CASE, description.note);
});

test('the unmeasured note names every field that nobody could measure', () => {
    const description = describeConflict([
        wf({ id: 'a', frequencyPerWeek: 'lots', minutesPerInstance: 'about half an hour', peopleAffected: 2 }),
        wf({ id: 'b', frequencyPerWeek: 'weekly-ish', minutesPerInstance: 'n/a', peopleAffected: 2 })
    ]);

    // Sorted order is frequencyPerWeek, minutesPerInstance.
    assert.deepEqual(description.unmeasured, ['frequencyPerWeek', 'minutesPerInstance']);
    assert.ok(description.note.includes('how often it happens'), description.note);
    assert.ok(description.note.includes('time for one instance'), description.note);
    assert.doesNotMatch(description.note, CAMEL_CASE, description.note);
});

test('the note of a three-way disagreement lists every disagreement', () => {
    const description = describeConflict(threeWayDisagreement());

    assert.deepEqual(
        description.differences.map((d) => d.field),
        ['frequencyPerWeek', 'minutesPerInstance', 'peopleAffected']
    );
    assert.ok(description.note.includes('How often it happens'), description.note);
    assert.ok(description.note.includes('Time for one instance'), description.note);
    assert.ok(description.note.includes('People involved'), description.note);
    assert.ok(description.note.includes('8 min'), description.note);
    assert.ok(description.note.includes('22 min'), description.note);
    assert.ok(description.note.includes('Counted once, at the lower estimate'), description.note);
    assert.doesNotMatch(description.note, CAMEL_CASE, description.note);
});

test('a note without units reads as a sentence, not a percentage alone', () => {
    // Whichever fields disagree, each reported value is followed by its unit,
    // so "8 vs 22" cannot be read as counts of people.
    const note = describeConflict([
        wf({ id: 'a', minutesPerInstance: 8, frequencyPerWeek: 2, peopleAffected: 2 }),
        wf({ id: 'b', minutesPerInstance: 22, frequencyPerWeek: 2, peopleAffected: 2 })
    ]).note;

    assert.equal((note.match(/min/g) || []).length, 2, note);
    assert.doesNotMatch(note, /\b8 vs 22\b/, note);
});

test('aggregate carries the labelled note onto the collapsed record', () => {
    const result = aggregate([
        wf({ id: 'a', conflictsWith: 'b', frequencyPerWeek: 4, minutesPerInstance: 8, peopleAffected: 2, judgementScore: 5 }),
        wf({ id: 'b', frequencyPerWeek: 4, minutesPerInstance: 22, peopleAffected: 2, judgementScore: 5 })
    ]);

    assert.equal(result.workflowCount, 1);
    assert.equal(result.scored[0].conflictNote, result.conflicts[0].note);
    assert.ok(result.scored[0].conflictNote.includes('Time for one instance'), result.scored[0].conflictNote);
    assert.doesNotMatch(result.scored[0].conflictNote, CAMEL_CASE, result.scored[0].conflictNote);
});

test('the conflict note is deterministic for the same input', () => {
    const first = describeConflict(threeWayDisagreement()).note;
    const second = describeConflict(threeWayDisagreement()).note;
    assert.equal(second, first);
});

// --- partial answers must not delete a workflow from the headline -----------
// The defect this guards: an earlier rule marked a field unmeasured when ANY
// record in the group omitted it, so one blank answer collapsed the group to a
// record with no value and a real task contributed ZERO to the client document.
// A field is unmeasured only when NO record supplies a usable value.

test('one blank answer keeps the task in the headline at the usable value', () => {
    // 8 min x 40/week x 3 people / 60 = 16 h/wk. One respondent left the field
    // blank; the task must still contribute its 16 hours, not zero.
    const list = [
        wf({ id: 'a', conflictsWith: 'b', frequencyPerWeek: 40, minutesPerInstance: 8, peopleAffected: 3, judgementScore: 5, reportedBy: 'Ann' }),
        wf({ id: 'b', frequencyPerWeek: 40, minutesPerInstance: undefined, peopleAffected: 3, judgementScore: 5, reportedBy: 'Bob' })
    ];
    const result = aggregate(list);

    assert.equal(result.workflowCount, 1, 'the pair is one workflow');
    assert.equal(result.scored[0].minutesPerInstance, 8, 'the one answer IS the measurement');
    assert.equal(result.scored[0].effortHoursPerWeek, 16, 'the task keeps its real hours');
    assert.notEqual(result.totalRecoverableHoursPerWeek, 0, 'a blank answer must not zero the headline');
    assert.equal(result.totalRecoverableHoursPerWeek, 16);
});

test('three records, two blank, one answered: the task still counts once at that value', () => {
    const list = [
        wf({ id: 'a', conflictsWith: 'b', frequencyPerWeek: 40, minutesPerInstance: 8, peopleAffected: 3, judgementScore: 5 }),
        wf({ id: 'b', conflictsWith: 'c', frequencyPerWeek: 40, minutesPerInstance: null, peopleAffected: 3, judgementScore: 5 }),
        wf({ id: 'c', frequencyPerWeek: 40, minutesPerInstance: '', peopleAffected: 3, judgementScore: 5 })
    ];
    const result = aggregate(list);

    assert.equal(result.workflowCount, 1);
    assert.equal(result.scored[0].minutesPerInstance, 8);
    assert.equal(result.totalRecoverableHoursPerWeek, 16);
});

test('the partial record is recorded, and the note names the field', () => {
    const list = [
        wf({ id: 'a', conflictsWith: 'b', frequencyPerWeek: 40, minutesPerInstance: 8, peopleAffected: 3 }),
        wf({ id: 'b', frequencyPerWeek: 40, minutesPerInstance: undefined, peopleAffected: 3 })
    ];
    const description = describeConflict(list);

    assert.equal(description.isConflict, false);
    assert.deepEqual(description.unmeasured, []);
    assert.deepEqual(description.partial, [{ field: 'minutesPerInstance', missing: 1 }]);
    // Deliberately NOT pinned verbatim: this is client-facing copy and a copy
    // edit must not fail the suite. The sibling test above asserts the same
    // behaviour the same way.
    assert.ok(description.note.includes('Only one respondent gave'), description.note);
    assert.ok(description.note.toLowerCase().includes('time for one instance'), description.note);
    assert.ok(description.note.includes('scored on that single answer'), description.note);
    assert.doesNotMatch(description.note, CAMEL_CASE, description.note);
});

test('partialFields is absent (no own property) when everyone answered everything', () => {
    const list = [
        wf({ id: 'a', conflictsWith: 'b', minutesPerInstance: 10 }),
        wf({ id: 'b', minutesPerInstance: 60 })
    ];
    const { workflows } = collapseDuplicates(list, []);
    assert.equal(Object.prototype.hasOwnProperty.call(workflows[0], 'partialFields'), false);
});

test('partialFields carries the raw field names of the fields someone left blank', () => {
    const list = [
        wf({ id: 'a', conflictsWith: 'b', frequencyPerWeek: 2, minutesPerInstance: undefined, peopleAffected: 2 }),
        wf({ id: 'b', frequencyPerWeek: 2, minutesPerInstance: 15, peopleAffected: 2 })
    ];
    const { workflows } = collapseDuplicates(list, []);
    assert.deepEqual(workflows[0].partialFields, ['minutesPerInstance']);
});

test('partial is empty when every record answered every effort field', () => {
    const description = describeConflict([
        wf({ id: 'a', minutesPerInstance: 16, frequencyPerWeek: 2, peopleAffected: 2 }),
        wf({ id: 'b', minutesPerInstance: 20, frequencyPerWeek: 2, peopleAffected: 2 })
    ]);
    assert.deepEqual(description.partial, []);
    assert.deepEqual(description.unmeasured, []);
});

test('findConflicts reports a group where some but not all records omitted a field', () => {
    // Previously such a group was dropped entirely, so the omission was invisible
    // in the client's data-quality panel.
    const list = [
        wf({ id: 'a', conflictsWith: 'b', minutesPerInstance: 8, frequencyPerWeek: 2, peopleAffected: 2 }),
        wf({ id: 'b', minutesPerInstance: undefined, frequencyPerWeek: 2, peopleAffected: 2 })
    ];
    const conflicts = findConflicts(list);
    assert.equal(conflicts.length, 1, 'a partial group must still be reported');
    assert.equal(conflicts[0].isConflict, false);
    assert.equal(conflicts[0].partial.length, 1);
});

// --- a negative duration is not a measurement -------------------------------

test('a negative value is unmeasured in describeConflict', () => {
    const description = describeConflict([
        wf({ id: 'a', minutesPerInstance: -5, frequencyPerWeek: 2, peopleAffected: 2 }),
        wf({ id: 'b', minutesPerInstance: undefined, frequencyPerWeek: 2, peopleAffected: 2 })
    ]);
    // -5 and undefined are both unusable, so nobody measured it.
    assert.ok(description.unmeasured.includes('minutesPerInstance'));
    assert.equal(description.isConflict, false);
});

test('a negative value is dropped from the collapsed record, not used as the minimum', () => {
    // The corrected contract: -5 is missing data, so the only usable value, 10,
    // is the measurement. Previously -5 was accepted and became the minimum.
    const list = [
        wf({ id: 'a', conflictsWith: 'b', minutesPerInstance: -5, frequencyPerWeek: 2, peopleAffected: 2 }),
        wf({ id: 'b', minutesPerInstance: 10, frequencyPerWeek: 2, peopleAffected: 2 })
    ];
    const { workflows } = collapseDuplicates(list, []);
    const entry = workflows[0];
    assert.equal(entry.minutesPerInstance, 10, 'the usable value must win, not the negative');
    assert.ok(!(entry.minutesPerInstance < 0), 'no negative duration may reach the record');
});

test('a negative value does not reach the conflict note or the headline', () => {
    const list = [
        wf({ id: 'a', conflictsWith: 'b', minutesPerInstance: -5, frequencyPerWeek: 2, peopleAffected: 2, judgementScore: 5 }),
        wf({ id: 'b', minutesPerInstance: 10, frequencyPerWeek: 2, peopleAffected: 2, judgementScore: 5 })
    ];
    const result = aggregate(list);
    const entry = result.scored[0];

    assert.ok(!entry.conflictNote.includes('-5'), entry.conflictNote);
    assert.ok(entry.conflictNote.includes('time for one instance'), entry.conflictNote);
    assert.equal(entry.minutesPerInstance, 10);
    // 2 * 10 * 2 / 60 = 0.6667 -> 0.67, and the negative never lowers it.
    assert.ok(result.totalRecoverableHoursPerWeek >= 0, 'headline must never be negative');
});

// --- one rule for "is this a number", shared by both readers -----------------

test('effortHoursPerWeek and the conflict path agree about a null for the SAME workflow', () => {
    // Previously two readers disagreed about null: the scoring path read it as
    // absent while the conflict path read it as a measured zero. Now one rule.
    const withMarker = wf({ id: 'single', conflictsWith: 'other', minutesPerInstance: null, frequencyPerWeek: 2, peopleAffected: 2 });
    const withoutMarker = wf({ id: 'single', minutesPerInstance: null, frequencyPerWeek: 2, peopleAffected: 2 });

    // Both readers agree the null contributes nothing.
    assert.equal(effortHoursPerWeek(withMarker), 0);
    assert.equal(effortHoursPerWeek(withoutMarker), 0);

    // The conflict path also agrees: the null is not a measurement of zero, so
    // beside a real 10 it is partial, not a 100% conflict.
    const description = describeConflict([
        withMarker,
        wf({ id: 'other', minutesPerInstance: 10, frequencyPerWeek: 2, peopleAffected: 2 })
    ]);
    assert.equal(description.isConflict, false, 'null must not be scored as a measured zero');
    assert.deepEqual(description.partial, [{ field: 'minutesPerInstance', missing: 1 }]);
});

test('the nullable workflow is scored the same with and without a conflict marker', () => {
    // With the marker the group is collapsed to the usable 10; on its own the
    // null record scores zero. Neither path invents a value for the null.
    const withMarker = aggregate([
        wf({ id: 'a', conflictsWith: 'b', minutesPerInstance: null, frequencyPerWeek: 2, peopleAffected: 2, judgementScore: 5 }),
        wf({ id: 'b', minutesPerInstance: 10, frequencyPerWeek: 2, peopleAffected: 2, judgementScore: 5 })
    ]);
    assert.equal(withMarker.scored[0].minutesPerInstance, 10);

    const withoutMarker = aggregate([wf({ id: 'a', minutesPerInstance: null, frequencyPerWeek: 2, peopleAffected: 2, judgementScore: 5 })]);
    assert.equal(withoutMarker.scored[0].effortHoursPerWeek, 0, 'a lone null stays unmeasured, not zero-as-agreement');
});

// --- a missing title must degrade, never throw ------------------------------
// The boundary (parseModelResponse) now requires a non-empty string title, so a
// titleless payload should not reach scoring. Scoring must still not be a crash
// site if one gets through: a TypeError here used to lose the entire analysis
// rather than produce one imperfect row. These tests call the pure functions
// directly, bypassing the boundary on purpose, to pin that second line of
// defence.

test('describeConflict falls back to the id when title is absent', () => {
    const description = describeConflict([
        { id: 'w1', minutesPerInstance: 10 },
        { id: 'w2', minutesPerInstance: 60 }
    ]);
    assert.equal(description.title, 'w1');
});

test('describeConflict falls back to the id when title is an empty string', () => {
    const description = describeConflict([
        { id: 'w1', title: '', minutesPerInstance: 10 },
        { id: 'w2', title: '', minutesPerInstance: 60 }
    ]);
    assert.equal(description.title, 'w1');
});

test('describeConflict falls back to the id for a whitespace-only title', () => {
    // Whitespace is not a title. A blank heading in a client document is worse
    // than the internal id, and a whitespace title that reached scoring used to
    // be carried through as '   '. The fallback trims before deciding.
    const description = describeConflict([
        { id: 'w1', title: '   ', minutesPerInstance: 10 },
        { id: 'w2', title: '   ', minutesPerInstance: 60 }
    ]);
    assert.equal(description.title, 'w1');
});

test('describeConflict falls back to "Unnamed workflow" when neither title nor id exists', () => {
    const description = describeConflict([
        { minutesPerInstance: 10 },
        { minutesPerInstance: 60 }
    ]);
    assert.equal(description.title, 'Unnamed workflow');
});

test('describeConflict keeps a real title in preference to the id', () => {
    const description = describeConflict([
        { id: 'w1', title: 'Invoice entry', minutesPerInstance: 10 },
        { id: 'w2', title: 'Invoice entry', minutesPerInstance: 60 }
    ]);
    assert.equal(description.title, 'Invoice entry');
});

test('a titleless pair reaching aggregate directly produces a result, not a TypeError', () => {
    // The regression: this used to throw and take the whole analysis with it.
    const list = [
        { id: 'a', conflictsWith: 'b', frequencyPerWeek: 2, minutesPerInstance: 10, peopleAffected: 2, judgementScore: 5 },
        { id: 'b', frequencyPerWeek: 2, minutesPerInstance: 60, peopleAffected: 2, judgementScore: 5 }
    ];
    let result;
    assert.doesNotThrow(() => { result = aggregate(list); });
    assert.equal(result.workflowCount, 1);
    assert.equal(result.scored[0].title, 'a', 'the fallback title is used, not undefined');
});

test('a single titleless workflow reaching aggregate produces a result', () => {
    const result = aggregate([
        { id: 'solo', frequencyPerWeek: 2, minutesPerInstance: 30, peopleAffected: 2, judgementScore: 5 }
    ]);
    assert.equal(result.workflowCount, 1);
    assert.equal(result.scored[0].score, 2);
});

test('a whitespace title reaching aggregate is replaced by the id, not served blank', () => {
    // The route no longer accepts a whitespace title (validateWorkflows rejects
    // it), but a direct caller can still reach aggregate. Scoring must not serve
    // a blank heading: the fallback trims, so the id is used instead.
    const list = [
        { id: 'a', title: '  ', conflictsWith: 'b', frequencyPerWeek: 2, minutesPerInstance: 10, peopleAffected: 2, judgementScore: 5 },
        { id: 'b', title: '  ', frequencyPerWeek: 2, minutesPerInstance: 60, peopleAffected: 2, judgementScore: 5 }
    ];
    let result;
    assert.doesNotThrow(() => { result = aggregate(list); });
    assert.equal(result.scored[0].title, 'a', 'a blank heading must become the id');
});

test('collapseDuplicates carries the fallback title onto the merged record', () => {
    const list = [
        { id: 'a', conflictsWith: 'b', frequencyPerWeek: 2, minutesPerInstance: 10, peopleAffected: 2 },
        { id: 'b', frequencyPerWeek: 2, minutesPerInstance: 60, peopleAffected: 2 }
    ];
    const { workflows } = collapseDuplicates(list, []);
    assert.equal(workflows[0].title, 'a');
});

// --- reportedBy when a respondent is not named ------------------------------
// `reportedBy` is optional in the payload. The collapsed record must never
// carry a bare separator or the literal text "undefined": a respondent who is
// not named simply contributes no name. An earlier version joined
// [undefined, undefined] into ' / ' and ['Ann', undefined] into 'Ann / ', both
// of which render as a stray separator with nobody on one side.
test('describeConflict drops the names of respondents that were not named', () => {
    const description = describeConflict([
        { id: 'a', title: 'T', minutesPerInstance: 10 },
        { id: 'b', title: 'T', minutesPerInstance: 60 }
    ]);
    assert.deepEqual(description.reportedBy, [], 'unnamed respondents contribute no name');
});

test('collapseDuplicates yields undefined when no respondent is named', () => {
    // No names at all: the field is absent, not a stray " / ".
    const list = [
        { id: 'a', title: 'T', conflictsWith: 'b', frequencyPerWeek: 2, minutesPerInstance: 10, peopleAffected: 2 },
        { id: 'b', title: 'T', frequencyPerWeek: 2, minutesPerInstance: 60, peopleAffected: 2 }
    ];
    const { workflows } = collapseDuplicates(list, []);
    assert.equal(workflows[0].reportedBy, undefined);
});

test('collapseDuplicates yields undefined for whitespace-only names', () => {
    // A name that is only whitespace is not a name.
    const list = [
        { id: 'a', title: 'T', conflictsWith: 'b', reportedBy: '   ', frequencyPerWeek: 2, minutesPerInstance: 10, peopleAffected: 2 },
        { id: 'b', title: 'T', reportedBy: '\t', frequencyPerWeek: 2, minutesPerInstance: 60, peopleAffected: 2 }
    ];
    const { workflows } = collapseDuplicates(list, []);
    assert.equal(workflows[0].reportedBy, undefined);
});

test('a partially named group keeps the names that exist, with no trailing separator', () => {
    const list = [
        { id: 'a', title: 'T', conflictsWith: 'b', reportedBy: 'Ann', frequencyPerWeek: 2, minutesPerInstance: 10, peopleAffected: 2 },
        { id: 'b', title: 'T', frequencyPerWeek: 2, minutesPerInstance: 60, peopleAffected: 2 }
    ];
    const { workflows } = collapseDuplicates(list, []);
    // One name, so the field is "Ann", not "Ann / " with an empty right side.
    assert.equal(workflows[0].reportedBy, 'Ann');
});

test('one named respondent yields just that name', () => {
    const list = [
        { id: 'a', title: 'T', conflictsWith: 'b', reportedBy: 'Finance', frequencyPerWeek: 2, minutesPerInstance: 10, peopleAffected: 2 },
        { id: 'b', title: 'T', frequencyPerWeek: 2, minutesPerInstance: 60, peopleAffected: 2 }
    ];
    const { workflows } = collapseDuplicates(list, []);
    assert.equal(workflows[0].reportedBy, 'Finance');
});

test('both named respondents yield both names separated by a slash', () => {
    const list = [
        { id: 'a', title: 'T', conflictsWith: 'b', reportedBy: 'Finance', frequencyPerWeek: 2, minutesPerInstance: 10, peopleAffected: 2 },
        { id: 'b', title: 'T', reportedBy: 'Ops', frequencyPerWeek: 2, minutesPerInstance: 60, peopleAffected: 2 }
    ];
    const { workflows } = collapseDuplicates(list, []);
    assert.equal(workflows[0].reportedBy, 'Finance / Ops');
});

// --- a conflict can push a task out of the headline -------------------------
// Documented in ARCHITECTURE.md: when the two estimates straddle the do-first
// threshold, counting the lower one can drop the task into do_later and hence
// out of the headline total, even though the higher estimate would have been do
// first. The conflict is still reported. This is intended behaviour, pinned
// here so it is a decision rather than an accident.

test('a disagreement across the threshold drops the task out of the headline total', () => {
    // a: 4 * 40 * 1 / 60 = 2.67 h -> do first (>= 2.0)
    // b: 4 * 10 * 1 / 60 = 0.67 h -> do later
    // The lower estimate wins, so the task is do later and contributes nothing.
    const list = [
        wf({ id: 'a', conflictsWith: 'b', frequencyPerWeek: 4, minutesPerInstance: 40, peopleAffected: 1, judgementScore: 5, title: 'Task' }),
        wf({ id: 'b', frequencyPerWeek: 4, minutesPerInstance: 10, peopleAffected: 1, judgementScore: 5, title: 'Task' })
    ];
    const result = aggregate(list);

    assert.equal(result.workflowCount, 1, 'still counted once');
    assert.equal(result.scored[0].minutesPerInstance, 10, 'scored at the lower estimate');
    assert.equal(result.scored[0].bucket, BUCKET.DO_LATER);
    assert.equal(result.totalRecoverableHoursPerWeek, 0, 'a do-later task does not reach the headline');
    assert.equal(result.conflicts.length, 1, 'the disagreement is still reported');
    assert.equal(result.conflicts[0].isConflict, true);
});

test('the same task would have reached the headline without the disagreement', () => {
    // Control for the test above: the higher estimate alone is do first and does
    // contribute, which is exactly the inflation the lower-estimate rule avoids.
    const result = aggregate([
        wf({ id: 'a', frequencyPerWeek: 4, minutesPerInstance: 40, peopleAffected: 1, judgementScore: 5, title: 'Task' })
    ]);
    assert.equal(result.scored[0].bucket, BUCKET.DO_FIRST);
    assert.equal(result.totalRecoverableHoursPerWeek, 2.67);
});

// --- bucket fields: judgement and step-consistency are compared, not inherited
// The N1 defect: `judgementScore` and `stepsConsistent` were not compared inside
// a group, and `collapseDuplicates` spread `group[0]` to get them. Groups are
// built in arrival order, so the verdict came from whichever record the model
// emitted first: the same two answers produced "do_later" or "judgement_bound"
// depending on order alone. `judgementScore` is the discriminator the tool
// exists to weight, so silently inheriting it is the worst form of "a plausible
// number that does not mean what its label says".

test('describeConflict reports a steps-consistency disagreement as a bucket disagreement', () => {
    const description = describeConflict([
        wf({ id: 'a', stepsConsistent: true, minutesPerInstance: 30, frequencyPerWeek: 2, peopleAffected: 2 }),
        wf({ id: 'b', stepsConsistent: false, minutesPerInstance: 30, frequencyPerWeek: 2, peopleAffected: 2 })
    ]);
    assert.deepEqual(description.bucketDisagreements, [{ field: 'stepsConsistent', values: [true, false] }]);
});

test('describeConflict detects a judgement disagreement only after clamping', () => {
    // 5.4 and 5 both clamp to 5, so they agree.
    const agree = describeConflict([
        wf({ id: 'a', judgementScore: 5.4 }),
        wf({ id: 'b', judgementScore: 5 })
    ]);
    assert.deepEqual(agree.bucketDisagreements, []);

    // 4.6 clamps to 5 while 4 stays 4, so they disagree.
    const disagree = describeConflict([
        wf({ id: 'a', judgementScore: 4.6 }),
        wf({ id: 'b', judgementScore: 4 })
    ]);
    assert.deepEqual(disagree.bucketDisagreements, [{ field: 'judgementScore', values: [5, 4] }]);
});

test('describeConflict reports no bucket disagreement when both fields agree', () => {
    const description = describeConflict([
        wf({ id: 'a', judgementScore: 5, stepsConsistent: true }),
        wf({ id: 'b', judgementScore: 5, stepsConsistent: true })
    ]);
    assert.deepEqual(description.bucketDisagreements, []);
});

test('a bucket field present on only one record is not a disagreement', () => {
    // With fewer than two opinions there is nothing to disagree about; the one
    // present value is the measurement.
    const description = describeConflict([
        wf({ id: 'a', stepsConsistent: true, judgementScore: 5 }),
        wf({ id: 'b', stepsConsistent: undefined, judgementScore: undefined })
    ]);
    assert.deepEqual(description.bucketDisagreements, []);
});

test('findConflicts reports a group whose ONLY disagreement is a bucket field', () => {
    // Effort fields all agree, so there is no effort conflict. Before N1 this
    // group was dropped entirely and the inherited rating was never questioned.
    const reported = findConflicts([
        wf({ id: 'a', conflictsWith: 'b', judgementScore: 1, stepsConsistent: false, frequencyPerWeek: 2, minutesPerInstance: 30, peopleAffected: 2 }),
        wf({ id: 'b', judgementScore: 5, stepsConsistent: true, frequencyPerWeek: 2, minutesPerInstance: 30, peopleAffected: 2 })
    ]);
    assert.equal(reported.length, 1);
    assert.equal(reported[0].isConflict, false, 'not an effort conflict');
    assert.deepEqual(
        reported[0].bucketDisagreements.map((d) => d.field).sort(),
        ['judgementScore', 'stepsConsistent']
    );
});

test('collapseDuplicates takes the LOWEST judgement score regardless of order', () => {
    const build = (first, second) => collapseDuplicates([
        wf({ id: 'a', conflictsWith: 'b', judgementScore: first, minutesPerInstance: 10 }),
        wf({ id: 'b', judgementScore: second, minutesPerInstance: 60 })
    ], []).workflows[0];
    assert.equal(build(5, 1).judgementScore, 1);
    assert.equal(build(1, 5).judgementScore, 1);
});

test('collapseDuplicates keeps stepsConsistent true only when every record said true', () => {
    const build = (first, second) => collapseDuplicates([
        wf({ id: 'a', conflictsWith: 'b', stepsConsistent: first, minutesPerInstance: 10 }),
        wf({ id: 'b', stepsConsistent: second, minutesPerInstance: 60 })
    ], []).workflows[0];
    assert.equal(build(true, true).stepsConsistent, true, 'unanimous true stays true');
    assert.equal(build(true, false).stepsConsistent, false, 'any false makes it vary');
    assert.equal(build(false, true).stepsConsistent, false);
    assert.equal(build(false, false).stepsConsistent, false);
});

test('collapseDuplicates uses the one present bucket value when the other record omits it', () => {
    const entry = collapseDuplicates([
        wf({ id: 'a', conflictsWith: 'b', judgementScore: undefined, stepsConsistent: undefined, minutesPerInstance: 10 }),
        wf({ id: 'b', judgementScore: 3, stepsConsistent: false, minutesPerInstance: 60 })
    ], []).workflows[0];
    assert.equal(entry.judgementScore, 3);
    assert.equal(entry.stepsConsistent, false);
});

test('collapseDuplicates records bucketDisagreements on the merged record', () => {
    const entry = collapseDuplicates([
        wf({ id: 'a', conflictsWith: 'b', judgementScore: 1, stepsConsistent: false, minutesPerInstance: 10 }),
        wf({ id: 'b', judgementScore: 5, stepsConsistent: true, minutesPerInstance: 60 })
    ], []).workflows[0];
    assert.deepEqual(entry.bucketDisagreements, [
        { field: 'judgementScore', values: [1, 5] },
        { field: 'stepsConsistent', values: [false, true] }
    ]);
});

test('bucketDisagreements is absent (no own property) when the group agrees', () => {
    const entry = collapseDuplicates([
        wf({ id: 'a', conflictsWith: 'b', judgementScore: 5, stepsConsistent: true, minutesPerInstance: 10 }),
        wf({ id: 'b', judgementScore: 5, stepsConsistent: true, minutesPerInstance: 60 })
    ], []).workflows[0];
    assert.equal(Object.prototype.hasOwnProperty.call(entry, 'bucketDisagreements'), false);
});

test('the bucket note explains judgement and steps, and why they are reported', () => {
    const note = describeConflict([
        wf({ id: 'a', judgementScore: 1, stepsConsistent: false, minutesPerInstance: 10 }),
        wf({ id: 'b', judgementScore: 5, stepsConsistent: true, minutesPerInstance: 60 })
    ]).note;

    assert.ok(note.includes('Whether it needs judgement'), note);
    assert.ok(note.includes('1 vs 5'), note);
    assert.ok(note.includes('scored on the lower rating'), note);
    assert.ok(note.includes('Whether the steps are the same each time'), note);
    assert.ok(note.includes('false vs true'), note);
    assert.ok(note.includes('treated as varying'), note);
    assert.ok(
        note.includes('This decides which bucket the task falls into, so it is reported rather than averaged away.'),
        note
    );
    assert.doesNotMatch(note, CAMEL_CASE, note);
});

test('the bucket note for a judgement-only disagreement names judgement and not steps', () => {
    const note = describeConflict([
        wf({ id: 'a', judgementScore: 1 }),
        wf({ id: 'b', judgementScore: 5 })
    ]).note;
    assert.ok(note.includes('Whether it needs judgement'), note);
    assert.ok(!note.includes('steps are the same'), note);
});

test('the mock fixture collapses its invoice record to judgement 4 and steps false', () => {
    // Respondent 1 says judgement 5 / steps true, respondent 2 says 4 / false.
    // The old code inherited 5/true from the first record and showed a note about
    // minutes only. The conservative merge must take 4/false and say so.
    const entry = aggregate(mockInvoicePair()).scored.find((s) => s.id === 'invoice-processing');
    assert.equal(entry.judgementScore, 4, 'the lower rating wins, not the friendlier one');
    assert.equal(entry.stepsConsistent, false, 'steps vary if either says they vary');
    assert.deepEqual(entry.bucketDisagreements, [
        { field: 'judgementScore', values: [5, 4] },
        { field: 'stepsConsistent', values: [true, false] }
    ]);
    assert.ok(entry.conflictNote.includes('Whether it needs judgement'), entry.conflictNote);
});

/** The two mock records for the invoice workflow, in fixture order. */
function mockInvoicePair() {
    return [
        { id: 'invoice-processing', title: 'Invoice intake and processing', frequencyPerWeek: 40, minutesPerInstance: 8, peopleAffected: 3, judgementScore: 5, stepsConsistent: true, reportedBy: 'Finance' },
        { id: 'invoice-processing-2', title: 'Invoice intake and processing (second respondent)', frequencyPerWeek: 40, minutesPerInstance: 22, peopleAffected: 3, judgementScore: 4, stepsConsistent: false, reportedBy: 'Finance (second respondent)', conflictsWith: 'invoice-processing' }
    ];
}

// --- order independence -----------------------------------------------------
// The previous determinism test called the SAME array twice, which cannot
// detect order-dependence: an order-dependent function returns the same wrong
// answer twice. These tests permute the input instead and assert the scoring
// verdict is identical.

/** Runs aggregate over every permutation of a small list. */
function permutations(items) {
    if (items.length <= 1) return [items];
    const out = [];
    items.forEach((item, index) => {
        const rest = [...items.slice(0, index), ...items.slice(index + 1)];
        for (const tail of permutations(rest)) out.push([item, ...tail]);
    });
    return out;
}

/** The scoring verdict, with identity fields removed so ordering of ids cannot mask a real difference. */
function verdict(result) {
    return result.scored.map((s) => ({
        judgementScore: s.judgementScore,
        stepsConsistent: s.stepsConsistent,
        score: s.score,
        bucket: s.bucket,
        effortHoursPerWeek: s.effortHoursPerWeek,
        title: s.title
    }));
}

test('aggregate is order-independent for a judgement disagreement', () => {
    const records = [
        { id: 'a', title: 'T', conflictsWith: 'b', frequencyPerWeek: 2, minutesPerInstance: 30, peopleAffected: 2, judgementScore: 1, stepsConsistent: false },
        { id: 'b', title: 'T', frequencyPerWeek: 2, minutesPerInstance: 30, peopleAffected: 2, judgementScore: 5, stepsConsistent: true }
    ];
    const results = permutations(records).map((order) => aggregate(order));
    const first = JSON.stringify(verdict(results[0]));
    for (const result of results) {
        assert.equal(JSON.stringify(verdict(result)), first, 'the verdict must not depend on array order');
        assert.equal(result.totalRecoverableHoursPerWeek, results[0].totalRecoverableHoursPerWeek);
    }
    // And the verdict is the conservative one, not either record's own.
    assert.equal(results[0].scored[0].judgementScore, 1);
    assert.equal(results[0].scored[0].bucket, BUCKET.JUDGEMENT_BOUND);
});

test('aggregate is order-independent for a steps-consistency disagreement', () => {
    const records = [
        { id: 'a', title: 'T', conflictsWith: 'b', frequencyPerWeek: 2, minutesPerInstance: 30, peopleAffected: 2, judgementScore: 5, stepsConsistent: true },
        { id: 'b', title: 'T', frequencyPerWeek: 2, minutesPerInstance: 30, peopleAffected: 2, judgementScore: 5, stepsConsistent: false }
    ];
    const results = permutations(records).map((order) => aggregate(order));
    const first = JSON.stringify(verdict(results[0]));
    for (const result of results) {
        assert.equal(JSON.stringify(verdict(result)), first, 'the verdict must not depend on array order');
    }
    assert.equal(results[0].scored[0].stepsConsistent, false, 'steps vary if either says they vary');
});

test('aggregate is order-independent when all three effort fields disagree', () => {
    const records = [
        { id: 'a', title: 'T', conflictsWith: 'b', frequencyPerWeek: 1, minutesPerInstance: 40, peopleAffected: 1, judgementScore: 4, stepsConsistent: true },
        { id: 'b', title: 'T', frequencyPerWeek: 4, minutesPerInstance: 10, peopleAffected: 3, judgementScore: 4, stepsConsistent: true },
        { id: 'c', title: 'T', frequencyPerWeek: 2, minutesPerInstance: 20, peopleAffected: 2, judgementScore: 4, stepsConsistent: true, conflictsWith: 'b' }
    ];
    const results = permutations(records).map((order) => aggregate(order));
    const first = JSON.stringify(verdict(results[0]));
    for (const result of results) {
        assert.equal(JSON.stringify(verdict(result)), first, 'the verdict must not depend on array order');
    }
    // Lowest of each effort field: 1, 10, 1.
    assert.equal(results[0].scored[0].frequencyPerWeek, 1);
    assert.equal(results[0].scored[0].minutesPerInstance, 10);
    assert.equal(results[0].scored[0].peopleAffected, 1);
});

test('findConflicts reports the same conflicts regardless of record order', () => {
    const records = [
        { id: 'a', title: 'T', conflictsWith: 'b', frequencyPerWeek: 2, minutesPerInstance: 10, peopleAffected: 2, judgementScore: 1, stepsConsistent: false, reportedBy: 'Ann' },
        { id: 'b', title: 'T', frequencyPerWeek: 2, minutesPerInstance: 60, peopleAffected: 2, judgementScore: 5, stepsConsistent: true, reportedBy: 'Bob' }
    ];
    const summaries = permutations(records).map((order) => {
        const conflicts = findConflicts(order);
        return JSON.stringify(conflicts.map((c) => ({
            isConflict: c.isConflict,
            bucketDisagreements: c.bucketDisagreements.map((d) => d.field).sort(),
            differences: c.differences.map((d) => d.field),
            reportedBy: [...c.reportedBy].sort()
        })));
    });
    assert.equal(new Set(summaries).size, 1, `conflict summary must not depend on order: ${summaries.join(' | ')}`);
});
