/**
 * Formatting helpers for the views: one home for presentation rules, so a value reads the same wherever it
 * appears and a change lands once.
 *
 * Not a localisation layer. The console is for one operator reading their own data, and this holds only the
 * small set of values whose raw form is unreadable or too wide for a page.
 */

/**
 * A stored instant as a short, readable date and time. Measured why: a raw ISO instant is twenty-four
 * characters and the invitations table carries two per row, so at 390px it overflowed the card.
 *
 * Deliberately unambiguous rather than locale-formatted, because `Intl` gives different day/month orders
 * in different locales while the timestamps are UTC and the reader may not be. The zone is labelled and not
 * converted, so an operator comparing against a log has the UTC instant.
 *
 * @param {string|null|undefined} value The stored ISO 8601 instant.
 * @returns {string} `YYYY-MM-DD HH:MM UTC`, or an empty string when there is no value - empty rather than
 *   a placeholder, because "no timestamp" is a real state the views already branch on.
 */
export function shortInstant(value) {
    if (typeof value !== 'string' || value.trim() === '') return '';

    // Parsed rather than sliced, so a value that is not the stored shape is reported instead of being cut
    // into something that looks like a date.
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) {
        console.warn(`[views] a timestamp could not be parsed: ${JSON.stringify(value)}`);
        // The raw value rather than an empty string: an operator seeing a strange value learns something.
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
 * The workflow a stored response should be read as, whatever shape it was saved in. A response is stored as
 * `{ workflows: [ ... ] }` for an interview round or the workflow directly for an imported one, and reading
 * the wrong shape renders every live interview as "Untitled answer" with no fields.
 *
 * One resolver rather than a fallback at each of three read sites, which would drift. The definition lives
 * in `ai/response-shape.js`, because `ai/merge-steps.js` reads a response too and can reach `ai/` but not
 * `lib/`.
 */
// Imported for local use as well as re-exported: `responseTitle` calls it, and a bare `export { x } from`
// re-exports the name without binding it in this module's own scope.
import { responseWorkflow } from '../ai/response-shape.js';

export { responseWorkflow };

/**
 * The heading for a stored response, from whichever shape it holds.
 *
 * @param {object|null} data The parsed response data.
 * @returns {string}
 */
export function responseTitle(data) {
    const workflow = responseWorkflow(data);
    const task = workflow && typeof workflow.task === 'string' ? workflow.task.trim() : '';
    return task !== '' ? task : 'Untitled answer';
}
