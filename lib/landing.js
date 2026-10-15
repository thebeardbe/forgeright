/**
 * The landing page: `/` is a place to arrive rather than a questionnaire, so it names the three ways in and
 * nothing else. Sign in or create an organisation are the same action, a participant may paste a token, and
 * a lost link can be recovered.
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
