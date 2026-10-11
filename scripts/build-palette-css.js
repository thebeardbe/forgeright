/**
 * Generates public/css/palette.css from lib/palettes.js.
 *
 * A build step rather than a hand-written stylesheet, so the 22 palettes have one
 * home: the data module. Run with `node scripts/build-palette-css.js`.
 *
 * Not part of the request path. The generated file is committed, so the server
 * never runs this.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FOLLOW_SYSTEM, PALETTES, PALETTE_IDS, SYSTEM_DARK, SYSTEM_LIGHT } from '../lib/palettes.js';
import { paletteVars } from '../lib/theme.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'public', 'css', 'palette.css');

const HEADER = `/*
 * The 22 palettes as CSS custom properties, one block per theme.
 *
 * GENERATED FROM lib/palettes.js by scripts/build-palette-css.js. Do not edit by
 * hand: change the data module and regenerate, so the colours have one home.
 *
 * A palette is data in the module and variables here; nothing in this file
 * decides anything, and no component style names one of these colours.
 * public/css/app.css maps them onto semantic roles (--bg, --card, --accent),
 * which is what the components use.
 *
 * The names are --o-*, following the convention of the reference implementation
 * in the Pi Pocket repository. Alongside them --o-mode is "dark" or "light",
 * which app.css reads for the few values that depend on it.
 *
 * Applied as [data-theme="<id>"] on the html element, set server-side from the
 * theme cookie so the first paint is already correct.
 */
`;

/** One CSS block for a palette, as an array of lines. */
function block(selector, indent, palette, vars) {
    const pad = ' '.repeat(indent);
    const lines = [`${selector} {`, `${pad}--o-mode: ${palette.colors.mode};`];

    for (const [name, value] of Object.entries(vars)) {
        lines.push(`${pad}${name}: ${value};`);
    }
    lines.push('}');
    return lines;
}

const lines = [HEADER];

for (const id of PALETTE_IDS) {
    const palette = PALETTES[id];
    lines.push(`/* ${palette.name} (${palette.colors.mode}) */`);
    lines.push(...block(`[data-theme="${id}"]`, 4, palette, paletteVars(palette)));
    lines.push('');
}

// "Follow system", which is what an unreadable preference falls back to. The
// dark pair is the base, so a browser that does not support the media query gets
// a usable theme; the query then overrides it for a light preference.
lines.push(`/*
 * FOLLOW SYSTEM. The dark pair is the base value, so an unsupported browser still
 * gets a usable theme; the media query then overrides it for a light preference.
 *
 * The ids are Catppuccin and Catppuccin Latte: the same palette in the two modes,
 * so the OS preference chooses between two looks that were designed together.
 *
 * This is the same result the inline script in views/partials/theme.ejs produces,
 * so a browser without scripting still gets the system's preference.
 */`);
lines.push('@media (prefers-color-scheme: light) {');
lines.push(...block(`    [data-theme="${FOLLOW_SYSTEM}"]`, 8, PALETTES[SYSTEM_LIGHT], paletteVars(PALETTES[SYSTEM_LIGHT])));
lines.push('}');
lines.push('');
lines.push(...block(`[data-theme="${FOLLOW_SYSTEM}"]`, 4, PALETTES[SYSTEM_DARK], paletteVars(PALETTES[SYSTEM_DARK])));
lines.push('');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, lines.join('\n'));
console.log(`wrote ${path.relative(process.cwd(), OUT)} (${PALETTE_IDS.length} palettes, ${lines.length} lines)`);
