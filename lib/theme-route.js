/**
 * The theme route: stores the picker's choice, then returns the person where they were.
 *
 * A MODULE RATHER THAN PART OF `server.js`, which had passed the project's size budget
 * once the return-target logic grew. The seam is real: this is one self-contained route
 * with its own validator, and everything it needs arrives through `deps` instead of
 * importing the server back.
 *
 * THE RETURN TARGET IS A PATH FROM THE QUERY, NOT THE REFERER HEADER, and that is a fix
 * rather than a preference. The referer was compared against `publicBaseUrl()`, which
 * fails whenever the browser's URL is not byte-identical to the configured one, and THE
 * FAILURE IS SILENT: the theme is stored, the user lands on the landing page, and it
 * reads as the theme being broken.
 */


/**
 * Registers `GET /settings/theme` on the app.
 *
 * @param {object} app The express app.
 * @param {object} deps The pieces owned by server.js: the theme constants, the palette
 *   table, the choice parser, and the two path/secure helpers. Passed rather than
 *   imported, so this module does not import `server.js` back.
 */
export function registerThemeRoute(app, deps) {
    const {
        PUBLIC_PATH, FOLLOW_SYSTEM, PALETTES, parseThemeChoice,
        THEME_COOKIE, THEME_COOKIE_MAX_AGE, isSecureRequest, publicBaseUrl
    } = deps;

    /**
     * A safe path to return to after a theme change, or null.
     *
     * ACCEPTS A PATH ONLY, AND ONLY ONE UNDER THIS APP'S PREFIX. A redirect target taken
     * from the request is an open redirect if it is echoed unchecked: `?next=https://evil`
     * would send a user to another site from a link on this one, which is the classic way a
     * trusted host lends credibility to a phishing page.
     *
     * THE THREE RULES: it must start with a SINGLE `/`, because `//evil.test` is protocol-relative
     * and every browser reads it as a HOST; it must stay UNDER `PUBLIC_PATH`, so a deployment
     * mounted at `/forgeright` cannot be pointed at an unrelated path on the same host; and it may
     * hold no control characters or backslashes, because browsers normalise `\` to `/` in some
     * positions and a newline can terminate a header.
     *
     * THE PATH IS RETURNED UNCHANGED rather than rebuilt, so a query string on it survives.
     * PERCENT-ENCODING IS NOT DECODED: the value is only ever a Location header, and decoding would
     * turn `%2F%2F` into `//` AFTER the check.
     *
     * @param {unknown} value The raw `next` query parameter.
     * @returns {string|null}
     */
    function themeReturnPath(value) {
        if (typeof value !== 'string' || value === '') return null;
        if (!value.startsWith('/') || value.startsWith('//')) return null;
        if (/[\u0000-\u0020\\]/.test(value)) return null;

        // THE PATH IS RESOLVED BEFORE IT IS TRUSTED, and that step is not optional. A prefix
        // check on the raw string is not enough: `/forgeright/../..%2Fetc` BEGINS with the
        // prefix and resolves outside it, which was measured against the running instance
        // before this line existed. Resolving first is what makes rule 2 true of the path
        // that is actually navigated to, rather than of the text that was sent.
        //
        // `URL` normalises `..` segments the way a browser does. The base is a fixed
        // placeholder because only the PATH is used: an absolute `value` was already refused
        // above, so the origin here cannot come from the caller.
        let resolved;
        try {
            resolved = new URL(value, 'https://placeholder.invalid').pathname;
        } catch (err) {
            // An unparseable value is refused rather than guessed at.
            return null;
        }

        // A deployment with no prefix has the whole host, so the rules above carry the
        // safety and the resolved path only has to be a path.
        if (PUBLIC_PATH === '') return resolved;

        // The bare prefix is the console's own root, which is a legitimate target: a
        // signed-in admin lands there. Any other path must be under it.
        if (resolved === PUBLIC_PATH) return resolved;
        return resolved.startsWith(`${PUBLIC_PATH}/`) ? resolved : null;
    }

    app.get('/settings/theme', (req, res) => {
        const raw = String(req.query.choice || '');
        const choice = parseThemeChoice(raw) === FOLLOW_SYSTEM ? FOLLOW_SYSTEM : (PALETTES[raw] ? raw : null);

        if (choice === null) {
            console.warn(`[theme] refusing an unknown theme choice ${JSON.stringify(raw)}`);
            return res.redirect(`${PUBLIC_PATH}/`);
        }

        res.cookie(THEME_COOKIE, choice, {
            path: '/',
            sameSite: 'lax',
            httpOnly: false, // the page reads it to reflect the choice in the picker
            maxAge: THEME_COOKIE_MAX_AGE * 1000,
            secure: isSecureRequest(req)
        });

        // BACK WHERE THEY CAME FROM, from the query string rather than the Referer header.
        //
        // THE REFERER WAS THE BUG. The picker sends no `next`, so this route compared
        // `Referer` against `publicBaseUrl()` and redirected to the landing page when the two
        // did not match. That comparison fails whenever the browser's URL is not
        // byte-identical to the configured one - a proxy terminating a different hostname, a
        // `www.` prefix, a port the browser adds - AND THE FAILURE IS SILENT: the theme is
        // stored, the user is dumped on the landing page, and it reads as the theme being
        // broken. Measured on the live instance: `Referer:
        // https://host/forgeright/admin/roadmap` against a process whose
        // `PUBLIC_BASE_URL` was `http://127.0.0.1:3000` gave `Location: /`, while the same
        // request with a matching base URL gave the roadmap back. A local test passes and the
        // deployment breaks, which is the whole difficulty of the defect.
        const target = themeReturnPath(req.query.next);
        if (target !== null) return res.redirect(target);

        // The Referer is still honoured as a FALLBACK, for a browser that sent no `next`: an
        // old page, or a hand-written URL. It is no longer the primary mechanism.
        const referer = req.headers.referer;
        if (typeof referer === 'string' && referer.startsWith(`${publicBaseUrl()}/`)) {
            return res.redirect(referer);
        }
        return res.redirect(`${PUBLIC_PATH}/`);
    });
}
