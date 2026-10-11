/**
 * Merging the steps of a process described by several people.
 *
 * WHY THIS IS A MODULE AND NOT A TEMPLATE. The rule below is business logic: it
 * decides what the automation boundary is, which is the one thing a reader of the
 * roadmap most needs to be true. It was originally written inline in
 * `views/admin-roadmap.ejs`, where no test could reach it, so the pessimistic
 * reading of a disagreement was covered by nothing at all. It lives here now
 * because the console's view of a process and the score's view of a process are
 * the same claim, and a claim made twice in two languages drifts.
 *
 * WHY IT LIVES IN `ai/` AND NOT `lib/store/`. It is a pure comment on the shape of
 * a response, so it could sit either side of that boundary on its own merits. It
 * sits here because BOTH layers now need it: the console renders the merged steps,
 * and the weighing prompt sends them to the model, and `ai/weigh-core.js` is the
 * caller. Importing it from `lib/store/` would have made `ai/` depend on the store
 * layer, which is the wrong direction: `ai/` is the workflow logic that turns
 * responses into model replies and should not know the store exists. `ai/` is the
 * common ancestor of both callers, so the shared piece belongs there. See the
 * dependency rule in the note below.
 *
 * NOT IN `lib/store/processes.js`: that module's export list is pinned by
 * `test/processes.test.js` to exactly the five operations the console path needs,
 * and the pin is a deliberate boundary rather than an accident.
 *
 * DEPENDENCY DIRECTION, which is what made the placement a real question: `lib/`
 * importing `ai/` is long established (`lib/scoring.js`, `lib/routes-api.js`).
 * `ai/` importing `lib/` was a NEW edge, and it is NOT introduced here: this
 * module imports only from `ai/matrix.js`, so every file in the graph stays on the
 * right side of the arrow (`ai/` -> `ai/` within the layer, `lib/` -> `ai/`
 * across it).
 *
 * THE FUNCTION IS PURE. It takes plain responses and returns plain steps: no
 * database, no connection, no org. That is what makes it testable with literals.
 */

import { stepNeedsReasoning } from './matrix.js';

export { stepNeedsReasoning };

/** The key a step is merged on: its name, trimmed and case-folded. */
function stepKey(step) {
    return String((step && (step.name || step.whatHappens)) || '').trim().toLowerCase();
}

/**
 * Merges the steps of every response behind ONE process into one ordered sequence.
 *
 * A PROCESS HAS ONE SEQUENCE OF STEPS, not one per response. Each participant
 * describing the same work lists the same steps in the same order, so rendering
 * them per response showed a three-step process six times over. Steps are merged
 * by name, keeping first-seen order, which is each participant's own order.
 *
 * THE PESSIMISTIC READING WINS on a disagreement. If one participant says a step
 * follows a rule and another says it needs a person, the step needs a person:
 * `needsReasoning` is true if ANY response says true. This is not a tie-break, it
 * is the point of the merge. The flag marks where a human stays in the loop, and
 * taking the optimistic reading would hide exactly the work the roadmap exists to
 * surface, in favour of a tidier number. The mock fixture carries this case
 * deliberately: two accounts of invoice processing disagree about whether matching
 * the amounts is a two-euro rule or a judgement about the supplier.
 *
 * THIS IS A KNOWN TRADE WITH A STATED LIMIT, not an accident of ordering. On a
 * disagreement the merged row carries the PESSIMISTIC FLAG and ONE ACCOUNT'S
 * QUOTATION, so the quotation can come from an account whose own reading of the
 * step was the optimistic one. Pairing the flag with the quote from the account
 * that decided it would be worse: a reader would then be shown a rejected reading
 * presented as the accepted evidence. The other accounts' own flags and
 * quotations are readable in view 1, under each answer, where the disagreement is
 * visible as a disagreement. A reader who opens only the roadmap sees the merged
 * row and not that. That limit is recorded here rather than left to be discovered.
 *
 * Where two accounts of the same step differ in wording, the LONGER `whatHappens`
 * wins (it carries more of what somebody said) and the FIRST non-empty `decidedHow`
 * wins (a basis is a basis; the first account to state one is not made wrong by a
 * second that omits it). `reasoningBasis`, the quotation behind the flag, follows
 * the same rule as `decidedHow`: first non-empty wins, so a later account that
 * quoted is not dropped for arriving second.
 *
 * @param {Array<object>} responses Response rows, each with `data.steps`.
 * @returns {{
 *   steps: Array<object>,
 *   reasoningSteps: number,
 *   describedBy: Array<[string, number]>,
 *   stepCount: number,
 *   disagreed: boolean,
 *   disputedSteps: number,
 *   sharedSteps: number
 * }} The merged steps with the count of steps needing a person, the departments
 *   that described the work, how many steps there are, whether any shared step was
 *   read differently by different accounts, HOW MANY were read differently, and how
 *   many were shared at all.
 */
export function mergeProcessSteps(responses) {
    const merged = new Map();
    const describedBy = new Map();

    for (const response of Array.isArray(responses) ? responses : []) {
        if (!response) continue;

        // The departments and their counts are read from the responses BEHIND the
        // process rather than from a field: "which departments described this" is
        // how many people spoke, not how many teams the work crosses, and the two
        // questions have different answers.
        const departments = (response.data && response.data.touchedDepartments) || [];
        const list = Array.isArray(departments) ? departments : [];
        const names = list.length > 0 ? list : [response.department];
        for (const name of names.filter(Boolean)) {
            describedBy.set(name, (describedBy.get(name) || 0) + 1);
        }

        const steps = (response.data && response.data.steps) || [];
        for (const step of Array.isArray(steps) ? steps : []) {
            const key = stepKey(step);
            if (key === '') continue;

            const existing = merged.get(key);
            if (!existing) {
                // `accounts` and `flags` are bookkeeping for the caller, not fields of
                // the step: they are removed before the steps are returned.
                merged.set(key, { ...step, accounts: 1, flags: new Set([stepNeedsReasoning(step)]) });
                continue;
            }

            existing.accounts += 1;
            existing.flags.add(stepNeedsReasoning(step));

            if (String(step.whatHappens || '').length > String(existing.whatHappens || '').length) {
                existing.whatHappens = step.whatHappens;
            }
            if (!existing.decidedHow && step.decidedHow) existing.decidedHow = step.decidedHow;
            if (stepNeedsReasoning(step)) existing.needsReasoning = true;

            // THE QUOTATION IS CARRIED THE SAME WAY AS THE BASIS IT COMES FROM. The
            // first account to state one is not made wrong by a second that omits
            // it, and a second account that DID quote must not have its evidence
            // dropped just because the first one did not. Without this the field
            // survived only when the first response happened to carry it, which is
            // the sort of asymmetry that reads as a model being inconsistent.
            if (!existing.reasoningBasis && step.reasoningBasis) {
                existing.reasoningBasis = step.reasoningBasis;
            }
        }
    }

    // WHETHER THE ACCOUNTS DISAGREED, reported rather than left for the caller to
    // infer from the response count. Two people who describe a process and agree
    // about every flag are a different thing from two who differ, and the roadmap
    // shows a note about the disagreement only when there is one: a note on every
    // multi-account process reads as boilerplate and stops being a signal that a
    // particular process needs attention.
    //
    // TWO COUNTS, NAMED FOR WHAT THEY ARE. `sharedSteps` is every step more than one
    // account described; `disputedSteps` is the subset those accounts did not read
    // the same way. They diverge as soon as a process has several shared steps and a
    // dispute on one, and using the first for the second OVERSTATES the dispute in
    // exactly the case the roadmap note exists for. A figure named for one thing and
    // used for another is how that went unnoticed for four rounds.
    const all = [...merged.values()];
    const disputedSteps = all.filter((step) => step.flags.size > 1).length;
    const sharedSteps = all.filter((step) => step.accounts > 1).length;
    const disagreed = disputedSteps > 0;

    // The bookkeeping is dropped here, so a caller sees only step fields.
    const steps = all.map(({ accounts, flags, ...step }) => step);

    return {
        steps,
        stepCount: steps.length,
        reasoningSteps: steps.filter(stepNeedsReasoning).length,
        describedBy: [...describedBy.entries()].sort((a, b) => b[1] - a[1]),
        // True when at least one merged step was described by more than one account
        // AND those accounts did not all read its flag the same way.
        disagreed,
        disputedSteps,
        sharedSteps
    };
}
