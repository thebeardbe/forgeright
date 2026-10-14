/**
 * Theme resolution: which palette a request should use, and its CSS variables.
 *
 * THREE CASES, IN THIS ORDER: a stored choice naming a palette gives that palette; a stored choice
 * meaning "follow system" gives the palette matching prefers-color-scheme; and no stored choice
 * follows the system too. The mode therefore comes from the OS in the last two, so a visit from a
 * machine with nothing stored is correct on the FIRST PAINT rather than corrected after it.
 *
 * A COOKIE RATHER THAN localStorage: this runs on the server and its point is to render the right
 * palette into the HTML, while localStorage is not sent - so the server could not know the choice
 * and the page would have to be patched after paint, which is the flash this avoids.
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
 * The palette id a stored value means, or null when it names nothing usable.
 *
 * A cookie is attacker-editable even when it is SameSite=Lax, so its value is
 * validated against the known palettes rather than trusted. An unknown value is
 * treated as no choice at all, which falls back to the system preference.
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
 * @throws {Error} On an unknown choice, which is a programming error here: the
 *   caller parses first, so an unparsed value reaching this function is a bug
 *   rather than something to paper over.
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
 * Whether a request asked for a dark colour scheme.
 *
 * prefers-color-scheme is the only reliable signal: a user agent's dark mode is
 * not necessarily the OS preference, and there is nothing else to read.
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
 * The CSS custom properties for a palette.
 *
 * The names are `--o-*`, matching the reference's convention, so the mapping in
 * public/css/app.css reads the same way its stylesheet does. Everything semantic
 * (`--bg`, `--card`, `--accent`) is derived from these in CSS, so a component
 * never names a palette colour.
 *
 * ONE SUBSTITUTION, explicit: three palettes have no `orange`, so the fallback is
 * written here rather than left to a blank value. `yellow` is the closest
 * relative in every one of the three, which is why it is the choice.
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
 * Express middleware: resolve the theme and expose it to every view.
 *
 * Sets `res.locals.theme`, so a template reads `theme.id`, `theme.selected` and
 * `theme.followingSystem` without any route having to know how a theme is chosen.
 *
 * The palette itself reaches the page through public/css/palette.css, keyed by
 * the data-theme attribute the views put on <html>. It is NOT inlined as a style
 * attribute: that would be a second copy of the colours, free to drift from the
 * stylesheet and repeated in every response.
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
