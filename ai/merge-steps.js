/**
 * Merging the steps of a process described by several people.
 *
 * The rule is business logic rather than a rendering detail, because it decides where the automation
 * boundary is. It sits in `ai/` because both layers need it and `ai/` is the common ancestor, so
 * neither has to depend on the other; it imports only from `ai/`, keeping the one-way arrow intact.
 * The function is pure, so it is testable with literals.
 */

import { stepNeedsReasoning } from './matrix.js';
import { responseWorkflow } from './response-shape.js';

export { stepNeedsReasoning };

/** The key a step is merged on: its name, trimmed and case-folded. */
function stepKey(step) {
    return String((step && (step.name || step.whatHappens)) || '').trim().toLowerCase();
}

/**
 * Merges the steps of every response behind one process into one ordered sequence, not one per
 * response, because rendering them separately showed a three-step process six times. Merged by name,
 * first-seen order.
 *
 * The pessimistic reading wins: `needsReasoning` is true if any response says true, because the flag
 * marks where a human stays in the loop and the optimistic reading would hide the work the roadmap
 * exists to surface. On a disagreement the merged row carries the pessimistic flag and one account's
 * quotation, so differing wording takes the longer `whatHappens` and the first non-empty `decidedHow`
 * and `reasoningBasis`.
 *
 * @param {Array<object>} responses Response rows, each with `data` in either stored shape.
 * @returns {{steps: Array<object>, reasoningSteps: number, describedBy: Array<[string, number]>,
 *   stepCount: number, disagreed: boolean, disputedSteps: number, sharedSteps: number}}
 *   Merged steps, the count needing a person, the departments that described the work, the step count,
 *   and whether any shared step was read differently, how many, and how many were shared.
 */
export function mergeProcessSteps(responses) {
    const merged = new Map();
    const describedBy = new Map();

    for (const response of Array.isArray(responses) ? responses : []) {
        if (!response) continue;

        // Resolved once, here, where the response enters the merge, rather than at each read below:
        // both fields come from the same resolved workflow, so a shape the resolver understands cannot
        // be read correctly for the steps and wrongly for the departments.
        const workflow = responseWorkflow(response.data);

        // The departments and their counts are read from the responses behind the process rather than
        // from a field: "which departments described this" is how many people spoke, not how many teams
        // the work crosses.
        const departments = (workflow && workflow.touchedDepartments) || [];
        const list = Array.isArray(departments) ? departments : [];
        const names = list.length > 0 ? list : [response.department];
        for (const name of names.filter(Boolean)) {
            describedBy.set(name, (describedBy.get(name) || 0) + 1);
        }

        // From the same resolved workflow as the departments above: on a live interview this is
        // `data.workflows[0].steps`, and on an imported round `data.steps`.
        const steps = (workflow && workflow.steps) || [];
        for (const step of Array.isArray(steps) ? steps : []) {
            const key = stepKey(step);
            if (key === '') continue;

            const existing = merged.get(key);
            if (!existing) {
                // `accounts` and `flags` are bookkeeping for the caller, not fields of the step: they
                // are removed before the steps are returned.
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

            // First non-empty wins, like the basis it comes from: a second account that did quote must
            // not lose its evidence because the first one did not.
            if (!existing.reasoningBasis && step.reasoningBasis) {
                existing.reasoningBasis = step.reasoningBasis;
            }
        }
    }

    // Two counts, named for what they are, because using one for the other overstates the dispute:
    // `sharedSteps` is every step more than one account described, and `disputedSteps` is the subset
    // those accounts did not read the same way.
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
