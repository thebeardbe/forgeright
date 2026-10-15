/**
 * The two console views, and the rejudge that both offer.
 *
 * MOUNTED INSIDE the console router, so every route here is already behind
 * `requireSession` and `requireConsole`, and `req.console` carries the organisation
 * resolved from the session. NO ROUTE HERE READS AN ORGANISATION FROM THE REQUEST,
 * which is the one mistake this whole console exists to avoid, and the reason the
 * routes live under the guard rather than beside it.
 *
 * TWO VIEWS, per the spec, and a third was rejected as redundant: the ordered list
 * contains every process, so it is where a wrong grouping is fixed. A second view
 * of the same processes in another order would be the same data twice.
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
 * View 1: every answer, with the process it was matched to.
 *
 * The subject is ONE RESPONSE: "this answer was read wrong". The participant's own
 * words are on the page beside the grouping's reasoning, because the spec is
 * explicit that the paragraph is not what you check: the answers are.
 *
 * ATTRIBUTION IS ABSENT BY CONSTRUCTION. `listResponsesWithGrouping` and
 * `getResponsesForAnalysis` both omit the invitation, so there is no email or
 * invitation id available to render even by accident.
 *
 * `?open=<response id>` IS READ HERE RATHER THAN IN THE CLIENT, so the answer's `<details>` can
 * be rendered already open. A page that works WITHOUT JAVASCRIPT is this file's standard - the
 * theme picker and the transcript are the same - so a script-dependent link would be the odd one
 * out and would silently do nothing if the script failed.
 *
 * IT IS COMPARED AGAINST THE RENDERED ROWS rather than trusted: an unknown or stale id opens
 * nothing, so a hand-edited URL cannot make the page do anything a normal request would not.
 * See partials/answer-row.ejs for the id it matches on.
 */
router.get('/answers', (req, res) => {
    const { organisation } = req.console;
    const db = requireConnection(organisation.id);

    // `?open=<response id>` opens one answer; see the note above.
    res.render('admin-answers', {
        organisation,
        readOnly: req.console.readOnly,
        responses: listResponsesWithGrouping(db),
        openResponseId: typeof req.query.open === 'string' ? req.query.open : null,
        // A rejudge that failed or succeeded posts back a fragment of state to show,
        // rather than living in a flash cookie this app does not have.
        notice: noticeFrom(req.query)
    });
});

/**
 * View 2: the roadmap.
 *
 * BOTH THE DELIVERABLE AND THE DEBUGGING SURFACE, because they are the same
 * objects: the sorted list is what the client reads, and a badly grouped process
 * sinks down it while staying rejudgeable where the admin is already looking.
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
 * A rejudge from an ANSWER.
 *
 * "This answer was read wrong." The admin supplies an argument, not a category: the
 * spec is explicit that a dropdown would be worse than a reasoned request, because
 * the classification depends on factors nobody can enumerate in advance.
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
 * A rejudge from a PROCESS.
 *
 * "This flow is wrong." THE SAME MECHANISM as the route above: it always goes back
 * to workflow 2, because a process cannot be reweighed before it is certain what the
 * process is. Two places, one path.
 */
/**
 * AN ADMIN CORRECTS ONE VALUE, then the process is reweighed.
 *
 * THE THIRD THING AN ADMIN CAN DO, beside the two regrouping actions above. Both of those are
 * arguments about WHICH PROCESS a response belongs to; neither reaches a value, which is why an
 * admin who said "it is not 56 a week, but 56 every morning" got a sentence back and a score
 * unchanged. Measured on the deployed instance.
 *
 * THE FIELD IS CHOSEN FROM A CLOSED SET - the four the effort formula reads - and the value is
 * VALIDATED before anything is written, so a sentence where a number belongs is refused at the
 * boundary rather than carried into a score. See `readCorrectedValue`.
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
 * The outcome to show, read from the query string of a redirect.
 *
 * Values are passed through for the template to ESCAPE rather than being marked
 * safe here: a model's note can contain text, and the view is where that is made
 * inert. Nothing here trusts the query string for anything but display.
 */
function noticeFrom(query) {
    const notice = {};

    if (typeof query.error === 'string' && query.error !== '') notice.error = query.error;
    if (typeof query.note === 'string' && query.note !== '') notice.note = query.note;
    if (query.weighed === '1') notice.weighed = true;
    if (typeof query.rejudged === 'string' && query.rejudged !== '') notice.rejudged = query.rejudged;
    // A move, with the name of the process the response left and whether that
    // process could be reweighed. Names and notes arrive from the query string and
    // are escaped by the template, like every other value shown on these pages.
    if (typeof query.moved === 'string' && query.moved !== '') {
        notice.moved = query.moved;
        notice.leftWeighed = query.leftWeighed === '1';
        if (typeof query.leftNote === 'string' && query.leftNote !== '') notice.leftNote = query.leftNote;
    }

    return Object.keys(notice).length > 0 ? notice : null;
}
