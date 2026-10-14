/**
 * Formatting helpers for the views.
 *
 * ONE HOME FOR PRESENTATION RULES, so a value reads the same wherever it appears and a
 * change lands once. The alternative - each template calling a method on the raw value -
 * is how the same timestamp ends up in two formats on two pages.
 *
 * NOT A LOCALISATION LAYER. The console is for one operator reading their own data, and
 * the strings it shows come from the participant or the model rather than from this
 * module. What lives here is the small set of values whose RAW FORM is unreadable or too
 * wide for a page, and nothing else.
 */

/**
 * Formatting helpers for the views.
 *
 * ONE HOME FOR PRESENTATION RULES, so a value reads the same wherever it appears. The
 * alternative - each template calling a method on the raw value - is how the same timestamp ends
 * up in two formats on two pages.
 *
 * NOT A LOCALISATION LAYER: the console is for one operator reading their own data. What lives
 * here is the small set of values whose RAW FORM is unreadable or too wide for a page.
 */

/**
 * A stored instant as a short, readable date and time.
 *
 * MEASURED WHY: every timestamp rendered as `2026-10-12T05:51:45.377Z`, twenty-four characters,
 * and the invitations table carries TWO per row across eight rows. At 390px that table was 609px
 * wide inside a 374px card, so its action buttons rendered outside the card, and at 1280px it
 * still overflowed. The milliseconds, the `Z` and the `T` are three quarters of the width and
 * none of the meaning.
 *
 * DELIBERATELY UNAMBIGUOUS RATHER THAN LOCALE-FORMATTED: `Intl` gives `12/10/2026` in one locale
 * and `10/12/2026` in another, and this project's timestamps are UTC while its reader is in
 * Brussels - so a bare `12/10` means two different days depending on who reads it.
 *
 * THE ZONE IS LABELLED AND NOT CONVERTED, because an operator comparing a timestamp to a log
 * needs the UTC instant and the suffix is what tells them that is what they have.
 *
 * @param {string|null|undefined} value The stored ISO 8601 instant.
 * @returns {string} `YYYY-MM-DD HH:MM UTC`, or an empty string when there is no value - empty
 *   rather than a placeholder, because "no timestamp" is a real state the views already branch on.
 */
export function shortInstant(value) {
    if (typeof value !== 'string' || value.trim() === '') return '';

    // Parsed rather than sliced, so a value that is NOT the stored shape is reported
    // instead of being cut into something that looks like a date. A slice would render
    // `not a date` as `not a date`, silently.
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) {
        console.warn(`[views] a timestamp could not be parsed: ${JSON.stringify(value)}`);
        // The raw value is returned rather than an empty string: an operator seeing a
        // strange value learns something, and one seeing nothing learns nothing.
        return value;
    }

    const d = new Date(parsed);
    const pad = (n) => String(n).padStart(2, '0');
    const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    return `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/**
 * A duration in milliseconds as a short human phrase, for the session line.
 *
 * Beside `shortInstant` because both make one stored value readable rather than formatting
 * arbitrary numbers.
 *
 * @param {number} milliseconds
 * @returns {string}
 */
export function shortDuration(milliseconds) {
    if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds) || milliseconds < 0) return '';
    const minutes = Math.round(milliseconds / 60_000);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} h`;
    return `${Math.round(hours / 24)} days`;
}

/**
 * The workflow a stored response should be read as, whatever shape it was saved in.
 *
 * A RESPONSE IS STORED IN ONE OF TWO SHAPES and the views read one of them: an INTERVIEW round
 * saves `{ workflows: [ ... ] }`, while an IMPORTED round saves the workflow directly. The views
 * read `response.data.task`, which is undefined for every interview round, so EVERY live interview
 * rendered as "Untitled answer" with no fields at all.
 *
 * ONE RESOLVER RATHER THAN A FALLBACK AT EACH READ SITE: there are three, and a fallback written
 * three times drifts. It returns the FIRST workflow, because a round is the work of one process.
 *
 * THE DEFINITION LIVES IN `ai/response-shape.js` AND IS RE-EXPORTED HERE. It moved because
 * `ai/merge-steps.js` reads a response too and can reach `ai/` but NOT `lib/` - that module is
 * pinned to `./matrix.js` alone - so `ai/` is the common ancestor.
 *
 * IT NEVER THROWS: a malformed or absent payload returns null and the caller decides what to show.
 */
// Imported for LOCAL USE as well as re-exported: `responseTitle` below calls it, and a bare
// `export { x } from` re-exports the name WITHOUT binding it in this module's own scope, which
// left every caller of `responseTitle` throwing `responseWorkflow is not defined`.
import { responseWorkflow } from '../ai/response-shape.js';

export { responseWorkflow };

/**
 * The heading for a stored response, from whichever shape it holds.
 *
 * `Untitled answer` IS A GENUINE FALLBACK rather than the usual case: before this, it was what
 * EVERY interview round displayed.
 *
 * @param {object|null} data The parsed response data.
 * @returns {string}
 */
export function responseTitle(data) {
    const workflow = responseWorkflow(data);
    const task = workflow && typeof workflow.task === 'string' ? workflow.task.trim() : '';
    return task !== '' ? task : 'Untitled answer';
}
