/**
 * Tool registry: V1 ships exactly one tool, kept explicit rather than abstracted for a single case.
 *
 * Adding a tool means adding an entry here and a prompt directory under data/prompts/<id>/.
 */
export const TOOLS = {
    cartiere_audit: {
        id: 'cartiere_audit',
        title: 'Workflow Audit',
        // The prompt directory under data/prompts/, and the toolId the client sends.
        promptDir: 'cartiere_audit'
    }
};

export const DEFAULT_TOOL_ID = 'cartiere_audit';

/**
 * @returns {object|null} The tool config, or null when unknown.
 */
export function getTool(id) {
    return TOOLS[id] || null;
}
