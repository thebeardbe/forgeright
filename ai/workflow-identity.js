/**
 * The `id` and `title` a workflow gets when the interview path has not supplied them.
 *
 * A REPRODUCED DEFECT. The prompt asks for `id` and `title` in its `audit.workflows` block, but
 * `workflowsFrom` reads `parsed.processes` - a different block with neither field - so a live
 * interview reached `/api/score` without them and was refused with a 400: "The analysis could not
 * be computed."
 *
 * THE FIELDS CANNOT SIMPLY BE UNREQUIRED. `id` is the process's identity: `findConflictGroups`
 * keys a union-find on it, so entries sharing a key collapse into one process, and the client's
 * `mergeForwardDroppedProcesses` matches carried-forward processes by it, silently doing nothing
 * when it is missing.
 *
 * The demo seed writes both directly, in the same short-kebab-case convention this generates, so
 * after this the two paths agree.
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
 * PURE AND DETERMINISTIC, which is the point: the same task yields the same slug on every turn.
 * Stability is what the client's carry-forward needs - an id regenerated per turn would break the
 * match it exists to serve, and the failure would look like dropped answers.
 *
 * ASCII ONLY, because a task may be in any language; a task that leaves nothing falls back rather
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
        // A trim AFTER the slice, because cutting at 60 characters can leave a trailing dash.
        .replace(/-+$/g, '');

    return slug === '' ? FALLBACK_SLUG : slug;
}

/**
 * A human-readable title for a process, taken from its task.
 *
 * The task IS the title on the interview path: the participant described the work and the prompt's
 * `title` field is never produced. A long task is cut at a word boundary with an ellipsis, so a
 * reader can see something was left out rather than finding a sentence that stops mid-word.
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
 * Gives every workflow in a payload the `id` and `title` the scorer requires.
 *
 * EXISTING VALUES WIN. The demo seed writes its own, the model may supply them, and a present
 * non-blank value is more informative than a derived slug - overwriting would change what the demo
 * scores.
 *
 * UNIQUENESS IS NOT TIDINESS: `findConflictGroups` keys a union-find on `id`, so two processes
 * deriving the same slug would be treated as ONE process. A repeat gets `-2`, `-3` in array order.
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
 * THE ROUND IS THE EVIDENCE THE REPLY CANNOT CARRY, which is why this belongs on the server: the
 * model never sees its own prior `processes` - `ai/audit-core.js` rebuilds an assistant turn as
 * role and content only - so it re-derives and re-words each turn. MEASURED: the same process came
 * back as four steps all reworded, with `frequencyPerWeek` 56 in one entry against 7 in the other
 * because the model had forgotten it recorded 56 and re-read "every morning" as weekly.
 *
 * THE MATCH IS POSITIVE AND VERBATIM: a shared step name, or the same id. Nothing is inferred from
 * the ABSENCE of evidence.
 *
 * THE HARM DIRECTION: it must DECLINE for a genuinely different process, and it does - such an
 * entry shares no step name and is not the held id. Only the case the round can witness, one
 * process being re-emitted, is folded.
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

    const carriesNothing = (w) => !Array.isArray(w.steps) || w.steps.length === 0;
    // POSITIVE, VERBATIM EVIDENCE ONLY: the entry names the round's id, or shares an exactly
    // equal step name with it. THIS FUNCTION HAS NO EMPTINESS CLAUSE, deliberately - an entry with
    // no steps is NOT evidence of being the round's process, because on a naming turn it is the
    // process the participant has JUST NAMED. Emptiness is used BELOW, in the opposite direction:
    // see `foldable`.
    const isRoundsProcess = (w) => sharesAStepName(w, held)
        || (typeof w.id === 'string' && w.id === held.id);

    // WHICH ENTRY IS THE ROUND'S, and there can be at most one: the process the round was on.
    const matches = replyWorkflows.filter((w) => w && typeof w === 'object' && isRoundsProcess(w));
    if (matches.length === 0) return { workflows: replyWorkflows, folded: 0 };

    // A REWORDED COPY HAS CONTENT while the round's process is being restated, and THAT is the
    // signal - not emptiness. A NAMING TURN IS THE OTHER SHAPE AND IS NOT FOLDED: naming a new
    // process produces `[ the finished process , the new one with NO steps ]`, and the entry with
    // no content is the NEW one. `!carriesNothing` is what keeps that process, which is the
    // inverse of the by-absence arm removed from the client.
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
