/**
 * DeepSeek adapter.
 *
 * DeepSeek exposes an OpenAI-compatible /chat/completions endpoint. Its own adapter rather
 * than the OpenAI one, so the endpoint, JSON-mode handling and error mapping can be tested
 * in isolation.
 *
 * JSON MODE IS NOT SENT TO DEEPSEEK, measured rather than cautious. With
 * `response_format: {type:"json_object"}` the API returns 11 to 16 SPACES with
 * `finish_reason: "stop"` and HTTP 200, once a conversation passes about two exchanges.
 * Only plain mode is stable:
 *
 *   JSON mode, real 7-message conversation:   0/6 non-blank
 *   plain mode, same conversation:            6/6 non-blank
 *   JSON mode by turns:  2->4/4  3->3/4  4->3/4  5->3/4  6->1/4
 *   plain mode by turns: 2->4/4  5->4/4       (stable)
 *
 * DeepSeek-specific: Gemini on the same conversation returned 4/4, so its flag stays on.
 * Full measurements and every explanation tested and FALSIFIED (token length, turn count,
 * truncation, rate limiting, model name) are in NOTES-deepseek-json-mode.md.
 *
 * So this provider's replies arrive as PROSE with the JSON inside, and are parsed by
 * ai/json-extract.js rather than handed to JSON.parse. The prompt still demands JSON and
 * nothing outside it; the extractor makes a fence or a stray sentence survivable.
 *
 * The flag is `sendJsonMode` in config/ai-config.json - a config change per provider.
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

    // JSON mode is asked for ONLY when the provider's config says it works.
    //
    // The default is true, so a new provider gets the stronger contract until it
    // is measured otherwise. DeepSeek is set false, for the reason in the header:
    // its JSON mode returns whitespace, silently, with a 200 and a stopped
    // finish reason, which is the worst kind of failure because it looks like a
    // successful empty reply rather than an error.
    const wantsJson = responseMimeType === 'application/json';
    const jsonModeWorks = providerConfig?.sendJsonMode !== false;

    if (wantsJson && jsonModeWorks) {
        body.response_format = { type: 'json_object' };
    } else if (wantsJson) {
        // Said once per request, because a silent difference between providers is
        // what made this hard to find in the first place.
        console.info(
            `[deepseek] JSON is required but this provider's JSON mode is disabled ` +
            `(sendJsonMode: false in ai-config.json); asking in plain mode and extracting the JSON`
        );
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
