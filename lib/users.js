/**
 * People who may sign in to the console, and the organisation each belongs to.
 *
 * In the installation database, because sign-in happens before an organisation is known. The
 * organisation id is never a request value: every function takes it from a caller that got it from the
 * session.
 *
 * The roles are `admin` and `user`, identical today; the column exists because adding it later would be a
 * migration.
 */
import { randomUUID } from 'node:crypto';
import { adminConnection } from './store/registry.js';

/** Roles a user row may hold. Validated here so the error names the problem. */
export const ROLES = Object.freeze({ ADMIN: 'admin', USER: 'user' });

/** Every role, in one place, so a check and a message cannot disagree. */
const VALID_ROLES = Object.freeze([ROLES.ADMIN, ROLES.USER]);

/**
 * Count of sign-in attempts logged, so the noise is bounded but the record
 * exists. Not a security control; the rate limiter is.
 */
function nowIso() {
    return new Date().toISOString();
}

/** Fails loudly on a role this system does not use. A programming error. */
function assertValidRole(role) {
    if (!VALID_ROLES.includes(role)) {
        throw new Error(
            `Unknown role ${JSON.stringify(role)}. Expected one of: ${VALID_ROLES.join(', ')}.`
        );
    }
    return role;
}

/** Normalises an address for storage and lookup, so case cannot split one person in two. */
function normaliseEmail(email) {
    if (typeof email !== 'string' || email.trim() === '') {
        throw new Error('A user requires a non-empty email address.');
    }
    return email.trim().toLowerCase();
}

/**
 * The user for an address, or null.
 *
 * Case-insensitive, so a capital letter does not create a second organisation.
 *
 * @param {string} email
 * @returns {object|null}
 */
export function findUserByEmail(email) {
    const normalised = normaliseEmail(email);
    const db = adminConnection();

    return db.prepare(
        'SELECT id, organisation_id, email, role, created_at, updated_at FROM users WHERE email = ?'
    ).get(normalised) ?? null;
}

/**
 * The user for an id, or null.
 *
 * @param {string} userId
 * @returns {object|null}
 */
export function findUserById(userId) {
    if (typeof userId !== 'string' || userId === '') return null;
    const db = adminConnection();

    return db.prepare(
        'SELECT id, organisation_id, email, role, created_at, updated_at FROM users WHERE id = ?'
    ).get(userId) ?? null;
}

/**
 * Every user in one organisation. The organisation id is a required first argument, so a caller cannot list
 * users without naming the tenant.
 *
 * @param {string} organisationId
 * @returns {object[]}
 */
export function listUsersForOrganisation(organisationId) {
    if (typeof organisationId !== 'string' || organisationId === '') {
        throw new Error('listUsersForOrganisation requires an organisation id.');
    }
    const db = adminConnection();

    return db.prepare(
        `SELECT id, organisation_id, email, role, created_at, updated_at
         FROM users WHERE organisation_id = ? ORDER BY created_at, email`
    ).all(organisationId);
}

/**
 * Adds a user to an organisation, or returns the existing one. It refuses to move an existing user into a
 * different organisation, because an address belongs to one organisation.
 *
 * @param {object} details organisationId, email and role.
 * @returns {{ user: object, created: boolean }}
 */
export function addUserToOrganisation({ organisationId, email, role = ROLES.USER }) {
    if (typeof organisationId !== 'string' || organisationId === '') {
        throw new Error('addUserToOrganisation requires an organisation id.');
    }
    assertValidRole(role);

    const normalised = normaliseEmail(email);
    const existing = findUserByEmail(normalised);

    if (existing) {
        if (existing.organisation_id !== organisationId) {
            throw new Error(
                `${normalised} already belongs to a different organisation. A user belongs to one ` +
                'organisation; move them deliberately if that is intended, rather than by adding them again.'
            );
        }
        return { user: existing, created: false };
    }

    const at = nowIso();
    const user = {
        id: randomUUID(),
        organisation_id: organisationId,
        email: normalised,
        role,
        created_at: at,
        updated_at: at
    };

    const db = adminConnection();
    db.prepare(
        `INSERT INTO users (id, organisation_id, email, role, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
    ).run(user.id, user.organisation_id, user.email, user.role, at, at);

    console.info(`[users] added ${normalised} to organisation ${organisationId} as ${role}`);
    return { user, created: true };
}

/**
 * Changes a user's role within their own organisation. The organisation id is checked against the row, so
 * this cannot promote somebody in another tenant.
 *
 * @param {object} details organisationId, userId and role.
 * @returns {object} The updated user.
 * @throws {Error} When the user is unknown, in another organisation, or last admin.
 */
export function setUserRole({ organisationId, userId, role }) {
    assertValidRole(role);
    if (typeof organisationId !== 'string' || organisationId === '') {
        throw new Error('setUserRole requires an organisation id.');
    }

    const user = findUserById(userId);
    if (!user) {
        throw new Error(`No user ${JSON.stringify(userId)}.`);
    }
    if (user.organisation_id !== organisationId) {
        // Does not say which organisation the user is in, so the refusal cannot be
        // used to map users to tenants.
        console.warn(`[users] refused a role change for a user outside organisation ${organisationId}`);
        throw new Error('That user is not in this organisation.');
    }

    // Refuse to remove the last admin, which would leave the organisation with
    // nobody able to manage it and no route back in the console.
    if (user.role === ROLES.ADMIN && role !== ROLES.ADMIN) {
        const others = listUsersForOrganisation(organisationId)
            .filter((u) => u.role === ROLES.ADMIN && u.id !== user.id);
        if (others.length === 0) {
            throw new Error(
                'Refusing to demote the last admin: the organisation would have nobody able to manage it.'
            );
        }
    }

    const db = adminConnection();
    db.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?')
        .run(role, nowIso(), user.id);

    console.info(`[users] set ${user.email} to ${role}`);
    return findUserById(user.id);
}

/**
 * True when an address already has an account. It must not change what the login route responds with,
 * because that response is deliberately identical for a known and an unknown address.
 *
 * @param {string} email
 * @returns {boolean}
 */
export function userExists(email) {
    return findUserByEmail(email) !== null;
}
