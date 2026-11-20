/**
 * Input guardrails: strip control characters and cap length, and detect text that is trying to instruct
 * the model rather than describe a workflow.
 *
 * Detection is deliberately conservative: a false positive costs a participant one rephrased answer, while
 * a false negative lets injected text into the system prompt's context.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Overridable so the loader's failure branches can be tested against fixtures.
const PATTERNS_PATH = process.env.INJECTION_PATTERNS_PATH
    || path.join(__dirname, 'injection-patterns.json');

/**
 * THE BOUND ON ONE PARTICIPANT-PROVIDED STRING.
 *
 * This is what 3000 was always meant to be. MEASURED against the demo store, the longest single
 * field a participant writes is well under 1500 characters, and the longest whole response payload
 * is 1956, so 3000 leaves a participant room to write at length and still bounds one string.
 *
 * IT MUST NOT BE APPLIED TO AN ASSEMBLED MESSAGE. It was, in identify-core and weigh-core, and a
 * message is a document: on the demo data a weighing message with an admin's rejudge argument is
 * already 3145 characters, and the identification message for an organisation with 60 processes is
 * 22228. The slice cut those at 3000, which silently removed the admin's argument and almost the
 * whole known-processes list. The document bound is `prompt-budget.js`.
 */
export const MAX_INPUT_CHARS = 3000;

/**
 * Strips control characters (keeping tab and newline) and caps length.
 *
 * For ONE participant-provided string. See MAX_INPUT_CHARS for why this is not a document bound.
 *
 * @param {string} text
 * @param {string} [label] what is being capped, so the log says which field was cut
 * @returns {string}
 */
export function sanitizeInput(text, label = 'input') {
    if (!text) return '';
    let clean = String(text).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    if (clean.length > MAX_INPUT_CHARS) {
        console.warn(
            `[security] ${label} truncated: ${clean.length} characters, cap ${MAX_INPUT_CHARS}, ` +
            `cut ${clean.length - MAX_INPUT_CHARS}`
        );
        clean = clean.slice(0, MAX_INPUT_CHARS) + '\n...[TRUNCATED]';
    }
    return clean;
}

/**
 * Strip control characters from every string inside a value, WITHOUT the length cap.
 *
 * Used where a value is going to be assembled into a message and the cap is decided later, on the
 * whole document. The control-character strip is not a bound on size, so doing it here loses nothing.
 *
 * @param {unknown} value any JSON-shaped value
 * @returns {unknown} the same shape with control characters removed from its strings
 */
export function stripControlCharsDeep(value) {
    if (typeof value === 'string') {
        return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    }
    if (Array.isArray(value)) return value.map(stripControlCharsDeep);
    if (value && typeof value === 'object') {
        const out = {};
        for (const [key, inner] of Object.entries(value)) out[key] = stripControlCharsDeep(inner);
        return out;
    }
    return value;
}

/**
 * Cyrillic and Greek characters that render like Latin ones, folded so "іgnore аll previous" cannot slip
 * past a plain text match.
 */
const HOMOGLYPH_MAP = {
    'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x',
    'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O',
    'Р': 'P', 'С': 'C', 'Т': 'T', 'У': 'Y', 'Х': 'X',
    'і': 'i', 'І': 'I', 'ѕ': 's', 'ј': 'j', 'Ј': 'J',
    'ο': 'o', 'Ο': 'O', 'α': 'a', 'Α': 'A', 'ν': 'v', 'Ν': 'N'
};

/**
 * Normalises text for pattern matching only, never for stored or displayed content.
 * @param {string} text
 * @returns {string}
 */
export function normalizeForInspection(text) {
    let folded = '';
    for (const char of String(text)) folded += HOMOGLYPH_MAP[char] || char;
    return folded
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

let cachedRules = null;

const FALLBACK_RULES = {
    keywords: ['ignore all previous', 'ignore previous instructions', 'system prompt', 'jailbreak'],
    patterns: []
};

/**
 * Loads the guardrail rules. Keywords and patterns stay separate lists because they are matched
 * differently: a keyword is a literal substring and a pattern is a regular expression, and
 * substring-matching everything would turn every regex into a literal that matches nothing.
 */
async function loadRules() {
    if (cachedRules) return cachedRules;

    let raw;
    try {
        raw = JSON.parse(await fs.readFile(PATTERNS_PATH, 'utf8'));
    } catch (err) {
        // A missing rules file must not silently disable the guardrail.
        console.error('[security] could not load injection patterns, using built-in fallback:', err.message);
        cachedRules = FALLBACK_RULES;
        return cachedRules;
    }

    const keywords = (raw.keywords || []).map((k) => String(k).toLowerCase());

    const patterns = [];
    for (const source of raw.patterns || []) {
        try {
            patterns.push(new RegExp(String(source), 'i'));
        } catch (err) {
            // A broken regex is a config error: say which one, and keep the rest working rather than
            // dropping the whole guardrail.
            console.error(`[security] ignoring invalid injection pattern ${JSON.stringify(source)}:`, err.message);
        }
    }

    // A guardrail that loaded nothing would report every input as clean.
    if (keywords.length === 0 && patterns.length === 0) {
        console.error('[security] injection rules were empty, using built-in fallback');
        cachedRules = FALLBACK_RULES;
        return cachedRules;
    }

    cachedRules = { keywords, patterns };
    return cachedRules;
}

/**
 * @param {string} text
 * @returns {Promise<boolean>} true when the text looks like an injection attempt.
 */
export async function checkPromptInjection(text) {
    if (!text) return false;
    const { keywords, patterns } = await loadRules();
    const normalized = normalizeForInspection(text);

    if (keywords.some((keyword) => normalized.includes(keyword))) return true;
    return patterns.some((pattern) => pattern.test(normalized));
}

/** Test helper: drop the rule cache. */
export function resetPatternCache() {
    cachedRules = null;
}
