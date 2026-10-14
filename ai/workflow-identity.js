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

/**
 * The step names of a workflow, trimmed and case-folded.
 *
 * ONE DEFINITION, shared with the client's copy in `public/js/audit.js` and with
 * `ai/merge-steps.js`'s `stepKey`, so a change to what "the same step" means cannot be made in
 * one place and missed in the others.
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
 * Whether two workflows share at least one EXACTLY equal step name.
 *
 * NO SIMILARITY, NO THRESHOLD. Measured on the owner's own payload, a step-text overlap rule
 * cannot work: the same process reworded scored 0.588 against a DIFFERENT process described in
 * the participant's own words at 0.556. A margin of 0.032 is inside the model's rewording noise,
 * so any threshold that folds the true match is one rewording away from folding a genuine one.
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
 * Whether a process is the same one the round was already working on.
 *
 * THE ROUND IS THE EVIDENCE THE REPLY CANNOT CARRY, and this is the whole reason the decision
 * belongs on the server. The model never sees its own prior `processes` - `ai/audit-core.js`
 * rebuilds an assistant turn as role and content only - so it re-derives its answer from memory
 * each turn and re-words it. The prompt states one process per round ("`processes` holds the
 * process you are working on NOW", `prompt_en.md` line 515) and NOTHING enforced it, so a live
 * interview produced the same process twice: four steps, all four reworded, same order, and
 * `frequencyPerWeek` 56 in one entry against 7 in the other because the model had forgotten it
 * had already recorded 56 servers and re-read "every morning" as weekly.
 *
 * THE TESTS, in order, and each is a positive statement about the data rather than a score:
 *
 *   1. THE ROUND HOLDS EXACTLY ONE PROCESS and the reply carries an entry that is not it. This
 *      is the ordinary case: the round was working on one process, so a reply cannot be starting
 *      a second one unless the participant named one - and naming one is a turn of its own,
 *      which produces an entry with NO shared fields and no steps to share.
 *   2. THE ENTRY CARRIES NOTHING YET. A newly named process begins as a fresh matrix from its
 *      `task` and `trigger` (line 511). But see the test below: emptiness alone is NOT identity,
 *      which is what killed the by-absence arm in the client.
 *   3. OR THE TWO ENTRIES SHARE AN EXACT STEP NAME. Verbatim agreement, no inference.
 *
 * AND THE HARM DIRECTION: it must DECLINE when the reply is a genuinely different process. An
 * entry with content that shares no step name with the held process is a different process, and
 * stays separate. Only the case the round can actually witness - one process, being re-emitted -
 * is folded.
 *
 * @param {Array<object>} replyWorkflows The workflows from this reply.
 * @param {Array<object>} heldWorkflows The processes the round already holds.
 * @returns {{ workflows: Array<object>, folded: number }}
 */
export function reconcileWithHeld(replyWorkflows, heldWorkflows) {
    if (!Array.isArray(replyWorkflows) || replyWorkflows.length === 0) {
        return { workflows: replyWorkflows, folded: 0 };
    }
    // A ROUND HOLDS ONE PROCESS AT A TIME (line 515). With several held, position and step
    // sharing are not evidence enough to say WHICH one is being reworded, so this declines and
    // the caller keeps the reply as it stands - the safe direction.
    if (!Array.isArray(heldWorkflows) || heldWorkflows.length !== 1) {
        return { workflows: replyWorkflows, folded: 0 };
    }

    const held = heldWorkflows[0];
    if (!held || typeof held !== 'object' || Array.isArray(held)) {
        return { workflows: replyWorkflows, folded: 0 };
    }

    // THE REPLY IS THE ROUND'S PROCESS WHEN IT SHARES A STEP NAME WITH IT, or when it carries
    // nothing to compare and the round holds the content. Otherwise it is something else and is
    // left alone.
    const carriesNothing = (w) => !Array.isArray(w.steps) || w.steps.length === 0;
    // POSITIVE, VERBATIM EVIDENCE ONLY: the entry names the round's id, or shares an exactly
    // equal step name with it.
    //
    // THERE IS DELIBERATELY NO EMPTINESS CLAUSE, and leaving it out is the fix for a trap this
    // codebase has already sprung twice. An entry carrying no steps is NOT evidence of being the
    // round's process: on a naming turn it is the process the participant has JUST NAMED, which
    // the prompt says arrives as "a fresh matrix from its `task` and `trigger` onward"
    // (`prompt_en.md` line 511). Folding on emptiness discards that process - the harm that
    // killed the client's by-absence arm - and I reintroduced it here before this test caught it.
    const isRoundsProcess = (w) => sharesAStepName(w, held)
        || (typeof w.id === 'string' && w.id === held.id);

    // WHICH ENTRY IS THE ROUND'S, and there can be at most one: the process the round was on.
    const matches = replyWorkflows.filter((w) => w && typeof w === 'object' && isRoundsProcess(w));
    if (matches.length === 0) return { workflows: replyWorkflows, folded: 0 };

    // THE ROUND'S OWN ENTRY IS RESTATED, so the reply describes the same process TWICE: once in
    // the round's wording and once reworded. A reworded copy is recognised by having CONTENT
    // while the round's process is being restated - see the note above `foldRewording` for why
    // that, and not emptiness, is the signal.
    //
    // A NAMING TURN IS THE OTHER SHAPE AND IS NOT FOLDED: a participant naming a new process
    // produces `[ the finished process , the new one with NO steps ]`, and the entry with no
    // content is the NEW one. That is the exact inverse of the by-absence arm that was removed
    // from the client, and the reason this folds the FULL entry rather than the empty one.
    const restatedSomething = matches.length > 0;
    const contentEntries = replyWorkflows.filter((w) => w && typeof w === 'object' && !carriesNothing(w));
    const foldable = (w) => restatedSomething
        && !isRoundsProcess(w)
        && !carriesNothing(w)
        // Never fold the only entry that carries content: then IT is the process and the empty
        // restatement is the stale one.
        && contentEntries.length > 1;

    const toFold = replyWorkflows.filter((w) => w && typeof w === 'object' && foldable(w));
    const roundEntries = replyWorkflows.filter((w) => w && typeof w === 'object' && isRoundsProcess(w));

    if (toFold.length === 0 && roundEntries.length <= 1) {
        return { workflows: replyWorkflows, folded: 0 };
    }

    // THE FULLEST ACCOUNT OF THE PROCESS SURVIVES: the round's entry, any verbatim restatement,
    // and any reworded copy are one process, so the entry with the most content represents it and
    // the round's values are merged on top.
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
            // THE PROCESS TAKES ITS FIRST POSITION, so the reply's own ordering survives.
            if (!placed) {
                out.push(merged);
                placed = true;
            }
            continue;
        }
        out.push(w);
    }

    // A FOLD IS NEVER SILENT. The server names what it folded, which is the evidence needed to
    // tell a reworded process from a genuinely new one if the second is ever seen in the wild.
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
 * THE ROUND'S VALUE WINS WHERE BOTH HAVE ONE, and this is a decision rather than a default.
 * `frequencyPerWeek` was 56 in the round and 7 in the reply, because the model re-derived it
 * from "every morning" having forgotten it had already recorded 56 servers. THE EARLIER VALUE IS
 * THE PARTICIPANT'S, taken on the turn that collected it, and the later one is the model's
 * re-reading of its own memory. Taking the later value on a re-emission is taking the guess.
 *
 * THE REPLY'S VALUE IS USED WHERE THE ROUND HAS NOTHING, so progress is never lost: this is a
 * merge of one process's accounts, not a rejection of the new turn.
 *
 * @param {object} held The round's account.
 * @param {object} reply The reply's account.
 * @returns {object}
 */
export function mergeHeldIntoReply(held, reply) {
    const merged = { ...reply };
    for (const field of filledFields(held)) {
        // A field the round has filled is the participant's own earlier statement about THIS
        // process, so it is kept. `task` is deliberately excluded: the model rewords it, and the
        // round's wording is not more correct than the reply's - either names the same work.
        merged[field] = held[field];
    }
    // THE ROUND'S IDENTITY IS KEPT, so the console's answer links and `process_response` joins
    // continue to name one process rather than gaining a second id for the same work.
    if (typeof held.id === 'string' && held.id !== '') merged.id = held.id;
    return merged;
}
