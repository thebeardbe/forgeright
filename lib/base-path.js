/**
 * The application's paths: where it is mounted, and where it is seen from.
 *
 * Two prefixes rather than one, because a reverse proxy separates them. `BASE_PATH` is where the app is
 * mounted, and Express strips it before routes run. `PUBLIC_PATH` is where the app is visible, and every
 * emitted URL must carry it.
 *
 *   proxy passes it through   BASE_PATH=/forgeright  PUBLIC_PATH=/forgeright
 *   proxy strips it           BASE_PATH=             PUBLIC_PATH=/forgeright
 *   no prefix                 BASE_PATH=             PUBLIC_PATH=
 *
 * `PUBLIC_PATH` is derived from `PUBLIC_BASE_URL`'s pathname so an operator cannot set the two
 * inconsistently; the explicit override is for the unusual case where they must differ. Both resolve once
 * at module load.
 */

/**
 * Characters allowed in a prefix: segments of letters, digits, hyphen, underscore and dot, which excludes
 * "..", spaces, "#", "?" and repeated slashes.
 */
const PATH_PATTERN = /^\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/** A segment that is all dots is a traversal, not a name. */
const TRAVERSAL_SEGMENT = /^\.+$/;

/**
 * Normalises and validates a prefix value: accepts "forgeright" or "/forgeright", strips a trailing slash,
 * and returns "" for empty or unset. It throws rather than refusing anything else, because a bad prefix
 * produces 404s that look like a missing file rather than a misconfiguration.
 *
 * @param {unknown} raw The value.
 * @param {string} label The variable name, for the error message.
 * @returns {string} "" for the root, otherwise a leading-slash prefix with no
 *   trailing slash.
 * @throws {Error} Naming the offending value when it is not usable.
 */
export function normalisePrefix(raw, label = 'prefix') {
    if (raw === undefined || raw === null) return '';

    const trimmed = String(raw).trim();
    if (trimmed === '') return '';

    // A missing leading slash is the common typo, so it is added rather than refused.
    const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;

    // So "/forgeright/" and "/forgeright" are one value; a bare "/" means the root.
    const stripped = withSlash.replace(/\/+$/, '');
    if (stripped === '') return '';

    if (!PATH_PATTERN.test(stripped)) {
        throw new Error(
            `${label}=${JSON.stringify(raw)} is not a usable path prefix. ` +
            'Expected one or more path segments of letters, digits, hyphen, underscore or dot, ' +
            `for example ${label}=/forgeright. Leave it empty to serve at the root.`
        );
    }

    // ".." would let the prefix climb out of the proxy's location. Checked per segment, because the pattern
    // allows dots inside a name.
    for (const segment of stripped.split('/').filter(Boolean)) {
        if (segment === '..' || TRAVERSAL_SEGMENT.test(segment)) {
            throw new Error(
                `${label}=${JSON.stringify(raw)} contains a traversal segment (${JSON.stringify(segment)}), ` +
                'which would escape the prefix rather than name it. Refusing.'
            );
        }
    }

    return stripped;
}

/**
 * The path component of PUBLIC_BASE_URL, or "" when there is none. It returns null when PUBLIC_BASE_URL is
 * unset or unparseable, so the caller can tell "no public path configured" from "the public path is the
 * root".
 *
 * @returns {string|null}
 */
export function publicPathFromBaseUrl() {
    const configured = process.env.PUBLIC_BASE_URL;
    if (!configured || configured.trim() === '') return null;

    let parsed;
    try {
        parsed = new URL(configured.trim());
    } catch (err) {
        console.warn(
            `[base-path] PUBLIC_BASE_URL=${JSON.stringify(configured)} is not a parseable URL ` +
            `(${err.message}), so the public path cannot be derived from it.`
        );
        return null;
    }

    // `pathname` is already normalised by URL.
    return parsed.pathname === '/' ? '' : parsed.pathname;
}

/**
 * The path this app is mounted at: what an incoming request carries before the routes run. Empty means the
 * app expects requests at the root, which is right for a proxy that strips its prefix.
 */
export const BASE_PATH = normalisePrefix(process.env.BASE_PATH, 'BASE_PATH');

/**
 * The path this app is visible at: the prefix every emitted URL must carry, derived from PUBLIC_BASE_URL's
 * path so the mailed link, the redirects and the cookie Path cannot disagree.
 *
 * An explicit PUBLIC_PATH is cross-checked against the derived value, because if both are set and disagree
 * the site's links point somewhere it is not served.
 */
export const PUBLIC_PATH = (() => {
    const explicit = normalisePrefix(process.env.PUBLIC_PATH, 'PUBLIC_PATH');
    const derived = publicPathFromBaseUrl();

    if (explicit !== '' && derived !== null && explicit !== derived) {
        throw new Error(
            `PUBLIC_PATH=${JSON.stringify(explicit)} and the path in PUBLIC_BASE_URL ` +
            `(${JSON.stringify(derived)}) disagree. Emitted URLs would point at one place while the ` +
            'site is reached at another. Set only one of them, or make them match.'
        );
    }

    // An explicit value wins when PUBLIC_BASE_URL is unset or unparseable.
    if (explicit !== '') return explicit;
    if (derived !== null) return derived;

    // Neither is available, so fall back to the mount path.
    return BASE_PATH;
})();

/**
 * Prefixes an absolute application path for the browser. It uses PUBLIC_PATH rather than BASE_PATH, because
 * a stripping proxy means the path the app receives and the path the browser uses are different strings.
 *
 * @param {string} appPath A path beginning with "/", for example "/api/chat".
 * @returns {string} The prefixed path, or the input unchanged at the root.
 */
export function withBasePath(appPath) {
    if (typeof appPath !== 'string' || !appPath.startsWith('/')) {
        throw new Error(`withBasePath requires an absolute path, got ${JSON.stringify(appPath)}.`);
    }
    return `${PUBLIC_PATH}${appPath}`;
}

/**
 * Where the app is mounted, for logging: "the root" reads better than "".
 *
 * @returns {string}
 */
export function describeMount() {
    return BASE_PATH === '' ? 'the root' : BASE_PATH;
}

/**
 * Where the app is visible, for logging.
 *
 * @returns {string}
 */
export function describePublicPath() {
    return PUBLIC_PATH === '' ? 'the origin root' : PUBLIC_PATH;
}
