/**
 * The application's paths: where it is mounted, and where it is seen from.
 *
 * TWO PREFIXES, NOT ONE, because a reverse proxy separates them: `BASE_PATH` is where this app is
 * MOUNTED, so the path it expects to receive and Express strips before the routes run;
 * `PUBLIC_PATH` is where it is VISIBLE, so the prefix every URL it emits must carry - redirects,
 * form actions, asset URLs and the session cookie's Path.
 *
 * THE DEPLOYMENT THAT FORCED THEM APART is `tailscale serve`, which maps /forgeright to this
 * container and STRIPS the prefix, so the app sees "/" while the browser is at "/forgeright/".
 * MEASURED through the real proxy: with BASE_PATH=/forgeright the app expected the prefix and
 * answered 404 for a request sent "/"; with BASE_PATH empty the page served but emitted
 * `src="/js/audit.js"` and `Location: /admin/login`, which the browser resolves at the HOST ROOT -
 * a 404 for the asset and a redirect that leaves the mount. So the internal prefix had to empty
 * while the public prefix stayed.
 *
 * The three modes, and which value each needs:
 *
 *   proxy passes the prefix through  BASE_PATH=/forgeright  PUBLIC_PATH=/forgeright
 *   proxy strips the prefix          BASE_PATH=             PUBLIC_PATH=/forgeright
 *   no prefix at all                 BASE_PATH=             PUBLIC_PATH=
 *
 * PUBLIC_PATH IS DERIVED, NOT A THIRD VARIABLE. PUBLIC_BASE_URL already ends with
 * the public path (it is the URL the site is reached at, used for mailed links
 * and redirects), so its pathname IS the public prefix. Deriving it means an
 * operator cannot set the two inconsistently, and there is one fewer knob to get
 * wrong. PUBLIC_PATH exists as an explicit override for the case where the
 * emitted prefix must differ from PUBLIC_BASE_URL's path, which is unusual enough
 * that it should be set deliberately.
 *
 * Both are resolved once, at module load, so nothing can change them underneath a
 * running process.
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
