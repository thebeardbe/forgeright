/**
 * Provider dispatch.
 *
 * Resolves the configured provider to an adapter and exposes a single
 * generateText entry point. Adapters are imported eagerly because there are
 * only three and dynamic import would hide a broken adapter until first use.
 */
import { loadAiConfig } from './config.js';
import { generate as generateMock } from './adapters/mock.js';
import { generate as generateGemini } from './adapters/gemini.js';
import { generate as generateDeepseek } from './adapters/deepseek.js';

const ADAPTERS = {
    mock: generateMock,
    gemini: generateGemini,
    'openai-compatible': generateDeepseek
};

/**
 * @param {object} args
 * @param {Array<{role: string, content: string}>} args.messages
 * @param {string} [args.systemInstruction]
 * @param {number} [args.temperature]
 * @param {number} [args.maxTokens]
 * @param {string} [args.responseMimeType]
 * @param {string} [args.lang] Passed through for adapters that localise themselves.
 * @returns {Promise<string>} Raw model output.
 */
export async function generateText({ messages, systemInstruction, temperature, maxTokens, responseMimeType, lang }) {
    const config = loadAiConfig();
    const adapter = ADAPTERS[config.type];

    // A missing adapter is a programming error, not a runtime condition: the
    // config names a type nothing implements. Fail loudly.
    if (!adapter) {
        throw new Error(
            `No adapter registered for provider type "${config.type}" ` +
            `(provider "${config.name}"). Registered: ${Object.keys(ADAPTERS).join(', ')}`
        );
    }

    return adapter({
        model: config.defaultModel,
        messages,
        systemInstruction,
        temperature,
        maxTokens,
        responseMimeType,
        providerConfig: { ...config, lang }
    });
}
