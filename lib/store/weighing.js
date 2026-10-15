/**
 * Weighing: the store's public interface for workflow 3.
 *
 * One number per process, with the terms behind it and a paragraph explaining it. A score is a
 * judgement about a particular grouping, so it is keyed on the revision rather than the process, and
 * a rejudge adds a score rather than editing one. Every function takes an org id first.
 */
import { requireConnection } from './organisations.js';
import { timedWrite } from './write-timing.js';
import * as processSql from './process-sql.js';
import { needsReviewFromRevisions } from './process-membership.js';
import * as sql from './sqlite.js';

/**
 * The terms a weighing must report. All ten are required, because a score computed without one of
 * them is not the score this system claims to produce, and substituting a middle value would make it
 * look as though it had been weighed. The order is the spec's table order.
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
 * The terms whose high value counts against the process, named and explained rather than used for
 * arithmetic: the direction is applied by the model in the prompt, and this code validates the
 * reply's shape without recomposing the score. There is no `contributionOf`, and the direction can
 * therefore be checked here but not enforced.
 */
export const COST_TERMS = Object.freeze([
    'departments', 'complexity', 'reasoningSteps', 'buildEffort'
]);

/**
 * The range every term must fall in: 0 to 100, the same scale as the score, so the ten terms and the
 * composite number are read on the same footing.
 *
 * The names cover the whole scale rather than only the terms, and test/ reads them by name, so
 * renaming would be a change to the tests to satisfy a tidier word. The refusal messages do not rely
 * on the name, because each says which of the two it is refusing.
 */
export const TERM_MIN = 0;
export const TERM_MAX = 100;

/** True when a high value in this term counts against the process. */
export function isCostTerm(term) {
    return COST_TERMS.includes(term);
}

/**
 * Checks a model's weighing reply and reports what is wrong with it, so a caller can fail clearly
 * rather than store a number nobody can explain. A non-numeric score, a missing or non-numeric term
 * and missing reasoning are each refused rather than defaulted.
 *
 * @param {object} reply The model's parsed reply.
 * @returns {{ok: true, score: number, terms: object, reasoning: string}
 *   | {ok: false, reason: string}}
 */
export function validateWeighing(reply) {
    if (!reply || typeof reply !== 'object' || Array.isArray(reply)) {
        return { ok: false, reason: 'the reply is not an object' };
    }

    // A string number is refused, not coerced: the one place that checks the shape must not also be
    // guessing about types.
    if (typeof reply.score !== 'number' || !Number.isFinite(reply.score)) {
        return { ok: false, reason: `the score must be a finite number, got ${JSON.stringify(reply.score)}` };
    }

    // The score is on the same scale as the terms, so it is checked on the same scale.
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
        // Named, like a missing term, so the refusal says which term was wrong rather than only that
        // something was.
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

    // Only the required terms are stored, so a model that invents an extra one cannot put an
    // unexplained value into the breakdown a reader trusts.
    const terms = {};
    for (const term of TERMS) terms[term] = reply.terms[term];

    return { ok: true, score: reply.score, terms, reasoning: reply.reasoning.trim() };
}

/**
 * Records a weighing for a process's current revision. The revision is resolved here rather than
 * passed in, so a caller cannot score a grouping that is no longer current, and a process with no
 * revision has never been grouped and cannot be weighed.
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
            // No `revisionNo`: `insertScore` computes it inside its own transaction, so the MAX and
            // the INSERT cannot be split by another writer.
        });

        console.info(
            `[store] weighed process ${processId} at ${checked.score} in organisation ${orgId} ` +
            `(weighing ${score.revision_no})`
        );

        return { score, revision, process };
    });
}

/**
 * The roadmap: every process, highest score first. Sorted here, once, so the console and anything else
 * reading the list cannot disagree about the order. An unscored process sorts last rather than being
 * dropped, because it is still work somebody described, and `score: null` says why it is at the
 * bottom.
 *
 * @returns {Array<object>} Processes with their current grouping, score and history.
 */
export function listRoadmap(orgId) {
    const db = requireConnection(orgId);

    const entries = processSql.listProcesses(db).map((process) => {
        const revision = processSql.selectCurrentRevision(db, process.id);
        const score = revision ? processSql.selectCurrentScore(db, revision.id) : null;

        // Derived, not stored, from the history, because a later merge must not clear it and a
        // low-confidence merge must not set it.
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
            // Across every revision, not just the current one: a rejudge makes a new revision and the
            // scores restart at 1, so a per-revision list would hide the score being compared against.
            scoreHistory: processSql.listScoresForProcess(db, process.id)
        };
    });

    // Highest first, unscored last, ties broken on the name so the order is stable between reads.
    return entries.sort((a, b) => {
        if (a.score === null && b.score === null) return a.name.localeCompare(b.name);
        if (a.score === null) return 1;
        if (b.score === null) return -1;
        if (b.score.value !== a.score.value) return b.score.value - a.score.value;
        return a.name.localeCompare(b.name);
    });
}
