/**
 * Loads and validates config/ai-config.json. The provider actually used is chosen by the AI_PROVIDER
 * env var, falling back to the file's defaultProvider, so switching providers is a config change rather
 * than a code change.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'ai-config.json');

let cached = null;

export function loadAiConfig() {
    if (cached) return cached;

    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const requested = process.env.AI_PROVIDER || raw.defaultProvider;

    if (!raw.providers[requested]) {
        throw new Error(
            `ai-config: AI_PROVIDER "${requested}" is not a known provider. ` +
            `Known: ${Object.keys(raw.providers).join(', ')}`
        );
    }

    const provider = raw.providers[requested];
    if (!provider.active) {
        throw new Error(`ai-config: provider "${requested}" is present but marked inactive.`);
    }

    // Fails loudly at startup rather than at the first question, because a missing key with a real
    // provider is a misconfiguration.
    if (provider.type !== 'mock' && provider.apiKeyEnv && !process.env[provider.apiKeyEnv]) {
        console.warn(
            `[ai-config] WARNING: AI_PROVIDER is "${requested}" but ${provider.apiKeyEnv} is unset. ` +
            `Requests will fail. Set the key or use AI_PROVIDER=mock.`
        );
    }

    cached = { name: requested, ...provider };
    return cached;
}

/** Test helper: drop the cache so env changes take effect. */
export function resetAiConfigCache() {
    cached = null;
}
