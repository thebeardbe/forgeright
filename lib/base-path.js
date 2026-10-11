/**
 * The application's base path.
 *
 * A reverse proxy may mount this app under a prefix rather than at the root, for
 * example https://host/forgeright. Every URL the app emits and every route it
 * serves must then carry that prefix, or the proxy's stripped path reaches no
 * route and the browser's root-relative links miss.
 *
 * ONE SOURCE OF TRUTH. The prefix is read and validated here, once, at module
 * load. The server mounts its routers with it, the views read it from
 * res.locals, and the client reads it from the page config. Nothing hand-writes
 * the prefix, so "which prefix?" is answered in one place.
 *
 * The empty string means "served at the root", which is the default and the
 * existing behaviour. Express treats app.use('', router) as app.use(router), so
 * an empty prefix needs no special case at the mount points; the helpers below
 * return root-relative paths unchanged when the prefix is empty.
 */

/**
 * Characters allowed in the prefix: one or more path segments of letters,
 * digits, hyphen, underscore and dot. Deliberately excludes "..", spaces, "#",
 * "?" and repeated slashes: a prefix is a place, not an expression, and a value
 * that needs any of those is a mistake that would produce broken URLs silently.
 */
const BASE_PATH_PATTERN = /^\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/** A segment that is all dots is a traversal, not a name. */
const TRAVERSAL_SEGMENT = /^\.+$/;

/**
 * Normalises and validates a BASE_PATH value.
 *
 * Accepts "forgeright" or "/forgeright", strips a trailing slash, and returns
 * "" for empty or unset. Refuses anything that is not a single safe path
 * prefix, by throwing: a bad prefix produces URLs that 404 in a way that looks
 * like a missing file rather than a misconfiguration, so it must fail at
 * startup where the operator is looking.
 *
 * @param {unknown} raw The environment value.
 * @returns {string} "" for the root, otherwise a leading-slash prefix with no
 *   trailing slash.
 * @throws {Error} Naming the offending value when it is not usable.
 */
export function normaliseBasePath(raw) {
    if (raw === undefined || raw === null) return '';

    const trimmed = String(raw).trim();
    if (trimmed === '') return '';

    // A missing leading slash is the common typo (BASE_PATH=forgeright), so add it
    // rather than refusing. Everything else is validated as given.
    const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;

    // Strip trailing slashes so "/forgeright/" and "/forgeright" are one value.
    // The bare "/" means the root, which is the same as unset.
    const stripped = withSlash.replace(/\/+$/, '');
    if (stripped === '') return '';

    if (!BASE_PATH_PATTERN.test(stripped)) {
        throw new Error(
            `BASE_PATH=${JSON.stringify(raw)} is not a usable base path. ` +
            'Expected one or more path segments of letters, digits, hyphen, underscore or dot, ' +
            'for example BASE_PATH=/forgeright. Leave it empty to serve at the root.'
        );
    }

    // ".." anywhere would let the prefix climb out of the proxy's location, and a
    // segment of only dots is a traversal spelled differently. Checked per
    // segment because the pattern above allows dots inside a name (v1.2 is fine).
    for (const segment of stripped.split('/').filter(Boolean)) {
        if (segment === '..' || TRAVERSAL_SEGMENT.test(segment)) {
            throw new Error(
                `BASE_PATH=${JSON.stringify(raw)} contains a traversal segment (${JSON.stringify(segment)}), ` +
                'which would escape the prefix rather than name it. Refusing.'
            );
        }
    }

    return stripped;
}

/**
 * The configured base path, resolved once.
 *
 * Read at module load rather than per request, so the value cannot change
 * underneath a running process and every consumer sees the same string.
 */
export const BASE_PATH = normaliseBasePath(process.env.BASE_PATH);

/**
 * Prefixes an absolute application path.
 *
 * @param {string} appPath A path beginning with "/", for example "/api/chat".
 * @returns {string} The prefixed path, or the input unchanged when at the root.
 */
export function withBasePath(appPath) {
    if (typeof appPath !== 'string' || !appPath.startsWith('/')) {
        throw new Error(`withBasePath requires an absolute path, got ${JSON.stringify(appPath)}.`);
    }
    return `${BASE_PATH}${appPath}`;
}
