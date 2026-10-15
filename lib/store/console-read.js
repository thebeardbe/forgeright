/**
 * The console's read side for the two views.
 *
 * This is not in processes.js because that module's export list is asserted as a boundary by the
 * suite, so a participant route cannot ask "where was my answer grouped?" and write to influence it.
 * The console legitimately needs the opposite direction, so the read lives here and the boundary is
 * preserved by placement.
 *
 * Console-only: lib/auth/participant-routes.js and lib/routes-api.js must never import it.
 * Attribution is not resolved here either; this says which process a response belongs to, never who
 * answered.
 */
import * as processSql from './process-sql.js';
import { needsReviewFromRevisions } from './process-membership.js';
import { fieldsPresentIn } from '../../ai/field-shapes.js';
import { correctionsForResponse } from './corrections.js';

/**
 * Every response in this organisation, each with the process it was matched to. Grouped here in one
 * pass rather than a query per response, because the console renders a list and a lookup per row is
 * how a page becomes slow without anyone noticing.
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

    // Which process each response currently belongs to, resolved through the revision it is linked
    // to. A response can appear in several revisions; only the current one is shown.
    const byResponse = new Map();
    const current = currentRevisions(connection);
    const historyByProcess = revisionsByProcess(connection);

    for (const revision of current) {
        for (const linked of processSql.selectResponsesForRevision(connection, revision.id)) {
            // Reported rather than silent, because it means a grouping is stale and the roadmap
            // counts one person twice.
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
                // Why it was grouped, which is the whole reason the console shows a grouping: the
                // admin checks the reasoning against the words.
                reasoning: revision.reasoning,
                decidedBy: revision.decided_by,
                decidedAt: revision.created_at,
                contributed: linked.contributed,
                // The same derived flag as the roadmap, from the same function, so view 1 shows it
                // per answer where the admin is reading that answer.
                needsReview: review.needsReview,
                needsReviewReason: review.reason
            });
        }
    }

    return responses.map((response) => ({
        ...response,
        // A response nobody has identified yet has no grouping rather than an empty one, so the view
        // can say "not yet read" instead of showing a blank card.
        grouping: byResponse.get(response.id) ?? null,
        // Derived rather than stored, and it is the answer to "why does an empty round look
        // finished": a round where the participant declined everything carries no evidence, so it
        // renders as `Untitled answer` with no fields and, because `submitted_at` is set, no "still
        // in progress" tag, and an admin cannot tell it from a completed interview. A column would
        // need a migration this schema deliberately has none of. It is a different state from "still
        // in progress", which has no `submitted_at`.
        empty: response.submitted_at !== null && presentsNoEvidence(response.data),
        // An admin's corrections, per response, so the view can show the admin's reading as a
        // correction rather than as the participant's words or a model's reading.
        corrections: correctionsForResponse(connection, response.id)
    }));
}

/**
 * Whether a stored round carries no usable field at all: the all-declined case, where every field is
 * either absent or a `{ declined }` marker. It is computed from the stored payload rather than a
 * status the row does not carry. A round that is merely incomplete is not empty, which `submitted_at`
 * already describes.
 *
 * @param {object|null} data The parsed response data.
 * @returns {boolean}
 */
function presentsNoEvidence(data) {
    if (!data || typeof data !== 'object') return true;

    // The payload shape is `{ workflows: [...] }` on an interview round and a bare workflow on an
    // imported one, so both are checked. `fieldsPresentIn` is the same predicate the matrix and the
    // weighing use, which is what makes this agree with them rather than approximate.
    const candidates = Array.isArray(data.workflows) ? data.workflows : [data];
    return candidates.every((candidate) => fieldsPresentIn(candidate).length === 0);
}

/**
 * The current revision of every process, with its process name attached. A revision alone carries no
 * name, so the join is done once here rather than in the template.
 */
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
 * Every revision of every process, grouped by process id: one query for the whole list, because the
 * flag is derived from the history and a lookup per process is how a page becomes slow without
 * anyone noticing.
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
 * Fails loudly when a connection was not handed in. This module takes a connection rather than an
 * orgId, unlike the rest of the store's public API, because it joins three process tables in one pass
 * and the console already holds the scope; the connection is the one `requireConnection(orgId)`
 * returned, so it is still confined to one file.
 */
function assertOpenConnection(db) {
    if (!db || typeof db.prepare !== 'function') {
        throw new Error('listResponsesWithGrouping requires an open connection; it never opens one.');
    }
    return db;
}
