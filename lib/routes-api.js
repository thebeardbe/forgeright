/**
 * The questionnaire's API: one turn of the conversation, and scoring.
 *
 * No organisation is resolved here, because these endpoints answer questions and do not touch participant
 * data; the endpoint that writes an answer is /api/response, in lib/auth/participant-routes.js, where the
 * organisation comes from the token.
 */
import express from 'express';
import { runAuditTurn, validateWorkflows } from '../ai/audit-core.js';
import { aggregate } from './scoring.js';
import { DEFAULT_TOOL_ID, getTool } from '../config/tools.js';
import { routeForParticipantToken } from './token-index.js';
import { invitationForToken, isOrganisationFinished } from './store/index.js';
import { reconcileWithHeld } from '../ai/workflow-identity.js';
import { checkEffortCeilings } from '../ai/effort-ceiling.js';
import { checkChatRate, CHAT_LIMITS } from './auth/rate-limit.js';
import { validateMessages } from '../ai/message-validation.js';

export const router = express.Router();

/**
 * What a participant is told when the questionnaire they are holding is closed.
 *
 * ONE MESSAGE, TWO DOORS. The API refuses a turn with it, and the page itself refuses to render the
 * form with it. Two copies of this sentence would drift, and the participant would get a different
 * explanation depending on which door they came through.
 */
export const QUESTIONNAIRE_CLOSED_MESSAGE =
    'This questionnaire has been closed. Your answers so far are saved. '
    + 'Ask the person who sent you the link if you need it reopened.';

/**
 * Whether a request may use the questionnaire's AI endpoints. One accepted credential: a valid participant
 * token, unguessable and naming the person it was issued to, and resolving it proves it is live.
 *
 * There is no second way in, and that removal is worth keeping: a shared access code once allowed a
 * tokenless visit whose answers were attributed to nobody, which sits outside a security model built
 * per-person and per-organisation.
 *
 * LIVENESS IS CHECKED THE SAME WAY /api/response CHECKS IT. This used to resolve the token through
 * `routeForParticipantToken`, which reads the installation-level index and nothing else: that index holds
 * a token hash, an organisation id and an invitation id, and has NO expires_at column, so it cannot answer
 * "is this still good". `/api/response` meanwhile goes through `invitationForToken`, whose query filters
 * `revoked_at IS NULL AND expires_at > ?`. THE TWO ENDPOINTS THEREFORE DISAGREED: an expired link could
 * still start an interview and spend a full 60-call provider budget, and only failed at the first save.
 *
 * The fix is to resolve through the store's own liveness check rather than to add a column to an index.
 * `invitationForToken` IS that check, and it is the one /api/response already uses, so the two cannot
 * drift again: there is one answer to "is this token alive" instead of two.
 *
 * @param {import('express').Request} req
 * @returns {{ ok: true, tool: object, route: object }|{ ok: false, reason: string }}
 */
export function mayUseQuestionnaire(req) {
    const { participantToken } = req.body || {};

    const tool = getTool(req.body?.toolId || DEFAULT_TOOL_ID);
    if (!tool) return { ok: false, reason: 'Unknown tool.' };

    if (participantToken && typeof participantToken === 'string') {
        // The index still says WHICH organisation to ask, because a participant arrives holding a token
        // and nothing else. Whether that token is still alive is then the store's answer, not the index's.
        const found = routeForParticipantToken(participantToken);
        if (!found) return { ok: false, reason: 'That link is not valid any more. Ask for a new one.' };

        const invitation = invitationForToken(found.organisationId, participantToken);
        if (!invitation) {
            console.warn(
                `[api] refused an expired or revoked link for invitation ${found.invitationId} in `
                + `organisation ${found.organisationId}`
            );
            return { ok: false, reason: 'That link is not valid any more. Ask for a new one.' };
        }

        // AN ORGANISATION THAT HAS BEEN CLOSED MUST NOT CONTINUE AN INTERVIEW. The store refuses writes to
        // a finished organisation, so without this a participant would answer every remaining question
        // and lose all of it at the first save. Refusing at the start of the turn costs one read and tells
        // them before they spend their time.
        if (isOrganisationFinished(found.organisationId)) {
            return { ok: false, reason: QUESTIONNAIRE_CLOSED_MESSAGE };
        }

        return { ok: true, tool, route: found };
    }

    // NO TOKEN AT ALL, and there is nothing else to check. The wording says what to
    // do rather than what failed, because the caller reaching this is somebody whose
    // link did not arrive or was mangled, and "Invalid code" told them nothing.
    return { ok: false, reason: 'You need an invitation link to start. Ask for a new one.' };
}

/** One turn of the intake conversation. */
router.post('/api/chat', async (req, res) => {
    const { messages, lang, roundProcesses } = req.body || {};

    const access = mayUseQuestionnaire(req);
    if (!access.ok) {
        return res.status(403).json({ status: 'error', content: access.reason });
    }

    if (!Array.isArray(messages)) {
        return res.status(400).json({ status: 'error', content: 'Missing messages.' });
    }

    // THE ROLE AND SHAPE OF EVERY TURN IS CHECKED HERE, BEFORE ANY PROVIDER CALL.
    //
    // runAuditTurn sanitised only `role === 'user'` and copied every other role through untouched, so
    // a body carrying `{role: 'system', content: '...'}` reached the provider as a system message:
    // past the injection filter, and folded into systemInstruction by the Gemini adapter. A client
    // does not get to choose the role of its own message.
    //
    // LOGGED AS A REFUSED REQUEST, not as a model fault, because the two are different events: one
    // means somebody sent something malformed or hostile, the other means a provider misbehaved.
    const checked = validateMessages(messages);
    if (!checked.ok) {
        console.warn(
            `[api/chat] refused: malformed messages from invitation ${access.route.invitationId} in ` +
            `organisation ${access.route.organisationId}: ${checked.reason}`
        );
        return res.status(400).json({
            status: 'error',
            content: 'That message could not be sent. Reload the page and try again.'
        });
    }

    // COUNTED AFTER THE TOKEN IS RESOLVED, so the key is a credential the route has already
    // accepted and never a value an unauthenticated caller picks. A refusal here is the only
    // thing between one invitation and an unbounded number of provider calls.
    const rate = checkChatRate(req.body.participantToken);
    if (!rate.allowed) {
        // LOGGED WITH THE ORGANISATION, because the participant sees one sentence and an operator
        // would otherwise see only "the questionnaire stopped working".
        console.warn(
            `[api/chat] refused: invitation ${access.route.invitationId} in ` +
            `organisation ${access.route.organisationId} exceeded ` +
            `${CHAT_LIMITS.max} turns in ${CHAT_LIMITS.windowMinutes} minutes`
        );
        return res.status(429).json({
            status: 'error',
            content:
                'This interview has been running for a long time and has been paused to protect ' +
                'the service. Your answers so far are saved. Wait a few minutes and send your ' +
                'last message again, or open your link later to continue where you left off.'
        });
    }

    try {
        const result = await runAuditTurn({
            messages: checked.messages,
            lang,
            toolId: access.tool.promptDir
        });

        // ONE PROCESS PER ROUND, ENFORCED WHERE THE ROUND IS KNOWN.
        //
        // The prompt states it under `## Rules`: "`processes` holds the process you are working on
        // NOW, not every process of the interview" (prompt_en.md). NOTHING enforced it: the only test
        // on the reply's arity anywhere is `length > 0`, which accepts any number. A live interview
        // therefore produced ONE process twice, four steps reworded, `frequencyPerWeek` 56 in one
        // entry against 7 in the other because the model had forgotten it had already recorded 56
        // servers.
        //
        // THE CLIENT SENDS THE ROUND'S PROCESSES, which is the one fact the reply cannot carry.
        // A reply restating the round's process AND adding a second complete account of it is
        // the model re-describing work it already recorded, so the two are one process. See
        // `reconcileWithHeld` in ai/workflow-identity.js for the evidence and for the one case
        // this deliberately does not distinguish.
        //
        // IT DECLINES WITHOUT A HELD SET, which is the safe direction: no round history means
        // no basis for deciding, so the reply is passed through as it stands.
        const held = Array.isArray(roundProcesses) ? roundProcesses : [];
        if (result && result.audit && Array.isArray(result.audit.workflows) && held.length > 0) {
            const { workflows } = reconcileWithHeld(result.audit.workflows, held);
            result.audit = { ...result.audit, workflows };
        }

        res.json(result);
    } catch (err) {
        console.error('[api/chat] failed:', err);
        res.status(500).json({
            status: 'error',
            content: 'The analysis service is temporarily unavailable. Please try again.'
        });
    }
});

/**
 * A payload's shape for a log line, rather than its contents. `undefined` and `null` are named separately,
 * because a missing key and a deliberate null are different faults.
 *
 * @param {unknown} value
 * @returns {string}
 */
function describeShape(value) {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    if (Array.isArray(value)) return `an array of ${value.length}`;
    if (typeof value === 'object') {
        const keys = Object.keys(value);
        return `an object with keys [${keys.slice(0, 8).join(', ')}${keys.length > 8 ? ', ...' : ''}]`;
    }
    return typeof value;
}

/**
 * Scores a completed audit. A rejection is logged, because it is otherwise invisible to whoever runs the
 * installation: the participant sees one message and nothing reaches the server log.
 *
 * The shape is logged rather than the payload, because what makes this diagnosable is whether `workflows` was
 * missing rather than what a participant typed.
 */
router.post('/api/score', async (req, res) => {
    const { audit } = req.body || {};

    const access = mayUseQuestionnaire(req);
    if (!access.ok) {
        return res.status(403).json({ error: access.reason });
    }

    // Validate with the same rule the model path uses, rather than duplicating the
    // checks. This route takes the payload straight from the client, so without it
    // a request could serve a blank heading to the reader.
    const check = validateWorkflows(audit?.workflows);
    if (!check.ok) {
        // Logged, and only the SHAPE; see the note above.
        console.error(
            `[api/score] refused: ${check.reason}. ` +
            `audit is ${describeShape(audit)}, workflows is ${describeShape(audit?.workflows)}` +
            (Array.isArray(audit?.workflows) && audit.workflows.length > 0
                ? `, first entry is ${describeShape(audit.workflows[0])}`
                : '')
        );
        return res.status(400).json({ error: `Invalid audit: ${check.reason}.` });
    }

    // THE NUMERIC DOOR, WHICH WAS OPEN. validateWorkflows checks ids and titles and never looks at a
    // number, so a browser client could post `minutesPerInstance: 100001` and have it scored: MEASURED,
    // that returned 133334.67. The write path bounds what a participant stores; this bounds what a client
    // can ask to have computed, and it is the SAME FUNCTION for the same reason - one rule, two doors.
    const ceiling = checkEffortCeilings(audit.workflows);
    if (!ceiling.ok) {
        console.warn(`[api/score] refused: ${ceiling.reason}`);
        return res.status(400).json({ error: `A figure in this audit is not believable: ${ceiling.reason}` });
    }

    // Scoring is pure and cannot fail on well-formed input, but guard the shape so
    // a malformed payload is a 400 rather than a 500.
    try {
        res.json(aggregate(audit.workflows));
    } catch (err) {
        console.error('[api/score] failed:', err);
        res.status(400).json({ error: 'Could not score the supplied audit.' });
    }
});
