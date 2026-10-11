/**
 * The landing page.
 *
 * `/` is a place to arrive, not a questionnaire. The questionnaire needs a token,
 * so the front page names the three ways in and nothing else:
 *
 *   - sign in or create an organisation, which is the same action (see /admin)
 *   - paste a token, for a participant holding one
 *   - recover a lost link
 *
 * It replaced a page that showed the questionnaire immediately and demanded an
 * access code the participant had never been given, which was a dead end: the
 * token is the credential, and a bare visit has no token at all.
 */
import express from 'express';

export const router = express.Router();

/** The three ways in, rendered from one place so the copy and the links agree. */
router.get('/', (req, res) => {
    // strings, lang and supportedLangs come from res.locals (set once in
    // server.js), so only what is specific to this page is passed here. Passing
    // req.lang would set them to undefined and override the locals.
    res.render('landing', {
        // Where the "sign in or create" button points. /admin decides between the
        // form and the console from the session, so there is no separate register
        // or sign-in route for the page to choose between.
        adminPath: '/admin'
    });
});
