/**
 * The application's paths: where it is mounted, and where it is seen from.
 *
 * TWO PREFIXES, NOT ONE, because a reverse proxy separates them. `BASE_PATH` is where
 * the app is MOUNTED - the path it expects and Express strips before routes run.
 * `PUBLIC_PATH` is where it is VISIBLE - the prefix every emitted URL must carry:
 * redirects, form actions, asset URLs, the session cookie's Path.
 *
 * `tailscale serve` forced them apart: it maps /forgeright here and STRIPS the prefix,
 * so the app sees "/" while the browser is at "/forgeright/". MEASURED through the
 * proxy: BASE_PATH=/forgeright answered 404 for a request sent "/"; BASE_PATH empty
 * served the page but emitted `src="/js/audit.js"` and `Location: /admin/login`, which
 * the browser resolves at the HOST ROOT - a 404 asset and a redirect out of the mount.
 *
 *   proxy passes it through   BASE_PATH=/forgeright  PUBLIC_PATH=/forgeright
 *   proxy strips it           BASE_PATH=             PUBLIC_PATH=/forgeright
 *   no prefix                 BASE_PATH=             PUBLIC_PATH=
 *
 * PUBLIC_PATH IS DERIVED, NOT A THIRD VARIABLE: `PUBLIC_BASE_URL` already ends with the
 * public path, so its pathname IS the prefix. Deriving it stops an operator setting the
 * two inconsistently. It is an explicit override only when the emitted prefix must
 * differ from that path, which is unusual enough to be set deliberately.
 *
 * Both resolve once at module load, so nothing changes them under a running process.
 */

/**
 * Characters allowed in a prefix: segments of letters, digits, hyphen, underscore
 * and dot. Excludes "..", spaces, "#", "?" and repeated slashes: a prefix is a
 * place, not an expression, and a value that needs any of those would produce
 * broken URLs silently.
 */
const PATH_PATTERN = /^\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/** A segment that is all dots is a traversal, not a name. */
const TRAVERSAL_SEGMENT = /^\.+$/;

/**
 * Normalises and validates a prefix value.
 *
 * Accepts "forgeright" or "/forgeright", strips a trailing slash, and returns ""
 * for empty or unset. Refuses anything that is not a single safe path prefix, by
 * throwing: a bad prefix produces URLs that 404 in a way that looks like a
 * missing file rather than a misconfiguration, so it must fail at startup where
 * the operator is looking.
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

    // A missing leading slash is the common typo (forgeright), so add it rather
    // than refusing. Everything else is validated as given.
    const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;

    // Strip trailing slashes so "/forgeright/" and "/forgeright" are one value.
    // The bare "/" means the root, which is the same as unset.
    const stripped = withSlash.replace(/\/+$/, '');
    if (stripped === '') return '';

    if (!PATH_PATTERN.test(stripped)) {
        throw new Error(
            `${label}=${JSON.stringify(raw)} is not a usable path prefix. ` +
            'Expected one or more path segments of letters, digits, hyphen, underscore or dot, ' +
            `for example ${label}=/forgeright. Leave it empty to serve at the root.`
        );
    }

    // ".." anywhere would let the prefix climb out of the proxy's location, and a
    // segment of only dots is a traversal spelled differently. Checked per
    // segment because the pattern allows dots inside a name (v1.2 is fine).
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
 * The path component of PUBLIC_BASE_URL, or "" when there is none.
 *
 * Returns null when PUBLIC_BASE_URL is unset or unparseable, so the caller can
 * tell "no public path is configured" from "the public path is the root". Those
 * are different: the first leaves an explicit PUBLIC_PATH in charge, the second
 * means the site is at an origin with no path at all.
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

    // The pathname is already normalised by URL (no trailing slash, except "/").
    return parsed.pathname === '/' ? '' : parsed.pathname;
}

/**
 * The path this app is MOUNTED at: what an incoming request carries before the
 * routes run.
 *
 * Empty means the app expects requests at the root, which is right for a proxy
 * that strips its prefix before forwarding.
 */
export const BASE_PATH = normalisePrefix(process.env.BASE_PATH, 'BASE_PATH');

/**
 * The path this app is VISIBLE at: the prefix every emitted URL must carry.
 *
 * Derived from PUBLIC_BASE_URL's path so the mailed link, the redirects, the
 * asset URLs and the cookie Path cannot disagree. PUBLIC_PATH overrides it, for
 * the unusual case where they must differ.
 *
 * An explicit PUBLIC_PATH is validated and then CROSS-CHECKED against the derived
 * value: if both are set and disagree, startup fails, because the alternative is
 * a site whose links point somewhere it is not served.
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

    // Neither is available. Fall back to the mount path, which is right for the
    // common case of a proxy that passes its prefix through.
    return BASE_PATH;
})();

/**
 * Prefixes an absolute application path for the BROWSER.
 *
 * Uses PUBLIC_PATH, not BASE_PATH, because the browser is outside the mount: a
 * stripping proxy means the path the app receives and the path the browser uses
 * are different strings.
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
