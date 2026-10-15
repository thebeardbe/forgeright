/**
 * Theme resolution: which palette a request should use, and its CSS variables.
 *
 * Three cases in order: a stored choice naming a palette gives that palette, a stored choice meaning "follow
 * system" gives the palette matching prefers-color-scheme, and no stored choice follows the system too. A
 * visit with nothing stored is therefore correct on the first paint.
 *
 * A cookie rather than localStorage, because this runs on the server and its point is to render the right
 * palette into the HTML, while localStorage is not sent.
 */
import { FOLLOW_SYSTEM, PALETTES, SYSTEM_DARK, SYSTEM_LIGHT, paletteById } from './palettes.js';

/** Cookie name. Prefixed to avoid colliding with anything else on the origin. */
export const THEME_COOKIE = 'fr_theme';

/**
 * Cookie lifetime in seconds: about two years, the ceiling browsers accept.
 *
 * Long on purpose. A theme is a preference, not a session, and being reset to the
 * default every visit would make the picker pointless.
 */
export const THEME_COOKIE_MAX_AGE = 63_072_000;

/**
 * The palette id a stored value means, or null when it names nothing usable. A cookie is attacker-editable,
 * so its value is validated against the known palettes rather than trusted.
 *
 * @param {unknown} value
 * @returns {string|null} A palette id, or FOLLOW_SYSTEM, or null for "no valid choice".
 */
export function parseThemeChoice(value) {
    if (typeof value !== 'string' || value === '') return null;
    if (value === FOLLOW_SYSTEM) return FOLLOW_SYSTEM;
    return paletteById(value) ? value : null;
}

/**
 * The palette a request should use.
 *
 * @param {object} options
 * @param {string|null} options.choice The stored choice, already parsed.
 * @param {boolean} options.prefersDark Whether the client asked for a dark scheme.
 * @returns {{ id: string, palette: object, followingSystem: boolean }}
 * @throws {Error} On an unknown choice, which is a programming error: the caller parses first.
 */
export function resolveTheme({ choice, prefersDark }) {
    if (choice !== null && choice !== FOLLOW_SYSTEM && !paletteById(choice)) {
        throw new Error(
            `Unknown theme ${JSON.stringify(choice)}. Parse the cookie with parseThemeChoice first.`
        );
    }

    // Cases 2 and 3: follow the system, or no choice was stored.
    if (choice === null || choice === FOLLOW_SYSTEM) {
        const id = prefersDark ? SYSTEM_DARK : SYSTEM_LIGHT;
        return { id, palette: PALETTES[id], followingSystem: true };
    }

    return { id: choice, palette: PALETTES[choice], followingSystem: false };
}

/**
 * Whether a request asked for a dark colour scheme. `prefers-color-scheme` is the only reliable signal.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
export function prefersDark(req) {
    const header = req.headers['sec-ch-prefers-color-scheme'];
    if (typeof header === 'string') return header.toLowerCase() === 'dark';

    // No client hint: follow the system, and let the inline script in the head
    // correct it before paint for a browser that sends the hint later.
    return false;
}

/**
 * The CSS custom properties for a palette, named `--o-*` so public/css/app.css reads the same way the
 * reference stylesheet does. Everything semantic is derived from these in CSS, so a component never names a
 * palette colour.
 *
 * One substitution: three palettes have no `orange`, so `yellow` is the fallback written here rather than a
 * blank value.
 *
 * @param {object} palette
 * @returns {Record<string, string>}
 */
export function paletteVars(palette) {
    const c = palette.colors;
    const pick = (...keys) => keys.map((key) => c[key]).find((v) => typeof v === 'string' && v !== '');

    const bg = pick('background');
    const fg = pick('foreground');
    const accent = pick('accent', 'blue', 'foreground');

    return {
        '--o-bg': bg,
        '--o-bg-dark': pick('dark_background', 'background'),
        '--o-bg-darker': pick('darker_background', 'dark_background', 'background'),
        '--o-bg-light': pick('lighter_background', 'background'),
        '--o-fg': fg,
        '--o-fg-dim': pick('dark_foreground', 'muted', 'foreground'),
        '--o-fg-light': pick('light_foreground', 'foreground'),
        '--o-fg-bright': pick('bright_foreground', 'foreground'),
        '--o-accent': accent,
        '--o-selection': pick('selection', 'lighter_background', 'accent'),
        '--o-red': pick('red'),
        '--o-yellow': pick('yellow', 'bright_yellow'),
        '--o-orange': pick('orange', 'bright_yellow', 'yellow'),
        '--o-green': pick('green'),
        '--o-cyan': pick('cyan'),
        '--o-blue': pick('blue', 'accent'),
        '--o-magenta': pick('magenta')
    };
}

/**
 * Express middleware: resolve the theme and expose it to every view as `res.locals.theme`, so a template
 * needs no knowledge of how a theme is chosen.
 *
 * The palette reaches the page through public/css/palette.css, keyed by the `data-theme` attribute; it is not
 * inlined, which would be a second copy of the colours free to drift.
 */
export function themeMiddleware(req, res, next) {
    const choice = parseThemeChoice(req.cookies?.[THEME_COOKIE]);
    const resolved = resolveTheme({ choice, prefersDark: prefersDark(req) });

    res.locals.theme = {
        id: resolved.id,
        // The display name, for the picker's label and any page that names it.
        name: resolved.palette.name,
        mode: resolved.palette.colors.mode,
        followingSystem: resolved.followingSystem,
        // What the picker should have selected: the stored choice, which may be
        // "system" even when a concrete palette is being rendered.
        selected: choice === null ? FOLLOW_SYSTEM : choice,
        // For the inline head script, which repeats this in the client for the
        // case where the server's guess at the OS preference was wrong.
        systemDarkId: SYSTEM_DARK,
        systemLightId: SYSTEM_LIGHT
    };
    next();
}
