/** The landing page: `/` names the three ways in - sign in, paste a token, recover a lost link. */
import express from 'express';

export const router = express.Router();

router.get('/', (req, res) => {
    // strings, lang and supportedLangs come from res.locals, so passing them here would override
    // them with undefined.
    res.render('landing', {
        // /admin decides between the form and the console from the session.
        adminPath: '/admin'
    });
});
