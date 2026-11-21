/**
 * Periods, and the two questions asked about a `timePerPeriod` value: a period that says the work is zero
 * is not the same as one that could not be measured.
 */
import { MAX_HOURS_PER_PERIOD } from './field-shapes.js';

/**
 * Both the structured object (`{ hours, period }`) and a description in the participant's own words are
 * accepted; a description's hours read as zero by the effort calculation.
 *
 * @returns {boolean}
 */
export function isPeriod(value) {
    if (typeof value === 'string') return value.trim() !== '';
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (typeof value.hours !== 'number' || !Number.isFinite(value.hours) || value.hours <= 0) return false;
    // A week holds 168 hours, so no person works more than that per period. See MAX_HOURS_PER_PERIOD.
    if (value.hours > MAX_HOURS_PER_PERIOD) return false;
    return PERIODS_IN_WEEK[value.period] !== undefined;
}

/**
 * True for the structured shape, false for a description: scorable zero means the work consumes nothing,
 * while an unscorable description means the figure is unknown.
 *
 * @returns {boolean}
 */
export function timePerPeriodIsScorable(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        && typeof value.hours === 'number' && Number.isFinite(value.hours) && value.hours > 0
        && value.hours <= MAX_HOURS_PER_PERIOD
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
