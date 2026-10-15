/**
 * Validates a transcript supplied by the browser.
 *
 * SHAPE, NOT CONTENT. Each turn needs a `role` and a string `content`, which is all the store and
 * the console read. The content is NOT inspected: it is the participant's own words, the guardrails
 * ran as each turn was sent, and screening again here would be a second rule able to disagree.
 *
 * AN ABSENT transcript is ACCEPTED as `undefined`, so a caller with none is not blocked, and an
 * EMPTY array is accepted too - "this conversation had no turns" differs from "no transcript".
 * A present but MALFORMED one is refused, because storing it would throw in the database layer or
 * produce a transcript the console cannot render.
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
 * The participant's routes: the questionnaire reached by a link, the paste-a-token
 * form, and the self-service "lost my link".
 *
 * A PARTICIPANT LINK IS A CREDENTIAL. The token resolves through the installation-level index to
 * an organisation and an invitation, and every store call is scoped to that organisation, so the
 * participant never names a tenant and there is nothing for them to tamper with.
 *
 * NO ACCESS CODE. A valid link starts the questionnaire directly: the token is already an
 * unguessable single-purpose secret, so a second secret that was never sent to the participant is
 * a dead end.
 *
 * PATHS CARRY THE TOKEN: /q/<token>, not /?token=. Not more private - both appear in a proxy log -
 * but conventional, and it leaves / free to be a landing page.
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
 *
 * A TOKEN IN THE QUERY STRING IS CHECKED HERE, AND IT WAS NOT. The form below submits with GET, so
 * a pasted token arrived as `?token=...` on THIS route, which ignored it and re-rendered with
 * `error: null` - so a wrong code looked exactly like a fresh visit. MEASURED:
 * `/q?token=fsfdasdfasdf` answered 200 with no problem block anywhere.
 *
 * IT REDIRECTS RATHER THAN RENDERING, so the token lands on the canonical `/q/<token>` URL the POST
 * path uses: a working token gets the questionnaire, an unusable one the refusal page, and both go
 * through the SAME code path - which is where the indistinguishable-message rule lives.
 */
router.get('/q', (req, res) => {
    const token = String(req.query?.token || '').trim();

    // AN EMPTY SUBMISSION IS THE FORM'S OWN `required` FAILING, not a refusal: the browser
    // normally blocks it, and a caller that got past that needs to be asked again rather than
    // told their code is wrong.
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

    // A redirect rather than rendering here, so the token lands in one canonical
    // URL and the browser's back button behaves.
    return res.redirect(`${publicBaseUrl()}/q/${encodeURIComponent(token)}`);
});

/**
 * Records one answer from a participant, with the conversation that produced it.
 *
 * The organisation comes from the token, never from the request body, so a
 * participant cannot write into another organisation's file.
 *
 * THE TRANSCRIPT IS ACCEPTED FROM THE CLIENT, because the browser is the only
 * thing that has it: the conversation runs there, and the server sees one answer
 * at a time. It is checked for shape here rather than trusted, since it is
 * client-supplied text that ends up stored.
 *
 * THE `lang` COMES FROM `res.locals`, which server.js sets once per request from the same value
 * the page renders in. Reading a local `lang` here is `undefined` - this route never destructures
 * one - and every identification would then be made in English regardless of the interview's.
 */
router.post('/api/response', async (req, res) => {
    // `department` IS NO LONGER READ FROM THE BODY. `recordTurn` takes it from the
    // invitation the token resolves to, which is the value the invitation was issued
    // with; a body field could only ever be a way for a client to overwrite it.
    const { token, data, transcript, complete } = req.body || {};
    const resolved = resolveParticipant(token);

    if (!resolved) {
        return res.status(403).json({ error: 'That link is not valid. Ask for a new one.' });
    }

    // A MALFORMED TRANSCRIPT IS REFUSED RATHER THAN DROPPED: storing the answers without the
    // conversation would leave a gap nothing afterwards could detect.
    const checkedTranscript = checkTranscript(transcript);
    if (!checkedTranscript.ok) {
        console.warn(`[participant] refusing a response with a bad transcript: ${checkedTranscript.reason}`);
        return res.status(400).json({ error: `The conversation could not be read: ${checkedTranscript.reason}` });
    }

    // THE ROUND IS FINALISED HERE, FROM THE CLIENT'S `complete` FLAG - which the client
    // sets from `status: "complete"` in the model's reply, not from anything it decides
    // itself. That indirection is the point: `status` is computed by the matrix, so
    // "this process is done" is never the page's opinion or the admin's. See
    // `recordTurn` in lib/store/index.js for how a completed turn closes the open round
    // and how the next turn opens a new one.
    //
    // `=== true` rather than a truthy test: a missing flag and a false one both mean
    // "still going", and a stray string would otherwise finalise a round by accident.
    const isComplete = complete === true;

    try {
        const response = recordTurn(resolved.orgId, token, {
            data,
            transcript: checkedTranscript.transcript,
            complete: isComplete
        });

        // IDENTIFICATION RUNS ON THE ORDINARY PATH ONCE THE ROUND IS FINISHED: nothing identified a
        // live interview before this, so the participant's answer reached the roadmap only if an
        // admin rejudged it. See lib/auth/identify-response.js for why it is neither in the store
        // nor a rejudge.
        //
        // NOT AWAITED, DELIBERATELY: it is a deepseek call that takes seconds and the participant
        // is waiting for this turn's reply, so the reply goes first. It catches its own failures,
        // and the answers are ALREADY SAVED above - so an interruption leaves "not yet read",
        // never a lost answer.
        //
        // COMPLETE ROUNDS ONLY: a half-written round has no final answer to group, and grouping
        // one would build a process from evidence the next turn contradicts.
        if (isComplete) {
            void identifyFinishedResponse({
                orgId: resolved.orgId,
                response,
                // `res.locals`; see the note above.
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
