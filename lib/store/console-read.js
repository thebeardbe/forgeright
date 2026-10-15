/**
 * The console's read side for the two views.
 *
 * This lives here rather than in processes.js because that module's export list is asserted as a boundary
 * by the suite: a participant route must not be able to ask where an answer was grouped. Console-only,
 * so lib/auth/participant-routes.js and lib/routes-api.js must never import it. It resolves which process
 * a response belongs to, never who answered.
 */
import * as processSql from './process-sql.js';
import { needsReviewFromRevisions } from './process-membership.js';
import { fieldsPresentIn } from '../../ai/field-shapes.js';
import { correctionsForResponse } from './corrections.js';

/**
 * Every response in this organisation, each with the process it was matched to. Grouped in one pass
 * rather than a query per response, because the console renders a list.
 *
 * @param {object} db An open connection, already scoped to one organisation.
 * @returns {Array<object>} Responses with `grouping`, oldest first.
 */
export function listResponsesWithGrouping(db) {
    const connection = assertOpenConnection(db);

    const responses = connection
        .prepare(`SELECT id, department, data, transcript, created_at, updated_at, submitted_at
                  FROM response ORDER BY created_at, id`)
        .all()
        .map(parseResponse);

    // A response can appear in several revisions; only the current one is shown.
    const byResponse = new Map();
    const current = currentRevisions(connection);
    const historyByProcess = revisionsByProcess(connection);

    for (const revision of current) {
        for (const linked of processSql.selectResponsesForRevision(connection, revision.id)) {
            // Reported, because it means a grouping is stale and one person is counted twice.
            if (byResponse.has(linked.responseId)) {
                const previous = byResponse.get(linked.responseId);
                console.error(
                    `[console] response ${linked.responseId} is behind two current revisions; ` +
                    `showing ${revision.name} and hiding ${previous.processName}. ` +
                    `This means a grouping is stale and the roadmap counts one person twice.`
                );
            }

            // Computed once per process, before the inner loop walks its members.
            const review = needsReviewFromRevisions(historyByProcess.get(revision.process_id) ?? []);

            byResponse.set(linked.responseId, {
                processId: revision.process_id,
                processName: revision.name,
                revision: revision.revision,
                confidence: revision.confidence,
                // Why it was grouped: the admin checks the reasoning against the words.
                reasoning: revision.reasoning,
                decidedBy: revision.decided_by,
                decidedAt: revision.created_at,
                contributed: linked.contributed,
                // The same flag the roadmap derives, from the same function.
                needsReview: review.needsReview,
                needsReviewReason: review.reason
            });
        }
    }

    return responses.map((response) => ({
        ...response,
        // None rather than empty, so the view can say "not yet read" instead of a blank card.
        grouping: byResponse.get(response.id) ?? null,
        // An all-declined round is finished but carries no evidence, which is a different state from
        // "still in progress"; a column would need a migration this schema deliberately has none of.
        empty: response.submitted_at !== null && presentsNoEvidence(response.data),
        // So the view can show the admin's reading as a correction rather than as their words.
        corrections: correctionsForResponse(connection, response.id)
    }));
}

/**
 * Whether a stored round carries no usable field at all: every field absent or a `{ declined }` marker.
 * A round that is merely incomplete is not empty.
 *
 * @param {object|null} data The parsed response data.
 * @returns {boolean}
 */
function presentsNoEvidence(data) {
    if (!data || typeof data !== 'object') return true;

    // An interview round wraps in `workflows`, an imported one does not, so both are checked.
    // `fieldsPresentIn` is the same predicate the matrix and the weighing use.
    const candidates = Array.isArray(data.workflows) ? data.workflows : [data];
    return candidates.every((candidate) => fieldsPresentIn(candidate).length === 0);
}

/** The current revision of every process, with its name attached for the template. */
function currentRevisions(db) {
    return db.prepare(
        `SELECT pr.id, pr.process_id, pr.revision, pr.reasoning, pr.confidence, pr.decided_by,
                pr.created_at, p.name
         FROM process_revision pr
         JOIN process p ON p.id = pr.process_id
         WHERE pr.is_current = 1
         ORDER BY p.created_at, p.id`
    ).all();
}

/**
 * Every revision of every process, grouped by process id: one query for the whole list.
 *
 * @param {object} db
 * @returns {Map<string, Array<object>>}
 */
function revisionsByProcess(db) {
    const rows = db.prepare(
        `SELECT id, process_id, revision, confidence, decided_by
         FROM process_revision
         ORDER BY process_id, revision`
    ).all();

    const byProcess = new Map();
    for (const row of rows) {
        if (!byProcess.has(row.process_id)) byProcess.set(row.process_id, []);
        byProcess.get(row.process_id).push(row);
    }

    return byProcess;
}

/** Parses a response row's JSON blobs, with the same tolerance as the store. */
function parseResponse(row) {
    return {
        id: row.id,
        department: row.department,
        data: parseJson(row.data, `response ${row.id} data`),
        transcript: parseJson(row.transcript, `response ${row.id} transcript`),
        created_at: row.created_at,
        updated_at: row.updated_at,
        submitted_at: row.submitted_at
    };
}

/** A corrupt blob is reported and returned as null rather than throwing the page. */
function parseJson(value, label) {
    if (value === null || value === undefined || value === '') return null;
    try {
        return JSON.parse(value);
    } catch (err) {
        console.error(`[console] unreadable JSON in ${label} (${err.message}); showing it as absent.`);
        return null;
    }
}

/**
 * Fails loudly when a connection was not handed in. This module takes a connection rather than an orgId,
 * because it joins three process tables in one pass and the console already holds the scope.
 */
function assertOpenConnection(db) {
    if (!db || typeof db.prepare !== 'function') {
        throw new Error('listResponsesWithGrouping requires an open connection; it never opens one.');
    }
    return db;
}
