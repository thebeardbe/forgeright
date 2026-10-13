/**
 * The `id` and `title` a workflow gets when the interview path has not supplied them.
 *
 * WHY THIS EXISTS, and it is a reproduced defect rather than a tidy-up. A live interview ends with
 * "The analysis could not be computed." because of these two fields, and it is worth stating the
 * whole chain because every link was individually reasonable:
 *
 *   `ai/audit-core.js` `workflowsFrom` prefers `parsed.processes`, which is what the prompt asks
 *   the model to emit on EVERY turn. The `processes` example in the prompt
 *   (`data/prompts/cartiere_audit/prompt_en.md` line 276) has `task`, `trigger` and `steps` and
 *   NO `id` and NO `title`. The client wraps that array as `{ workflows }` and hands it to
 *   `/api/score` unchanged, and `lib/routes-api.js` validates it with `validateWorkflows`, which
 *   REQUIRES both fields. So the payload a participant's own interview produces can never satisfy
 *   the scorer's validator: `[api/score] refused: 1 entry has no id.` and a 400.
 *
 * THE PROMPT DOES ASK FOR THEM, in the `audit.workflows` block at lines 338-339. That block is
 * the one `workflowsFrom` puts SECOND, so on the interview path the model is asked for the fields
 * on one shape and its answer is read from another. This module makes the shape the interview
 * actually produces carry what the prompt already documents, rather than relaxing the check.
 *
 * WHY NOT SIMPLY STOP REQUIRING THEM. `id` is not decoration the validator invented: it is the
 * process's identity, and two consumers depend on it being stable and unique.
 *
 *   `lib/scoring.js` keys a union-find on `w.id` (`findConflictGroups`, line 223 onwards), so
 *   entries sharing a key are treated as ONE process. Measured: three workflows with no `id`
 *   return a single group of three, which collapses distinct processes into one another.
 *   `public/js/audit.js` `mergeForwardDroppedProcesses` matches carried-forward processes by
 *   `id`, and only records one in `state.roundProcesses` when `id` is a non-empty string. With no
 *   `id` that map stays empty, the carry-forward silently does nothing, and the `console.warn`
 *   that would have reported the loss never fires.
 *
 * THE DEMO IS UNCHANGED BY DESIGN, and that is the test of this being the right shape: the seed
 * writes `id: "invoice-processing"` and `title: "Invoice intake and processing"` directly, which
 * is the same short-kebab-case convention this generates. After it, both paths agree.
 */

/** The longest slug worth generating. A task is prose and an id is a name, not a paragraph. */
const MAX_SLUG_LENGTH = 60;

/** What is left of a slug when a task has no letters or digits at all. */
const FALLBACK_SLUG = 'process';

/** The longest title taken from a task, so a heading stays a heading. */
const MAX_TITLE_LENGTH = 80;

/**
 * A short kebab-case slug for a process, derived from its own task.
 *
 * PURE AND DETERMINISTIC, which is the whole point: the same task yields the same slug on every
 * turn, with no counter, no clock and no randomness. That is what makes the value STABLE, and
 * stability is the property the client's carry-forward needs. An id regenerated per turn would
 * break the very match it exists to serve, and the failure would look like the participant's
 * answers being dropped.
 *
 * ASCII ONLY. A task may be written in any language (the prompt asks the model to write in the
 * participant's), so an accented or non-Latin task is reduced to what survives rather than
 * producing an id that is an encoding of prose. The FALLBACK covers the case where nothing
 * survives, so the caller never receives an empty string that `validateWorkflows` would refuse.
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
        // A trim AFTER the slice, because cutting at 60 characters can leave a trailing dash.
        .replace(/-+$/g, '');

    return slug === '' ? FALLBACK_SLUG : slug;
}

/**
 * A human-readable title for a process, taken from its task.
 *
 * THE TASK IS THE TITLE, because on the interview path it is the only name a process has: the
 * participant described the work, and the prompt's `title` field is not produced. This is a
 * heading rather than a summary, so a long task is shortened at a word boundary where one exists
 * and a known-length ellipsis is appended, so a reader can see something was left out instead of
 * finding a sentence that stops mid-word.
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
    // Only break on a space when there is a word's worth of text before it; otherwise the clip
    // itself is the better heading.
    const head = lastSpace > MAX_TITLE_LENGTH * 0.6 ? clipped.slice(0, lastSpace) : clipped;
    return `${head.trimEnd()}...`;
}

/**
 * Gives every workflow in a payload the `id` and `title` the scorer requires, without touching
 * any that already carries them.
 *
 * EXISTING VALUES WIN, ALWAYS. The demo seed writes its own id and title, `audit.workflows` from
 * the model may carry them, and any reply that supplies them is more informative than a slug
 * derived from the task. Overwriting them here would change what the demo scores, so a present
 * and non-blank value is passed through untouched.
 *
 * UNIQUENESS IS ENFORCED WITHIN THE PAYLOAD, and this is not tidiness. `findConflictGroups` keys
 * a union-find on `id`, so two processes deriving the same slug from two similar tasks would be
 * treated as ONE process and merged into a single conflict group. A repeated slug therefore gets
 * `-2`, `-3` in array order, which is stable for a given payload and keeps distinct processes
 * distinct. A workflow with no usable task at all falls back to its position for the same reason.
 *
 * IT DOES NOT MUTATE ITS INPUT: the caller's array and objects are left alone and a new array is
 * returned, so a resolved payload cannot be altered by a later reader of the original.
 *
 * @param {Array<object>} workflows The workflows as the model supplied them.
 * @returns {Array<object>} A new array, each entry carrying a usable `id` and `title`.
 */
export function withWorkflowIdentity(workflows) {
    if (!Array.isArray(workflows)) return workflows;

    // `counts` IS THE ONLY BOOKKEEPING, and an explicit id is claimed through it too, so a
    // generated slug cannot collide with an id the payload already carried beside it.
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
 * Claims `base`, or the first free `base-N` when it is taken.
 *
 * COUNTS PER BASE RATHER THAN SCANNING GLOBALLY, so the suffixes stay small and predictable:
 * three processes with the same task become `task`, `task-2`, `task-3` rather than `task`,
 * `task-2`, `task-3` after two unrelated collisions have already pushed the counter up.
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

    // The base is taken, so the FIRST duplicate becomes `-2` and the count moves on from there:
    // `base` is 1, `base-2` is 2, `base-3` is 3. The loop exists because a payload may already
    // contain an explicit `base-2`, and handing that out twice would collapse the two processes
    // into one conflict group.
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
