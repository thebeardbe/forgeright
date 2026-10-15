/**
 * The two console views, and the rejudge that both offer.
 *
 * Mounted inside the console router, so every route here is behind `requireSession` and
 * `requireConsole` and `req.console` carries the organisation; no route here reads one from the request.
 */
import express from 'express';
import { requireConnection } from '../store/organisations.js';
import { listResponsesWithGrouping } from '../store/console-read.js';
import { listRoadmap, isCostTerm } from '../store/weighing.js';
import { mergeProcessSteps } from '../../ai/merge-steps.js';
import { rejudgeFromProcess, rejudgeFromResponse } from './rejudge.js';
import { correctField } from './correct-field.js';

export const router = express.Router();

/**
 * View 1: every answer, with the process it was matched to. The participant's own words are on the page
 * beside the grouping's reasoning, because the answers are what you check.
 *
 * Attribution is absent by construction: both accessors omit the invitation.
 *
 * `?open=<response id>` is read here rather than in the client, so the answer's `<details>` renders already
 * open without a script, and it is compared against the rendered rows rather than trusted, so a hand-edited
 * URL opens nothing.
 */
router.get('/answers', (req, res) => {
    const { organisation } = req.console;
    const db = requireConnection(organisation.id);

    // Opens one answer; see the note above.
    res.render('admin-answers', {
        organisation,
        readOnly: req.console.readOnly,
        responses: listResponsesWithGrouping(db),
        openResponseId: typeof req.query.open === 'string' ? req.query.open : null,
        // A rejudge posts back a fragment of state rather than a flash cookie this app does not have.
        notice: noticeFrom(req.query)
    });
});

/**
 * View 2: the roadmap. Both the deliverable and the debugging surface, because the sorted list is what the
 * client reads and a badly grouped process sinks down it while staying rejudgeable.
 */
router.get('/roadmap', (req, res) => {
    const { organisation } = req.console;

    res.render('admin-roadmap', {
        organisation,
        readOnly: req.console.readOnly,
        processes: listRoadmap(organisation.id),
        // Passed to the template so the view marks the cost terms without knowing
        // which they are: the direction lives in one place, in the store.
        isCostTerm,
        // The merge is a module, handed to the view the same way `isCostTerm` is:
        // the view is given the calculations it needs rather than importing them,
        // so a template holds no rule of its own.
        mergeProcessSteps,
        notice: noticeFrom(req.query)
    });
});

/**
 * A rejudge from an answer. The admin supplies an argument rather than a category, because the
 * classification depends on factors nobody can enumerate in advance.
 */
router.post('/answers/:id/rejudge', async (req, res) => {
    const reasoning = String(req.body?.reason || '').trim();

    try {
        const result = await rejudgeFromResponse({
            orgId: req.console.organisation.id,
            responseId: req.params.id,
            adminReasoning: reasoning
        });
        return res.redirect(`${noticeUrl('/admin/answers', result, 'read again')}`);
    } catch (err) {
        console.error(`[console] rejudge from an answer failed: ${err.message}`);
        return res.redirect(urlWith('/admin/answers', { error: err.message }));
    }
});

/**
 * A rejudge from a process: the same mechanism as the route above, and it always goes back to workflow 2
 * because a process cannot be reweighed before it is certain what the process is.
 */
/**
 * An admin corrects one value, then the process is reweighed. The two regroup actions above argue about which
 * process a response belongs to and neither reaches a value.
 *
 * The field is chosen from a closed set, the four the effort formula reads, and the value is validated before
 * anything is written, so a sentence where a number belongs is refused at the boundary.
 */
router.post('/answers/:id/correct', async (req, res) => {
    const field = String(req.body?.field || '').trim();
    const rawValue = req.body?.value;
    const reasoning = String(req.body?.reason || '').trim();

    try {
        await correctField({
            orgId: req.console.organisation.id,
            responseId: req.params.id,
            field,
            rawValue,
            adminReasoning: reasoning
        });
        return res.redirect(urlWith('/admin/answers', { notice: `Corrected ${field}, and reweighed.` }));
    } catch (err) {
        // REFUSED LOUDLY, because every refusal here is a value that would otherwise have reached
        // a score: a bad number is harder to notice than a missing one, and the console would
        // have presented it as a considered reading.
        console.error(`[console] correcting ${field} on answer ${req.params.id} failed: ${err.message}`);
        return res.redirect(urlWith('/admin/answers', { error: err.message }));
    }
});

router.post('/roadmap/:id/rejudge', async (req, res) => {
    const reasoning = String(req.body?.reason || '').trim();

    try {
        const result = await rejudgeFromProcess({
            orgId: req.console.organisation.id,
            processId: req.params.id,
            adminReasoning: reasoning
        });
        return res.redirect(noticeUrl('/admin/roadmap', result, 'regrouped'));
    } catch (err) {
        console.error(`[console] rejudge from a process failed: ${err.message}`);
        return res.redirect(urlWith('/admin/roadmap', { error: err.message }));
    }
});

/** Builds a redirect carrying the outcome, so the page can say what happened. */
function noticeUrl(basePath, result, verb) {
    const parts = [`rejudged=${encodeURIComponent(verb)}`];
    if (result.weighed) parts.push('weighed=1');
    // The note is shown rather than only logged: when a regrouping succeeds and the
    // weighing does not, the admin has to know the number did not move.
    if (!result.weighed && result.note) parts.push(`note=${encodeURIComponent(result.note)}`);
    // A MOVE NAMES THE PROCESS LEFT BEHIND, because the admin is looking at one
    // process's page and the other one changed too. Shown whenever a move happened,
    // not only on failure: a silent move would leave the admin believing the other
    // process is untouched.
    if (result.moved) {
        parts.push(`moved=${encodeURIComponent(result.moved.name)}`);
        parts.push(`leftWeighed=${result.leftWeighed ? '1' : '0'}`);
        if (result.leftNote) parts.push(`leftNote=${encodeURIComponent(result.leftNote)}`);
    }
    return `${basePath}?${parts.join('&')}`;
}

/** Appends a query string to a path, keeping any the caller already had. */
function urlWith(basePath, params) {
    const query = Object.entries(params)
        .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
        .join('&');
    return `${basePath}?${query}`;
}

/**
 * The outcome to show, read from the query string of a redirect. Values are passed through for the template
 * to escape rather than being marked safe here, and nothing trusts the query string for anything but display.
 */
function noticeFrom(query) {
    const notice = {};

    if (typeof query.error === 'string' && query.error !== '') notice.error = query.error;
    if (typeof query.note === 'string' && query.note !== '') notice.note = query.note;
    if (query.weighed === '1') notice.weighed = true;
    if (typeof query.rejudged === 'string' && query.rejudged !== '') notice.rejudged = query.rejudged;
    // A move, with the name of the process the response left and whether it could be reweighed. These
    // are escaped by the template, like every other value shown on these pages.
    if (typeof query.moved === 'string' && query.moved !== '') {
        notice.moved = query.moved;
        notice.leftWeighed = query.leftWeighed === '1';
        if (typeof query.leftNote === 'string' && query.leftNote !== '') notice.leftNote = query.leftNote;
    }

    return Object.keys(notice).length > 0 ? notice : null;
}
