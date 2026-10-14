/**
 * The store's public interface.
 *
 * EVERY METHOD TAKES AN ORG ID FIRST, so "which tenant is this?" is a required argument rather than
 * something a route can forget. The isolation itself lives in lib/store/registry.js: one SQLite
 * file per organisation, and that module alone opens a connection.
 *
 * NO DATA IS A NULL OR AN EMPTY ARRAY; CANNOT COMPUTE IS AN EXCEPTION OR A LOGGED REFUSAL. The two
 * are never conflated.
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
 * THE ID IS GENERATED HERE BY DEFAULT - a random UUID, so it matches the safe-path pattern by
 * construction and never comes from user input. `orgId` IS AN OPTIONAL OVERRIDE for the one caller
 * that needs a predictable file name: the demo seed, whose database is committed and shipped, so
 * its id has to be a constant configuration can name.
 *
 * A SUPPLIED ID GOES THROUGH THE SAME PATH AS A GENERATED ONE. `connectionFor` calls
 * `assertSafeOrgId` before it builds a path or opens a file, so an id that is not a single safe path
 * component throws there and cannot reach the filesystem - which is why the override does not
 * weaken the invariant it sits next to.
 */
export function createOrganisation(name, orgId = null) {
    if (typeof name !== 'string' || name.trim() === '') {
        throw new Error('createOrganisation requires a non-empty name.');
    }

    // Generated here so it matches the safe-path pattern by construction. A supplied
    // id is checked by `connectionFor` below, on the same path, rather than by a
    // second check here that could drift from the store's own rule.
    const id = orgId === null ? randomUUID() : orgId;
    const safeId = assertSafeOrgId(id);
    // mayCreate: this is the ONE path allowed to bring a database file into
    // existence. Everything else reads an organisation that is already there.
    //
    // `connectionFor` re-runs `assertSafeOrgId`, so the check above is for the ERROR
    // rather than for safety - a caller passing a bad id gets the store's own message
    // here instead of a confusing failure further down.
    const db = connectionFor(safeId, { mayCreate: true });

    if (sql.selectOrganisation(db)) {
        throw new Error(`Organisation ${safeId} already exists.`);
    }

    const organisation = sql.insertOrganisation(db, { id: safeId, name: name.trim() });
    console.info(`[store] created organisation ${safeId} at ${orgDbPath(safeId)}`);
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
 * AN UNUSABLE TOKEN RETURNS `[]`, the same as a valid-form token matching nothing: a missing
 * `?token=` is routine and must not become a 500 on a read.
 *
 * READS RETURN NOTHING FOR A TOKEN THAT YIELDS NO INVITATION; THE WRITE PATHS THROW. A write with no
 * valid credential is a caller error, and a returned null is a silent failure a caller has to
 * remember to check. The divergence is read versus write, not one spelling of a bad token.
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
 * Records one FINISHED process a participant described.
 *
 * Appends a new row. A participant describing a second process, or a second
 * round of the questionnaire, adds another response; an earlier round is never
 * overwritten.
 *
 * THE ROUND IS FINALISED HERE (`submitted_at` set), because this function is for data
 * that is already complete: a seed, an import, a fixture. A round that is still being
 * filled in belongs to `recordTurn`, which upserts the open round and finalises it from
 * `status: complete`. Inserting through this function produces a row that the roadmap
 * counts, so use it only for a rounded-off answer.
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

    // AN ABSENT TRANSCRIPT IS NOT AN ERROR: a response without one is still a valid answer, and
    // refusing it would make the transcript mandatory for no reason. It is never silently dropped -
    // sqlite.js refuses anything that is not an array rather than storing a surprise.
    //
    // FINALISED ON INSERT, because this function is for a COMPLETED round. Storing it as partial
    // would make it invisible to every analysis path, since `submitted_at` null means a round still
    // in progress and the roadmap excludes those.
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

    // THE TRANSCRIPT IS FORWARDED WHEN SUPPLIED, and omitted when not, so an update
    // from a caller with no conversation keeps the stored one rather than blanking it.
    // See updateResponseData for why an update that ignored the transcript would lose
    // everything said after the first save.
    return timedWrite(orgId, 'updateResponse', () =>
        sql.updateResponseData(db, responseId, invitation.id, data, transcript));
}

/**
 * Records one turn of an interview against the round it belongs to.
 *
 * THE SERVER DECIDES WHICH ROUND A TURN BELONGS TO. The client sends its whole accumulating payload
 * every turn and never tracks a round id - a client that chose the round could write into a
 * finalised one, and the round boundary is something the MODEL decided (`status: complete` in
 * ai/audit-core.js) rather than something the page knows.
 *
 * THREE CASES: no open round and nothing finished yet inserts one; an open round is updated in
 * place; and no open round WITH `complete` inserts a round and finalises it immediately, because
 * the reply that finished it is this one. That last case is what makes the ordering safe - the reply
 * carries the closing question, so the round is on disk as finished BEFORE the participant can
 * answer it, and there is no window in which a finished process is unsaved.
 *
 * THE PAYLOAD IS STORED AS THE MODEL SENT IT, NOT SCOPED TO THE NEW PROCESS: it carries every
 * process described so far, because that is the object the matrix validated and scoring reads. The
 * consequence is that an earlier process appears in more than one round, so identification runs
 * over it again - `alreadyIdentified` in lib/auth/identify-response.js is the guard that declines
 * rather than paying for that. Storing the full payload keeps each row self-contained, which is what
 * lets the console show a partial round at all.
 *
 * @param {object} args
 * @param {string} args.data The payload, as the model produced it.
 * @param {Array} [args.transcript] The whole conversation so far.
 * @param {boolean} [args.complete] Whether the reply that produced this data was
 *   `complete`, meaning the round is finished.
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
            // Case 2: continue the round that is already open.
            const updated = sql.updateResponseData(db, open.id, invitation.id, data, transcript);
            if (!updated) {
                // The round vanished between the read and the write. Nothing sensible
                // to fall back to: report it rather than silently starting a new round,
                // which would look like the participant's work had been reset.
                throw new Error(`The open round for invitation ${invitation.id} disappeared mid-write.`);
            }
            return complete
                ? sql.markResponseSubmitted(db, open.id, invitation.id)
                : updated;
        }

        // Cases 1 and 3: there is no round to continue, so this turn begins one.
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
 * FINALISED responses for the roadmap, with attribution STRIPPED.
 *
 * PARTIAL ROUNDS ARE EXCLUDED, and that is the product decision rather than an
 * oversight: a round the participant has not finished is visible in the answers view
 * and contributes NOTHING to the roadmap - not to sorting, and so not to scoring, in
 * the owner's words. The exclusion is in the query, so a caller cannot forget it; see
 * selectResponsesForAnalysis in lib/store/sqlite.js.
 *
 * The consequence worth knowing: a participant who abandons an interview produces a row
 * that never reaches a process. Their answers are kept and readable, and no score is
 * computed from work they did not finish.
 *
 * No invitation id, no email, no join: the query does not select the link, so
 * the admin path cannot leak it. See the comment on the query in
 * lib/store/sqlite.js for the accepted trade-off around direct database access.
 */
export function getResponsesForAnalysis(orgId) {
    const db = requireConnection(orgId);
    return sql.selectResponsesForAnalysis(db);
}

/**
 * Every response, PARTIAL ROUNDS INCLUDED, for the answers view.
 *
 * The accessor for showing what a participant actually said, finished or not. A partial
 * carries whatever `data` it had and the conversation up to the last turn, so a reader
 * can see where somebody stopped.
 *
 * WHICH ROWS ARE PARTIAL IS `submitted_at === null`, and callers must say so rather than
 * letting a partial look finished - a half-completed interview presented like a
 * completed one is worse than one that is missing, because it reads as a real answer.
 */
export function getAllResponses(orgId) {
    const db = requireConnection(orgId);
    return sql.selectAllResponses(db);
}
