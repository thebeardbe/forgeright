/**
 * Formatting helpers for the views.
 *
 * ONE HOME FOR PRESENTATION RULES, so a value reads the same wherever it appears and a
 * change lands once. The alternative - each template calling a method on the raw value -
 * is how the same timestamp ends up in two formats on two pages.
 *
 * NOT A LOCALISATION LAYER. The console is for one operator reading their own data, and
 * the strings it shows come from the participant or the model rather than from this
 * module. What lives here is the small set of values whose RAW FORM is unreadable or too
 * wide for a page, and nothing else.
 */

/**
 * A stored instant as a short, readable date and time.
 *
 * WHY THIS EXISTS. Every timestamp was rendered as the stored ISO string -
 * `2026-10-12T05:51:45.377Z`, twenty-four characters - and the invitations table carries
 * TWO of them per row across eight rows. Measured in a browser at 390px, that table was
 * **609px wide inside a 374px card**, so its action buttons rendered outside the card on
 * the page background, and at 1280px it still overflowed (609px against 934px). The
 * milliseconds and the `Z` and `T` are three quarters of the width and none of the
 * meaning: a reader needs the date and roughly the time.
 *
 * THE OUTPUT IS DELIBERATELY UNAMBIGUOUS RATHER THAN LOCALE-FORMATTED. `Intl` would give
 * `12/10/2026` in one locale and `10/12/2026` in another, and this project's timestamps
 * are UTC while its reader is in Brussels - so a bare `12/10` is a date that means two
 * different days depending on who reads it. `2026-10-12 05:51` reads the same everywhere,
 * sorts correctly as text, and drops nine characters and both wrapping points.
 *
 * THE ZONE IS LABELLED AND NOT CONVERTED. Converting to the reader's zone would be
 * friendlier and would also make a stored value unrecoverable from the screen: an
 * operator comparing a timestamp to a log or a database row needs the UTC instant, and
 * the `UTC` suffix is what tells them that is what they are looking at.
 *
 * @param {string|null|undefined} value The stored ISO 8601 instant.
 * @returns {string} `YYYY-MM-DD HH:MM UTC`, or an empty string when there is no value.
 *   Empty rather than a placeholder, because "no timestamp" is a real state (an
 *   invitation nobody opened) and the views already branch on it.
 */
export function shortInstant(value) {
    if (typeof value !== 'string' || value.trim() === '') return '';

    // Parsed rather than sliced, so a value that is NOT the stored shape is reported
    // instead of being cut into something that looks like a date. A slice would render
    // `not a date` as `not a date`, silently.
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) {
        console.warn(`[views] a timestamp could not be parsed: ${JSON.stringify(value)}`);
        // The raw value is returned rather than an empty string: an operator seeing a
        // strange value learns something, and one seeing nothing learns nothing.
        return value;
    }

    const d = new Date(parsed);
    const pad = (n) => String(n).padStart(2, '0');
    const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    return `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/**
 * A duration in milliseconds as a short human phrase, for the session line.
 *
 * Kept beside `shortInstant` because both exist to make one stored value readable rather
 * than to format arbitrary numbers.
 *
 * @param {number} milliseconds
 * @returns {string}
 */
export function shortDuration(milliseconds) {
    if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds) || milliseconds < 0) return '';
    const minutes = Math.round(milliseconds / 60_000);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} h`;
    return `${Math.round(hours / 24)} days`;
}

/**
 * The workflow a stored response should be read as, whatever shape it was saved in.
 *
 * WHY THIS EXISTS. A response is stored in one of two shapes and the views read one of them:
 *
 *   an INTERVIEW round saves `{ workflows: [ ... ] }`  - what the client posts
 *   an IMPORTED round saves the workflow directly      - what the demo seed and the API write
 *
 * The views read `response.data.task`, which is undefined for every interview round, so
 * EVERY live interview rendered as "Untitled answer" with no fields at all. Both halves are
 * old - the view was written against the imported shape before the interview existed - and the
 * inconsistency was visible inside a single file, where `presentsNoEvidence` iterates
 * `data.workflows` two lines above a read of `data.task` on the same object.
 *
 * ONE RESOLVER RATHER THAN A FALLBACK AT EACH READ SITE, because there are three of them (the
 * title, the fields partial, the roadmap) and a fallback written three times is a fallback that
 * drifts. It returns the FIRST workflow: a round is the work of one process, so a round with
 * several is a shape the round model does not produce, and showing the first is honest rather
 * than merging them into something that was never said.
 *
 * IT NEVER THROWS. A malformed or absent payload returns null and the caller decides what to
 * show, which is what keeps a corrupt row from taking the page down.
 *
 * @param {object|null} data The parsed response data.
 * @returns {object|null} The workflow to read fields from, or null when there is none.
 */
export function responseWorkflow(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;

    // The interview shape first, because that is what a live round saves.
    if (Array.isArray(data.workflows)) {
        return data.workflows.find((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)) ?? null;
    }

    // The imported shape: the workflow IS the data. An empty object counts as nothing to show,
    // so a row with `{}` renders as untitled rather than as a heading that is not there.
    return Object.keys(data).length > 0 ? data : null;
}

/**
 * The heading for a stored response, from whichever shape it holds.
 *
 * `Untitled answer` IS A GENUINE FALLBACK rather than the usual case, which is the difference
 * this makes: before, it was what EVERY interview round displayed.
 *
 * @param {object|null} data The parsed response data.
 * @returns {string}
 */
export function responseTitle(data) {
    const workflow = responseWorkflow(data);
    const task = workflow && typeof workflow.task === 'string' ? workflow.task.trim() : '';
    return task !== '' ? task : 'Untitled answer';
}
