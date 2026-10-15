/**
 * Store locations and path safety: an organisation id is validated as one path component before being
 * joined into a filename, and the file it names must be a regular file inside the store directory rather
 * than a symlink.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Repository root, two levels up from lib/store. */
const PROJECT_ROOT = path.join(__dirname, '..', '..');

/** Default store location, overridable with STORE_DIR so a volume can be mounted. */
const DEFAULT_STORE_DIR = path.join(PROJECT_ROOT, 'data', 'store');

/** Subdirectory holding one database file per organisation. */
const ORGS_DIRNAME = 'orgs';

/** Suffix of an organisation database file. */
const DB_SUFFIX = '.db';

/** A literal this module constructs, never a value from a request. */
const ADMIN_DB_NAME = 'admin.db';

/** Lowercase letters, digits and hyphens, starting with a letter or digit. */
const ORG_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * @returns {string} Absolute path of the store root.
 */
export function storeDir() {
    return process.env.STORE_DIR || DEFAULT_STORE_DIR;
}

/**
 * Validates an organisation id as a single safe path component. It says nothing about what the resulting
 * path points at, which is assertOpenableDatabaseFile's job.
 *
 * @param {unknown} orgId
 * @returns {string} The id, unchanged, when it is safe.
 * @throws {Error} Naming the offending value when it is not.
 */
export function assertSafeOrgId(orgId) {
    if (typeof orgId !== 'string' || !ORG_ID_PATTERN.test(orgId)) {
        throw new Error(
            `Unsafe organisation id: ${JSON.stringify(orgId)}. ` +
            `Expected lowercase letters, digits and hyphens, 1 to 64 characters.`
        );
    }
    return orgId;
}

/**
 * The orgs directory, resolved once and cached, so a `STORE_DIR/orgs` that is itself a symlink is fixed
 * the first time and every later call uses that real path.
 *
 * @returns {string}
 */
let resolvedOrgsDir = null;

export function orgsDirectoryPath() {
    if (resolvedOrgsDir !== null) return resolvedOrgsDir;

    const candidate = path.join(storeDir(), ORGS_DIRNAME);
    fs.mkdirSync(candidate, { recursive: true });

    resolvedOrgsDir = fs.realpathSync(candidate);
    return resolvedOrgsDir;
}

/**
 * Asserts that the orgs directory is still the one resolved at startup, compared against the cached path
 * so a store mounted through a symlink is fine. Called once per connection open, where a swap takes
 * effect.
 *
 * @throws {Error} When the orgs directory no longer resolves to the path that was first resolved.
 */
export function assertOrgsDirectoryUnchanged() {
    if (resolvedOrgsDir === null) {
        // Not resolved yet; the first resolution establishes the baseline.
        orgsDirectoryPath();
        return;
    }

    const candidate = path.join(storeDir(), ORGS_DIRNAME);
    let current;
    try {
        current = fs.realpathSync(candidate);
    } catch (err) {
        throw new Error(
            `The store directory ${candidate} can no longer be resolved (${err.code || err.message}). ` +
            `It was ${resolvedOrgsDir} when the store started. Refusing to open a database.`
        );
    }

    if (current !== resolvedOrgsDir) {
        console.error(
            `[store] refusing to open a database: ${candidate} now resolves to ${current}, ` +
            `but it resolved to ${resolvedOrgsDir} when the store started.`
        );
        throw new Error(
            `The store directory changed underneath the store: ${candidate} now resolves to ${current}, ` +
            `but resolved to ${resolvedOrgsDir} at startup. A mounted store is resolved once and used from ` +
            `that path; refusing to write, because following the new target would place data outside the store.`
        );
    }
}

/** Test helper: forget the resolved directories, after changing STORE_DIR. */
export function resetResolvedPaths() {
    resolvedOrgsDir = null;
    resolvedStoreDir = null;
}

/**
 * The path a connection may be opened against, which only guarantees the name is safe: the caller must
 * still pass it through assertOpenableDatabaseFile.
 *
 * @param {string} orgId
 * @returns {string}
 */
export function orgDbPath(orgId) {
    const safeId = assertSafeOrgId(orgId);
    const dir = orgsDirectoryPath();
    const fullPath = path.join(dir, `${safeId}${DB_SUFFIX}`);

    // Containment by name, deliberately lexical: this catches a name, assertOpenableDatabaseFile
    // catches a file.
    if (path.dirname(fullPath) !== dir) {
        throw new Error(`Organisation id ${JSON.stringify(orgId)} did not resolve inside ${dir}.`);
    }
    return fullPath;
}

/**
 * Asserts that a path is a regular file inside the orgs directory, by looking at the file rather than the
 * name: a symlink is refused rather than resolved.
 *
 * @param {string} dbPath Result of orgDbPath.
 * @param {string} orgId For the error message.
 * @returns {string|null} The real path of the file, or null when it does not exist yet; absence is not an
 *   error here, and the caller decides whether creating it is allowed.
 * @throws {Error} When the path is a symlink, not a regular file, or resolves outside the store directory.
 */
export function assertOpenableDatabaseFile(dbPath, orgId) {
    let stats;
    try {
        stats = fs.lstatSync(dbPath);
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
    }

    if (stats.isSymbolicLink()) {
        console.error(`[store] refusing to open ${dbPath}: it is a symlink, not a regular file.`);
        throw new Error(
            `Refusing organisation ${orgId}: ${dbPath} is a symlink. ` +
            `The store opens regular files only, so a link cannot redirect one organisation to another's data.`
        );
    }
    if (!stats.isFile()) {
        console.error(`[store] refusing to open ${dbPath}: it is not a regular file.`);
        throw new Error(`Refusing organisation ${orgId}: ${dbPath} is not a regular file.`);
    }

    // Containment against the real directory with the file's real path, which is what the lexical check
    // in orgDbPath cannot do.
    const realFile = fs.realpathSync(dbPath);
    const realDir = orgsDirectoryPath();
    if (path.dirname(realFile) !== realDir) {
        console.error(`[store] refusing to open ${dbPath}: real path ${realFile} is outside ${realDir}.`);
        throw new Error(
            `Refusing organisation ${orgId}: ${dbPath} resolves to ${realFile}, outside the store directory.`
        );
    }
    return realFile;
}

export function adminDbPath() {
    return path.join(storeDir(), ADMIN_DB_NAME);
}

/**
 * The installation-file counterpart of assertOpenableDatabaseFile, checking containment under the store
 * root rather than under orgs/.
 *
 * @param {string} dbPath Result of adminDbPath.
 * @returns {string|null} The real path, or null when it does not exist yet.
 * @throws {Error} When the path is a symlink, not a regular file, or resolves outside the store directory.
 */
export function assertOpenableAdminDatabaseFile(dbPath) {
    let stats;
    try {
        stats = fs.lstatSync(dbPath);
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
    }

    if (stats.isSymbolicLink()) {
        console.error(`[store] refusing to open ${dbPath}: it is a symlink, not a regular file.`);
        throw new Error(
            `Refusing to open ${dbPath}: it is a symlink. The store opens regular files only, ` +
            `so a link cannot redirect the installation database elsewhere.`
        );
    }
    if (!stats.isFile()) {
        console.error(`[store] refusing to open ${dbPath}: it is not a regular file.`);
        throw new Error(`Refusing to open ${dbPath}: it is not a regular file.`);
    }

    // Containment against the real store directory with the file's real path.
    const realFile = fs.realpathSync(dbPath);
    const realDir = fs.realpathSync(storeDir());
    if (path.dirname(realFile) !== realDir) {
        console.error(`[store] refusing to open ${dbPath}: real path ${realFile} is outside ${realDir}.`);
        throw new Error(
            `Refusing to open ${dbPath}: it resolves to ${realFile}, outside the store directory.`
        );
    }
    return realFile;
}

/**
 * The counterpart of assertOrgsDirectoryUnchanged for the installation file.
 *
 * @throws {Error} When the store root no longer resolves to the path first seen.
 */
let resolvedStoreDir = null;

export function assertStoreDirUnchanged() {
    const candidate = storeDir();

    if (resolvedStoreDir === null) {
        fs.mkdirSync(candidate, { recursive: true });
        resolvedStoreDir = fs.realpathSync(candidate);
        return;
    }

    let current;
    try {
        current = fs.realpathSync(candidate);
    } catch (err) {
        throw new Error(
            `The store directory ${candidate} can no longer be resolved (${err.code || err.message}). ` +
            `It was ${resolvedStoreDir} when the store started. Refusing to open a database.`
        );
    }

    if (current !== resolvedStoreDir) {
        console.error(
            `[store] refusing to open a database: ${candidate} now resolves to ${current}, ` +
            `but it resolved to ${resolvedStoreDir} when the store started.`
        );
        throw new Error(
            `The store directory changed underneath the store: ${candidate} now resolves to ${current}, ` +
            `but resolved to ${resolvedStoreDir} at startup. Refusing to write, because following the ` +
            `new target would place data outside the store.`
        );
    }
}

/** Organisation ids present on disk. A symlink named like one is skipped. */
export function listOrganisationFileIds() {
    const dir = orgsDirectoryPath();
    if (!fs.existsSync(dir)) return [];

    const ids = [];
    for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith(DB_SUFFIX)) continue;

        const id = name.slice(0, -DB_SUFFIX.length);
        if (!ORG_ID_PATTERN.test(id)) {
            console.warn(`[store] ignoring unrecognised entry in ${dir}: ${name}`);
            continue;
        }

        const stats = fs.lstatSync(path.join(dir, name));
        if (!stats.isFile()) {
            console.warn(`[store] ignoring ${path.join(dir, name)}: not a regular file.`);
            continue;
        }
        ids.push(id);
    }
    return ids.sort();
}
