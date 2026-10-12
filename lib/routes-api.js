/**
 * The questionnaire's API: one turn of the conversation, and scoring.
 *
 * Extracted from server.js so that file stays a wiring list rather than growing
 * past its budget, and so the two endpoints that take the participant's answers
 * live together.
 *
 * NO ORGANISATION IS RESOLVED HERE. These endpoints answer questions; they do not
 * read or write participant data, so there is nothing to scope. The endpoint that
 * does write an answer is /api/response, in lib/auth/participant-routes.js, where
 * the organisation comes from the token.
 */
import express from 'express';
import { runAuditTurn, validateWorkflows } from '../ai/audit-core.js';
import { aggregate } from './scoring.js';
import { DEFAULT_TOOL_ID, getTool } from '../config/tools.js';
import { routeForParticipantToken } from './token-index.js';

export const router = express.Router();

/**
 * Whether a request may use the questionnaire's AI endpoints.
 *
 * ONE ACCEPTED CREDENTIAL: a valid PARTICIPANT TOKEN. The token is unguessable,
 * single-purpose, identifies the person it was issued to, and is what an invitation
 * mails them. Validating it means resolving it, which also proves it is live rather
 * than revoked or expired.
 *
 * THERE USED TO BE A SECOND WAY IN, and its removal is the point of this comment.
 * A shared AUDIT_ACCESS_CODE allowed a TOKENLESS visit: anybody holding the code
 * could run the questionnaire, and the answers were attributed to nobody. It was
 * removed because it sat OUTSIDE this application's security model rather than
 * beside it. Access here is per-person and per-organisation - an organisation is
 * created for a sign-up, people are invited, and each invitation is a token that
 * names its holder and its tenant. A shared secret that anybody in the world can
 * hold, that identifies no one and belongs to no organisation, cannot be reconciled
 * with that, and no route was asking for it any more either.
 *
 * So there is no third way in, and a request without a usable token is refused.
 *
 * @param {import('express').Request} req
 * @returns {{ ok: true, tool: object }|{ ok: false, reason: string }}
 */
export function mayUseQuestionnaire(req) {
    const { participantToken } = req.body || {};

    const tool = getTool(req.body?.toolId || DEFAULT_TOOL_ID);
    if (!tool) return { ok: false, reason: 'Unknown tool.' };

    if (participantToken && typeof participantToken === 'string') {
        const route = routeForParticipantToken(participantToken);
        if (route) return { ok: true, tool };
        return { ok: false, reason: 'That link is not valid any more. Ask for a new one.' };
    }

    // NO TOKEN AT ALL, and there is nothing else to check. The wording says what to
    // do rather than what failed, because the caller reaching this is somebody whose
    // link did not arrive or was mangled, and "Invalid code" told them nothing.
    return { ok: false, reason: 'You need an invitation link to start. Ask for a new one.' };
}

/** One turn of the intake conversation. */
router.post('/api/chat', async (req, res) => {
    const { messages, lang } = req.body || {};

    const access = mayUseQuestionnaire(req);
    if (!access.ok) {
        return res.status(403).json({ status: 'error', content: access.reason });
    }

    if (!Array.isArray(messages)) {
        return res.status(400).json({ status: 'error', content: 'Missing messages.' });
    }

    try {
        const result = await runAuditTurn({
            messages,
            lang,
            toolId: access.tool.promptDir
        });
        res.json(result);
    } catch (err) {
        console.error('[api/chat] failed:', err);
        res.status(500).json({
            status: 'error',
            content: 'The analysis service is temporarily unavailable. Please try again.'
        });
    }
});

/** Scores a completed audit. */
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
        return res.status(400).json({ error: `Invalid audit: ${check.reason}.` });
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
