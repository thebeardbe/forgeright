/**
 * The participant's routes: the questionnaire reached by a link, the paste-a-token
 * form, and the self-service "lost my link".
 *
 * A PARTICIPANT LINK IS A CREDENTIAL. The token is resolved through the
 * installation-level index to an organisation and an invitation, and every store
 * call is then scoped to that organisation, so the participant never names a
 * tenant and there is nothing for them to tamper with.
 *
 * THE TOKEN IS THE CREDENTIAL, AND IT IS ENOUGH. A valid link starts the
 * questionnaire directly: there is no access code to enter, because the token is
 * already an unguessable single-purpose secret and asking for a second one that
 * was never sent to the participant is a dead end. The code gate remains only for
 * a tokenless visit to the questionnaire path.
 *
 * PATHS CARRY THE TOKEN: /q/<token>, not /?token=. It is not more private (both
 * appear in the request line and in a proxy log) but it is conventional, and it
 * leaves / free to be a landing page rather than "the questionnaire, sometimes".
 */
import express from 'express';
import {
    addResponse,
    getResponsesByToken,
    invitationForToken,
    ISSUED_BY,
    listInvitations,
    listOrganisationIds,
    resetAccess
} from '../store/index.js';
import { routeForParticipantToken } from '../token-index.js';
import { publicBaseUrl } from './public-base-url.js';
import { send as sendMail } from '../mail/index.js';
import { checkLoginRate } from './rate-limit.js';

export const router = express.Router();

/** A conservative address check, matching the admin login form. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Resolve a token to its organisation and invitation, or null.
 *
 * The organisation comes from the installation index, never from the request, so
 * a participant cannot choose a tenant. A token that resolves to nothing (never
 * issued, revoked, or expired) is refused before any organisation file is opened.
 *
 * @param {string} token
 * @returns {{ orgId: string, invitation: object }|null}
 */
function resolveParticipant(token) {
    if (typeof token !== 'string' || token === '') return null;

    const route = routeForParticipantToken(token);
    if (!route) return null;

    const invitation = invitationForToken(route.organisationId, token);
    if (!invitation) return null;

    return { orgId: route.organisationId, invitation };
}

/** Renders the questionnaire for a resolved participant. */
function renderQuestionnaire(req, res, token, resolved) {
    // strings, lang, toolId and supportedLangs come from res.locals, set once in
    // server.js, so only the participant-specific values are passed here.
    res.render('audit', {
        // The token is passed to the page so the client can post answers back.
        // It is already in the URL, so this reveals nothing new, and without it
        // answers could not be attributed.
        participantToken: token,
        // A valid token means the questionnaire starts immediately: see the note
        // at the top of this file.
        tokenResolved: true,
        // Existing work, so a returning participant resumes rather than starting
        // again. This is what a reset preserves.
        existingResponses: getResponsesByToken(resolved.orgId, token)
    });
}

/**
 * The questionnaire, with the token in the path.
 *
 * A token that resolves renders the questionnaire immediately. One that does not
 * shows the paste-a-token form with an explanation, because a mangled link is the
 * common case and the page that fixes it should be the one they see.
 */
router.get('/q/:token', (req, res) => {
    const token = String(req.params.token || '');
    const resolved = resolveParticipant(token);

    if (!resolved) {
        console.warn('[participant] a link was opened whose token resolves to nothing');
        return res.status(400).render('participant-token', {
            error: 'link_invalid',
            prefill: token
        });
    }

    return renderQuestionnaire(req, res, token, resolved);
});

/**
 * The paste-a-token form.
 *
 * For a mail client that strips or wraps the URL, which is how a participant ends
 * up here with a token and no working link.
 */
router.get('/q', (req, res) => {
    res.render('participant-token', { error: null, prefill: '' });
});

/** Accepts a pasted token and sends the participant to the questionnaire. */
router.post('/q', (req, res) => {
    const token = String(req.body?.token || '').trim();

    if (token === '') {
        return res.status(400).render('participant-token', { error: 'token_required', prefill: '' });
    }

    // A redirect rather than rendering here, so the token lands in one canonical
    // URL and the browser's back button behaves.
    return res.redirect(`${publicBaseUrl()}/q/${encodeURIComponent(token)}`);
});

/**
 * Records one answer from a participant.
 *
 * The organisation comes from the token, never from the request body, so a
 * participant cannot write into another organisation's file.
 */
router.post('/api/response', async (req, res) => {
    const { token, department, data } = req.body || {};
    const resolved = resolveParticipant(token);

    if (!resolved) {
        return res.status(403).json({ error: 'That link is not valid. Ask for a new one.' });
    }

    try {
        const response = addResponse(resolved.orgId, token, {
            department: department || resolved.invitation.department,
            data
        });
        return res.json({ ok: true, id: response.id });
    } catch (err) {
        // A finished questionnaire is the expected refusal, so it is reported
        // rather than looking like a fault.
        console.warn(`[participant] could not record a response: ${err.message}`);
        return res.status(409).json({ error: 'This questionnaire is closed and no longer accepts answers.' });
    }
});

/** The lost-my-link form. */
router.get('/lost-link', (req, res) => {
    res.render('participant-lost-link', { error: null, sent: false });
});

/**
 * The lost-my-link form.
 *
 * RESPONDS IDENTICALLY WHETHER OR NOT THE ADDRESS WAS EVER INVITED. A difference
 * would be a way to discover who has been invited, which is a list of employees
 * and their departments.
 *
 * A reset, not a re-send: it revokes every existing token for that invitation and
 * issues one new one. Mailing an existing link to whoever asked for it would hand
 * an attacker a live credential for any employee whose address they know.
 */
router.post('/lost-link', async (req, res) => {
    const email = String(req.body?.email || '').trim();

    const rate = checkLoginRate(req, email ? `lost:${email}` : 'lost:unknown');
    if (!rate.allowed) {
        res.set('Retry-After', String(rate.retryAfterSeconds));
        return res.status(429).render('participant-lost-link', { error: 'too_many_requests', sent: false });
    }

    if (!EMAIL_PATTERN.test(email)) {
        return res.status(400).render('participant-lost-link', { error: 'invalid_email', sent: false });
    }

    try {
        const issued = resetAccessForAddress(email);
        if (issued) {
            await sendMail({
                to: email,
                subject: 'Your forgeright questionnaire link',
                body: invitationMailBody({
                    link: issued.link,
                    token: issued.token,
                    department: issued.department,
                    intro: 'Here is a new link to the questionnaire.'
                })
            });
        }
    } catch (err) {
        // Logged, because a silent failure leaves the participant waiting for mail
        // that will never arrive. The RESPONSE is unchanged all the same: an error
        // only for invited addresses would leak the same list.
        console.error(`[participant] lost-link handling failed: ${err.message}`);
    }

    return res.render('participant-lost-link', { error: null, sent: true });
});

/**
 * Resets access for an address, across the organisations that could hold it.
 *
 * The address is not a key we can look up globally: invitations live in
 * organisation files. The installation index lists organisations, so each is
 * asked in turn. At this scale that is a short loop, and it keeps the isolation
 * property intact: no query spans two organisations.
 *
 * @returns {{ link: string, token: string, department: string }|null} Null when
 *   the address was never invited, which the caller must NOT distinguish.
 */
function resetAccessForAddress(email) {
    const normalised = email.toLowerCase();

    for (const orgId of listOrganisationIds()) {
        let invitations;
        try {
            invitations = listInvitations(orgId);
        } catch (err) {
            // One unreadable organisation must not stop the search, but it must
            // not be silent either: it could be the one holding this address.
            console.error(`[participant] could not read invitations for ${orgId}: ${err.message}`);
            continue;
        }

        const match = invitations.find((inv) => inv.email.toLowerCase() === normalised);
        if (!match) continue;

        const token = resetAccess(orgId, match.id, ISSUED_BY.PARTICIPANT);
        return { token, department: match.department, link: `${publicBaseUrl()}/q/${encodeURIComponent(token)}` };
    }

    console.info('[participant] no invitation matched the address given to the lost-link form');
    return null;
}

/**
 * The body of an invitation mail.
 *
 * THE TOKEN APPEARS AS PLAIN TEXT AS WELL AS IN THE LINK. Mail clients strip,
 * wrap and mangle URLs, which is how a participant ends up with a link that does
 * not work; a copyable token plus the paste page is the way back. The line saying
 * so is part of the body, not an afterthought.
 *
 * @param {object} details link, token, department and an opening line.
 * @returns {string}
 */
export function invitationMailBody({ link, token, department, intro }) {
    return [
        `${intro} It is the forgeright questionnaire for ${department}.`,
        '',
        'Open it here:',
        '',
        link,
        '',
        'If the link does not work, copy this code and paste it at the site:',
        '',
        token,
        '',
        'A later link replaces this one. Your answers are kept either way.'
    ].join('\n');
}
