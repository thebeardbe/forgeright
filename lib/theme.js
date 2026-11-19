/**
 * Theme resolution: which palette a request should use, and its CSS variables. A cookie rather than
 * localStorage, because this runs on the server and must render the right palette into the HTML. A visit with
 * nothing stored is correct on the first paint.
 */
import { FOLLOW_SYSTEM, PALETTES, SYSTEM_DARK, SYSTEM_LIGHT, paletteById } from './palettes.js';

/** Prefixed to avoid colliding with anything else on the origin. */
export const THEME_COOKIE = 'fr_theme';

/** About two years, the ceiling browsers accept: a preference, not a session. */
export const THEME_COOKIE_MAX_AGE = 63_072_000;

/**
 * A cookie is attacker-editable, so the value is validated against the known palettes rather than trusted.
 *
 * @returns {string|null} A palette id, or FOLLOW_SYSTEM, or null for "no valid choice".
 */
export function parseThemeChoice(value) {
    if (typeof value !== 'string' || value === '') return null;
    if (value === FOLLOW_SYSTEM) return FOLLOW_SYSTEM;
    return paletteById(value) ? value : null;
}

/**
 * @param {object} options
 * @param {string|null} options.choice The stored choice, already parsed.
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
 * `prefers-color-scheme` is the only reliable signal. A missing hint returns false, and the inline script in
 * the head corrects it before paint.
 */
export function prefersDark(req) {
    const header = req.headers['sec-ch-prefers-color-scheme'];
    if (typeof header === 'string') return header.toLowerCase() === 'dark';

    // No client hint; the inline head script corrects it before paint.
    return false;
}

/**
 * Three palettes have no `orange`, so `yellow` is the fallback written here rather than a blank value.
 *
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
 * The palette reaches the page through public/css/palette.css, keyed by `data-theme`; it is not inlined, which
 * would be a second copy of the colours free to drift.
 */
export function themeMiddleware(req, res, next) {
    const choice = parseThemeChoice(req.cookies?.[THEME_COOKIE]);
    const resolved = resolveTheme({ choice, prefersDark: prefersDark(req) });

    res.locals.theme = {
        id: resolved.id,
        name: resolved.palette.name,
        mode: resolved.palette.colors.mode,
        followingSystem: resolved.followingSystem,
        // The stored choice, which may be "system" while a concrete palette is rendered.
        selected: choice === null ? FOLLOW_SYSTEM : choice,
        // For the inline head script, which repeats this client-side when the server's guess was wrong.
        systemDarkId: SYSTEM_DARK,
        systemLightId: SYSTEM_LIGHT
    };
    next();
}
