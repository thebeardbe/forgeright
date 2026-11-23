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
 *     A JUDGEMENT, and the weakest number in this module: it rests on a scenario somebody invented
 *     rather than on a statement about the record. It is kept, and the reason it is kept is MEASURED.
 *
 *     The consistency rule below refuses any record claiming more hours than the people it names could
 *     work, which is at most peopleAffected x 168. On the WRITE path peopleAffected is itself bounded at
 *     100000, so consistency can at most admit 1.68e7 h/week and this ceiling could never fire. It would
 *     be dead code there.
 *
 *     BUT /api/score DOES NOT APPLY THE FIELD BOUNDS: it is a client-supplied payload, and
 *     checkAnswerSizes is only called from the store. So a client can send peopleAffected 2000000, which
 *     is perfectly consistent (3.36e8 hours allowed, 2e6 claimed) and still absurd. This ceiling is the
 *     only absolute backstop on that door, so it stays.
 *
 *     IT IS TRIED LAST, after consistency and after the per-instance bound, because those two produce a
 *     sentence about the participant's own record and this one can only say "more than any process can
 *     cost". A reader who finds this number firing has found a payload from the API, not a participant.

 *   CONSISTENCY: total hours <= peopleAffected x 168
 *     Not a judgement about plausibility but a statement about the record: 168 hours is what one person
 *     can work in a week, so a process claiming more hours in total than the people it names could
 *     physically work is CONTRADICTING ITSELF. MEASURED, it refuses cases this ceiling admits:
 *     frequencyPerWeek 10000, minutesPerInstance 10080, peopleAffected 100 gives 169,680,000 h/week
 *     claimed by 100 people who can work 16,800 between them.
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

/** The hours one person can work in a week. The consistency rule is stated in terms of this. */
export const HOURS_PER_PERSON_PER_WEEK = 168;

/**
 * Whether a record contradicts itself: more hours than the people it names could work.
 *
 * THE RULE IS ABOUT THE RECORD, NOT ABOUT PLAUSIBILITY. `effortHoursPerWeek` returns person-hours per week
 * across everyone, so the hours a process claims must fit inside what its own people can work: 168 hours
 * each. A record claiming more is not a big operation, it is a record that disagrees with itself, and no
 * judgement about how large a real operation can be is needed to say so.
 *
 * `frequencyPerWeek` IS ONE PERSON'S LOAD, which is what makes this a contradiction rather than a policy.
 * The prompt's own example is "40 invoices a week", meaning the ones that person deals with, and the demo
 * store confirms it: 40 x 22 minutes is 14.7 hours for one person and 44 across three. So
 * frequency x minutes is one person's week, and multiplying by people must land inside people x 168.
 *
 * WHAT THE CALL CENTRE TELLS US, MEASURED BOTH WAYS. A 100,000-call-a-week call centre with 4-minute
 * calls and 200 people FAILS this rule, and that is CORRECT rather than a false refusal: the record says
 * each of 200 people personally handles 100,000 calls a week, which is 39.7 weeks of work each.
 *
 *   as a TEAM TOTAL in the field   100000 x 4 x 200 = 1,333,333 h/wk vs 33,600   REFUSED
 *   as ONE PERSON's load           500 x 4 x 200   = 6,667 h/wk vs 33,600       ACCEPTED
 *
 * THE OPERATION IS REAL; THE FIGURE IN THE RECORD WAS THE ORGANISATION'S TOTAL, NOT THE PERSON'S. The
 * prompt now states that reading in both languages, so the model cannot write the team total here. A rule
 * that quietly accepted it would be accepting a record that contradicts itself, and the score built from
 * it would be wrong by a factor of 200.
 *
 * @param {object} workflow
 * @param {string} label
 * @returns {{ok: false, reason: string, limit: number, actual: number, people: number} | null}
 */
function checkConsistency(workflow, label) {
    // THE PEOPLE COUNT MUST BE A MEASURED NUMBER. peopleAffected may be absent, prose, declined, or a
    // number, and the interview accepts all four. AN ABSENT OR UNUSABLE COUNT IS NOT A CONTRADICTION:
    // there is nothing to contradict, so the rule does not apply and the workflow is left to the other
    // bounds. This is the same treatment effortHoursPerWeek gives it, where an unmeasurable count reads as
    // 0 and the workflow contributes no effort.
    const people = measuredPeople(workflow.peopleAffected);
    if (people === null || people <= 0) return null;

    const hours = effortHoursPerWeek(workflow);
    if (!Number.isFinite(hours)) return null;   // handled by the non-finite branch below

    const capacity = people * HOURS_PER_PERSON_PER_WEEK;
    if (hours <= capacity) return null;

    return {
        ok: false,
        consistent: false,
        people,
        capacity,
        // Both counts are formatted, so "20,000 people" and "3,360,000 hours" read the same way. A raw
        // integer beside a separated one is the kind of detail that makes a sentence look careless.
        //
        // THIS SENTENCE IS FOR AN OPERATOR AND FOR THE API. It is accurate but it ACCUSES: the figures
        // can be true and the record still wrong, which is the usual case when a team total has been
        // written into a per-person field. The participant gets `participantMessage` instead.
        reason: `${label} says ${formatHours(people)} people do this, and the figures work out to `
            + `${formatHours(hours)} hours a week. ${formatHours(people)} people cannot work more than `
            + `${formatHours(capacity)} hours between them in a week.`,
        // THE PARTICIPANT'S SENTENCE, and it blames nobody. A person reading it has just been told their
        // honest answer is refused, and the likeliest cause is that the number reached the record with a
        // different reading from the one they gave. So it NAMES THE MISREADING, says what the two figures
        // were, and asks for the one number that would settle it. No em dashes, short sentences.
        participantMessage: participantSentence(people, hours, capacity),
        limit: capacity,
        actual: hours
    };
}

/**
 * What the participant is told when their record contradicts itself.
 *
 * Separate from `reason` because the two have different readers and different jobs. `reason` logs the
 * facts for an operator; this explains the misreading to the person who gave the answer. It must not
 * accuse, and it must give them something to supply rather than something to feel bad about.
 *
 * @param {number} people
 * @param {number} hours
 * @param {number} capacity
 * @returns {string}
 */
function participantSentence(people, hours, capacity) {
    return 'I recorded this as figures that work out to ' + formatHours(hours) + ' hours a week, '
        + 'which is more than ' + formatHours(people) + ' people can work between them '
        + '(' + formatHours(capacity) + ' hours). The usual reason is that a number for the whole '
        + 'team has been read as a number per person. If the figure was what all of you do together, '
        + 'tell me roughly how much you handle yourself and I will correct it.';
}

/**
 * The people count as a number, or null when it is not a usable one.
 *
 * Mirrors `measuredNumber` in lib/scoring.js, which is private to it, so the rule here reads the value the
 * same way the effort calculation does. Prose and a refusal both give null: "I am alone on this" says how
 * many people touch the work without saying a figure, and the interview accepts that as a complete answer.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function measuredPeople(value) {
    if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
    if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value.trim());
        return Number.isFinite(n) && n > 0 ? n : null;
    }
    return null;
}

/**
 * A figure a person can read: thousands separators, and no decimals on a large number.
 *
 * @param {number} value
 * @returns {string}
 */
function formatHours(value) {
    return Math.round(value).toLocaleString('en-GB');
}

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
            // The participant's version names the one occurrence and asks for a realistic figure. "More
            // than a week of work" is already a sentence they can act on; this says it without the
            // internal ceiling number.
            // Named, because a participant with several processes needs to know which answer to fix.
            participantMessage: `${label} works out to ${formatHours(minutes)} minutes for one `
                + 'occurrence, which is longer than a working week. The usual reason is that the time '
                + 'for the whole job has been read as the time for one piece of it. Tell me roughly how '
                + 'long one occasion takes you and I will correct it.',
            limit: MAX_MINUTES_PER_INSTANCE,
            actual: minutes
        };
    }

    // CONSISTENCY FIRST, because its sentence is about the participant's own record and is the one they
    // can act on. See checkConsistency for what it does when there is no usable people count.
    const inconsistent = checkConsistency(workflow, label);
    if (inconsistent) return inconsistent;

    const hours = effortHoursPerWeek(workflow);
    if (Number.isFinite(hours) && hours > MAX_EFFORT_HOURS_PER_WEEK) {
        return {
            ok: false,
            reason: `${label} works out to ${Math.round(hours)} hours a week, which is more than any `
                + `process can cost (${MAX_EFFORT_HOURS_PER_WEEK}).`,
            // Only reachable from /api/score, which has no participant behind it, so this is written for
            // completeness rather than because a person will read it.
            participantMessage: 'These figures work out to ' + formatHours(hours) + ' hours a week, '
                + 'which is more than any one process can cost. Please check the numbers and send the '
                + 'answer again.',
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
            participantMessage: 'These figures work out to a number too large to use. Please check the '
                + 'frequency and the time for one occasion, and send the answer again. Your earlier '
                + 'answers are saved.',
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
