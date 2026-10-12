/**
 * Tool registry.
 *
 * V1 ships exactly one tool. This is an explicit registry rather than a config
 * file with routing semantics, because V1 has one entry and inventing an
 * abstraction for a single case is how the referrers system became hard to
 * reason about.
 *
 * Adding a tool later means adding an entry here and a prompt directory under
 * data/prompts/<id>/.
 */
export const TOOLS = {
    cartiere_audit: {
        id: 'cartiere_audit',
        title: 'Workflow Audit',
        // The prompt directory under data/prompts/, and the name the client sends
        // as toolId. `accessCodeEnv` used to live here, naming the environment
        // variable holding a shared code that gated a tokenless questionnaire
        // visit. Both are gone: access is by participant token only, so there is
        // no per-tool secret left to name.
        promptDir: 'cartiere_audit'
    }
};

export const DEFAULT_TOOL_ID = 'cartiere_audit';

/**
 * @param {string} id
 * @returns {object|null} The tool config, or null when unknown.
 */
export function getTool(id) {
    return TOOLS[id] || null;
}
