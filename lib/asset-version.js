/**
 * A VERSION STAMP FOR THE TWO SCRIPTS THE QUESTIONNAIRE PAGE LOADS.
 *
 * THE PROBLEM THIS SOLVES. public/js/audit.js prefers `window.saveOutcome` whenever it exists, and
 * save-outcome.global.js is what installs it. A browser holding a CACHED older save-outcome.global.js
 * beside a FRESH audit.js therefore runs the old rule and never touches the new module. No error, no
 * warning: the participant gets whatever the stale copy says. `express.static` sends
 * `Cache-Control: public, max-age=0` with an ETag and Last-Modified, so a correct revalidation picks up
 * the new file, but a proxy or a browser that does not revalidate keeps the old one across a deploy.
 *
 * THE STAMP IS A CONTENT HASH, and that is the point: it is derived from the bytes on disk, so it changes
 * exactly when a file changes and nobody has to remember to bump it. A hand-maintained version number is
 * wrong precisely when it matters, because the person changing a file is the person who forgets. A build
 * id from a deployment pipeline would be correct too, but this app has no pipeline to ask, and the mtime
 * would change on a checkout or a copy without the content changing.
 *
 * WHAT IT DOES AND DOES NOT DO, stated plainly because it is easy to overclaim:
 *
 *   It makes a MISMATCHED PAIR highly unlikely: a new audit.js is served with a query string the old
 *   cached save-outcome.global.js was not fetched under, so the browser treats them as different URLs.
 *
 *   It does NOT make a stale pair impossible. A proxy that ignores the query string, a service worker, or
 *   a browser serving the HTML page itself from cache across a deploy can still pair an old global with a
 *   new audit.js. The stamp removes the ordinary case, which is one file revalidating and the other not.
 *
 * WHY ONE STAMP FOR BOTH FILES. The two must agree with each other, so the stamp covers both: it is the
 * hash of their contents together, and changing either changes the URL of both. Stamping them separately
 * would let one change while the other kept a URL a cache had already answered.
 *
 * The hash is computed once, at startup, because the files are read from disk a single time and do not
 * change while the process runs. In development a restart is how a change reaches the server anyway.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** The scripts whose agreement the stamp protects. Order matters only for determinism. */
export const VERSIONED_SCRIPTS = Object.freeze(['save-outcome.global.js', 'audit.js']);

/**
 * A short content hash over the named scripts.
 *
 * Sixteen hex characters from a SHA-256: collision is not a concern for two files, and a short string
 * keeps the HTML readable and the URL inside any proxy's limits.
 *
 * A MISSING FILE IS REPORTED, NOT IGNORED. If a name is mistyped, hashing the remaining files would
 * produce a stamp that changes for the wrong reason and a page that silently loads one script. Throwing at
 * startup makes that a boot failure, which is where it is cheap to fix.
 *
 * @param {string[]} names file names inside public/js
 * @param {string} dir the directory holding them
 * @returns {Promise<string>}
 */
export async function computeAssetVersion(names, dir) {
    const hash = crypto.createHash('sha256');

    for (const name of names) {
        const file = path.join(dir, name);
        let contents;
        try {
            contents = await fs.readFile(file);
        } catch (err) {
            throw new Error(
                `Cannot version the questionnaire's scripts: ${file} could not be read (${err.code}). `
                + 'Every name in VERSIONED_SCRIPTS must exist in public/js.'
            );
        }
        // The name is hashed too, so renaming one file without changing the other still changes the stamp.
        hash.update(name);
        hash.update(contents);
    }

    return hash.digest('hex').slice(0, 16);
}
