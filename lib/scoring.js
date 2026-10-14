/**
 * Scoring and aggregation. SUPERSEDED BY WORKFLOW 3, AND KEPT DELIBERATELY.
 *
 * Workflow 3 (`ai/weigh-core.js`, `lib/store/weighing.js`) weighs a PROCESS on the ten-term matrix.
 * This scores a WORKFLOW from `judgementScore` and `stepsConsistent`, which workflow 1 no longer
 * produces, and it has no build-effort term, so it cannot express the quick-win distinction the
 * sort now turns on.
 *
 * TWO PATHS ARE STILL REACHABLE, which is the overlap worth naming: `/api/score` gives one number
 * per WORKFLOW for the participant, and workflow 3 gives one number per PROCESS for the console.
 * They do not run on the same objects and nothing joins them. `test/scoring.test.js` imports eleven
 * names from this file; when `/api/score` is retired or repointed, this can go.
 *
 * THE MODEL, for as long as it is used:
 *
 *   effortHoursPerWeek = frequencyPerWeek * minutesPerInstance * peopleAffected / 60
 *   score              = effortHoursPerWeek * rulesFactor
 *
 * `rulesFactor` comes from judgementScore (1 = pure judgement, 5 = pure rules) and is the
 * discriminator: effort alone ranks the longest task first, which is a wish list.
 */
import { judgementBandFor, PERIODS_IN_WEEK, timePerPeriodIsScorable } from '../ai/matrix.js';
/** Weight applied to a workflow's raw effort, by judgement score. */
export const RULES_FACTOR = {
    1: 0.15, // almost entirely judgement: automating it changes the work, not just the effort
    2: 0.35,
    3: 0.60,
    4: 0.85,
    5: 1.00  // follows fixed rules: the effort is genuinely recoverable
};

/** Workflows whose steps differ every time resist straightforward automation. */
export const INCONSISTENT_STEPS_FACTOR = 0.7;

export const BUCKET = {
    DO_FIRST: 'do_first',
    DO_LATER: 'do_later',
    JUDGEMENT_BOUND: 'judgement_bound'
};

// Thresholds, in score units (recoverable hours per week, difficulty-weighted).
const DO_FIRST_MIN_SCORE = 2.0;
const JUDGEMENT_BOUND_MAX_JUDGEMENT = 2;

/**
 * The effort a workflow consumes, in person-hours per week.
 *
 * TWO SHAPES OF WORK, and the matrix admits both:
 *
 *   per-instance   frequencyPerWeek * minutesPerInstance * peopleAffected / 60
 *   continuous     timePerPeriod.hours * periodsPerWeek * peopleAffected
 *
 * CONTINUOUS WORK IS CONVERTED, NOT DROPPED. The matrix admits `timePerPeriod` because a supervisor
 * watching a line has no per-instance time to give, and NOTHING READ `.hours` or `.period` - so that
 * workflow completed with `missing: 0` and then scored zero, reading as "nothing worth automating"
 * for exactly the work the either/or pair describes.
 *
 * A period this system cannot read is rejected by the matrix before it reaches here, so an
 * unrecognised `period` cannot silently score zero.
 *
 * @param {object} workflow
 * @returns {number} Person-hours per week, across everyone involved.
 */
export function effortHoursPerWeek(workflow) {
    const people = measuredNumber(workflow.peopleAffected) ?? 0;

    const perPeriod = workflow.timePerPeriod;
    if (perPeriod !== undefined && perPeriod !== null) {
        if (timePerPeriodIsScorable(perPeriod)) {
            const hours = measuredNumber(perPeriod.hours) ?? 0;
            const perWeek = PERIODS_IN_WEEK[perPeriod.period] ?? 0;
            return hours * perWeek * people;
        }

        // A DESCRIPTION, not a measurable figure: the participant said "2 hours a
        // day" and the matrix accepted it as their answer. Its hours are unknown,
        // so this contributes nothing AND says so, rather than looking like a
        // workflow that consumes no time. Logged once per call, because a silent
        // zero is the failure this whole change exists to remove.
        console.warn(
            '[scoring] a timePerPeriod description could not be measured, so this workflow ' +
            `contributes no effort: ${JSON.stringify(perPeriod)}`
        );
        return 0;
    }

    const frequency = measuredNumber(workflow.frequencyPerWeek) ?? 0;
    const minutes = measuredNumber(workflow.minutesPerInstance) ?? 0;
    return (frequency * minutes * people) / 60;
}

/**
 * Multiplier capturing how automatable the work is, before difficulty.
 *
 * @param {object} workflow
 * @returns {number}
 */
export function automabilityFactor(workflow) {
    const judgement = clampJudgement(workflow);
    const rulesFactor = RULES_FACTOR[judgement] ?? RULES_FACTOR[3];

    // A workflow that varies every time needs a different kind of solution, so
    // it is discounted rather than excluded: it may still be a candidate later.
    return workflow.stepsConsistent === false
        ? rulesFactor * INCONSISTENT_STEPS_FACTOR
        : rulesFactor;
}

/**
 * Scores one workflow.
 * @param {object} workflow
 * @returns {object} The workflow with score fields attached.
 */
export function scoreWorkflow(workflow) {
    const judgementScore = clampJudgement(workflow);
    const effort = effortHoursPerWeek(workflow);
    const factor = automabilityFactor(workflow);
    const score = effort * factor;

    return {
        ...workflow,
        // Echo the clamped value, so what the UI displays is what was scored.
        judgementScore,
        effortHoursPerWeek: round(effort),
        automabilityFactor: round(factor),
        score: round(score),
        recoverableHoursPerWeek: round(score),
        bucket: bucketFor(workflow, score)
    };
}

/**
 * Buckets a workflow. JUDGEMENT-BOUND WORK IS SEPARATED FIRST: a high-effort task needing a
 * person's judgement every time is not a "do later" item but a different conversation, and
 * lumping them together is what makes the output read as arithmetic.
 * @param {object} workflow
 * @param {number} score
 * @returns {string}
 */
export function bucketFor(workflow, score) {
    const judgement = clampJudgement(workflow);
    if (judgement <= JUDGEMENT_BOUND_MAX_JUDGEMENT) return BUCKET.JUDGEMENT_BOUND;
    return score >= DO_FIRST_MIN_SCORE ? BUCKET.DO_FIRST : BUCKET.DO_LATER;
}

/**
 * The three terms that make up a workflow's effort. A disagreement on any of
 * them is a disagreement about the workflow.
 */
const EFFORT_FIELDS = ['frequencyPerWeek', 'minutesPerInstance', 'peopleAffected'];

/**
 * Fields that are not part of effort but still decide the bucket.
 *
 * Unlike the effort fields these are NOT averaged or minimised silently: the
 * bucket flips on them (a judgement score of 1 versus 5 moves a task between
 * "do first" and "do not automate"), so a disagreement here is a finding to
 * report, not a number to reconcile.
 */
const BUCKET_FIELDS = ['judgementScore', 'stepsConsistent'];

/**
 * Pluralises a unit for the client-facing note. "1 people" in a document a
 * business reads is the kind of detail that undermines everything around it.
 * @param {number} value
 * @param {string} singular
 * @param {string} plural
 * @returns {string}
 */
function unitFor(value, singular, plural) {
    return value === 1 ? singular : plural;
}

/**
 * Renders a measurement with its unit, pluralised.
 * @param {number} value
 * @param {{singular: string, plural: string}} unit
 * @returns {string}
 */
function withUnit(value, unit) {
    if (!unit || !unit.singular) return String(value);
    return `${value} ${unitFor(value, unit.singular, unit.plural)}`;
}

/**
 * Human labels and units for the effort and bucket fields.
 *
 * The conflict note is read by the client, not by a developer, and it is
 * delivered without anyone in the room to explain it. `minutesPerInstance` in a
 * client-facing sentence is a database field name leaking into a sales document.
 */
const FIELD_LABEL = {
    frequencyPerWeek: { label: 'How often it happens', singular: 'x per week', plural: 'x per week' },
    minutesPerInstance: { label: 'Time for one instance', singular: 'min', plural: 'min' },
    peopleAffected: { label: 'People involved', singular: 'person', plural: 'people' },
    judgementScore: { label: 'Whether it needs judgement', singular: '/5', plural: '/5' },
    stepsConsistent: { label: 'Whether the steps are the same each time', singular: '', plural: '' }
};

/**
 * Finds groups of records that describe the same workflow.
 *
 * `conflictsWith` is treated as an UNDIRECTED edge: a marker on either side of a
 * pair is honoured, and chains are followed, so three records for one task form
 * one group. An earlier version required the marker in one direction only and
 * stopped at the first match, which silently counted the same task three times.
 *
 * @param {Array<object>} workflows
 * @returns {Array<Array<object>>} Groups of two or more records.
 */
export function findConflictGroups(workflows) {
    const byId = new Map(workflows.map((w) => [w.id, w]));

    // Union-find over the conflict edges. Only records that exist are linked,
    // so a dangling reference is ignored rather than throwing.
    const parent = new Map();
    const find = (id) => {
        while (parent.get(id) !== id) {
            parent.set(id, parent.get(parent.get(id)));
            id = parent.get(id);
        }
        return id;
    };
    const union = (a, b) => {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) parent.set(ra, rb);
    };

    for (const wf of workflows) parent.set(wf.id, wf.id);

    for (const wf of workflows) {
        if (!wf.conflictsWith) continue;
        const other = byId.get(wf.conflictsWith);
        if (!other) {
            console.warn(`[scoring] workflow "${wf.id}" references unknown conflictsWith "${wf.conflictsWith}"; ignoring`);
            continue;
        }
        union(wf.id, other.id);
    }

    const groups = new Map();
    for (const wf of workflows) {
        const root = find(wf.id);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root).push(wf);
    }

    return [...groups.values()].filter((group) => group.length > 1);
}

/**
 * Describes the disagreement within a group of records for one workflow.
 *
 * Compares every effort term, not just time. Two respondents who agree on
 * minutes but disagree on how often the task happens are disagreeing about the
 * workflow, and an earlier version of this function reported no conflict at all
 * in that case, counting the task twice.
 *
 * @param {Array<object>} group
 * @param {number} tolerance Relative difference below which estimates agree.
 * @returns {object} The conflict description, with `isConflict` set.
 */
export function describeConflict(group, tolerance = 0.25) {
    const differences = [];
    const unmeasured = [];
    const partial = [];

    for (const field of EFFORT_FIELDS) {
        const { measured, missing, allZero } = summariseField(group, field);

        // Unmeasured only when nobody supplied a usable value. One blank answer
        // does not invalidate the field for the group.
        if (measured.length === 0 || allZero) {
            unmeasured.push(field);
            continue;
        }

        // Note that some respondents left it blank, but still compare the rest.
        if (missing > 0) partial.push({ field, missing });

        const high = Math.max(...measured);
        const relativeGap = (high - Math.min(...measured)) / high;
        if (relativeGap > tolerance) {
            differences.push({ field, values: measured, relativeGap: round(relativeGap) });
        }
    }

    // Tolerate a missing or blank title rather than throwing or serving whitespace.
    // The boundary validates titles, but this path is also reachable directly
    // (POST /api/score takes the payload from the client), so scoring must not
    // depend on the boundary having run. A blank heading is worse than the id.
    const firstTitle = group[0].title;
    const titleFallback = (typeof firstTitle === 'string' && firstTitle.trim() !== '')
        ? firstTitle
        : (group[0].id || 'Unnamed workflow');
    const title = String(titleFallback).replace(/\s*\((second|third) respondent\)$/, '');

    // A disagreement on judgement or step-consistency is not an effort conflict,
    // but it decides the bucket and therefore whether the task is recommended at
    // all. It must be reported: without this, the merged record silently took
    // these fields from whichever record the model happened to list first, and
    // the same two answers produced "do first" or "do not automate" depending
    // on array order.
    const bucketDisagreements = [];
    for (const field of BUCKET_FIELDS) {
        const present = group
            .map((w) => w[field])
            .filter((v) => v !== undefined && v !== null);
        if (present.length < 2) continue;

        if (field === 'judgementScore') {
            const nums = present.map((v) => clampBand(v));
            if (Math.max(...nums) !== Math.min(...nums)) {
                bucketDisagreements.push({ field, values: nums });
            }
        } else if (present.some((v) => v === true) && present.some((v) => v === false)) {
            bucketDisagreements.push({ field, values: present });
        }
    }

    const notes = [];
    if (differences.length > 0) {
        notes.push(
            differences
                .map((d) => {
                    const meta = FIELD_LABEL[d.field] || { label: d.field };
                    const shown = d.values.map((v) => withUnit(v, meta)).join(' vs ');
                    return `${meta.label} differs by ${Math.round(d.relativeGap * 100)}% (${shown})`;
                })
                .join('; ') + '. Counted once, at the lower estimate.'
        );
    }
    if (bucketDisagreements.length > 0) {
        notes.push(
            bucketDisagreements
                .map((d) => {
                    const meta = FIELD_LABEL[d.field] || { label: d.field };
                    const shown = d.values.join(' vs ');
                    return d.field === 'stepsConsistent'
                        ? `${meta.label} disagrees (${shown}); treated as varying`
                        : `${meta.label} disagrees (${shown}); scored on the lower rating`;
                })
                .join('; ') + '. This decides which bucket the task falls into, so it is reported rather than averaged away.'
        );
    }
    if (unmeasured.length > 0) {
        const labels = unmeasured.map((f) => (FIELD_LABEL[f] || { label: f }).label.toLowerCase());
        notes.push(`No usable value for ${labels.join(', ')}; treated as unmeasured rather than as agreement.`);
    }
    if (partial.length > 0) {
        const labels = partial.map((p) => {
            const meta = FIELD_LABEL[p.field] || { label: p.field };
            return meta.label.toLowerCase();
        });
        // A blank answer means the lower-estimate rule had nothing to compare
        // against. Saying "the remaining answers were used" implied agreement
        // and hid that the conservative rule could not be applied at all.
        notes.push(`Only one respondent gave ${labels.join(', ')}; scored on that single answer, so the lower-estimate rule did not apply.`);
    }

    return {
        isConflict: differences.length > 0,
        ids: group.map((w) => w.id),
        title,
        // Only the records that named a team. Joining undefined values produced
        // the literal " / " for an unnamed group and "Ann / " for a partly
        // named one, both of which are non-empty strings that say nothing and
        // would render as a stray separator wherever they are shown.
        reportedBy: group.map((w) => w.reportedBy).filter((name) => typeof name === 'string' && name.trim() !== ''),
        differences,
        bucketDisagreements,
        unmeasured,
        partial,
        note: notes.join(' ')
    };
}

/**
 * Detects groups of workflows that describe the same task with materially
 * different inputs.
 *
 * Real intake data contradicts itself. Silently averaging the two estimates
 * hides the disagreement and produces a confident number that is not true.
 * Surfacing it is more honest and, for a diagnostic, more useful: a workflow
 * that two people describe differently is itself a finding.
 *
 * @param {Array<object>} workflows
 * @param {number} [tolerance] Relative difference below which estimates agree.
 * @returns {Array<object>} One entry per group with a disagreement or missing data.
 */
export function findConflicts(workflows, tolerance = 0.25) {
    return findConflictGroups(workflows)
        .map((group) => describeConflict(group, tolerance))
        // A group is worth reporting when the respondents disagreed, when some
        // value could not be measured at all, or when some but not all of them
        // answered. Each is a data-quality finding the client should see.
        .filter((conflict) =>
            conflict.isConflict
            || conflict.unmeasured.length > 0
            || conflict.partial.length > 0
            || conflict.bucketDisagreements.length > 0
        );
}

/**
 * Collapses groups of records that describe the same workflow.
 *
 * Counting every record would multiply the hours for one task by the number of people who
 * described it, and counting the highest estimate would inflate the case in the direction that
 * flatters the pitch. So a group becomes ONE entry, scored on the LOWEST estimate per effort
 * field, with the disagreement recorded against it. A field with no usable value is dropped
 * rather than carrying an undefined into the score.
 *
 * @param {Array<object>} workflows
 * @param {Array<object>} [conflicts] Result of findConflicts, used to find groups.
 * @returns {{workflows: Array<object>, collapsed: Array<object>}}
 */
export function collapseDuplicates(workflows, conflicts = []) {
    const groups = findConflictGroups(workflows);
    const collapsed = [];
    const consumed = new Set();

    for (const group of groups) {
        for (const member of group) consumed.add(member.id);

        const description = conflicts.find((c) => c.ids.includes(group[0].id))
            || describeConflict(group);

        // Lowest measurement per field, on normalised numbers only. A field with
        // no usable value is dropped from the collapsed record rather than
        // carrying an undefined through into the score.
        const merged = { ...group[0] };
        delete merged.conflictsWith;

        const unmeasured = [];
        const partial = [];
        for (const field of EFFORT_FIELDS) {
            const { measured, missing, allZero } = summariseField(group, field);

            // Drop the field only when nobody supplied a usable value. If one
            // respondent answered, that answer is the measurement.
            if (measured.length === 0 || allZero) {
                unmeasured.push(field);
                delete merged[field];
                continue;
            }

            if (missing > 0) partial.push(field);
            merged[field] = Math.min(...measured);
        }

        merged.id = group[0].id;
        merged.title = description.title;

        // These decide the bucket, so they must not be inherited from whichever
        // record happened to be first. Conservative on purpose: the lowest
        // judgement rating and "steps vary if anyone says they vary" both push a
        // task away from an automation recommendation, which is the safer error
        // for a tool whose output is a sales document.
        const judgements = group
            .map((w) => w.judgementScore)
            .filter((v) => v !== undefined && v !== null)
            .map((v) => clampBand(v));
        if (judgements.length > 0) merged.judgementScore = Math.min(...judgements);

        const consistency = group
            .map((w) => w.stepsConsistent)
            .filter((v) => v !== undefined && v !== null);
        if (consistency.length > 0) merged.stepsConsistent = consistency.every((v) => v === true);
        merged.hasConflict = description.isConflict;
        merged.conflictNote = description.note;
        merged.reportedBy = description.reportedBy.length > 0
            ? description.reportedBy.join(' / ')
            : undefined;
        if (description.isConflict) merged.conflictIds = description.ids;
        if (description.bucketDisagreements && description.bucketDisagreements.length > 0) {
            merged.bucketDisagreements = description.bucketDisagreements;
        }
        if (unmeasured.length > 0) merged.unmeasuredFields = unmeasured;
        if (partial.length > 0) merged.partialFields = partial;

        collapsed.push(merged);
    }

    const remaining = workflows.filter((wf) => !consumed.has(wf.id));
    return { workflows: [...remaining, ...collapsed], collapsed };
}

/**
 * Aggregates a set of workflows into a ranked, bucketed result.
 * @param {Array<object>} workflows
 * @returns {object}
 */
export function aggregate(workflows) {
    if (!Array.isArray(workflows) || workflows.length === 0) {
        return {
            scored: [],
            buckets: { [BUCKET.DO_FIRST]: [], [BUCKET.DO_LATER]: [], [BUCKET.JUDGEMENT_BOUND]: [] },
            conflicts: [],
            totalRecoverableHoursPerWeek: 0,
            workflowCount: 0
        };
    }

    const conflicts = findConflicts(workflows);
    const { workflows: deduped } = collapseDuplicates(workflows, conflicts);

    const scored = deduped
        .map(scoreWorkflow)
        .sort((a, b) => b.score - a.score);

    const buckets = {
        [BUCKET.DO_FIRST]: scored.filter((w) => w.bucket === BUCKET.DO_FIRST),
        [BUCKET.DO_LATER]: scored.filter((w) => w.bucket === BUCKET.DO_LATER),
        [BUCKET.JUDGEMENT_BOUND]: scored.filter((w) => w.bucket === BUCKET.JUDGEMENT_BOUND)
    };

    return {
        scored,
        buckets,
        conflicts,
        totalRecoverableHoursPerWeek: round(
            buckets[BUCKET.DO_FIRST].reduce((sum, w) => sum + w.score, 0)
        ),
        workflowCount: scored.length
    };
}

/**
 * Reads a value as a measured number, or null when it is not one.
 *
 * DELIBERATELY STRICTER than `numberOrZero`: `Number(null)` and `Number('')` are both 0, so a
 * lenient coercion turns "nobody measured this" into "someone measured zero", which then reads as a
 * 100% disagreement against a real value.
 *
 * NEGATIVE NUMBERS ARE NOT MEASUREMENTS either - a task cannot take minus five minutes - and
 * treating one as real puts a negative duration into the client's document.
 *
 * @param {*} value
 * @returns {number|null}
 */
function measuredNumber(value) {
    let n;
    if (typeof value === 'number') {
        n = value;
    } else if (typeof value === 'string' && value.trim() !== '') {
        n = Number(value.trim());
    } else {
        // null, undefined, '', booleans, objects, arrays: not a measurement.
        return null;
    }
    return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Summarises one effort field across a group of records.
 *
 * THE RULE, in one place so the two readers cannot disagree: A FIELD IS UNMEASURED ONLY WHEN NO
 * RECORD SUPPLIED A USABLE VALUE. If at least one did, those are the measurement and the rest are
 * recorded as missing. An earlier version marked it unmeasured when ANY record was missing, so one
 * respondent leaving one question blank deleted the whole workflow from the headline.
 *
 * @param {Array<object>} group
 * @param {string} field
 * @returns {{measured: number[], missing: number, allZero: boolean}}
 */
function summariseField(group, field) {
    const values = group.map((w) => measuredNumber(w[field]));
    const measured = values.filter((n) => n !== null);
    const missing = values.length - measured.length;

    return {
        measured,
        missing,
        // Every respondent said zero. That is unmeasured, not agreement.
        allZero: measured.length > 0 && measured.every((n) => n === 0)
    };
}

/** Rounds to two decimals, so a displayed figure is stable across runs. */
function round(value) {
    return Math.round(value * 100) / 100;
}

/**
 * The judgement band, 1 to 5: 1 is pure judgement, 5 is pure rules.
 *
 * A NUMBER from the conflict paths passes straight through; a WORKFLOW has its
 * band derived from its step flags by ai/matrix.js, beside `needsReasoning`
 * itself. Workflow 3 replaces this scorer, so only the band lives here.
 */
function clampJudgement(value) {
    const isWorkflow = value !== null && typeof value === 'object';
    return clampBand(isWorkflow ? judgementBandFor(value) : value);
}

function clampBand(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 3;
    return Math.min(5, Math.max(1, Math.round(n)));
}
