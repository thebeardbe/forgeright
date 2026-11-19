/** Formatting helpers for the views: one home for presentation rules, so a value reads the same everywhere. */

/**
 * A stored instant as a short, readable date and time. Unambiguous rather than locale-formatted, because
 * `Intl` gives different day/month orders while the timestamps are UTC; the zone is labelled, not converted,
 * so an operator comparing against a log has the UTC instant.
 *
 * @param {string|null|undefined} value The stored ISO 8601 instant.
 * @returns {string} `YYYY-MM-DD HH:MM UTC`, or an empty string when there is no value.
 */
export function shortInstant(value) {
    if (typeof value !== 'string' || value.trim() === '') return '';

    // Parsed rather than sliced, so a value that is not the stored shape is reported, not cut into
    // something that looks like a date.
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) {
        console.warn(`[views] a timestamp could not be parsed: ${JSON.stringify(value)}`);
        // The raw value rather than an empty string: a strange value tells an operator something.
        return value;
    }

    const d = new Date(parsed);
    const pad = (n) => String(n).padStart(2, '0');
    const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    return `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** A duration in milliseconds as a short human phrase. */
export function shortDuration(milliseconds) {
    if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds) || milliseconds < 0) return '';
    const minutes = Math.round(milliseconds / 60_000);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} h`;
    return `${Math.round(hours / 24)} days`;
}

/**
 * Two shapes are stored - `{ workflows: [ ... ] }` for an interview round, the workflow directly for an
 * imported one - and reading the wrong one renders every live interview with no fields.
 */
// Imported for local use as well as re-exported: responseTitle calls it, and a bare `export { x } from`
// re-exports without binding the name in this module's scope.
import { responseWorkflow } from '../ai/response-shape.js';

export { responseWorkflow };

/** The heading for a stored response, from whichever shape it holds. */
export function responseTitle(data) {
    const workflow = responseWorkflow(data);
    const task = workflow && typeof workflow.task === 'string' ? workflow.task.trim() : '';
    return task !== '' ? task : 'Untitled answer';
}
