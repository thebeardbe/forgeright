/**
 * Scoring and aggregation, superseded by workflow 3 and kept deliberately: `/api/score` gives one number per
 * workflow and workflow 3 gives one per process, and nothing joins them.
 *
 *   effortHoursPerWeek = frequencyPerWeek * minutesPerInstance * peopleAffected / 60
 *   score              = effortHoursPerWeek * rulesFactor
 *
 * `rulesFactor` comes from judgementScore and is the discriminator, because effort alone ranks the longest
 * task first.
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
 * Two shapes of work, both admitted by the matrix:
 *
 *   per-instance   frequencyPerWeek * minutesPerInstance * peopleAffected / 60
 *   continuous     timePerPeriod.hours * periodsPerWeek * peopleAffected
 *
 * Continuous work is converted rather than dropped, because a supervisor watching a line has no
 * per-instance time to give. A period this system cannot read is rejected by the matrix before it reaches
 * here.
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

        // A description rather than a measurable figure: its hours are unknown, so this contributes
        // nothing and says so rather than looking like a workflow that consumes no time.
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
 * Multiplier capturing how automatable the work is, before difficulty. A workflow that varies every time
 * is discounted rather than excluded, because it may still be a candidate later.
 *
 * @param {object} workflow
 * @returns {number}
 */
export function automabilityFactor(workflow) {
    const judgement = clampJudgement(workflow);
    const rulesFactor = RULES_FACTOR[judgement] ?? RULES_FACTOR[3];

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
 * Buckets a workflow, separating judgement-bound work first: a high-effort task needing a person's judgement
 * every time is a different conversation rather than a "do later" item.
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
 * The three terms that make up a workflow's effort; a disagreement on any of them is a disagreement about the
 * workflow.
 */
const EFFORT_FIELDS = ['frequencyPerWeek', 'minutesPerInstance', 'peopleAffected'];

/**
 * Fields that decide the bucket without being part of effort. Unlike the effort fields these are not
 * averaged or minimised silently, because a disagreement here is a finding to report.
 */
const BUCKET_FIELDS = ['judgementScore', 'stepsConsistent'];

/**
 * Pluralises a unit for the client-facing note.
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
 * Human labels and units for the effort and bucket fields. The conflict note is read by the client rather
 * than a developer, so a database field name must not reach a client-facing sentence.
 */
const FIELD_LABEL = {
    frequencyPerWeek: { label: 'How often it happens', singular: 'x per week', plural: 'x per week' },
    minutesPerInstance: { label: 'Time for one instance', singular: 'min', plural: 'min' },
    peopleAffected: { label: 'People involved', singular: 'person', plural: 'people' },
    judgementScore: { label: 'Whether it needs judgement', singular: '/5', plural: '/5' },
    stepsConsistent: { label: 'Whether the steps are the same each time', singular: '', plural: '' }
};

/**
 * Finds groups of records that describe the same workflow. `conflictsWith` is an undirected edge, with
 * chains followed, so three records for one task form one group.
 *
 * @param {Array<object>} workflows
 * @returns {Array<Array<object>>} Groups of two or more records.
 */
export function findConflictGroups(workflows) {
    const byId = new Map(workflows.map((w) => [w.id, w]));

    // Union-find over the conflict edges; a dangling reference is ignored rather than throwing.
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
 * Describes the disagreement within a group of records for one workflow. Every effort term is compared,
 * because two respondents who agree on minutes and disagree on frequency are disagreeing about the workflow.
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

        // Unmeasured only when nobody supplied a usable value.
        if (measured.length === 0 || allZero) {
            unmeasured.push(field);
            continue;
        }

        // Noted, but the rest are still compared.
        if (missing > 0) partial.push({ field, missing });

        const high = Math.max(...measured);
        const relativeGap = (high - Math.min(...measured)) / high;
        if (relativeGap > tolerance) {
            differences.push({ field, values: measured, relativeGap: round(relativeGap) });
        }
    }

    // Tolerated rather than thrown: scoring must not depend on the boundary having run, because
    // POST /api/score takes the payload from the client directly.
    const firstTitle = group[0].title;
    const titleFallback = (typeof firstTitle === 'string' && firstTitle.trim() !== '')
        ? firstTitle
        : (group[0].id || 'Unnamed workflow');
    const title = String(titleFallback).replace(/\s*\((second|third) respondent\)$/, '');

    // Not an effort conflict, but these decide the bucket and therefore whether the task is recommended at
    // all, so they are reported rather than taken from whichever record happened to be first.
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
        // A blank answer means the lower-estimate rule had nothing to compare against.
        notes.push(`Only one respondent gave ${labels.join(', ')}; scored on that single answer, so the lower-estimate rule did not apply.`);
    }

    return {
        isConflict: differences.length > 0,
        ids: group.map((w) => w.id),
        title,
        // Only the records that named a team, or an unnamed group joins to a stray separator.
        reportedBy: group.map((w) => w.reportedBy).filter((name) => typeof name === 'string' && name.trim() !== ''),
        differences,
        bucketDisagreements,
        unmeasured,
        partial,
        note: notes.join(' ')
    };
}

/**
 * Detects groups of workflows that describe the same task with materially different inputs: silently
 * averaging the two estimates produces a confident number that is not true, and a workflow two people
 * describe differently is itself a finding.
 *
 * @param {Array<object>} workflows
 * @param {number} [tolerance] Relative difference below which estimates agree.
 * @returns {Array<object>} One entry per group with a disagreement or missing data.
 */
export function findConflicts(workflows, tolerance = 0.25) {
    return findConflictGroups(workflows)
        .map((group) => describeConflict(group, tolerance))
        // Each of these is a data-quality finding the client should see.
        .filter((conflict) =>
            conflict.isConflict
            || conflict.unmeasured.length > 0
            || conflict.partial.length > 0
            || conflict.bucketDisagreements.length > 0
        );
}

/**
 * Collapses groups of records that describe the same workflow. Counting every record would multiply the hours
 * for one task by the number of people who described it, so a group becomes one entry scored on the lowest
 * estimate per effort field, with the disagreement recorded against it. A field with no usable value is
 * dropped rather than carrying an undefined into the score.
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

        // Lowest measurement per field, on normalised numbers only.
        const merged = { ...group[0] };
        delete merged.conflictsWith;

        const unmeasured = [];
        const partial = [];
        for (const field of EFFORT_FIELDS) {
            const { measured, missing, allZero } = summariseField(group, field);

            // Dropped only when nobody supplied a usable value.
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

        // Not inherited from whichever record was first. Conservative on purpose: the lowest judgement
        // rating and "steps vary if anyone says they vary" both push away from an automation
        // recommendation, which is the safer error.
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
 * Reads a value as a measured number, or null when it is not one. Stricter than a lenient coercion,
 * because `Number(null)` and `Number('')` are both 0 and that would turn "nobody measured this" into
 * "someone measured zero". A negative number is not a measurement either.
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
 * Summarises one effort field across a group of records: a field is unmeasured only when no record supplied
 * a usable value, so one respondent leaving a question blank does not delete the whole workflow.
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
        // Every respondent said zero, which is unmeasured rather than agreement.
        allZero: measured.length > 0 && measured.every((n) => n === 0)
    };
}

/** Rounds to two decimals, so a displayed figure is stable across runs. */
function round(value) {
    return Math.round(value * 100) / 100;
}

/**
 * The judgement band, 1 to 5: 1 is pure judgement, 5 is pure rules. A number from the conflict paths passes
 * through, while a workflow has its band derived from its step flags by ai/matrix.js.
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
