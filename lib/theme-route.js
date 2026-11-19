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
     * A safe path to return to, or null: a redirect target from the request is an open redirect.
     *
     * It must start with a single `/` (`//evil.test` is protocol-relative) and hold no control character or
     * backslash. It is resolved before it is trusted, because `/forgeright/../..%2Fetc` begins with the prefix
     * and resolves outside it; percent-encoding is not decoded, or `%2F%2F` would become `//` after the check.
     *
     * @returns {string|null}
     */
    function themeReturnPath(value) {
        if (typeof value !== 'string' || value === '') return null;
        if (!value.startsWith('/') || value.startsWith('//')) return null;
        if (/[\u0000-\u0020\\]/.test(value)) return null;

        // Resolved before it is trusted; see the note above.
        let resolved;
        try {
            resolved = new URL(value, 'https://placeholder.invalid').pathname;
        } catch (err) {
            // Unparseable is refused rather than guessed at.
            return null;
        }

        // With no prefix the rules above carry the safety, and the resolved path need only be a path.
        if (PUBLIC_PATH === '') return resolved;

        // The bare prefix is the console's own root, which a signed-in admin legitimately lands on.
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

        // Back where they came from, from the query rather than the Referer: the Referer comparison fails
        // whenever the browser's URL is not byte-identical to the configured one, and fails silently.
        const target = themeReturnPath(req.query.next);
        if (target !== null) return res.redirect(target);

        // The Referer is a fallback for a browser that sent no `next`.
        const referer = req.headers.referer;
        if (typeof referer === 'string' && referer.startsWith(`${publicBaseUrl()}/`)) {
            return res.redirect(referer);
        }
        return res.redirect(`${PUBLIC_PATH}/`);
    });
}
