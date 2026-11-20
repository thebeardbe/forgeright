/**
 * Gemini adapter.
 * Translates OpenAI-style messages into Gemini's { contents, system_instruction }
 * shape. Response is normalised back to a plain string.
 */
export async function generate({ model, messages, systemInstruction, temperature, maxTokens, responseMimeType, providerConfig }) {
    const apiKey = process.env[providerConfig.apiKeyEnv];
    if (!apiKey) throw new Error(`Gemini API key missing (${providerConfig.apiKeyEnv})`);

    const modelName = String(model || providerConfig.defaultModel).replace(/^gemini\//, '');
    const apiVersion = providerConfig.apiVersion || 'v1beta';
    const url = `${providerConfig.baseUrl}/${apiVersion}/models/${modelName}:generateContent`;

    // THE SYSTEM INSTRUCTION COMES FROM THE CALLER ONLY, NEVER FROM THE CONVERSATION.
    //
    // This loop used to append any `system` message it found to systemText, which put a client-sent
    // string in the highest-authority position the model reads. The route and runAuditTurn both
    // refuse that role now, and this is the third lock: an unknown role falls back to `user` here,
    // so nothing a conversation carries can ever become an instruction at this boundary.
    const systemText = systemInstruction || '';
    const contents = [];
    for (const msg of messages) {
        if (!msg || typeof msg.content !== 'string') continue;
        if (msg.role === 'system') {
            // Named in the log because it should be impossible: reaching this means a caller bypassed
            // both checks above, and the text is DROPPED rather than promoted.
            console.warn("[gemini] dropped a system message from the conversation; system text is the caller's alone");
            continue;
        }
        contents.push({
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: msg.content }]
        });
    }

    const generationConfig = {
        temperature: temperature ?? 0.3,
        maxOutputTokens: maxTokens ?? 4096
    };
    if (responseMimeType) generationConfig.response_mime_type = responseMimeType;

    // The v1 API rejects the system_instruction field, so prepend it instead.
    const requestBody = apiVersion === 'v1' && systemText
        ? {
            contents: [
                { role: 'user', parts: [{ text: systemText + '\n\n' + (contents[0]?.parts?.[0]?.text || '') }] },
                ...contents.slice(1)
            ],
            generationConfig
        }
        : {
            system_instruction: systemText ? { parts: [{ text: systemText }] } : undefined,
            contents,
            generationConfig
        };

    const response = await fetch(url, {
        method: 'POST',
        // The key goes in a header, not the query string. A URL key leaks into
        // proxy and access logs, and this service runs behind a reverse proxy.
        headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey
        },
        body: JSON.stringify(requestBody)
    });
    // Check the status BEFORE parsing. A non-JSON error body (a proxy 502, a
    // rate-limit HTML page) would otherwise throw a raw SyntaxError, and the
    // 429 mapping below would never run.
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        if (response.status === 429) throw new Error('QUOTA_EXHAUSTED');
        throw new Error(extractError(body) || response.statusText || `HTTP ${response.status}`);
    }

    const data = await response.json();

    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
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
