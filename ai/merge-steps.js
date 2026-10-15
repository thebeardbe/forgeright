/**
 * Merging the steps of a process described by several people.
 *
 * Business logic rather than a rendering detail, because it decides where the automation boundary is. It
 * sits in `ai/` because both layers need it and `ai/` is the common ancestor; it imports only from `ai/`.
 */

import { stepNeedsReasoning } from './matrix.js';
import { responseWorkflow } from './response-shape.js';

export { stepNeedsReasoning };

/** The key a step is merged on: its name, trimmed and case-folded. */
function stepKey(step) {
    return String((step && (step.name || step.whatHappens)) || '').trim().toLowerCase();
}

/**
 * Merges the steps of every response behind one process into one ordered sequence, merged by name in
 * first-seen order, rather than one sequence per response.
 *
 * The pessimistic reading wins: `needsReasoning` is true if any response says true, because the flag marks
 * where a human stays in the loop and the optimistic reading would hide that work. Differing wording takes
 * the longer `whatHappens` and the first non-empty `decidedHow` and `reasoningBasis`.
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

        // Resolved once here rather than at each read below, so the steps and the departments cannot
        // disagree about the shape.
        const workflow = responseWorkflow(response.data);

        // Read from the responses behind the process rather than a field: "which departments described
        // this" is how many people spoke, not how many teams the work crosses.
        const departments = (workflow && workflow.touchedDepartments) || [];
        const list = Array.isArray(departments) ? departments : [];
        const names = list.length > 0 ? list : [response.department];
        for (const name of names.filter(Boolean)) {
            describedBy.set(name, (describedBy.get(name) || 0) + 1);
        }

        // From the same resolved workflow as the departments above.
        const steps = (workflow && workflow.steps) || [];
        for (const step of Array.isArray(steps) ? steps : []) {
            const key = stepKey(step);
            if (key === '') continue;

            const existing = merged.get(key);
            if (!existing) {
                // Bookkeeping, removed before the steps are returned.
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

            // First non-empty wins, so a second account that did quote keeps its evidence.
            if (!existing.reasoningBasis && step.reasoningBasis) {
                existing.reasoningBasis = step.reasoningBasis;
            }
        }
    }

    // `disputedSteps` is the subset of `sharedSteps` the accounts read differently.
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
