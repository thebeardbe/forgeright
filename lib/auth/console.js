/**
 * The admin console: scoped to the session's organisation, always.
 *
 * THE ORGANISATION COMES FROM THE SESSION, NEVER FROM THE REQUEST. That is the
 * one rule this file exists to hold. The organisation id is read from the user
 * row the session's email points at, so there is no parameter, query string or
 * body field a client could supply to name a tenant. A route that took an id from
 * the request would be the one mistake in this design that shows a client another
 * client's data, which is why resolution lives in ONE function that every console
 * route calls rather than being repeated per route.
 */
import express from 'express';
import { withBasePath } from '../base-path.js';
import {
    addInvitation,
    getOrganisation,
    ISSUED_BY,
    issueAdditionalLink,
    listInvitations,
    renameOrganisation,
    resetAccess
} from '../store/index.js';
import { addUserToOrganisation, findUserByEmail, listUsersForOrganisation, ROLES, setUserRole } from '../users.js';
import { publicBaseUrl } from './public-base-url.js';
import { invitationMailBody } from './participant-routes.js';
import { send as sendMail } from '../mail/index.js';
import { router as viewsRouter } from './console-views.js';

/** A conservative address check, matching the login form. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The user and organisation for a session, or a thrown refusal.
 *
 * The SINGLE place a console route gets its organisation. Callers pass only the
 * session, so an organisation id cannot arrive from anywhere else, and a route
 * added later cannot forget the scoping because it has no other way to learn the
 * tenant.
 *
 * @param {object} session The session from requireSession.
 * @returns {{ user: object, organisation: object }}
 * @throws {Error} When the session names no user, or the user's organisation is
 *   missing. Both are faults, not empty results: showing an empty console would
 *   hide a broken relationship.
 */
export function scopeForSession(session) {
    if (!session || typeof session.email !== 'string' || session.email === '') {
        throw new Error('A session is required to resolve an organisation.');
    }

    const user = findUserByEmail(session.email);
    if (!user) {
        throw new Error(`No user for ${session.email}; the session outlived its account.`);
    }

    const organisation = getOrganisation(user.organisation_id);
    if (!organisation) {
        throw new Error(
            `The organisation for ${session.email} is missing from the store, so the console cannot ` +
            'show anything. This is a data fault, not an empty organisation.'
        );
    }

    return { user, organisation };
}

/**
 * Guards a console route: resolves the scope, or redirects to the login page.
 *
 * A user whose role is `user` signs in but does NOT get the console, so they are
 * refused here rather than shown a page with everything hidden.
 */
export function requireConsole(req, res, next) {
    let scope;
    try {
        scope = scopeForSession(req.session);
    } catch (err) {
        console.error(`[console] refusing: ${err.message}`);
        return res.redirect(withBasePath('/admin/login'));
    }

    if (scope.user.role !== ROLES.ADMIN) {
        console.warn(`[console] ${scope.user.email} has role ${scope.user.role} and no console access`);
        return res.status(403).render('admin-no-access', { email: scope.user.email });
    }

    req.console = scope;
    return next();
}

export const router = express.Router();

/**
 * The console page.
 *
 * Everything shown is queried with `req.console.organisation.id`, which came from
 * the session. Nothing here reads an organisation from the request.
 */
/**
 * The console page.
 *
 * Everything shown is queried with `req.console.organisation.id`, which came from
 * the session. Nothing here reads an organisation from the request.
 */
router.get('/', (req, res) => {
    const { user, organisation } = req.console;

    res.render('admin-console', {
        email: user.email,
        role: user.role,
        expiresAt: req.session.expiresAt,
        organisation,
        invitations: listInvitations(organisation.id),
        users: listUsersForOrganisation(organisation.id)
    });
});

/**
 * The two views and the rejudge they share, MOUNTED UNDER THIS ROUTER.
 *
 * Mounted here rather than in server.js so they inherit the guards above: every
 * route in console-views.js is behind requireSession and requireConsole, and
 * `req.console` carries the organisation from the session. A view added later
 * cannot forget the scoping because it has no other way to learn the tenant.
 */
router.use('/', viewsRouter);

/** Renames the session's organisation. The name is a placeholder until now. */
router.post('/organisation/name', (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (name === '') {
        return res.status(400).json({ error: 'A name is required.' });
    }

    // The id is the session's, so this cannot rename another organisation.
    try {
        renameOrganisation(req.console.organisation.id, name);
    } catch (err) {
        console.error(`[console] rename failed: ${err.message}`);
        return res.status(400).json({ error: err.message });
    }

    return res.redirect(withBasePath('/admin'));
});

/** Invites a participant, and sends them the link. */
router.post('/invitations', async (req, res) => {
    const email = String(req.body?.email || '').trim();
    const department = String(req.body?.department || '').trim();

    if (!EMAIL_PATTERN.test(email) || department === '') {
        return res.status(400).render('admin-console-error', {
            message: 'An invitation needs a valid email address and a department.'
        });
    }

    const invitation = addInvitation(req.console.organisation.id, { email, department });

    try {
        await sendInvitationMail({
            to: email,
            department,
            token: invitation.token,
            intro: 'You are invited to the questionnaire.'
        });
    } catch (err) {
        console.error(`[console] invitation created but not sent: ${err.message}`);
        return res.status(502).render('admin-console-error', {
            message: 'The invitation was created, but the message could not be sent. Try Send a link on it.'
        });
    }

    return res.redirect(withBasePath('/admin'));
});

/**
 * Sends another link for an invitation, leaving existing ones live.
 *
 * THE CONSOLE'S "SEND A LINK". The participant may simply have missed the first
 * message, so nothing is invalidated: a link they already hold keeps working, and
 * the new mail is an addition rather than a replacement. That is the difference
 * between this action and Reset all access, and it is why the two are separate
 * buttons rather than one.
 */
router.post('/invitations/:id/send', async (req, res) => {
    const invitations = listInvitations(req.console.organisation.id);
    const invitation = invitations.find((i) => i.id === req.params.id);

    if (!invitation) {
        return res.status(404).render('admin-console-error', { message: 'No such invitation.' });
    }

    let token;
    try {
        token = issueAdditionalLink(req.console.organisation.id, invitation.id);
    } catch (err) {
        console.error(`[console] could not issue a link: ${err.message}`);
        return res.status(500).render('admin-console-error', { message: 'A link could not be issued.' });
    }

    try {
        await sendInvitationMail({
            to: invitation.email,
            department: invitation.department,
            token,
            intro: 'Here is a link to the questionnaire.'
        });
    } catch (err) {
        console.error(`[console] link issued but not sent: ${err.message}`);
        return res.status(502).render('admin-console-error', {
            message: 'A link was issued, but the message could not be sent. Try Send a link again.'
        });
    }

    return res.redirect(withBasePath('/admin'));
});

/**
 * Resets all access for an invitation: every token revoked, one new link.
 *
 * The second of the two reset actions, and the SAME OPERATION as the
 * participant's "Lost my link" (see resetAccess in lib/store/invitations.js).
 * They differ only in who may ask: this one requires a session, and the
 * participant's requires an email address. Both revoke the lot, so a link that
 * was shared or exposed stops working when either runs.
 *
 * The invitation id is untouched, so every answer already given stays attached.
 */
router.post('/invitations/:id/reset', async (req, res) => {
    const invitations = listInvitations(req.console.organisation.id);
    const invitation = invitations.find((i) => i.id === req.params.id);

    if (!invitation) {
        return res.status(404).render('admin-console-error', { message: 'No such invitation.' });
    }

    let token;
    try {
        token = resetAccess(req.console.organisation.id, invitation.id, ISSUED_BY.ADMIN);
    } catch (err) {
        console.error(`[console] could not reset access: ${err.message}`);
        return res.status(500).render('admin-console-error', { message: 'Access could not be reset.' });
    }

    try {
        await sendInvitationMail({
            to: invitation.email,
            department: invitation.department,
            token,
            intro: 'Here is a new link to the questionnaire. Any earlier link has stopped working.'
        });
    } catch (err) {
        console.error(`[console] access reset but the link was not sent: ${err.message}`);
        return res.status(502).render('admin-console-error', {
            message: 'Access was reset, but the new link could not be sent. Try Reset all access again.'
        });
    }

    return res.redirect(withBasePath('/admin'));
});

/** Adds a user to this organisation, so access can be prepared before they sign in. */
router.post('/users', (req, res) => {
    const email = String(req.body?.email || '').trim();
    const role = String(req.body?.role || ROLES.USER);

    if (!EMAIL_PATTERN.test(email)) {
        return res.status(400).render('admin-console-error', { message: 'A valid email address is required.' });
    }

    try {
        // The organisation is the session's, so this cannot add a user elsewhere.
        addUserToOrganisation({ organisationId: req.console.organisation.id, email, role });
    } catch (err) {
        console.error(`[console] could not add a user: ${err.message}`);
        return res.status(400).render('admin-console-error', { message: err.message });
    }

    return res.redirect(withBasePath('/admin'));
});

/** Promotes or demotes a user in this organisation. */
router.post('/users/:id/role', (req, res) => {
    const role = String(req.body?.role || '');

    try {
        setUserRole({
            organisationId: req.console.organisation.id,
            userId: req.params.id,
            role
        });
    } catch (err) {
        console.error(`[console] role change refused: ${err.message}`);
        return res.status(400).render('admin-console-error', { message: err.message });
    }

    return res.redirect(withBasePath('/admin'));
});

/**
 * Mails an invitation link.
 *
 * The link is built from PUBLIC_BASE_URL, so it points at the externally visible
 * address exactly like the admin sign-in link does, and carries the public path.
 */
async function sendInvitationMail({ to, department, token, intro }) {
    const link = `${publicBaseUrl()}/q/${encodeURIComponent(token)}`;

    await sendMail({
        to,
        subject: 'Your forgeright questionnaire',
        // One builder for every invitation mail, in the participant module, so the
        // link, the copyable token and the paste instructions cannot differ between
        // the first invitation and a later one.
        body: invitationMailBody({ link, token, department, intro })
    });
}