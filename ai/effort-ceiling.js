/**
 * THE CEILING ON WHAT ONE PROCESS MAY CLAIM TO COST.
 *
 * M5 bounded each numeric field, and that stopped the crash: no Infinity reached scoring. It did not
 * stop the absurdity. MEASURED, with every field at its own defensible bound:
 *
 *   frequencyPerWeek 10000 x minutesPerInstance 100000 x peopleAffected 100000 / 60 = 1.667e12 h/week
 *
 * against a reference workflow of 44 h/week, the largest in the demo store. That is 3.8e10 times the
 * reference, it is FINITE, so round()'s floor never fires, and it ranks first with a roadmap total of
 * 1,666,666,666,726.67. Each factor is defensible alone. THE MULTIPLICATION IS WHAT IS ABSURD, so the
 * bound has to be on the product.
 *
 * WHAT THE CEILING IS, AND WHY IT CANNOT BE A PLAIN "PERSON-YEAR".
 *
 * The suggestion was one person-year of hours. MEASURED, that would refuse real operations: a call centre
 * taking 100,000 calls a week at 4 minutes with 200 people is 1,333,333 h/week, and a national-scale
 * service is more. A process is a kind of work, and the hours it consumes is the total across everyone who
 * does it, so the TOTAL is legitimately large for a large operation. A ceiling on the total would be worse
 * than no ceiling.
 *
 * So the ceiling is not on the total. It is on the one thing a process cannot legitimately claim: that a
 * SINGLE OCCURRENCE takes longer than a person could ever spend on it, or that the process as a whole
 * costs more hours than the number of people it says are involved could possibly work.
 *
 *   MAX_MINUTES_PER_INSTANCE = 10080
 *     168 hours, the hours in a week, in minutes. One instance of one process is one piece of work a
 *     person sits down to do; nobody does a single occurrence for longer than a week without stop.
 *     MEASURED, the demo's largest is 120 minutes and the prompt's examples are 4 to 75 minutes. 10080 is
 *     84 times the largest real value, and it refuses the 100000 the field bound allowed, which is 9.9
 *     person-weeks for ONE instance.
 *
 *   MAX_EFFORT_HOURS_PER_WEEK = 168000000  (1.68e8)
 *     A HUNDRED TIMES the largest national-scale scenario I could construct: 10,000 occurrences a week
 *     at 10 minutes across 20,000 people, which is 3.3e7 h/week. The first ceiling I tried was
 *     1.68e7, ten times the demo reference, AND IT REFUSED THAT SCENARIO - which is exactly the failure
 *     this must not have, because refusing a real operation is worse than allowing a large one. So the
 *     ceiling is set by what a process could conceivably be, not by what looks tidy.
 *
 *     It still sits 9.9e3 times below the abuse case at the field bounds (1.67e12), and the per-instance
 *     ceiling catches the genuinely absurd factor before this one is reached.
 *
 * REFUSED, NOT CLAMPED, like every other bound in this branch: a clamped figure is a false record.
 *
 * ONE FUNCTION, BOTH DOORS. This is called from /api/response (so a stored response cannot hold one) and
 * from /api/score (whose payload a browser client chooses, and which checked no number at all). Two copies
 * of this rule would drift, and the whole defect is that a number got through one door and not another.
 */
import { effortHoursPerWeek } from '../lib/scoring.js';

/** The longest one occurrence of one process may take, in minutes. See the header. */
export const MAX_MINUTES_PER_INSTANCE = 10080;

/** The most hours one process may cost its organisation per week. See the header. */
export const MAX_EFFORT_HOURS_PER_WEEK = 168000000;

/**
 * Check one workflow's effort against the ceilings.
 *
 * Returns the first problem rather than all of them, because the caller reports one sentence to one person.
 *
 * A workflow whose effort cannot be computed at all (no numbers, prose instead) is not refused here: it
 * contributes nothing to the score and the interview treats it as unmeasured, which is a different
 * question and already handled.
 *
 * @param {object} workflow a scored or raw workflow
 * @param {string} [label] what to call it in the reason, so a list of them can name the culprit
 * @returns {{ok: true} | {ok: false, reason: string, limit: number, actual: number}}
 */
export function checkEffortCeiling(workflow, label = 'this process') {
    if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) return { ok: true };

    // A per-instance figure, whichever shape carries it.
    const minutes = workflow.minutesPerInstance;
    if (typeof minutes === 'number' && Number.isFinite(minutes) && minutes > MAX_MINUTES_PER_INSTANCE) {
        return {
            ok: false,
            reason: `${label} says one instance takes ${Math.round(minutes)} minutes, which is more than `
                + `a week of work (${MAX_MINUTES_PER_INSTANCE} minutes).`,
            limit: MAX_MINUTES_PER_INSTANCE,
            actual: minutes
        };
    }

    const hours = effortHoursPerWeek(workflow);
    if (Number.isFinite(hours) && hours > MAX_EFFORT_HOURS_PER_WEEK) {
        return {
            ok: false,
            reason: `${label} works out to ${Math.round(hours)} hours a week, which is more than any `
                + `process can cost (${MAX_EFFORT_HOURS_PER_WEEK}).`,
            limit: MAX_EFFORT_HOURS_PER_WEEK,
            actual: hours
        };
    }

    // A non-finite effort is refused too: it means a factor overflowed, which is not a figure anybody
    // can mean, and letting it through hands the ranking an Infinity.
    if (!Number.isFinite(hours) && hours !== 0) {
        return {
            ok: false,
            reason: `${label} works out to a figure too large to compute.`,
            limit: MAX_EFFORT_HOURS_PER_WEEK,
            actual: hours
        };
    }

    return { ok: true };
}

/**
 * Check every workflow in a payload against the ceilings.
 *
 * @param {Array<object>} workflows
 * @returns {{ok: true} | {ok: false, reason: string, limit: number, actual: number}}
 */
export function checkEffortCeilings(workflows) {
    if (!Array.isArray(workflows)) return { ok: true };

    for (const workflow of workflows) {
        const title = workflow && typeof workflow.title === 'string' && workflow.title.trim() !== ''
            ? `"${workflow.title.trim().slice(0, 80)}"`
            : 'one process';
        const problem = checkEffortCeiling(workflow, title);
        if (!problem.ok) return problem;
    }
    return { ok: true };
}
