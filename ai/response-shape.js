/**
 * The shape of a STORED response payload, resolved in one place.
 *
 * WHY THIS MODULE EXISTS, and it is a defect rather than a tidy-up. A response is stored in one
 * of two shapes, and the code that reads it was written against one of them:
 *
 *   an INTERVIEW round saves `{ workflows: [ ... ] }`  - what the client posts
 *   an IMPORTED round saves the workflow directly      - what the demo seed and the API write
 *
 * `ai/merge-steps.js` read `response.data.steps`, a FLAT read, so on every live interview it saw
 * NO steps and NO touched departments. The consequences were silent and total: every step-derived
 * term scored as unmeasured, `reasoningSteps` came back zero, the merged step list was empty, and
 * the disagreement flags and the "needs a person" markers had nothing to mark. A real process
 * weighed 0 with "No steps were recorded" for work the participant had described in three steps.
 *
 * WHY THE DEMO HID IT: `scripts/seed-demo-org.js` writes the FLAT shape, so the committed demo
 * artefact weighs correctly and the deployed demo looks perfect. The first real client interview
 * was the one that scored zero.
 *
 * WHY IT LIVES IN `ai/` AND NOT `lib/`. The resolver has to be reachable from BOTH layers: the
 * console views read a response through `lib/view-format.js`, and the merge and the weighing read
 * one from `ai/`. `ai/` is the common ancestor, because `lib/` importing `ai/` is the established
 * direction (`lib/scoring.js`, `lib/routes-api.js`) and the reverse is not.
 *
 * `ai/merge-steps.js` COULD NOT SIMPLY IMPORT `responseWorkflow` FROM `lib/view-format.js`, and
 * that is a measured fact rather than a preference: `test/merge-steps.test.js` pins that module's
 * dependencies to `./matrix.js` alone, and an import of `../lib/view-format.js` fails it with
 * "ai/ does not import lib/". The function moved here instead, and `lib/view-format.js`
 * RE-EXPORTS IT, so `responseWorkflow` keeps both its behaviour and its import path for every
 * existing caller. `ai/field-shapes.js` was split out of `ai/matrix.js` the same way, for the same
 * reason, so this follows the pattern the project already uses.
 *
 * THERE IS ONE DEFINITION OF THE SHAPE. A resolver written a second time is a resolver that
 * drifts, and this defect is what that drift costs.
 */

/**
 * The workflow a stored response should be read as, whatever shape it was saved in.
 *
 * IT RETURNS THE FIRST WORKFLOW: a round is the work of one process, so a round with several is a
 * shape the round model does not produce, and showing the first is honest rather than merging them
 * into something that was never said.
 *
 * IT NEVER THROWS. A malformed or absent payload returns null and the caller decides what to show,
 * which is what keeps a corrupt row from taking a page down.
 *
 * @param {object|null} data The parsed response data.
 * @returns {object|null} The workflow to read fields from, or null when there is none.
 */
export function responseWorkflow(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;

    // The interview shape first, because that is what a live round saves.
    if (Array.isArray(data.workflows)) {
        return data.workflows.find((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)) ?? null;
    }

    // The imported shape: the workflow IS the data. An empty object counts as nothing to show,
    // so a row with `{}` renders as untitled rather than as a heading that is not there.
    return Object.keys(data).length > 0 ? data : null;
}
