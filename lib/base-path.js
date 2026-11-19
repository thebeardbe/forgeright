/**
 * The application's paths. Two prefixes rather than one, because a reverse proxy separates them: `BASE_PATH`
 * is where the app is mounted (Express strips it before routes run) and `PUBLIC_PATH` is where it is visible
 * (every emitted URL must carry it).
 *
 *   proxy passes it through   BASE_PATH=/forgeright  PUBLIC_PATH=/forgeright
 *   proxy strips it           BASE_PATH=             PUBLIC_PATH=/forgeright
 *   no prefix                 BASE_PATH=             PUBLIC_PATH=
 */

/** Segments of letters, digits, hyphen, underscore and dot: excludes "..", spaces, "#", "?" and repeated slashes. */
const PATH_PATTERN = /^\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/** A segment that is all dots is a traversal, not a name. */
const TRAVERSAL_SEGMENT = /^\.+$/;

/**
 * Normalises and validates a prefix: accepts "forgeright" or "/forgeright", strips a trailing slash, and
 * returns "" for empty. It throws, because a bad prefix produces 404s that look like a missing file.
 *
 * @returns {string} "" for the root, otherwise a leading-slash prefix with no trailing slash.
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
 * Null when PUBLIC_BASE_URL is unset or unparseable, so the caller can tell "no public path configured" from
 * "the public path is the root".
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

/** Empty means the app expects requests at the root, which is right for a proxy that strips its prefix. */
export const BASE_PATH = normalisePrefix(process.env.BASE_PATH, 'BASE_PATH');

/**
 * Derived from PUBLIC_BASE_URL's path so the mailed link, the redirects and the cookie Path cannot disagree.
 * An explicit PUBLIC_PATH is cross-checked, because if both are set and disagree the links point elsewhere.
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
 * PUBLIC_PATH rather than BASE_PATH, because a stripping proxy means the path the app receives and the path
 * the browser uses differ.
 *
 * @param {string} appPath A path beginning with "/", for example "/api/chat".
 * @returns {string} The prefixed path.
 */
export function withBasePath(appPath) {
    if (typeof appPath !== 'string' || !appPath.startsWith('/')) {
        throw new Error(`withBasePath requires an absolute path, got ${JSON.stringify(appPath)}.`);
    }
    return `${PUBLIC_PATH}${appPath}`;
}

/** "the root" reads better than "" in a log line. */
export function describeMount() {
    return BASE_PATH === '' ? 'the root' : BASE_PATH;
}


export function describePublicPath() {
    return PUBLIC_PATH === '' ? 'the origin root' : PUBLIC_PATH;
}
