/**
 * The console's read side for the two views.
 *
 * WHY THIS IS NOT IN lib/store/processes.js: that module's export list is asserted as a BOUNDARY by
 * the suite - exactly the five console operations, with no grouping lookup keyed on a response -
 * because a PARTICIPANT route must not be able to ask "where was my answer grouped?". People would
 * write to influence it. The console legitimately needs the opposite direction, so the read lives
 * here and the boundary is preserved by PLACEMENT rather than by refusing the console the data.
 *
 * THIS MODULE IS CONSOLE-ONLY: lib/auth/participant-routes.js and lib/routes-api.js must never
 * import it, and the suite greps for the process modules specifically.
 *
 * ATTRIBUTION IS NOT RESOLVED HERE EITHER. This says which PROCESS a response belongs to, which is
 * the grouping and not the person; nothing here can name who answered.
 */
import * as processSql from './process-sql.js';
import { needsReviewFromRevisions } from './process-membership.js';
import { fieldsPresentIn } from '../../ai/field-shapes.js';
import { correctionsForResponse } from './corrections.js';

/**
 * Every response in this organisation, each with the process it was matched to.
 *
 * GROUPED HERE, IN ONE PASS, rather than a query per response: the console renders
 * a list, and a lookup per row is how a page becomes slow without anyone noticing.
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

    // Which process each response currently belongs to, resolved through the
    // revision it is linked to. A response can appear in several revisions; only
    // the current one is shown, because that is the grouping in force.
    const byResponse = new Map();
    const current = currentRevisions(connection);
    // History, not just current rows; see the note above.
    const historyByProcess = revisionsByProcess(connection);

    for (const revision of current) {
        for (const linked of processSql.selectResponsesForRevision(connection, revision.id)) {
            // Reported, not silent; see the caveat above.
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
                // WHY it was grouped, which is the whole reason the console shows a
                // grouping at all: the admin checks the reasoning against the words.
                reasoning: revision.reasoning,
                decidedBy: revision.decided_by,
                decidedAt: revision.created_at,
                contributed: linked.contributed,
                // THE SAME DERIVED FLAG AS THE ROADMAP, from the same function: view 1
                // shows it per answer so the process a response landed in is marked
                // where the admin is reading that answer.
                needsReview: review.needsReview,
                needsReviewReason: review.reason
            });
        }
    }

    return responses.map((response) => ({
        ...response,
        // A response nobody has identified yet has NO grouping rather than an empty
        // one, so the view can say "not yet read" instead of showing a blank card.
        grouping: byResponse.get(response.id) ?? null,
        // DERIVED, NOT STORED, and it is the answer to "why does an empty round look
        // finished". A round where the participant declined everything carries no evidence at
        // all, so it renders as `Untitled answer` with no fields and - because `submitted_at`
        // IS set - no "still in progress" tag. An admin cannot tell it from a completed
        // interview, and it offers a Rejudge button that re-identifies nothing.
        //
        // WHY DERIVED RATHER THAN A COLUMN. The fact is computable from the row: a declined
        // field has no shape, so `fieldsPresentIn` returns nothing for it, and NO EVIDENCE is
        // exact rather than a heuristic. A column would mean a migration, and this schema
        // deliberately has none - see the note in NOTES.md - so a derived answer is both
        // cheaper and consistent with how `needsReview` is already computed from revision
        // history rather than stored.
        //
        // IT IS A DIFFERENT STATE FROM "STILL IN PROGRESS": that one has no `submitted_at`,
        // while this one is finished and simply holds nothing. The view needs both to say
        // something honest.
        empty: response.submitted_at !== null && presentsNoEvidence(response.data),
        // AN ADMIN'S CORRECTIONS, per response, so the view can show the admin's reading as a
        // CORRECTION rather than as the participant's words or a model's reading. Without this the
        // answers page would display the stored 56 while the score used 392, which is the
        // disagreement a correction exists to record rather than to create.
        corrections: correctionsForResponse(connection, response.id)
    }));
}

/**
 * Whether a stored round carries no usable field at all.
 *
 * THE ALL-DECLINED CASE, without naming it: every field either absent or a `{ declined }` marker,
 * so nothing has a shape the analysis can use. It is the signal the console needs, and it is
 * computed from the stored payload rather than from a status the row does not carry.
 *
 * A ROUND THAT IS MERELY INCOMPLETE IS NOT EMPTY. Fewer fields than fifteen with some evidence is
 * an ordinary unfinished answer, which `submitted_at` already describes; this is specifically the
 * round with nothing in it.
 *
 * @param {object|null} data The parsed response data.
 * @returns {boolean}
 */
function presentsNoEvidence(data) {
    if (!data || typeof data !== 'object') return true;

    // The payload shape is `{ workflows: [...] }` on an interview round and a bare workflow on
    // an imported one, so both are checked. `fieldsPresentIn` is the same predicate the matrix
    // and the weighing use, which is what makes this agree with them rather than approximate.
    const candidates = Array.isArray(data.workflows) ? data.workflows : [data];
    return candidates.every((candidate) => fieldsPresentIn(candidate).length === 0);
}

/**
 * The current revision of every process, with its process name attached.
 *
 * A revision alone carries no name, and the view names the process it matched, so
 * the join is done once here rather than in the template.
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
 * Every revision of every process, grouped by process id.
 *
 * ONE QUERY FOR THE WHOLE LIST, because the flag is derived from the history and a
 * lookup per process is how a page becomes slow without anyone noticing. The rows
 * are the same columns the flag rule reads.
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
 * Fails loudly when a connection was not handed in. A programming error.
 *
 * This module takes a CONNECTION rather than an orgId, unlike the rest of the
 * store's public API, because it joins three process tables in one pass and the
 * console already holds the scope. The connection it is handed is the one
 * `requireConnection(orgId)` returned, so it is still confined to one file.
 */
function assertOpenConnection(db) {
    if (!db || typeof db.prepare !== 'function') {
        throw new Error('listResponsesWithGrouping requires an open connection; it never opens one.');
    }
    return db;
}
