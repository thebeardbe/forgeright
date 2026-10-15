/**
 * The shape of a stored response payload, resolved in one place, because two shapes exist and the
 * readers were written against one:
 *
 *   interview saves `{ workflows: [ ... ] }`   what the client posts
 *   imported saves the workflow directly       what the seed and the API write
 *
 * It lives in `ai/` because both layers read a response and only `lib/` importing `ai/` is allowed;
 * `lib/view-format.js` re-exports it, keeping every existing import path. A resolver written twice is
 * one that drifts.
 */

/**
 * The workflow a stored response should be read as, whatever shape it was saved in. It returns the
 * first workflow, because a round is the work of one process and a round with several is a shape the
 * round model does not produce. It never throws: a malformed or absent payload returns null and the
 * caller decides what to show.
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

    // The imported shape: the workflow IS the data. An empty object counts as nothing to show, so a
    // row with `{}` renders as untitled rather than as a heading that is not there.
    return Object.keys(data).length > 0 ? data : null;
}
