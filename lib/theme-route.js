/**
 * The theme route: stores the picker's choice, then returns the person where they were.
 *
 * The return target is a path from the query rather than the referer header, because comparing the referer
 * against the configured base URL fails whenever the browser's URL is not byte-identical to it, and the
 * failure is silent.
 */


/**
 * Registers `GET /settings/theme` on the app.
 *
 * @param {object} app The express app.
 * @param {object} deps The pieces owned by server.js, passed rather than imported so this module does not
 *   import `server.js` back.
 */
export function registerThemeRoute(app, deps) {
    const {
        PUBLIC_PATH, FOLLOW_SYSTEM, PALETTES, parseThemeChoice,
        THEME_COOKIE, THEME_COOKIE_MAX_AGE, isSecureRequest, publicBaseUrl
    } = deps;

    /**
     * A safe path to return to after a theme change, or null. A redirect target taken from the request is an
     * open redirect if echoed unchecked, so this accepts a path only, and only one under this app's prefix.
     *
     * Three rules: it must start with a single `/`, because `//evil.test` is protocol-relative and read as a
     * host; it must stay under `PUBLIC_PATH`; and it may hold no control characters or backslashes, because
     * browsers normalise `\` to `/` and a newline can terminate a header.
     *
     * The path is returned unchanged rather than rebuilt, so a query string survives, and percent-encoding is
     * not decoded, because decoding would turn `%2F%2F` into `//` after the check.
     *
     * The path is resolved before it is trusted, which is not optional: `/forgeright/../..%2Fetc` begins with
     * the prefix and resolves outside it, so a prefix check on the raw string is not enough.
     *
     * @param {unknown} value The raw `next` query parameter.
     * @returns {string|null}
     */
    function themeReturnPath(value) {
        if (typeof value !== 'string' || value === '') return null;
        if (!value.startsWith('/') || value.startsWith('//')) return null;
        if (/[\u0000-\u0020\\]/.test(value)) return null;

        // Resolved before it is trusted; see the caveat above.
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
