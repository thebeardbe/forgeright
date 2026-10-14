/**
 * An admin's correction to a value the score is computed from.
 *
 * WHY THIS EXISTS. The effort formula is `frequencyPerWeek * minutesPerInstance *
 * peopleAffected / 60`, and every one of those comes from `response.data` - what the
 * participant said. When the MODEL reads that answer wrongly an admin has no way to say so: the
 * rejudge is a reasoned argument about the GROUPING, and it reaches neither a stored value nor
 * the score computed from it. Measured on the deployed instance, an admin rejudged with:
 *
 *   "it is not 56 a week, but 56 every morning so 7 times 56"
 *
 * and the weighing still read "fifty-six checks a week, every morning". The participant had said
 * "56 checks every morning"; the model recorded it as a weekly frequency. So the ERROR IS IN THE
 * STORED READING, and the correction belongs to the data rather than to a sentence about it.
 *
 * THE PARTICIPANT'S OWN ANSWER IS NEVER REWRITTEN, which is the design rather than a side
 * effect: `response.data` is the evidence this tool is an audit of, and the answers view shows
 * it. A correction is the ANALYSIS'S READING OF THAT ANSWER, held in its own row, so the two can
 * be shown together and neither can be mistaken for the other.
 *
 * NOT THE WEIGHING MODEL. An earlier attempt had the weighing prompt parse the admin's sentence
 * into a figure ("56 every morning is 392"). That was wrong for three separate reasons, all of
 * them decisive:
 *   - THE CORRECTION HAD NO HOME. It lived in a prompt, so the next reweigh recomputed from the
 *     stored 56 and the correction silently evaporated, and a second participant joining the
 *     process never saw it at all.
 *   - THE ARITHMETIC WAS IN THE PROMPT. A model multiplying words is precisely the invented
 *     number the prose marker exists to prevent, and nothing refused a wrong product.
 *   - IT WAS NOT RECORDED AS ONE. The console would show a score derived from 392 beside a field
 *     saying 56, with no way to tell that an admin had intervened.
 */

import { requireConnection } from './organisations.js';
import { assertConnection, nowIso } from './connection-guard.js';
import { newId, responseExists } from './sqlite.js';
import { timedWrite } from './write-timing.js';

/**
 * The fields an admin may correct: THE FOUR THE EFFORT FORMULA READS, and no others.
 *
 * ARGUED FROM THE FORMULA RATHER THAN FROM THE FIELD THAT WAS REPORTED. Effort is
 * `frequencyPerWeek * minutesPerInstance * peopleAffected / 60`, with `timePerPeriod` as the
 * either/or alternative the matrix admits for continuous work. A field the score is computed from
 * and cannot be corrected IS the bug; every other field feeds the narrative or the ten-term
 * weighing, is not the reported problem, and would be console surface with no caller.
 */
export const CORRECTABLE_FIELDS = Object.freeze([
    'frequencyPerWeek',
    'minutesPerInstance',
    'peopleAffected',
    'timePerPeriod'
]);

/**
 * Reads a submitted value for one of the correctable fields, or refuses it.
 *
 * REFUSED AT THE BOUNDARY RATHER THAN CARRIED INTO THE SCORE, which is the requirement this
 * exists to meet: a blank or nonsensical value must never reach the formula, because a
 * corrected-but-wrong number is harder to notice than an absent one and the console would
 * present it as a considered reading.
 *
 * THE SHAPE PER FIELD, rather than one relaxed test: a number the formula can use is a
 * non-negative finite number, and `timePerPeriod` is the one field that takes an object
 * (`{ hours, period }`). A string is REFUSED rather than coerced - `Number("56 every morning")`
 * is NaN and `Number("")` is 0, and either would put a wrong figure into a score that looks
 * deliberate.
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
        // The object form the matrix already accepts. A number here is refused rather than
        // guessed at, because the period is part of the meaning: "2" alone says nothing about
        // whether that is hours or days.
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

    // A NUMBER, AND ONLY FROM A STRING OF DIGITS. `Number('')` is 0 and `Number(' ')` is 0, so an
    // empty submission would otherwise read as a corrected zero - the one wrong value that looks
    // like a real answer.
    const text = String(raw ?? '').trim();
    if (text === '') return { ok: false, reason: 'A value is required.' };
    // A NEGATIVE IS REFUSED BY NAME rather than falling through to the shape test, because
    // "-1" IS a number and telling an admin that it "must be a number" wastes their time when the
    // real objection is that the score cannot use it.
    if (/^-/.test(text)) {
        return { ok: false, reason: 'A count of zero or more is required; it cannot be negative.' };
    }
    if (!/^\d+(\.\d+)?$/.test(text)) {
        return { ok: false, reason: 'The value must be a number, with no units or words around it.' };
    }
    return { ok: true, value: Number(text) };
}

/**
 * Records one admin correction, superseding any earlier correction of the same field.
 *
 * ONE CURRENT CORRECTION PER RESPONSE AND FIELD, which the schema enforces with a unique index.
 * `INSERT OR REPLACE` on that key is what makes a second correction supersede the first: "what is
 * the frequency" has one answer, and a reader should not have to choose between two rows. The
 * superseded VALUE is not kept - this table records the current reading - while the argument that
 * produced it survives in `process_revision.admin_reasoning` on the revision the correction led
 * to, which is where a reviewer looks for why a number changed.
 *
 * @param {object} args
 * @param {string} args.orgId
 * @param {string} args.responseId
 * @param {string} args.field
 * @param {*} args.value Already validated by `readCorrectedValue`.
 * @param {string} args.adminReasoning The admin's own words. Required.
 * @returns {object} The stored correction.
 * @throws {Error} When the response is not in this organisation, the field is not correctable,
 *   or no reasoning was given.
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
        // JSON, because one of the four fields is not a scalar. See the schema note.
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
 * Every current correction for one response, keyed by field.
 *
 * SHAPED FOR THE CONSUMER rather than the table: the caller wants
 * `{ frequencyPerWeek: 392 }` to lay over the stored answer, so the JSON is parsed and the
 * decision about which reading wins is made by the caller rather than here. One read for every
 * field, because a correction is read on paths that already have the response in hand.
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
            // A row that cannot be parsed is REPORTED rather than skipped silently: skipping it
            // would make a correction vanish and the score would quietly revert to the stored
            // value, which is the failure this table exists to prevent.
            console.warn(
                `[store] correction ${row.field} for response ${responseId} is not readable JSON ` +
                `(${err.message}); ignoring it, so the stored value will be scored.`
            );
        }
    }
    return out;
}
