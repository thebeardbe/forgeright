/**
 * Periods, and the two questions asked about a `timePerPeriod` value. The distinction these protect is
 * between a period that says the work is zero and one that could not be measured.
 */

/**
 * Whether a value is the continuous-work shape the prompt asks for. Both the structured object and a
 * description in the participant's own words are accepted:
 *
 *   { hours: 6, period: "week" }   convertible to weekly hours
 *   "2 hours a day"                answers the field but cannot be converted
 *
 * A description's hours are read as zero by the effort calculation; see `timePerPeriodIsScorable`.
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
 * Whether a `timePerPeriod` can be turned into weekly hours: true for the structured shape, false for a
 * description. The distinction exists so a zero effort figure is readable: scorable zero means the work
 * consumes nothing, while an unscorable description means the figure is unknown.
 *
 * @param {*} value
 * @returns {boolean}
 */
export function timePerPeriodIsScorable(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        && typeof value.hours === 'number' && Number.isFinite(value.hours) && value.hours > 0
        && PERIODS_IN_WEEK[value.period] !== undefined;
}

/** How many of each period fit in a week, used by the effort calculation. */
export const PERIODS_IN_WEEK = Object.freeze({
    day: 5,      // A working week, matching how the prompt reads "daily".
    week: 1,
    month: 1 / 4.345,
    quarter: 1 / 13,
    year: 1 / 52
});
