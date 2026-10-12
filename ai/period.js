/**
 * Periods, and the two questions asked about a `timePerPeriod` value.
 *
 * Extracted from `field-shapes.js`, which had grown past its size budget. This
 * module depends on nothing else in the matrix: it is one conversion table and the
 * predicates that read it, which is what makes the cut clean. `field-shapes.js`
 * re-exports all three, so no existing import path changed.
 *
 * The distinction these predicates exist to protect is between a period that SAYS
 * the work is zero and a period that could not be measured. See
 * `timePerPeriodIsScorable`.
 */

/**
 * Whether a value is the continuous-work shape the prompt asks for.
 *
 * TWO ACCEPTED FORMS, because the participant's own words are a valid answer as
 * well as the structured object:
 *
 *   { hours: 6, period: "week" }   the shape the prompt documents, convertible to
 *                                  weekly hours by the effort calculation
 *   "2 hours a day"                a description, which answers the field but
 *                                  cannot be converted without parsing prose
 *
 * The structured form is what M1's conversion reads. A description is accepted so
 * that an interview which got a real answer is not told the field is missing, and
 * because the matrix asks for the participant's words rather than a particular
 * encoding. Its hours are read as ZERO by the effort calculation, and that is
 * deliberate and visible: `timePerPeriodIsScorable` says which kind arrived, so a
 * caller can tell "this workflow consumes nothing" from "this description could
 * not be measured".
 *
 * A wrong-typed value that is neither, such as a number or an array, is refused.
 *
 * @param {*} value
 * @returns {boolean}
 */
export function isPeriod(value) {
    if (typeof value === 'string') return value.trim() !== '';
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (typeof value.hours !== 'number' || !Number.isFinite(value.hours) || value.hours <= 0) return false;
    return PERIODS_IN_WEEK[value.period] !== undefined;
}

/**
 * Whether a `timePerPeriod` can actually be turned into weekly hours.
 *
 * TRUE for the structured shape, FALSE for a description. The distinction exists
 * so a zero effort figure can be read correctly: a scorable period of zero would
 * mean the work consumes nothing, while an unscorable description means the
 * figure is unknown. Collapsing those two is how "we could not measure it" starts
 * reading as "there is nothing here".
 *
 * @param {*} value
 * @returns {boolean}
 */
export function timePerPeriodIsScorable(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        && typeof value.hours === 'number' && Number.isFinite(value.hours) && value.hours > 0
        && PERIODS_IN_WEEK[value.period] !== undefined;
}

/**
 * How many of each period fit in a week.
 *
 * The conversion M1 needed. One table, used by the effort calculation, so a period
 * this system cannot read is rejected at the matrix rather than scoring zero.
 */
export const PERIODS_IN_WEEK = Object.freeze({
    day: 5,      // A working week, matching how the prompt reads "daily".
    week: 1,
    month: 1 / 4.345,
    quarter: 1 / 13,
    year: 1 / 52
});
