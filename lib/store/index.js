/**
 * The store's public interface. Every method takes an org id first; the isolation itself lives in
 * registry.js. No data is a null or an empty array, cannot compute is an exception or a logged refusal,
 * and the two are never conflated.
 */
import { randomUUID } from 'node:crypto';
import {
    assertSafeOrgId, closeAll, closeConnection, connectionFor,
    listOrganisationIds, orgDbPath, storeDir
} from './registry.js';
import { connectionForOrNull, requireConnection } from './organisations.js';
import { isUnusableToken } from './connection-guard.js';
import { invitationForToken } from './invitations.js';
import { timedWrite } from './write-timing.js';
import * as sql from './sqlite.js';

/** The message every post-close write is refused with, so it is written once. */
function finishedMessage(orgId) {
    return `Organisation ${orgId} is finished: responses can no longer be added or edited.`;
}

/** The organisation for this id, or null. A file with no organisation row is not papered over. */
export function getOrganisation(orgId) {
    const db = connectionForOrNull(orgId);
    if (db === null) return null;

    const organisation = sql.selectOrganisation(db);
    if (!organisation) {
        console.warn(`[store] ${orgDbPath(orgId)} exists but holds no organisation row.`);
        return null;
    }
    return organisation;
}

/**
 * Creates the organisation that owns one database file. A second call for the same id is refused rather
 * than being a no-op. `orgId` overrides the generated UUID, for the demo seed's predictable file name.
 */
export function createOrganisation(name, orgId = null) {
    if (typeof name !== 'string' || name.trim() === '') {
        throw new Error('createOrganisation requires a non-empty name.');
    }

    const id = orgId === null ? randomUUID() : orgId;
    const safeId = assertSafeOrgId(id);
    // The one path allowed to create a database file; the check above is for the error message, as
    // `connectionFor` re-runs `assertSafeOrgId` itself.
    const db = connectionFor(safeId, { mayCreate: true });

    if (sql.selectOrganisation(db)) {
        throw new Error(`Organisation ${safeId} already exists.`);
    }

    const organisation = sql.insertOrganisation(db, { id: safeId, name: name.trim() });
    console.info(`[store] created organisation ${safeId} at ${orgDbPath(safeId)}`);
    return organisation;
}

/**
 * Renames one organisation, scoped by the id the console takes from the session.
 *
 * @returns {object} The organisation with its new name.
 * @throws {Error} When the organisation is unknown, or the name is empty.
 */
export function renameOrganisation(orgId, name) {
    if (typeof name !== 'string' || name.trim() === '') {
        throw new Error('renameOrganisation requires a non-empty name.');
    }

    const db = requireConnection(orgId);
    if (!sql.selectOrganisation(db)) {
        throw new Error(`Cannot rename organisation ${orgId}: it does not exist in the store.`);
    }

    const organisation = sql.updateOrganisationName(db, name.trim());
    console.info(`[store] organisation ${orgId} renamed`);
    return organisation;
}

/**
 * Closes the questionnaire for one organisation, permanently.
 *
 * @returns {object} The organisation with finished_at set.
 * @throws {Error} When the organisation is unknown.
 */
export function finishOrganisation(orgId) {
    const db = requireConnection(orgId);
    if (!sql.selectOrganisation(db)) {
        throw new Error(`Cannot finish organisation ${orgId}: it does not exist in the store.`);
    }

    const organisation = sql.markOrganisationFinished(db);
    console.info(`[store] organisation ${orgId} finished at ${organisation.finished_at}`);
    return organisation;
}

/** True when the questionnaire has been closed for this organisation. */
export function isOrganisationFinished(orgId) {
    const organisation = getOrganisation(orgId);
    return organisation !== null && organisation.finished_at !== null;
}

/**
 * Refuses a write when the organisation is finished. Reads through getOrganisation rather than the
 * caller's view, so a stale flag cannot bypass it.
 */
function assertOrganisationNotFinished(orgId) {
    const organisation = getOrganisation(orgId);
    if (organisation === null) {
        throw new Error(`Cannot write to organisation ${orgId}: it does not exist in the store.`);
    }
    if (organisation.finished_at !== null) {
        throw new Error(finishedMessage(orgId));
    }
    return organisation;
}

// The invitation lifecycle is re-exported so the public interface is one import for a caller, while
// the implementation lives in its own file.
export {
    addInvitation,
    invitationForToken,
    ISSUED_BY,
    issueAdditionalLink,
    listInvitations,
    listTokensForInvitation,
    resetAccess
} from './invitations.js';

export { closeAll, closeConnection, listOrganisationIds, orgDbPath, storeDir };
export { generateToken, hashToken } from './tokens.js';

// --- responses --------------------------------------------------------------

/**
 * One participant's own responses, for resume and edit, still available after the organisation is
 * finished. A token that is unusable or resolves to nothing returns `[]`, because a missing `?token=` is
 * routine on a read.
 *
 * The write paths below throw for the same tokens, so a caller never has to check a returned null.
 *
 * @returns {object[]} Rows with `data` parsed when readable.
 */
export function getResponsesByToken(orgId, token) {
    if (isUnusableToken(token)) {
        console.warn(`[store] organisation ${orgId} asked for responses with no usable token.`);
        return [];
    }

    const db = requireConnection(orgId);
    const invitation = invitationForToken(orgId, token);

    if (!invitation) {
        console.warn(`[store] organisation ${orgId} asked for responses with a token that resolves to nothing.`);
        return [];
    }

    return sql.selectResponsesByInvitation(db, invitation.id);
}

/**
 * Records one finished process a participant described, appending a new row so an earlier round is never
 * overwritten. The round is finalised on insert: this is for data that is already complete, and a round
 * still being filled in belongs to `recordTurn`.
 *
 * @param {object} details department, data, and the conversation.
 * @throws {Error} When the organisation is finished, the department is missing, or the token yields
 *   no invitation, for either reason: unusable, or well-formed and unknown.
 */
export function addResponse(orgId, token, { department, data, transcript } = {}) {
    if (isUnusableToken(token)) {
        throw new Error('addResponse requires a participant token.');
    }
    if (typeof department !== 'string' || department.trim() === '') {
        throw new Error('addResponse requires a non-empty department.');
    }
    if (data === undefined) {
        throw new Error('addResponse requires data.');
    }

    assertOrganisationNotFinished(orgId);

    const db = requireConnection(orgId);
    const invitation = invitationForToken(orgId, token);
    if (!invitation) {
        throw new Error(
            `Cannot add a response to organisation ${orgId}: the token resolves to no invitation. `
            + 'It may have been reset.'
        );
    }

    // An absent transcript is not an error; sqlite.js refuses anything that is not an array.
    return timedWrite(orgId, 'addResponse', () => {
        const inserted = sql.insertResponse(db, {
            id: sql.newId(),
            invitationId: invitation.id,
            department: department.trim(),
            data,
            transcript
        });
        return sql.markResponseSubmitted(db, inserted.id, invitation.id);
    });
}

/**
 * Replaces one round of a participant's answers. An id belonging to someone else throws rather than
 * returning null, and the message does not say whether it exists beyond this participant's rows.
 *
 * @returns {object} The updated response.
 * @throws {Error} When the organisation is finished, `responseId` is missing, the token yields no
 *   invitation (unusable or well-formed but unknown), or `responseId` is not this participant's; a
 *   well-formed unknown token throws to match addResponse.
 */
export function updateResponse(orgId, token, responseId, data, transcript) {
    if (isUnusableToken(token)) {
        throw new Error('updateResponse requires a participant token.');
    }
    if (typeof responseId !== 'string' || responseId === '') {
        throw new Error('updateResponse requires a responseId.');
    }
    if (data === undefined) {
        throw new Error('updateResponse requires data.');
    }

    assertOrganisationNotFinished(orgId);

    const db = requireConnection(orgId);
    const invitation = invitationForToken(orgId, token);
    if (!invitation) {
        throw new Error(
            `Cannot update a response in organisation ${orgId}: the token resolves to no invitation. `
            + 'It may have been reset.'
        );
    }
    if (!sql.responseBelongsToInvitation(db, responseId, invitation.id)) {
        console.warn(
            `[store] organisation ${orgId} tried to edit response ${responseId}, ` +
            `which does not belong to the invitation for that token.`
        );
        throw new Error('Cannot update that response: it does not belong to the invitation for this token.');
    }

    // Omitted transcript keeps the stored one rather than blanking it.
    return timedWrite(orgId, 'updateResponse', () =>
        sql.updateResponseData(db, responseId, invitation.id, data, transcript));
}

/**
 * Records one turn against the round it belongs to. The server decides which round, because the client
 * sends its whole accumulating payload each turn and the boundary is the model's `status: complete`.
 *
 * No open round inserts one; an open round is updated in place; no open round with `complete` inserts and
 * finalises immediately. The payload is stored as the model sent it, not scoped to the new process, so
 * rows stay self-contained and the console can show a partial round.
 *
 * @param {object} args
 * @param {string} args.data The payload, as the model produced it.
 * @param {Array} [args.transcript] The whole conversation so far.
 * @param {boolean} [args.complete] Whether the reply that produced this data was `complete`, meaning
 *   the round is finished.
 * @returns {object} The stored round.
 */
export function recordTurn(orgId, token, { data, transcript, complete = false } = {}) {
    if (isUnusableToken(token)) {
        throw new Error('recordTurn requires a participant token.');
    }
    if (data === undefined) {
        throw new Error('recordTurn requires data.');
    }

    assertOrganisationNotFinished(orgId);

    const db = requireConnection(orgId);
    const invitation = invitationForToken(orgId, token);
    if (!invitation) {
        throw new Error(
            `Cannot record a turn for organisation ${orgId}: the token resolves to no invitation. `
            + 'It may have been reset.'
        );
    }

    return timedWrite(orgId, 'recordTurn', () => {
        const open = sql.selectOpenResponse(db, invitation.id);

        if (open) {
            const updated = sql.updateResponseData(db, open.id, invitation.id, data, transcript);
            if (!updated) {
                // Vanished between the read and the write; report it rather than silently starting a
                // new round, which would look like the participant's work was reset.
                throw new Error(`The open round for invitation ${invitation.id} disappeared mid-write.`);
            }
            return complete
                ? sql.markResponseSubmitted(db, open.id, invitation.id)
                : updated;
        }

        const inserted = sql.insertResponse(db, {
            id: sql.newId(),
            invitationId: invitation.id,
            department: invitation.department,
            data,
            transcript
        });
        return complete
            ? sql.markResponseSubmitted(db, inserted.id, invitation.id)
            : inserted;
    });
}

/**
 * Finalised responses for the roadmap, with attribution stripped: no invitation id, no email, no join, so
 * the admin path cannot leak the link. Partial rounds are excluded, which is a product decision, and the
 * exclusion sits in the query so a caller cannot forget it.
 */
export function getResponsesForAnalysis(orgId) {
    const db = requireConnection(orgId);
    return sql.selectResponsesForAnalysis(db);
}

/**
 * Every response, partial rounds included, for the answers view. Which rows are partial is
 * `submitted_at === null`, and callers must say so rather than letting a partial look finished.
 */
export function getAllResponses(orgId) {
    const db = requireConnection(orgId);
    return sql.selectAllResponses(db);
}
