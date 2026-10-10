/**
 * DeepSeek adapter.
 *
 * DeepSeek exposes an OpenAI-compatible /chat/completions endpoint. It gets its
 * own adapter rather than sharing the OpenAI one so the endpoint, JSON-mode
 * handling and error mapping are explicit and can be tested in isolation.
 */
export async function generate({ model, messages, systemInstruction, temperature, maxTokens, responseMimeType, providerConfig }) {
    const apiKey = process.env[providerConfig.apiKeyEnv];
    if (!apiKey) throw new Error(`DeepSeek API key missing (${providerConfig.apiKeyEnv})`);

    const base = providerConfig.baseUrl.replace(/\/+$/, '');
    const version = providerConfig.apiVersion ? `/${providerConfig.apiVersion}` : '';
    const url = `${base}${version}/chat/completions`;

    const modelName = String(model || providerConfig.defaultModel).replace(/^[^/]+\//, '');

    const body = {
        model: modelName,
        messages: [
            ...(systemInstruction ? [{ role: 'system', content: systemInstruction }] : []),
            ...messages
        ],
        temperature: temperature ?? 0.3,
        max_tokens: maxTokens ?? 4096
    };

    // DeepSeek supports OpenAI-style JSON mode. Ask for it when JSON is required.
    if (responseMimeType === 'application/json') {
        body.response_format = { type: 'json_object' };
    }

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(body)
    });
    // Check the status BEFORE parsing. A non-JSON error body (a proxy 502, a
    // rate-limit HTML page) would otherwise throw a raw SyntaxError, and the
    // 429 mapping below would never run.
    if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        if (response.status === 429) throw new Error('QUOTA_EXHAUSTED');
        throw new Error(extractError(errorBody) || response.statusText || `HTTP ${response.status}`);
    }

    const data = await response.json();

    return data.choices?.[0]?.message?.content || '';
}

/** Best-effort read of a provider error message from a non-OK body. */
function extractError(body) {
    try {
        const parsed = JSON.parse(body);
        return parsed?.error?.message || '';
    } catch {
        return '';
    }
}
