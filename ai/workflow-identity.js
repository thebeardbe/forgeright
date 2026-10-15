/**
 * The `id` and `title` a workflow gets when the interview path has not supplied them. The fields cannot
 * simply be unrequired: `id` is the process's identity, because `findConflictGroups` keys a union-find on
 * it and the client's `mergeForwardDroppedProcesses` matches carried-forward processes by it.
 */

/** The longest slug worth generating: a task is prose and an id is a name. */
const MAX_SLUG_LENGTH = 60;

/** What is left of a slug when a task has no letters or digits at all. */
const FALLBACK_SLUG = 'process';

/** The longest title taken from a task, so a heading stays a heading. */
const MAX_TITLE_LENGTH = 80;

/**
 * A short kebab-case slug for a process, derived from its own task. It must be deterministic: an id
 * regenerated per turn would break the client's carry-forward match.
 *
 * ASCII only, because a task may be in any language, and a task that leaves nothing falls back rather
 * than returning the empty string `validateWorkflows` would refuse.
 *
 * @param {unknown} task The process's task, as the model supplied it.
 * @returns {string} A non-empty slug, at most MAX_SLUG_LENGTH characters.
 */
export function slugForTask(task) {
    const slug = String(task ?? '')
        .normalize('NFKD')
        // Combining marks first, so an accented letter reduces to its base letter, not to nothing.
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, MAX_SLUG_LENGTH)
        // After the slice, because cutting can leave a trailing dash.
        .replace(/-+$/g, '');

    return slug === '' ? FALLBACK_SLUG : slug;
}

/**
 * A human-readable title for a process, taken from its task: the prompt's `title` field is never produced
 * on the interview path, so the task is the title.
 *
 * @param {unknown} task The process's task, as the model supplied it.
 * @returns {string} A non-empty title.
 */
export function titleForTask(task) {
    const text = String(task ?? '').replace(/\s+/g, ' ').trim();
    if (text === '') return 'Untitled process';
    if (text.length <= MAX_TITLE_LENGTH) return text;

    const clipped = text.slice(0, MAX_TITLE_LENGTH);
    const lastSpace = clipped.lastIndexOf(' ');
    // Only break on a space when there is a word's worth of text before it; otherwise the clip itself
    // is the better heading.
    const head = lastSpace > MAX_TITLE_LENGTH * 0.6 ? clipped.slice(0, lastSpace) : clipped;
    return `${head.trimEnd()}...`;
}

/**
 * Gives every workflow in a payload the `id` and `title` the scorer requires. Existing values win, because
 * overwriting a supplied one would change what the demo scores.
 *
 * A repeat slug gets `-2`, `-3` in array order, because `findConflictGroups` keys a union-find on `id` and
 * two processes sharing one would be treated as a single process.
 *
 * @param {Array<object>} workflows The workflows as the model supplied them.
 * @returns {Array<object>} A new array, each entry carrying a usable `id` and `title`.
 */
export function withWorkflowIdentity(workflows) {
    if (!Array.isArray(workflows)) return workflows;

    // An explicit id is claimed through `counts` too, so a generated slug cannot collide with it.
    const counts = new Map();
    const claimExplicit = (id) => counts.set(id, 1);

    return workflows.map((workflow) => {
        if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) return workflow;

        const hasId = typeof workflow.id === 'string' && workflow.id.trim() !== '';
        const hasTitle = typeof workflow.title === 'string' && workflow.title.trim() !== '';

        const next = { ...workflow };

        if (hasId) claimExplicit(workflow.id);
        else next.id = claimUnique(slugForTask(workflow.task), counts);

        if (!hasTitle) next.title = titleForTask(workflow.task);

        return next;
    });
}

/**
 * Claims `base`, or the first free `base-N` when it is taken. Counts are per base rather than global, so
 * the suffixes stay small and predictable.
 *
 * @param {string} base The slug to claim.
 * @param {Map<string, number>} counts How many times each base has been handed out.
 * @returns {string} A slug not yet handed out.
 */
function claimUnique(base, counts) {
    if (!counts.has(base)) {
        counts.set(base, 1);
        return base;
    }

    // The loop exists because a payload may already contain an explicit `base-2`, and handing that out
    // twice would collapse the two processes into one conflict group.
    let n = counts.get(base) + 1;
    let candidate = `${base}-${n}`;
    while (counts.has(candidate)) {
        n += 1;
        candidate = `${base}-${n}`;
    }
    counts.set(candidate, 1);
    counts.set(base, n);
    return candidate;
}

/**
 * The step names of a workflow, trimmed and case-folded. Shared with the client's copy in
 * `public/js/audit.js` and with `ai/merge-steps.js`'s `stepKey`, so a change to what "the same step" means
 * cannot be made in one place and missed in the others.
 *
 * @param {object} workflow
 * @returns {string[]}
 */
function stepNamesOf(workflow) {
    if (!workflow || !Array.isArray(workflow.steps)) return [];
    return workflow.steps
        .map((step) => (step && typeof step.name === 'string' ? step.name.trim().toLowerCase() : ''))
        .filter((name) => name !== '');
}

/**
 * Whether two workflows share at least one exactly equal step name. No similarity and no threshold: a
 * step-text overlap rule cannot work, because a reworded match and a genuine difference score within the
 * model's rewording noise of each other.
 *
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
export function sharesAStepName(a, b) {
    const mine = stepNamesOf(a);
    if (mine.length === 0) return false;
    const theirs = new Set(stepNamesOf(b));
    return mine.some((name) => theirs.has(name));
}

/** A workflow's measurable fields, filled in. Used to choose between two accounts of one process. */
function filledFields(workflow) {
    const fields = ['frequencyPerWeek', 'timePerPeriod', 'minutesPerInstance', 'peopleAffected',
        'handoffTo', 'waitsFor', 'dependsOn', 'systems', 'touchedDepartments',
        'mistakesPerPeriod', 'mistakeConsequence', 'currentState', 'frustration'];
    return fields.filter((f) => workflow[f] !== undefined && workflow[f] !== null);
}

/**
 * Whether a process is the same one the round was already working on. The round is evidence the reply
 * cannot carry: the model never sees its own prior `processes`, because audit-core.js rebuilds an
 * assistant turn as role and content only, so it re-derives and re-words each turn.
 *
 * The match is positive and verbatim, a shared step name or the same id, and nothing is inferred from the
 * absence of evidence.
 *
 * @param {Array<object>} replyWorkflows The workflows from this reply.
 * @param {Array<object>} heldWorkflows The processes the round already holds.
 * @returns {{ workflows: Array<object>, folded: number }}
 */
export function reconcileWithHeld(replyWorkflows, heldWorkflows) {
    if (!Array.isArray(replyWorkflows) || replyWorkflows.length === 0) {
        return { workflows: replyWorkflows, folded: 0 };
    }
    // A round holds one process at a time. With several held, nothing identifies which is being reworded,
    // so this declines and the caller keeps the reply as it stands.
    if (!Array.isArray(heldWorkflows) || heldWorkflows.length !== 1) {
        return { workflows: replyWorkflows, folded: 0 };
    }

    const held = heldWorkflows[0];
    if (!held || typeof held !== 'object' || Array.isArray(held)) {
        return { workflows: replyWorkflows, folded: 0 };
    }

    const carriesNothing = (w) => !Array.isArray(w.steps) || w.steps.length === 0;
    // Positive, verbatim evidence only, with no emptiness clause: an entry with no steps is not evidence
    // of being the round's process, because on a naming turn it is the process just named. Emptiness is
    // used below, in the opposite direction.
    const isRoundsProcess = (w) => sharesAStepName(w, held)
        || (typeof w.id === 'string' && w.id === held.id);

    // Which entry is the round's, and there can be at most one.
    const matches = replyWorkflows.filter((w) => w && typeof w === 'object' && isRoundsProcess(w));
    if (matches.length === 0) return { workflows: replyWorkflows, folded: 0 };

    // A reworded copy has content while the round's process is being restated, and that is the signal
    // rather than emptiness: a naming turn produces the finished process and the new one with no steps,
    // and the empty entry is the new one.
    const restatedSomething = matches.length > 0;
    const contentEntries = replyWorkflows.filter((w) => w && typeof w === 'object' && !carriesNothing(w));
    const foldable = (w) => restatedSomething
        && !isRoundsProcess(w)
        && !carriesNothing(w)
        // Never fold the only entry with content: then it is the process and the empty one is stale.
        && contentEntries.length > 1;

    const toFold = replyWorkflows.filter((w) => w && typeof w === 'object' && foldable(w));
    const roundEntries = replyWorkflows.filter((w) => w && typeof w === 'object' && isRoundsProcess(w));

    if (toFold.length === 0 && roundEntries.length <= 1) {
        return { workflows: replyWorkflows, folded: 0 };
    }

    // The fullest account survives, with the round's values merged on top.
    const all = [...roundEntries, ...toFold];
    const richest = all.reduce((best, w) => {
        const score = (x) => (Array.isArray(x.steps) ? x.steps.length : 0) * 100 + filledFields(x).length;
        return score(w) > score(best) ? w : best;
    });
    const merged = mergeHeldIntoReply(held, richest);

    const out = [];
    let folded = 0;
    let placed = false;
    for (const w of replyWorkflows) {
        const belongsToRound = w && typeof w === 'object'
            && (isRoundsProcess(w) || foldable(w));
        if (belongsToRound) {
            folded += 1;
            // The process takes its first position, so the reply's ordering survives.
            if (!placed) {
                out.push(merged);
                placed = true;
            }
            continue;
        }
        out.push(w);
    }

    // A fold is never silent: naming what was folded is what tells a reworded process from a new one.
    console.warn(
        '[audit] the reply described the round\'s process more than once (' + folded +
        ' entries folded into one, id "' + String(merged.id) + '"); the model re-worded work it ' +
        'had already recorded, which the prompt tells it not to re-describe. The fullest account ' +
        'survives and the round\'s recorded values are kept.'
    );

    return { workflows: out, folded };
}

/**
 * Merges the round's record of a process with the reply's newer account of it.
 *
 * The round's value wins where both have one: the earlier value is the participant's, taken on the turn
 * that collected it, while the later one is the model's re-reading of its own memory. The reply's value is
 * used where the round has nothing, so progress is never lost.
 *
 * @param {object} held The round's account.
 * @param {object} reply The reply's account.
 * @returns {object}
 */
export function mergeHeldIntoReply(held, reply) {
    const merged = { ...reply };
    for (const field of filledFields(held)) {
        // `task` is deliberately excluded: the model rewords it, and either wording names the same work.
        merged[field] = held[field];
    }
    // Keeping the round's id stops the console's links and `process_response` joins gaining a second id
    // for the same work.
    if (typeof held.id === 'string' && held.id !== '') merged.id = held.id;
    return merged;
}
