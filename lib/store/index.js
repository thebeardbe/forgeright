/**
 * The store's public interface.
 *
 * EVERY METHOD TAKES AN ORG ID FIRST. A caller cannot reach a participant's
 * data without naming the organisation it belongs to, so "which tenant is this?"
 * is a required argument rather than something a route can forget. The isolation
 * itself lives in lib/store/registry.js: one SQLite file per organisation, which
 * is the only module allowed to open a connection.
 *
 * Methods here validate their arguments, log what they refuse, and throw for
 * programming errors (an unknown organisation, an unsafe id, a write after the
 * organisation was closed). "No data" is a null or an empty array; "cannot
 * compute" is an exception or a logged refusal. The two are never conflated.
 *
 * The lifecycle: an admin creates an organisation, invites participants, and
 * closes the questionnaire with finishOrganisation(). After that, no answers may
 * be added or edited, but a participant can still read what they wrote.
 */
import { randomUUID } from 'node:crypto';
import { closeAll, closeConnection, connectionFor, listOrganisationIds, orgDbPath, storeDir } from './registry.js';
import { connectionForOrNull, requireConnection } from './organisations.js';
import { isUnusableToken } from './connection-guard.js';
import { invitationForToken } from './invitations.js';
import { timedWrite } from './write-timing.js';
import * as sql from './sqlite.js';

/** The message every post-close write is refused with, so it is written once. */
function finishedMessage(orgId) {
    return `Organisation ${orgId} is finished: responses can no longer be added or edited.`;
}

/**
 * The organisation the store knows about for this id, or null.
 *
 * A file that exists with no organisation row is a half-created store, which is
 * a state the application cannot use and should not paper over.
 */
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
 * Creates the organisation that owns one database file.
 *
 * The file, its schema and the metadata row are created together on first call.
 * Calling this again for the same id is refused rather than treated as a no-op:
 * a route that thought it was creating organisation A while writing into
 * organisation B is exactly the mistake this module exists to prevent.
 *
 * @param {string} name Human-readable name for the admin's overview.
 * @returns {object} The organisation row.
 */
export function createOrganisation(name) {
    if (typeof name !== 'string' || name.trim() === '') {
        throw new Error('createOrganisation requires a non-empty name.');
    }

    // The id is generated here, so it matches the safe-path pattern by
    // construction and never comes from user input.
    const orgId = randomUUID();
    // mayCreate: this is the ONE path allowed to bring a database file into
    // existence. Everything else reads an organisation that is already there.
    const db = connectionFor(orgId, { mayCreate: true });

    if (sql.selectOrganisation(db)) {
        throw new Error(`Organisation ${orgId} already exists.`);
    }

    const organisation = sql.insertOrganisation(db, { id: orgId, name: name.trim() });
    console.info(`[store] created organisation ${orgId} at ${orgDbPath(orgId)}`);
    return organisation;
}

/**
 * Renames one organisation.
 *
 * The only mutable field on an organisation row, and the reason the placeholder
 * from a first sign-in is not permanent. Scoped by the organisation id, which the
 * console takes from the session.
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
 * Refuses a write when the organisation is finished.
 *
 * Reads the organisation through getOrganisation rather than trusting the
 * caller's view, so the boundary cannot be bypassed by holding a stale flag.
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

// The invitation lifecycle is re-exported so the public interface is one import
// for a caller, while the implementation lives in its own file.
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

// --- invitations ------------------------------------------------------------
//
// The invitation lifecycle (create, resend, reissue, list, mark opened) lives
// in ./invitations.js and is re-exported below, so this file stays a list of
// operations rather than growing past its budget.

// --- responses --------------------------------------------------------------

/**
 * One participant's own responses, for resume and edit.
 *
 * Still available after the organisation is finished, so a participant can read
 * back what they submitted. Only this token's own rows are returned.
 *
 * An empty, null, non-string or otherwise unusable token returns `[]`, the same
 * as a valid-form token that matches nothing. A link with a missing `?token=`
 * is a routine event and must not become a 500 on a read.
 *
 * The rule this method shares with the other read path: reads return nothing for
 * a token that yields no invitation. The write paths below throw instead,
 * whether the token is unusable or simply unknown: a write with no valid
 * credential is a caller error, and a returned null is a silent failure a
 * caller has to remember to check. The divergence is read versus write, not one
 * spelling of a bad token versus another.
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

    // invitationForToken already recorded the visit, so last_seen_at is current
    // and this is purely the read.
    return sql.selectResponsesByInvitation(db, invitation.id);
}

/**
 * Records one process a participant described.
 *
 * Appends a new row. A participant describing a second process, or a second
 * round of the questionnaire, adds another response; an earlier round is never
 * overwritten.
 *
 * @param {object} details department, data, and the conversation.
 * @throws {Error} When the organisation is finished, the department is missing,
 *   or the token yields no invitation, for either reason: unusable, or
 *   well-formed and unknown. The write paths throw where the read paths return
 *   nothing; see getResponsesByToken.
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

    // THE CONVERSATION IS STORED, and its absence is not an error. A response
    // without a transcript is still a valid answer from a caller that has none to
    // give, and refusing it would make the transcript mandatory for a reason
    // nobody asked for. What must not happen is a transcript silently dropped, so
    // a caller that supplies one gets it written, and lib/store/sqlite.js refuses
    // anything that is not an array rather than storing a surprise.
    return timedWrite(orgId, 'addResponse', () => sql.insertResponse(db, {
        id: sql.newId(),
        invitationId: invitation.id,
        department: department.trim(),
        data,
        transcript
    }));
}

/**
 * Replaces one round of a participant's answers.
 *
 * @returns {object} The updated response.
 * @throws {Error} When the organisation is finished, `responseId` is missing,
 *   the token yields no invitation (unusable or well-formed but unknown), or
 *   `responseId` is not this participant's. A well-formed unknown token throws
 *   to match addResponse; see getResponsesByToken for the read/write rule.
 *
 *   An id that belongs to someone else throws as well, rather than returning
 *   null. The message deliberately does not say whether the id exists beyond
 *   this participant's own rows, so the refusal does not confirm the existence
 *   of another participant's response.
 */
export function updateResponse(orgId, token, responseId, data) {
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

    return timedWrite(orgId, 'updateResponse', () => sql.updateResponseData(db, responseId, invitation.id, data));
}

/**
 * Responses for the roadmap, with attribution STRIPPED.
 *
 * No invitation id, no email, no join: the query does not select the link, so
 * the admin path cannot leak it. See the comment on the query in
 * lib/store/sqlite.js for the accepted trade-off around direct database access.
 */
export function getResponsesForAnalysis(orgId) {
    const db = requireConnection(orgId);
    return sql.selectResponsesForAnalysis(db);
}
