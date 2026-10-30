/**
 * The workflow a stored response should be read as. Two shapes are stored: an interview round saves
 * `{ workflows: [ ... ] }`, an imported round saves the workflow directly. The first workflow is returned,
 * because a round is the work of one process.
 */
export function responseWorkflow(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;

    if (Array.isArray(data.workflows)) {
        return data.workflows.find((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)) ?? null;
    }

    // An empty object counts as nothing to show.
    return Object.keys(data).length > 0 ? data : null;
}
