/**
 * An admin's correction to a value the score is computed from, which a rejudge cannot reach because it
 * argues about the grouping rather than a stored value.
 *
 * The participant's own answer is never rewritten: `response.data` is the evidence this tool audits, and
 * a correction is the analysis's reading of it, in its own row, so both can be shown.
 */
import { requireConnection } from './organisations.js';
import { assertConnection, nowIso } from './connection-guard.js';
import { newId, responseExists } from './sqlite.js';
import { timedWrite } from './write-timing.js';

/**
 * The four fields the effort formula reads, and no others: a field the score is computed from and cannot
 * be corrected is the bug, while every other field feeds the narrative or the ten-term weighing.
 */
export const CORRECTABLE_FIELDS = Object.freeze([
    'frequencyPerWeek',
    'minutesPerInstance',
    'peopleAffected',
    'timePerPeriod'
]);

/**
 * Reads a submitted value for one of the correctable fields, or refuses it, because a blank or
 * nonsensical value must never reach the formula and read as a considered number.
 *
 * The shape is checked per field, because `timePerPeriod` takes an object, and a string is refused
 * rather than coerced: `Number("")` is 0, which would put a wrong figure into the score.
 *
 * @param {string} field
 * @param {*} raw The value as submitted, a string from a form.
 * @returns {{ok: true, value: *}|{ok: false, reason: string}}
 */
export function readCorrectedValue(field, raw) {
    if (!CORRECTABLE_FIELDS.includes(field)) {
        return { ok: false, reason: `"${field}" is not a field that can be corrected.` };
    }

    if (field === 'timePerPeriod') {
        // A number is refused, because the period is part of the meaning.
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            return { ok: false, reason: 'A time per period needs an hours figure and a period.' };
        }
        const hours = Number(String(raw.hours ?? '').trim());
        const period = String(raw.period ?? '').trim();
        if (!Number.isFinite(hours) || hours < 0) {
            return { ok: false, reason: 'Hours must be a number of zero or more.' };
        }
        if (period === '') return { ok: false, reason: 'A period is required (for example "day" or "week").' };
        return { ok: true, value: { hours, period } };
    }

    // `Number('')` is 0, so an empty submission would otherwise read as a corrected zero.
    const text = String(raw ?? '').trim();
    if (text === '') return { ok: false, reason: 'A value is required.' };
    // Refused by name, because "-1" is a number and the objection is that the score cannot use it.
    if (/^-/.test(text)) {
        return { ok: false, reason: 'A count of zero or more is required; it cannot be negative.' };
    }
    if (!/^\d+(\.\d+)?$/.test(text)) {
        return { ok: false, reason: 'The value must be a number, with no units or words around it.' };
    }
    return { ok: true, value: Number(text) };
}

/**
 * Records one admin correction, superseding any earlier correction of the same field, because "what is
 * the frequency" has one answer and a reader should not choose between two rows. The superseded value is
 * not kept; the argument that produced it survives in `process_revision.admin_reasoning`.
 *
 * @param {object} args
 * @param {string} args.orgId
 * @param {string} args.responseId
 * @param {string} args.field
 * @param {*} args.value Already validated by `readCorrectedValue`.
 * @param {string} args.adminReasoning The admin's own words. Required.
 * @returns {object} The stored correction.
 * @throws {Error} When the response is not in this organisation, the field is not correctable, or no
 *   reasoning was given.
 */
export function recordFieldCorrection({ orgId, responseId, field, value, adminReasoning = null }) {
    if (!CORRECTABLE_FIELDS.includes(field)) {
        throw new Error(`Cannot correct ${JSON.stringify(field)}: it is not a field the score is computed from.`);
    }
    const reason = typeof adminReasoning === 'string' ? adminReasoning.trim() : '';
    if (reason === '') {
        throw new Error('A correction needs the admin\'s reasoning, so a changed number can be reviewed.');
    }

    const db = requireConnection(orgId);
    if (!responseExists(db, responseId)) {
        throw new Error(`Cannot correct response ${JSON.stringify(responseId)}: it is not in organisation ${orgId}.`);
    }

    const row = {
        id: newId(),
        response_id: responseId,
        field,
        // JSON, because one of the four fields is not a scalar.
        value: JSON.stringify(value),
        admin_reasoning: reason,
        decided_at: nowIso()
    };

    return timedWrite(orgId, 'recordFieldCorrection', () => {
        assertConnection(db)
            .prepare(
                `INSERT OR REPLACE INTO response_field_correction
                     (id, response_id, field, value, admin_reasoning, decided_at)
                 VALUES (?, ?, ?, ?, ?, ?)`
            )
            .run(row.id, row.response_id, row.field, row.value, row.admin_reasoning, row.decided_at);
        return row;
    });
}

/**
 * Every current correction for one response, keyed by field: the caller wants
 * `{ frequencyPerWeek: 392 }` to lay over the stored answer, so the decision about which reading wins is
 * made by the caller.
 *
 * @param {object} db
 * @param {string} responseId
 * @returns {Object<string, *>} Corrected values, by field. Empty when nothing is corrected.
 */
export function correctionsForResponse(db, responseId) {
    const rows = assertConnection(db)
        .prepare('SELECT field, value FROM response_field_correction WHERE response_id = ?')
        .all(responseId);

    const out = {};
    for (const row of rows) {
        try {
            out[row.field] = JSON.parse(row.value);
        } catch (err) {
            // Skipping silently would make the correction vanish and the score revert to the stored
            // value, which is the failure this table exists to prevent.
            console.warn(
                `[store] correction ${row.field} for response ${responseId} is not readable JSON ` +
                `(${err.message}); ignoring it, so the stored value will be scored.`
            );
        }
    }
    return out;
}
