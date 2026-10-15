/**
 * Turning a sign-in into a user with an organisation: the one place that joins the installation database to
 * an organisation's file, because a sign-in cannot know which organisation it belongs to until it has looked
 * the user up.
 *
 * Nothing here accepts an organisation id from a request: the id comes from the user row this module writes,
 * and a caller provides an email and nothing else.
 */
import { createOrganisation, getOrganisation } from './store/index.js';
import { ROLES, addUserToOrganisation, findUserByEmail } from './users.js';

/**
 * The placeholder name for an organisation created by a first sign-in, derived from the address so the
 * console does not show a blank row; the admin edits it in the console.
 *
 * @param {string} email
 * @returns {string}
 */
function placeholderName(email) {
    const domain = email.includes('@') ? email.split('@').pop() : email;
    return `Organisation for ${domain}`;
}

/**
 * The user and organisation for a sign-in, creating both when the address is new: a known address signs in
 * to its existing organisation, an unknown one creates an organisation. It returns the same shape for both,
 * because the caller must not branch on it for anything the client can observe.
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
 * The user for an address, or null. Exposed so the login route can decide access after the response has been
 * chosen, which keeps it identical either way.
 *
 * @param {string} email
 * @returns {object|null}
 */
export function userForEmail(email) {
    return findUserByEmail(email);
}
