/**
 * Weighing: the store's public interface for workflow 3.
 *
 * One number per process, with the terms behind it and a paragraph explaining it.
 * A score is a judgement about a particular GROUPING, so it is keyed on the
 * revision rather than on the process: the spec's path for either kind of
 * disagreement is to re-identify first and regenerate the score from that.
 *
 * A rejudge adds a score rather than editing one, so the earlier number and its
 * explanation stay readable for anyone asking why it moved.
 *
 * KEYED BY ORGANISATION, like the rest of the store: every function takes an orgId
 * first, and the connection it resolves is already scoped to one file.
 */
import { requireConnection } from './organisations.js';
import { timedWrite } from './write-timing.js';
import * as processSql from './process-sql.js';
import { needsReviewFromRevisions } from './process-membership.js';
import * as sql from './sqlite.js';

/**
 * The terms a weighing must report.
 *
 * ALL TEN ARE REQUIRED. A missing one is refused rather than defaulted, for the
 * same reason a missing `reasoning` is: a score computed without knowing how hard
 * the work is to build is not the score this system claims to produce, and
 * substituting a middle value would make it look as though it had been weighed.
 *
 * THE ORDER IS THE SPEC'S TABLE ORDER, so a reader comparing the code to the spec
 * does not have to hunt.
 */
export const TERMS = Object.freeze([
    'frequency',        // how often the work happens
    'time',             // how long it takes
    'people',           // how many are affected
    'results',          // the gain when it is done well
    'consequences',     // what a mistake costs
    'departments',      // how many teams it crosses
    'complexity',       // how involved the process is
    'automatableShare', // what fraction of steps need no reasoning
    'reasoningSteps',   // how many steps need a person
    'buildEffort'       // how hard it is to automate
]);

/**
 * The terms whose HIGH value counts against the process.
 *
 * Complexity and departments are COSTS, as are build effort and steps needing a
 * person: an earlier draft of the spec had reach amplifying both effort and
 * reward, which would have made a sprawling process look attractive.
 *
 * **THE DIRECTION IS APPLIED BY THE MODEL, NOT HERE.** The score is composed in
 * the prompt, and this code validates its shape - that the ten terms are present
 * and numeric - without recomputing it. So `COST_TERMS` exists to name and
 * explain the costs, and NOT to do arithmetic on them. There is no
 * `contributionOf`, and an earlier version of this comment named one that does
 * not exist.
 *
 * That means the direction can be checked here but not enforced: a model that
 * scores a cost term the wrong way round produces a number this code accepts.
 * The prompt carries the table, and the reasoning is required precisely so a
 * wrong direction is visible to a reader.
 */
export const COST_TERMS = Object.freeze([
    'departments', 'complexity', 'reasoningSteps', 'buildEffort'
]);

/**
 * The range every term must fall in, and it is a CONTRACT rather than a preference.
 *
 * **0 TO 100, THE SAME SCALE AS THE SCORE.** The owner's decision: one scale across
 * the whole feature, so the ten terms and the composite number are read on the same
 * footing and a reader comparing them is not converting between two ranges. The
 * prompt states the endpoints for every term in words, which is what makes the
 * direction checkable rather than a number to trust.
 *
 * It was 1 to 5 before that decision, and 1 to 5 was itself the fix for a gate that
 * accepted ANY finite number: measured, all ten terms at 0, at 6, at 100, at -3 and
 * at 0.5 were all accepted, and the suite's own boundary test used 10. So nothing
 * held the documented range at all. Note the irony worth keeping: `100` was one of
 * the values that had to be refused under the old range, and is now the top of the
 * new one, which is why the bound is a named constant rather than a literal.
 *
 * THE SCORE ITSELF IS NOT BOUNDED HERE. It is a composite the prompt composes with a
 * weighting of the model's own choosing, so this is a per-term bound and not a range
 * check on the number.
 */
export const TERM_MIN = 0;
export const TERM_MAX = 100;

/**
 * The names above cover THE WHOLE SCALE, not only the terms, and they are kept
 * rather than renamed for two reasons worth recording.
 *
 * THEY ARE THE SAME TWO BOUNDS. The prompt says the terms and the score share one
 * scale, so a second pair (`SCORE_MIN`/`SCORE_MAX` set to 0 and 100) would be the
 * same numbers written twice, which is how the next person gets them out of step
 * while every test stays green.
 *
 * AND `test/` READS THEM BY NAME (`weighing.TERM_MIN`), so renaming would be a
 * change to the tests to satisfy a tidier word. The docstring here is the honest
 * place to say what they cover.
 *
 * The name is not perfect: a reader may take `TERM_` as "terms only". The refusal
 * messages do not rely on it, because each says which of the two it is refusing.
 */

/** True when a high value in this term counts against the process. */
export function isCostTerm(term) {
    return COST_TERMS.includes(term);
}

/**
 * Checks a model's weighing reply and reports what is wrong with it.
 *
 * EXPORTED SO A CALLER CAN FAIL CLEARLY rather than store a number nobody can
 * explain. Three failures matter, and each is refused rather than defaulted:
 *
 *   - a non-numeric score, which would sort as undefined
 *   - a missing or non-numeric term, which would make the score unreviewable
 *   - missing reasoning, which is the spec's whole protection for this step
 *
 * @param {object} reply The model's parsed reply.
 * @returns {{ok: true, score: number, terms: object, reasoning: string}
 *   | {ok: false, reason: string}}
 */
export function validateWeighing(reply) {
    if (!reply || typeof reply !== 'object' || Array.isArray(reply)) {
        return { ok: false, reason: 'the reply is not an object' };
    }

    // A STRING NUMBER IS REFUSED, not coerced. "42" from a model is a reply that
    // ignored the contract, and accepting it would mean the one place that checks
    // the shape is also guessing about types.
    if (typeof reply.score !== 'number' || !Number.isFinite(reply.score)) {
        return { ok: false, reason: `the score must be a finite number, got ${JSON.stringify(reply.score)}` };
    }

    // THE SCORE IS ON THE SAME SCALE AS THE TERMS, so it is checked on the same
    // scale. It used to be unbounded: the prompt said "0 to 100, the same scale as
    // the terms" while this function checked only that it was finite, so a model
    // returning 250 had it stored, displayed and ranked by. That is the fourth time
    // in this project a document has promised something the code did not hold, and
    // the fix is to make the prompt true rather than to soften the prompt.
    //
    // THE REASON NAMES THE SCORE, NOT "these terms": a reader who saw the term
    // wording here would look for a term to fix.
    if (reply.score < TERM_MIN || reply.score > TERM_MAX) {
        return {
            ok: false,
            reason: `the score must be between ${TERM_MIN} and ${TERM_MAX}, got ${reply.score}`
        };
    }

    if (typeof reply.reasoning !== 'string' || reply.reasoning.trim() === '') {
        return { ok: false, reason: 'no reasoning was given, and a score cannot be reviewed without it' };
    }

    if (!reply.terms || typeof reply.terms !== 'object' || Array.isArray(reply.terms)) {
        return { ok: false, reason: 'the terms are missing or are not an object' };
    }

    const missing = [];
    const badType = [];
    const outOfRange = [];

    for (const term of TERMS) {
        const value = reply.terms[term];
        if (value === undefined || value === null) {
            missing.push(term);
            continue;
        }
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            badType.push(`${term}=${JSON.stringify(value)}`);
            continue;
        }
        // NAMED, like a missing term, so the refusal says WHICH term was wrong
        // rather than only that something was. `${term}=${value}` gives both, which
        // is what a reader needs to tell a wrong term from a wrong scale.
        if (value < TERM_MIN || value > TERM_MAX) {
            outOfRange.push(`${term}=${value}`);
        }
    }

    if (missing.length > 0) {
        return { ok: false, reason: `these terms are missing: ${missing.join(', ')}` };
    }
    if (badType.length > 0) {
        return { ok: false, reason: `these terms are not numbers: ${badType.join(', ')}` };
    }
    if (outOfRange.length > 0) {
        return {
            ok: false,
            reason: `these terms are outside ${TERM_MIN} to ${TERM_MAX}: ${outOfRange.join(', ')}`
        };
    }

    // Only the required terms are stored, so a model that invents an extra one
    // cannot put an unexplained value into the breakdown a reader trusts.
    const terms = {};
    for (const term of TERMS) terms[term] = reply.terms[term];

    return { ok: true, score: reply.score, terms, reasoning: reply.reasoning.trim() };
}

/**
 * Records a weighing for a process's current revision.
 *
 * THE REVISION IS RESOLVED HERE, not passed in, so a caller cannot score a
 * grouping that is no longer current: the score would then describe a grouping the
 * console does not show. A process with no revision yet has never been grouped and
 * cannot be weighed, which is a loud error rather than a zero.
 *
 * @param {object} args
 * @param {string} args.orgId
 * @param {string} args.processId
 * @param {object} args.reply The model's weighing reply, already parsed.
 * @returns {{score: object, revision: object, process: object}}
 * @throws {Error} When the reply is unusable or the process has no current grouping.
 */
export function recordWeighing({ orgId, processId, reply }) {
    const db = requireConnection(orgId);

    const process = processSql.selectProcessById(db, processId);
    if (!process) {
        throw new Error(`Cannot weigh process ${JSON.stringify(processId)}: it is not in organisation ${orgId}.`);
    }

    const revision = processSql.selectCurrentRevision(db, processId);
    if (!revision) {
        throw new Error(
            `Cannot weigh process ${processId}: it has no current grouping, so there is nothing to weigh. ` +
            'Identify a response into it first.'
        );
    }

    const checked = validateWeighing(reply);
    if (!checked.ok) {
        throw new Error(`Refusing a weighing: ${checked.reason}.`);
    }

    return timedWrite(orgId, 'recordWeighing', () => {
        const score = processSql.insertScore(db, {
            id: sql.newId(),
            revisionId: revision.id,
            score: checked.score,
            terms: checked.terms,
            reasoning: checked.reasoning
            // No `revisionNo`: `insertScore` computes it inside its own transaction,
            // so the MAX and the INSERT cannot be split by another writer.
        });

        console.info(
            `[store] weighed process ${processId} at ${checked.score} in organisation ${orgId} ` +
            `(weighing ${score.revision_no})`
        );

        return { score, revision, process };
    });
}

/**
 * The roadmap: every process, highest score first.
 *
 * SORTED HERE, ONCE, so the console and anything else reading the list cannot
 * disagree about the order. The spec's point is a sorted list by quickness of win,
 * because early results compound, so the order is the deliverable rather than a
 * presentation choice.
 *
 * AN UNSCORED PROCESS SORTS LAST rather than being dropped. A process nobody has
 * weighed yet, or one whose weighing failed, is still work somebody described, and
 * hiding it would quietly shrink the roadmap. `score: null` says why it is at the
 * bottom.
 *
 * @returns {Array<object>} Processes with their current grouping, score and history.
 */
export function listRoadmap(orgId) {
    const db = requireConnection(orgId);

    const entries = processSql.listProcesses(db).map((process) => {
        const revision = processSql.selectCurrentRevision(db, process.id);
        const score = revision ? processSql.selectCurrentScore(db, revision.id) : null;

        // DERIVED, NOT STORED: the process was born from a model-decided
        // low-confidence creation and no admin revision has settled it since. Read
        // from the history, because a later merge must not clear it and a
        // low-confidence merge must not set it. No flag column, nothing to reset.
        const review = needsReviewFromRevisions(processSql.listRevisions(db, process.id));

        return {
            id: process.id,
            name: process.name,
            needsReview: review.needsReview,
            needsReviewReason: review.reason,
            created_at: process.created_at,
            updated_at: process.updated_at,
            // The grouping behind the number, so a reader can see what was weighed.
            grouping: revision
                ? {
                    revision: revision.revision,
                    reasoning: revision.reasoning,
                    confidence: revision.confidence,
                    decidedBy: revision.decided_by,
                    decided_at: revision.created_at,
                    responses: processSql.selectResponsesForRevision(db, revision.id)
                }
                : null,
            score: score
                ? {
                    value: score.score,
                    terms: score.terms,
                    reasoning: score.reasoning,
                    weighing: score.revision_no,
                    weighed_at: score.created_at
                }
                : null,
            // ACROSS EVERY REVISION, not just the current one. A rejudge makes a new
            // revision and the scores restart at 1, so a per-revision list would hide
            // the score the admin is comparing against.
            scoreHistory: processSql.listScoresForProcess(db, process.id)
        };
    });

    // Highest first. An unscored process goes last, and ties break on the name so
    // the order is stable between reads rather than whatever the database returns.
    return entries.sort((a, b) => {
        if (a.score === null && b.score === null) return a.name.localeCompare(b.name);
        if (a.score === null) return 1;
        if (b.score === null) return -1;
        if (b.score.value !== a.score.value) return b.score.value - a.score.value;
        return a.name.localeCompare(b.name);
    });
}
