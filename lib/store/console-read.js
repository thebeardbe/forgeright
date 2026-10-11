/**
 * The console's read side for the two views.
 *
 * WHY THIS IS NOT IN lib/store/processes.js. That module's export list is asserted
 * as a BOUNDARY by the suite: exactly the five console operations, and no grouping
 * lookup keyed on a response. The reason is that a *participant* route must not be
 * able to ask "where was my answer grouped?" -- people would write to influence it.
 *
 * View 1 of the console legitimately needs the opposite direction: for a response,
 * which process it was matched to and why. So the read lives HERE, in a module the
 * console imports, and `lib/store/processes.js` keeps its five exports. The boundary
 * is preserved by placement rather than by refusing the console the data it needs.
 *
 * THIS MODULE IS CONSOLE-ONLY. `lib/auth/participant-routes.js` and
 * `lib/routes-api.js` must never import it, and the suite greps for the process
 * modules specifically; adding it to a participant route would be the mistake this
 * file exists to make visible.
 *
 * Attribution is NOT resolved here either. `getResponsesForAnalysis` strips the link
 * from a person; this module tells the console which PROCESS a response belongs to,
 * which is the grouping and not the person. Nothing here can name who answered.
 */
import * as processSql from './process-sql.js';
import { needsReviewFromRevisions } from './process-membership.js';

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
    // THE HISTORY, not just the current rows: a process that was BORN from an unsure
    // split must stay flagged even after a later merge, so the flag cannot be read
    // from the current revision alone. One query for every process in the list,
    // rather than one per row.
    const historyByProcess = revisionsByProcess(connection);

    for (const revision of current) {
        for (const linked of processSql.selectResponsesForRevision(connection, revision.id)) {
            // AN OVERWRITE IS REPORTED, NOT SILENT. This map is keyed on the response
            // id and the revisions are ordered by process creation, so a response in
            // two current revisions would have its earlier process quietly replaced by
            // the later one, and the console would show one grouping while the
            // response sat behind two. That silence is why a defect where a response
            // appeared in two processes survived four review rounds. The winner rule
            // is unchanged: this only makes a recurrence visible in the log, where the
            // store's own invariant check will have fired first.
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
        grouping: byResponse.get(response.id) ?? null
    }));
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
