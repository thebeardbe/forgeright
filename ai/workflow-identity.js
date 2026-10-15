/**
 * The `id` and `title` a workflow gets when the interview path has not supplied them.
 *
 * The prompt asks for `id` and `title` in its `audit.workflows` block, but `workflowsFrom` reads
 * `parsed.processes`, a different block with neither field, so a live interview reached `/api/score`
 * without them. The fields cannot simply be unrequired: `id` is the process's identity, because
 * `findConflictGroups` keys a union-find on it and the client's `mergeForwardDroppedProcesses` matches
 * carried-forward processes by it, silently doing nothing when it is missing.
 */

/** The longest slug worth generating. A task is prose and an id is a name, not a paragraph. */
const MAX_SLUG_LENGTH = 60;

/** What is left of a slug when a task has no letters or digits at all. */
const FALLBACK_SLUG = 'process';

/** The longest title taken from a task, so a heading stays a heading. */
const MAX_TITLE_LENGTH = 80;

/**
 * A short kebab-case slug for a process, derived from its own task. It is pure and deterministic, which
 * is the point: the same task yields the same slug on every turn, and stability is what the client's
 * carry-forward needs, because an id regenerated per turn would break the match it exists to serve.
 *
 * ASCII only, because a task may be in any language, and a task that leaves nothing falls back rather
 * than producing an empty string, which `validateWorkflows` would refuse.
 *
 * @param {unknown} task The process's task, as the model supplied it.
 * @returns {string} A non-empty slug, at most MAX_SLUG_LENGTH characters.
 */
export function slugForTask(task) {
    const slug = String(task ?? '')
        .normalize('NFKD')
        // Combining marks first, so an accented letter reduces to its base letter rather than to
        // nothing: "Réception" should read as "reception" and not as "rception".
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, MAX_SLUG_LENGTH)
        // A trim after the slice, because cutting at 60 characters can leave a trailing dash.
        .replace(/-+$/g, '');

    return slug === '' ? FALLBACK_SLUG : slug;
}

/**
 * A human-readable title for a process, taken from its task. The task is the title on the interview
 * path: the participant described the work and the prompt's `title` field is never produced. A long task
 * is cut at a word boundary with an ellipsis, so a reader can see something was left out.
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
 * Gives every workflow in a payload the `id` and `title` the scorer requires. Existing values win: the
 * demo seed writes its own, the model may supply them, and a present non-blank value is more informative
 * than a derived slug, so overwriting would change what the demo scores.
 *
 * Uniqueness is not tidiness: `findConflictGroups` keys a union-find on `id`, so two processes deriving
 * the same slug would be treated as one process. A repeat gets `-2`, `-3` in array order.
 *
 * @param {Array<object>} workflows The workflows as the model supplied them.
 * @returns {Array<object>} A new array, each entry carrying a usable `id` and `title`.
 */
export function withWorkflowIdentity(workflows) {
    if (!Array.isArray(workflows)) return workflows;

    // `counts` is the only bookkeeping, and an explicit id is claimed through it too, so a generated
    // slug cannot collide with an id the payload already carried beside it.
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
 * Claims `base`, or the first free `base-N` when it is taken. Counts are per base rather than a global
 * scan, so the suffixes stay small and predictable.
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

    // The base is taken, so the first duplicate becomes `-2` and the count moves on from there. The
    // loop exists because a payload may already contain an explicit `base-2`, and handing that out
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
 * The step names of a workflow, trimmed and case-folded. One definition, shared with the client's copy
 * in `public/js/audit.js` and with `ai/merge-steps.js`'s `stepKey`, so a change to what "the same step"
 * means cannot be made in one place and missed in the others.
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
 * step-text overlap rule cannot work, because the same process reworded and a different process
 * described in the participant's own words score within the model's rewording noise of each other, so
 * any threshold that folds the true match is one rewording away from folding a genuine one.
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
 * cannot carry, which is why this belongs on the server: the model never sees its own prior `processes`,
 * because audit-core.js rebuilds an assistant turn as role and content only, so it re-derives and
 * re-words each turn.
 *
 * The match is positive and verbatim, a shared step name or the same id, and nothing is inferred from
 * the absence of evidence. It must decline for a genuinely different process, and it does, because such
 * an entry shares no step name and is not the held id.
 *
 * @param {Array<object>} replyWorkflows The workflows from this reply.
 * @param {Array<object>} heldWorkflows The processes the round already holds.
 * @returns {{ workflows: Array<object>, folded: number }}
 */
export function reconcileWithHeld(replyWorkflows, heldWorkflows) {
    if (!Array.isArray(replyWorkflows) || replyWorkflows.length === 0) {
        return { workflows: replyWorkflows, folded: 0 };
    }
    // A round holds one process at a time. With several held, position and step sharing are not evidence
    // enough to say which one is being reworded, so this declines and the caller keeps the reply as it
    // stands, which is the safe direction.
    if (!Array.isArray(heldWorkflows) || heldWorkflows.length !== 1) {
        return { workflows: replyWorkflows, folded: 0 };
    }

    const held = heldWorkflows[0];
    if (!held || typeof held !== 'object' || Array.isArray(held)) {
        return { workflows: replyWorkflows, folded: 0 };
    }

    const carriesNothing = (w) => !Array.isArray(w.steps) || w.steps.length === 0;
    // Positive, verbatim evidence only: the entry names the round's id, or shares an exactly equal step
    // name with it. This has no emptiness clause, deliberately, because an entry with no steps is not
    // evidence of being the round's process: on a naming turn it is the process the participant has just
    // named. Emptiness is used below, in the opposite direction.
    const isRoundsProcess = (w) => sharesAStepName(w, held)
        || (typeof w.id === 'string' && w.id === held.id);

    // Which entry is the round's, and there can be at most one.
    const matches = replyWorkflows.filter((w) => w && typeof w === 'object' && isRoundsProcess(w));
    if (matches.length === 0) return { workflows: replyWorkflows, folded: 0 };

    // A reworded copy has content while the round's process is being restated, and that is the signal
    // rather than emptiness. A naming turn is the other shape and is not folded: naming a new process
    // produces the finished process and the new one with no steps, and the entry with no content is the
    // new one.
    const restatedSomething = matches.length > 0;
    const contentEntries = replyWorkflows.filter((w) => w && typeof w === 'object' && !carriesNothing(w));
    const foldable = (w) => restatedSomething
        && !isRoundsProcess(w)
        && !carriesNothing(w)
        // Never fold the only entry that carries content: then it is the process and the empty
        // restatement is the stale one.
        && contentEntries.length > 1;

    const toFold = replyWorkflows.filter((w) => w && typeof w === 'object' && foldable(w));
    const roundEntries = replyWorkflows.filter((w) => w && typeof w === 'object' && isRoundsProcess(w));

    if (toFold.length === 0 && roundEntries.length <= 1) {
        return { workflows: replyWorkflows, folded: 0 };
    }

    // The fullest account of the process survives: the round's entry, any verbatim restatement and any
    // reworded copy are one process, so the entry with the most content represents it and the round's
    // values are merged on top.
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
            // The process takes its first position, so the reply's own ordering survives.
            if (!placed) {
                out.push(merged);
                placed = true;
            }
            continue;
        }
        out.push(w);
    }

    // A fold is never silent: naming what was folded is the evidence needed to tell a reworded process
    // from a genuinely new one.
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
 * The round's value wins where both have one, which is a decision rather than a default: the earlier
 * value is the participant's, taken on the turn that collected it, while the later one is the model's
 * re-reading of its own memory, so taking the later value on a re-emission is taking the guess. The
 * reply's value is used where the round has nothing, so progress is never lost.
 *
 * @param {object} held The round's account.
 * @param {object} reply The reply's account.
 * @returns {object}
 */
export function mergeHeldIntoReply(held, reply) {
    const merged = { ...reply };
    for (const field of filledFields(held)) {
        // A field the round has filled is the participant's own earlier statement about this process, so
        // it is kept. `task` is deliberately excluded: the model rewords it, and either wording names the
        // same work.
        merged[field] = held[field];
    }
    // The round's identity is kept, so the console's answer links and `process_response` joins continue
    // to name one process rather than gaining a second id for the same work.
    if (typeof held.id === 'string' && held.id !== '') merged.id = held.id;
    return merged;
}
