/**
 * The 22 palettes, assembled from the data files beside this one, which hold the colour values and nothing
 * else.
 *
 * Three palettes have no `orange`, which is a property of the upstream theme data rather than an omission;
 * the value is `null` so it is visible, and `paletteVars` in lib/theme.js names the fallback.
 */
import { DARK_PALETTES_A } from './palettes-dark-a.js';
import { DARK_PALETTES_B } from './palettes-dark-b.js';
import { LIGHT_PALETTES } from './palettes-light.js';

/**
 * Every key a palette carries, so a mapping reads one list rather than guessing. `mode` drives the default
 * when the choice is "follow system"; the rest are colours.
 */
export const PALETTE_KEYS = [
    'mode',
    'background', 'foreground', 'accent', 'selection', 'muted',
    'dark_background', 'darker_background', 'lighter_background',
    'dark_foreground', 'light_foreground', 'bright_foreground',
    'red', 'yellow', 'orange', 'green', 'cyan', 'blue', 'magenta', 'bright_yellow'
];

/**
 * Every palette by id, dark themes first and then light, so a menu built from the key order groups them
 * naturally.
 */
export const PALETTES = {
    ...DARK_PALETTES_A,
    ...DARK_PALETTES_B,
    ...LIGHT_PALETTES
};

/** The palette ids in menu order. */
export const PALETTE_IDS = Object.keys(PALETTES);

/**
 * The pair used when the choice is "follow system". They are not the same palette in two modes: every
 * palette exposes the same semantic roles and no component names a colour, so the pair does not have to be
 * one design.
 *
 * Both values must stay in step with `@media (prefers-color-scheme: light)` in palette.css, which carries the
 * light half's variables for the case where the OS preference is known before the page loads; change one
 * without the other and the theme resolves to the wrong half.
 */
export const SYSTEM_DARK = 'matte-black';
export const SYSTEM_LIGHT = 'catppuccin-latte';

/** The id that means "follow the system's preference" rather than a fixed palette. */
export const FOLLOW_SYSTEM = 'system';

/**
 * A palette by id, or null when the id is unknown. Null rather than a fallback, so a caller that offers one
 * can say which it chose instead of hiding a bad cookie value behind a theme that looks fine.
 *
 * @param {string} id
 * @returns {{name: string, colors: object}|null}
 */
export function paletteById(id) {
    return PALETTES[id] ?? null;
}
