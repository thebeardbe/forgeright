/**
 * Validates a transcript supplied by the browser: shape only, not content, because the content is the
 * participant's own words and screening again here would be a second rule able to disagree.
 *
 * An absent transcript is accepted as `undefined` and an empty array is accepted too, while a present but
 * malformed one is refused, because storing it would throw in the database layer or produce a transcript
 * the console cannot render.
 *
 * @param {*} transcript
 * @returns {{ ok: true, transcript: Array<object>|undefined }|{ ok: false, reason: string }}
 */
function checkTranscript(transcript) {
    if (transcript === undefined || transcript === null) return { ok: true, transcript: undefined };

    if (!Array.isArray(transcript)) {
        return { ok: false, reason: 'it must be an array of messages' };
    }

    const badIndex = transcript.findIndex((turn) => !turn
        || typeof turn !== 'object'
        || Array.isArray(turn)
        || typeof turn.role !== 'string'
        || turn.role.trim() === ''
        || typeof turn.content !== 'string');

    if (badIndex !== -1) {
        return { ok: false, reason: `message ${badIndex + 1} has no role and content` };
    }

    return { ok: true, transcript };
}

/**
 * The participant's routes: the questionnaire reached by a link, the paste-a-token form, and the
 * self-service "lost my link".
 *
 * A participant link is a credential: the token resolves through the installation-level index to an
 * organisation and an invitation, and every store call is scoped to that organisation, so the participant
 * never names a tenant.
 *
 * There is no access code, because the token is already an unguessable single-purpose secret, and paths
 * carry the token (`/q/<token>`) rather than a query string.
 */
import express from 'express';
import {
    recordTurn,
    getResponsesByToken,
    invitationForToken,
    ISSUED_BY,
    listInvitations,
    listOrganisationIds,
    resetAccess
} from '../store/index.js';
import { routeForParticipantToken } from '../token-index.js';
import { identifyFinishedResponse } from './identify-response.js';
import { publicBaseUrl } from './public-base-url.js';
import { send as sendMail } from '../mail/index.js';
import { checkLoginRate } from './rate-limit.js';

export const router = express.Router();

/** A conservative address check, matching the admin login form. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Resolve a token to its organisation and invitation, or null. The organisation comes from the installation
 * index, never from the request, and a token that resolves to nothing is refused before any organisation
 * file is opened.
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
    // strings, lang, toolId and supportedLangs come from res.locals, set once in server.js.
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
 * The questionnaire, with the token in the path. A token that resolves renders it, and one that does not
 * shows the paste-a-token form, because a mangled link is the common case.
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
 * The paste-a-token form, for a mail client that strips or wraps the URL.
 *
 * It must check a token in the query string, because the form submits with GET and a pasted token arrives
 * here as `?token=...`.
 *
 * It redirects rather than rendering, so the token lands on the canonical `/q/<token>` URL the POST path
 * uses and both go through the same code path, where the indistinguishable-message rule lives.
 */
router.get('/q', (req, res) => {
    const token = String(req.query?.token || '').trim();

    // An empty submission is the form's own `required` failing, so ask again rather than refuse.
    if (token === '') {
        return res.render('participant-token', { error: null, prefill: '' });
    }

    return res.redirect(`${publicBaseUrl()}/q/${encodeURIComponent(token)}`);
});

/** Accepts a pasted token and sends the participant to the questionnaire. */
router.post('/q', (req, res) => {
    const token = String(req.body?.token || '').trim();

    if (token === '') {
        return res.status(400).render('participant-token', { error: 'token_required', prefill: '' });
    }

    // A redirect so the token lands in one canonical URL and the back button behaves.
    return res.redirect(`${publicBaseUrl()}/q/${encodeURIComponent(token)}`);
});

/**
 * Records one answer from a participant, with the conversation that produced it. The organisation comes
 * from the token, never the request body. The transcript is accepted from the client, because the browser
 * is the only thing that has it, and is checked for shape since it ends up stored.
 */
router.post('/api/response', async (req, res) => {
    // `department` is not read from the body: `recordTurn` takes it from the invitation the token
    // resolves to, so a body field could only overwrite it.
    const { token, data, transcript, complete } = req.body || {};
    const resolved = resolveParticipant(token);

    if (!resolved) {
        return res.status(403).json({ error: 'That link is not valid. Ask for a new one.' });
    }

    // Refused rather than dropped: storing the answers without the conversation would leave a gap
    // nothing afterwards could detect.
    const checkedTranscript = checkTranscript(transcript);
    if (!checkedTranscript.ok) {
        console.warn(`[participant] refusing a response with a bad transcript: ${checkedTranscript.reason}`);
        return res.status(400).json({ error: `The conversation could not be read: ${checkedTranscript.reason}` });
    }

    // The round is finalised from the client's `complete` flag, which the client sets from `status:
    // "complete"` in the model's reply, so "this process is done" is never the page's opinion.
    //
    // `=== true` rather than a truthy test, so a stray string cannot finalise a round by accident.
    const isComplete = complete === true;

    try {
        const response = recordTurn(resolved.orgId, token, {
            data,
            transcript: checkedTranscript.transcript,
            complete: isComplete
        });

        // Not awaited: it is a model call that takes seconds while the participant waits for this turn's
        // reply. It catches its own failures, and the answers are already saved above, so an interruption
        // leaves "not yet read" rather than a lost answer.
        //
        // Complete rounds only: grouping a half-written round would build a process from evidence the next
        // turn contradicts.
        if (isComplete) {
            void identifyFinishedResponse({
                orgId: resolved.orgId,
                response,
                // From res.locals, set once per request by server.js.
                lang: typeof res.locals?.lang === 'string' && res.locals.lang !== ''
                    ? res.locals.lang
                    : 'en'
            });
        }

        return res.json({
            ok: true,
            id: response.id,
            complete: isComplete,
            submittedAt: response.submitted_at,
            transcriptMessages: response.transcript?.length ?? 0
        });
    } catch (err) {
        // The expected refusal for a finished questionnaire, reported rather than looking like a fault.
        console.warn(`[participant] could not record a response: ${err.message}`);
        return res.status(409).json({ error: 'This questionnaire is closed and no longer accepts answers.' });
    }
});

/** The lost-my-link form. */
router.get('/lost-link', (req, res) => {
    res.render('participant-lost-link', { error: null, sent: false });
});

/**
 * The lost-my-link form, responding identically whether or not the address was ever invited, because a
 * difference would reveal who has been invited.
 *
 * A reset rather than a re-send: mailing an existing link to whoever asked would hand out a live credential
 * for any employee whose address is known.
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
        // Logged, because a silent failure leaves the participant waiting for mail that never arrives, while
        // the response stays unchanged: an error only for invited addresses would leak the same list.
        console.error(`[participant] lost-link handling failed: ${err.message}`);
    }

    return res.render('participant-lost-link', { error: null, sent: true });
});

/**
 * Resets access for an address, across the organisations that could hold it: invitations live in
 * organisation files, so each is asked in turn, which keeps the isolation property intact because no query
 * spans two organisations.
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
            // One unreadable organisation must not stop the search, and could be the one holding this
            // address.
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
 * The body of an invitation mail. The token appears as plain text as well as in the link, because mail
 * clients mangle URLs and the paste page needs a copyable token.
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
