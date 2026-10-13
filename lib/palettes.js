/**
 * The 22 palettes, assembled from the data files beside this one.
 *
 * A palette is colours and a mode, nothing else, so the data lives in
 * palettes-dark-a.js, palettes-dark-b.js and palettes-light.js and this module
 * is only the index over them. The values come from the Omarchy theme sets used
 * by the reference implementation in the Pi Pocket repository: they are colour
 * values rather than code, transcribed to avoid hand-copying twenty colours
 * across twenty-two tables.
 *
 * WHAT IS DELIBERATELY NOT HERE, because it belongs to Pi Pocket rather than to a
 * palette: its "follow the desktop" feature (which reads a theme from a server)
 * and the hyprland_active_border / hyprland_inactive_border keys, which drive
 * tiled window borders. Neither means anything in this application.
 *
 * MISSING VALUES, STATED RATHER THAN HIDDEN. Three palettes have no `orange`:
 * last-horizon, solitude and white. That is a property of the upstream theme
 * data, not an omission here, and the value is `null` in the table so it is
 * visible. lib/theme-vars.js names the fallback it uses, so the substitution is
 * one line in one place rather than a blank that appears as an unstyled element.
 */
import { DARK_PALETTES_A } from './palettes-dark-a.js';
import { DARK_PALETTES_B } from './palettes-dark-b.js';
import { LIGHT_PALETTES } from './palettes-light.js';

/**
 * Every key a palette carries, so a mapping reads one list rather than guessing.
 *
 * `mode` drives the default when the choice is "follow system"; the rest are
 * colours. `muted` is the one that is easy to miss: it is the dimmed foreground
 * some themes name separately from `dark_foreground`.
 */
export const PALETTE_KEYS = [
    'mode',
    'background', 'foreground', 'accent', 'selection', 'muted',
    'dark_background', 'darker_background', 'lighter_background',
    'dark_foreground', 'light_foreground', 'bright_foreground',
    'red', 'yellow', 'orange', 'green', 'cyan', 'blue', 'magenta', 'bright_yellow'
];

/**
 * Every palette by id.
 *
 * Dark themes first, then light, so a menu built from the key order groups them
 * naturally without a rule of its own.
 */
export const PALETTES = {
    ...DARK_PALETTES_A,
    ...DARK_PALETTES_B,
    ...LIGHT_PALETTES
};

/** The palette ids in menu order. */
export const PALETTE_IDS = Object.keys(PALETTES);

/**
 * The pair used when the choice is "follow system".
 *
 * THESE TWO ARE NOT THE SAME PALETTE ANY MORE, and that is a decision rather than an accident
 * of history. They were `catppuccin` and `catppuccin-latte` - one theme in its two modes, chosen
 * because a pair designed together cannot clash. The owner picked this pair instead: **Matte
 * Black for dark, Catppuccin Latte for light**, which is a near-black and a soft light rather
 * than two shades of one design. The two are legible together regardless, because every palette
 * here exposes the same SEMANTIC ROLES and no component names a colour - so nothing in the
 * application has to agree with this choice.
 *
 * BOTH VALUES MUST STAY IN STEP WITH `@media (prefers-color-scheme: light)` IN palette.css. That
 * block carries the light half's variables for the case where the OS preference is known before
 * the page loads, and the ids here are what the inline script in theme-head.ejs swaps in. Change
 * one without the other and the theme flickers or resolves to the wrong half.
 */
export const SYSTEM_DARK = 'matte-black';
export const SYSTEM_LIGHT = 'catppuccin-latte';

/** The id that means "follow the system's preference" rather than a fixed palette. */
export const FOLLOW_SYSTEM = 'system';

/**
 * A palette by id, or null when the id is unknown.
 *
 * Returns null rather than a fallback: a caller that offers a fallback can say
 * which one it chose, whereas a silent default here would hide a bad cookie
 * value behind a theme that happens to look fine.
 *
 * @param {string} id
 * @returns {{name: string, colors: object}|null}
 */
export function paletteById(id) {
    return PALETTES[id] ?? null;
}
