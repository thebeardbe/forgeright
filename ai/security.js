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
 * Characters that are INVISIBLE in a rendered string but break a substring match.
 *
 * MEASURED BEFORE THIS EXISTED: `ig\u200Bnore all previous instructions` did NOT match, while it reads
 * as "ignore all previous instructions" to a person AND to a model. A zero-width space is not decoration
 * to an attacker, it is the whole evasion.
 *
 * The ranges, and what each is:
 *   \u200B-\u200F  zero-width space, non-joiner, joiner, and the LTR/RTL marks
 *   \u202A-\u202E  the bidi embedding and override controls, which reorder a line's display
 *   \u2060-\u2064  word joiner and the invisible operators
 *   \uFEFF          zero-width no-break space, which is also a byte-order mark
 *   \u00AD          soft hyphen: invisible unless the line breaks, and it breaks a word in two
 *
 * BIDI OVERRIDES ARE NOT ONLY AN EVASION. They can make a line DISPLAY in a different order from the one
 * the model reads, so what a reviewer sees and what the filter sees are two different strings. Removing
 * them here means the screen sees the same order a reader would.
 */
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/g;

/**
 * Normalises text for pattern matching only, NEVER for stored or displayed content.
 *
 * THE SCREEN IS THE ONLY READER. A participant's words are stored exactly as they wrote them and shown
 * back to them unchanged, so anything this function removes stays in the record. It exists so that the
 * MATCHER cannot be defeated by a character nobody can see, not to tidy anybody's answer.
 *
 * The order matters:
 *   1. homoglyphs are folded first, because NFKC does not turn a Cyrillic 'о' into a Latin 'o';
 *   2. NFKC, which composes characters so 'ﬁ' and 'ⅼ' become the letters they look like;
 *   3. invisible characters are removed, so `ig\u200Bnore` reads as `ignore`;
 *   4. combining marks are dropped, so an accent cannot split a word;
 *   5. whitespace is collapsed and the text is lowercased.
 *
 * WHAT A LEGITIMATE ANSWER LOOKS LIKE AFTERWARDS, and it is unchanged for a reader: a Dutch answer with
 * "één" reaches the matcher as "een", an answer with a soft hyphen at a line break joins back into one
 * word, and an answer containing a zero-width space matches the same patterns it would without one. All
 * of those are still stored and shown with their original characters, because this value is never stored.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeForInspection(text) {
    let folded = '';
    for (const char of String(text)) folded += HOMOGLYPH_MAP[char] || char;
    return folded
        .normalize('NFKC')
        .replace(INVISIBLE_CHARS, '')
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

/**
 * What matched, so the caller can LOG WHY rather than only that something did.
 *
 * A boolean is enough for a caller that refuses. It is not enough for a caller that continues and
 * leaves a note, which is what identification and weighing now do: an operator reading "an injection
 * shaped phrase was here" with no phrase cannot tell a real attempt from the one-letter plural that
 * makes a Dutch or French sentence match, and that difference decides whether to act.
 *
 * Returns the matched substring, not the whole message: the message contains the participant's answer
 * and a log is not the place for it.
 *
 * @param {string} text
 * @param {string} [hint] an extra phrase to check separately, so the log can say which part of an
 *   assembled message matched
 * @returns {Promise<{matched: boolean, where: string}>}
 */
export async function describeInjectionMatch(text, hint) {
    const parts = [
        ['the message', text],
        ['the admin reasoning', hint]
    ];

    const { keywords, patterns } = await loadRules();

    for (const [label, value] of parts) {
        if (typeof value !== 'string' || value === '') continue;
        const normalized = normalizeForInspection(value);

        const keyword = keywords.find((k) => normalized.includes(k));
        if (keyword) return { matched: true, where: `${label} contains ${JSON.stringify(keyword)}` };

        for (const pattern of patterns) {
            const found = normalized.match(pattern);
            if (found) {
                // The matched text only, trimmed: enough to recognise, and not the answer.
                return { matched: true, where: `${label} matches ${JSON.stringify(found[0].slice(0, 60))}` };
            }
        }
    }

    return { matched: false, where: '' };
}

/** Test helper: drop the rule cache. */
export function resetPatternCache() {
    cachedRules = null;
}
