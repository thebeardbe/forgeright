/**
 * Merging the steps of a process described by several people.
 *
 * THE RULE IS BUSINESS LOGIC, not a rendering detail: it decides where the automation boundary
 * is. It sits in `ai/` because BOTH layers need it - the console renders the merged steps and the
 * weighing prompt sends them to the model - and `ai/` is the common ancestor, so neither has to
 * depend on the other. It imports only from `ai/`, keeping the one-way arrow intact.
 *
 * NOT IN `lib/store/processes.js`, whose export list is pinned to the console's five operations by
 * test/processes.test.js.
 *
 * THE FUNCTION IS PURE: plain responses in, plain steps out, so it is testable with literals.
 */

import { stepNeedsReasoning } from './matrix.js';
import { responseWorkflow } from './response-shape.js';

export { stepNeedsReasoning };

/** The key a step is merged on: its name, trimmed and case-folded. */
function stepKey(step) {
    return String((step && (step.name || step.whatHappens)) || '').trim().toLowerCase();
}

/**
 * Merges the steps of every response behind ONE process into one ordered sequence.
 *
 * One sequence per process, not per response: rendering them separately showed a
 * three-step process six times. Merged by name, first-seen order.
 *
 * THE PESSIMISTIC READING WINS: `needsReasoning` is true if ANY response says true.
 * Not a tie-break - the flag marks where a human stays in the loop, and the
 * optimistic reading would hide the work the roadmap exists to surface. The fixture
 * carries the case: two accounts of invoice processing disagree about whether
 * matching amounts is a two-euro rule or a judgement.
 *
 * On a disagreement the merged row carries the pessimistic flag and ONE account's
 * quotation, so the quote may come from the optimistic account. The others are
 * readable under each answer, but a reader who opens only the roadmap sees neither.
 *
 * Differing wording: the LONGER `whatHappens` wins, and the FIRST non-empty
 * `decidedHow` and `reasoningBasis` win.
 *
 * `responseWorkflow` resolves the shape, so this reader and the console cannot drift.
 *
 * @param {Array<object>} responses Response rows, each with `data` in EITHER stored shape.
 * @returns {{steps: Array<object>, reasoningSteps: number, describedBy: Array<[string, number]>,
 *   stepCount: number, disagreed: boolean, disputedSteps: number, sharedSteps: number}}
 *   Merged steps, the count needing a person, the departments that described the work, the step
 *   count, and whether any shared step was read differently, how many, and how many were shared.
 */
export function mergeProcessSteps(responses) {
    const merged = new Map();
    const describedBy = new Map();

    for (const response of Array.isArray(responses) ? responses : []) {
        if (!response) continue;

        // RESOLVED ONCE, HERE, WHERE THE RESPONSE ENTERS THE MERGE, rather than at each read
        // below. Both fields come from the same resolved workflow, so a shape the resolver
        // understands cannot be read correctly for the steps and wrongly for the departments.
        const workflow = responseWorkflow(response.data);

        // The departments and their counts are read from the responses BEHIND the
        // process rather than from a field: "which departments described this" is
        // how many people spoke, not how many teams the work crosses, and the two
        // questions have different answers.
        const departments = (workflow && workflow.touchedDepartments) || [];
        const list = Array.isArray(departments) ? departments : [];
        const names = list.length > 0 ? list : [response.department];
        for (const name of names.filter(Boolean)) {
            describedBy.set(name, (describedBy.get(name) || 0) + 1);
        }

        // FROM THE SAME RESOLVED WORKFLOW as the departments above. On a live interview this is
        // `data.workflows[0].steps`; on an imported round it is `data.steps`.
        const steps = (workflow && workflow.steps) || [];
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

            // First non-empty wins, like the basis it comes from: a second account that DID
            // quote must not lose its evidence because the first one did not.
            if (!existing.reasoningBasis && step.reasoningBasis) {
                existing.reasoningBasis = step.reasoningBasis;
            }
        }
    }

    // TWO COUNTS, NAMED FOR WHAT THEY ARE, because using one for the other overstates the
    // dispute: `sharedSteps` is every step more than one account described, and `disputedSteps`
    // is the subset those accounts did not read the same way.
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
        disagreed,
        disputedSteps,
        sharedSteps
    };
}
