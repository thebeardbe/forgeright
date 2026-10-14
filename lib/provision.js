/**
 * Turning a sign-in into a user with an organisation.
 *
 * This is the ONE place that joins the installation database (users) to an
 * organisation's file, and it is deliberate rather than accidental: a sign-in
 * cannot know which organisation it belongs to until it has looked the user up,
 * and the first sign-in has to create one. Both stores are reached by name
 * (`adminConnection` and the organisation API), each scoped by construction, so
 * nothing here can widen either.
 *
 * WHAT THIS MUST NOT DO: accept an organisation id from a request. The id comes
 * from the user row, which was written by this module, which is the only writer.
 * A caller provides an email and nothing else.
 */
import { createOrganisation, getOrganisation } from './store/index.js';
import { ROLES, addUserToOrganisation, findUserByEmail } from './users.js';

/**
 * The placeholder name for an organisation created by a first sign-in.
 *
 * Self-service, so there is nobody to ask for a real name at this point. The
 * console lets the admin edit it (see renameOrganisation), and the name is
 * derived from the address only so the console does not show a blank row.
 *
 * @param {string} email
 * @returns {string}
 */
function placeholderName(email) {
    const domain = email.includes('@') ? email.split('@').pop() : email;
    return `Organisation for ${domain}`;
}

/**
 * The user and organisation for a sign-in, creating both when the address is new.
 *
 * A KNOWN ADDRESS SIGNS IN TO ITS EXISTING ORGANISATION, so signing in twice lands in the same
 * place rather than creating a second tenant; an UNKNOWN one creates an organisation and becomes
 * its admin. It returns the same shape for both and never reveals which happened, because the
 * caller must not branch on it for anything the client can observe.
 *
 * @param {string} email
 * @returns {{ user: object, organisation: object, created: boolean }}
 * @throws {Error} When a user row points at an organisation whose file is missing.
 *   That is a half-deleted state, not a new user, and creating a second
 *   organisation for the same address would strand their data.
 */
export function resolveSignIn(email) {
    const existing = findUserByEmail(email);

    if (existing) {
        const organisation = getOrganisation(existing.organisation_id);
        if (!organisation) {
            console.error(
                `[provision] ${existing.email} belongs to organisation ${existing.organisation_id}, ` +
                'but that organisation has no file. Refusing to create a replacement.'
            );
            throw new Error(
                `The organisation for ${existing.email} is missing from the store. It was not recreated, ` +
                'because that would strand any existing data under a new id.'
            );
        }
        return { user: existing, organisation, created: false };
    }

    // A new address: make the organisation first, because the user row needs its
    // id, and a user without an organisation is a state nothing else can use.
    const organisation = createOrganisation(placeholderName(email));
    const { user } = addUserToOrganisation({
        organisationId: organisation.id,
        email,
        role: ROLES.ADMIN
    });

    console.info(
        `[provision] first sign-in created organisation ${organisation.id} and its admin (${user.email})`
    );
    return { user, organisation, created: true };
}

/**
 * The user for an address, or null. Exposed so the login route can decide
 * whether the address may reach the console AFTER the response has been chosen,
 * which keeps the response identical either way.
 *
 * @param {string} email
 * @returns {object|null}
 */
export function userForEmail(email) {
    return findUserByEmail(email);
}
