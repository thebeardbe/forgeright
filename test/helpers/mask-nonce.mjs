/**
 * Masking the per-response CSP nonce out of a rendered page.
 *
 * Two responses that must be INDISTINGUISHABLE now differ by the nonce, because a fresh one is
 * generated per request. The nonce carries nothing about the request, so masking it keeps such a
 * comparison honest: what is left is everything the page says, and a difference anywhere else still
 * fails.
 *
 * The nonce appears in exactly two shapes in a response:
 *
 *   1. in the CSP header, as `'nonce-<value>'`
 *   2. on each inline `<script>`, as `nonce="<value>"`
 *
 * Only these two are masked. A blanket digit/letter scrub would also erase an email address, an id or
 * a timestamp, which is precisely the evidence an enumeration test exists to compare.
 */

/** The shape of one nonce value: 16 random bytes, base64. */
const NONCE_VALUE = /[A-Za-z0-9+/]{20,}={0,2}/g;

/**
 * Replace the nonce on every inline script and every CSP header value with a fixed token.
 *
 * @param {string} text a response body, or a header value
 * @returns {string} the same text with the nonce masked
 */
export function maskNonce(text) {
    if (typeof text !== 'string') return text;

    return text
        // `nonce="..."` on an inline script tag, with any wrapping EJS expression already rendered.
        .replace(/nonce="[^"]*"/g, 'nonce="MASKED"')
        // `'nonce-...'` inside a policy string.
        .replace(/'nonce-[^']*'/g, "'nonce-MASKED'");
}

/**
 * Mask a set of response headers that carry the nonce, so two responses can be compared.
 *
 * @param {Record<string, string|string[]>} headers
 * @returns {Record<string, string|string[]>}
 */
export function maskNonceInHeaders(headers) {
    if (!headers || typeof headers !== 'object') return headers;

    const out = {};
    for (const [name, value] of Object.entries(headers)) {
        out[name] = Array.isArray(value) ? value.map(maskNonce) : maskNonce(value);
    }
    return out;
}

export { NONCE_VALUE };
