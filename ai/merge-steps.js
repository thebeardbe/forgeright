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
 * Where two accounts of the same step differ in wording, the LONGER `whatHappens`
 * wins (it carries more of what somebody said) and the FIRST non-empty `decidedHow`
 * wins (a basis is a basis; the first account to state one is not made wrong by a
 * second that omits it).
 *
 * @param {Array<object>} responses Response rows, each with `data.steps`.
 * @returns {{
 *   steps: Array<object>,
 *   reasoningSteps: number,
 *   describedBy: Array<string>,
 *   stepCount: number
 * }} The merged steps with the count of steps needing a person, the departments
 *   that described the work, and how many steps there are.
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
                merged.set(key, { ...step });
                continue;
            }

            if (String(step.whatHappens || '').length > String(existing.whatHappens || '').length) {
                existing.whatHappens = step.whatHappens;
            }
            if (!existing.decidedHow && step.decidedHow) existing.decidedHow = step.decidedHow;
            if (stepNeedsReasoning(step)) existing.needsReasoning = true;
        }
    }

    const steps = [...merged.values()];

    return {
        steps,
        stepCount: steps.length,
        reasoningSteps: steps.filter(stepNeedsReasoning).length,
        describedBy: [...describedBy.entries()].sort((a, b) => b[1] - a[1])
    };
}
