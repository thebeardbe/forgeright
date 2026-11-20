/**
 * Serialising a value for embedding INSIDE A <script> BLOCK.
 *
 * `JSON.stringify` escapes quotes and backslashes. It does NOT escape `<`, `>` or `&`, because in JSON
 * they need no escaping. In an HTML `<script>` block they do: the sequence `</script` ends the block
 * wherever the parser meets it, so a string containing `</script><script>...</script>` closes the tag
 * early and the rest of the value is parsed as MARKUP, not as data. The injected script then runs on
 * the page's own origin.
 *
 * On this app that is not defacement. A transcript is participant-supplied text, and every admin page
 * is same-origin, so a script planted in a transcript can fetch `/admin/...` with the admin's cookie.
 *
 * THE FIX IS HERE, AT OUTPUT, and not by sanitising the transcript on the way in. A participant's own
 * words are read later by the model, so rewriting them would change the evidence. The trust boundary
 * is where data becomes markup, which is this function.
 *
 * The three escapes are the ones that matter to the HTML parser:
 *   `<`  -> \u003c   the only character that can start `</script`
 *   `>`  -> \u003e   belt and braces, and it keeps the sequence out of view
 *   `&`  -> \u0026   so the value stays valid if it is ever moved to an attribute
 *   U+2028, U+2029 -> escaped because they are line terminators in older JavaScript engines, where a
 *                     raw one inside a string literal is a syntax error rather than a character.
 *
 * The result is still valid JSON AND valid JavaScript: `\u003c` is a legal JSON escape, so the parsed
 * value is the original string, character for character.
 */

/** U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR, which are escaped by code point. */
const LINE_SEPARATOR = '\u2028';
const PARAGRAPH_SEPARATOR = '\u2029';

/**
 * Serialise a value for safe inclusion inside a `<script>` block.
 *
 * Use it at EVERY site that puts JSON into a page. `<%- jsonForScript(x) %>` keeps EJS from
 * double-escaping, which would turn the value into a quoted string instead of data.
 *
 * @param {unknown} value the value to serialise
 * @returns {string} JSON with the HTML-significant characters escaped
 */
export function jsonForScript(value) {
    // `undefined` would serialise to the bare token `undefined`, which is valid JavaScript but not
    // valid JSON: in an array it becomes `null`, in an object the key vanishes. Map it to null so
    // every caller gets a defined value.
    const json = JSON.stringify(value === undefined ? null : value);

    // JSON.stringify returns undefined for a function or a symbol at the top level. Nothing in this
    // app passes one, but a silent `undefined` in a page is worse than a visible null.
    if (typeof json !== 'string') return 'null';

    return json
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .split(LINE_SEPARATOR).join('\\u2028')
        .split(PARAGRAPH_SEPARATOR).join('\\u2029');
}
