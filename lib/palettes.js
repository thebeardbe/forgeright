/** The 22 palettes, assembled from the data files beside this one, which hold the colour values only. */
import { DARK_PALETTES_A } from './palettes-dark-a.js';
import { DARK_PALETTES_B } from './palettes-dark-b.js';
import { LIGHT_PALETTES } from './palettes-light.js';

/** `mode` drives the default when the choice is "follow system"; the rest are colours. */
export const PALETTE_KEYS = [
    'mode',
    'background', 'foreground', 'accent', 'selection', 'muted',
    'dark_background', 'darker_background', 'lighter_background',
    'dark_foreground', 'light_foreground', 'bright_foreground',
    'red', 'yellow', 'orange', 'green', 'cyan', 'blue', 'magenta', 'bright_yellow'
];

/** Dark themes first, then light, so a menu built from the key order groups them naturally. */
export const PALETTES = {
    ...DARK_PALETTES_A,
    ...DARK_PALETTES_B,
    ...LIGHT_PALETTES
};

export const PALETTE_IDS = Object.keys(PALETTES);

/**
 * The pair used when the choice is "follow system". Both must stay in step with the
 * `prefers-color-scheme: light` block in palette.css, or the theme resolves to the wrong half.
 */
export const SYSTEM_DARK = 'matte-black';
export const SYSTEM_LIGHT = 'catppuccin-latte';

/** The id that means "follow the system's preference" rather than a fixed palette. */
export const FOLLOW_SYSTEM = 'system';

/**
 * Null rather than a fallback, so a caller that offers one can say which it chose instead of hiding a bad
 * cookie value behind a theme that looks fine.
 *
 * @returns {{name: string, colors: object}|null}
 */
export function paletteById(id) {
    return PALETTES[id] ?? null;
}
