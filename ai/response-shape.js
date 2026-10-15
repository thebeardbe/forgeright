/**
 * The shape of a STORED response payload, resolved in one place.
 *
 * Two shapes exist and the readers were written against one:
 *
 *   INTERVIEW saves `{ workflows: [ ... ] }`   - what the client posts
 *   IMPORTED saves the workflow directly       - what the seed and the API write
 *
 * `merge-steps.js` read `response.data.steps`, so every live interview saw NO steps:
 * step-derived terms scored unmeasured, `reasoningSteps` was zero, the merged list was
 * empty, and a real process weighed 0 for work described in three steps. The demo hid
 * it, because the seed writes the flat shape - the first real interview scored zero.
 *
 * Lives in `ai/` because BOTH layers read a response, and only `lib/` importing `ai/`
 * is allowed. `merge-steps.js` cannot import `lib/view-format.js`: `merge-steps.test.js`
 * pins its dependencies to the ai layer, so the function moved here and
 * `lib/view-format.js` re-exports it, keeping every existing import path.
 *
 * A resolver written twice is one that drifts.
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
