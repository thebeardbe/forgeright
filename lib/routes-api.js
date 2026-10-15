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
import { reconcileWithHeld } from '../ai/workflow-identity.js';

export const router = express.Router();

/**
 * Whether a request may use the questionnaire's AI endpoints. One accepted credential: a valid participant
 * token, unguessable and naming the person it was issued to, and resolving it proves it is live.
 *
 * There is no second way in, and that removal is worth keeping: a shared access code once allowed a
 * tokenless visit whose answers were attributed to nobody, which sits outside a security model built
 * per-person and per-organisation.
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
    const { messages, lang, roundProcesses } = req.body || {};

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

        // ONE PROCESS PER ROUND, ENFORCED WHERE THE ROUND IS KNOWN.
        //
        // The prompt states the contract, under its ONE PROCESS PER ROUND rule: "`processes` holds
        // the process you are working on NOW, not every process of the interview" (prompt_en.md,
        // section "Rules"). NOTHING enforced it: the only test on the reply's arity anywhere is `length > 0`, which
        // accepts any number. A live interview therefore produced ONE process twice, four steps
        // reworded, `frequencyPerWeek` 56 in one entry against 7 in the other because the model
        // had forgotten it had already recorded 56 servers.
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

    // Scoring is pure and cannot fail on well-formed input, but guard the shape so
    // a malformed payload is a 400 rather than a 500.
    try {
        res.json(aggregate(audit.workflows));
    } catch (err) {
        console.error('[api/score] failed:', err);
        res.status(400).json({ error: 'Could not score the supplied audit.' });
    }
});
