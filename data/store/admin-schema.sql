-- Schema for the INSTALLATION database, at <STORE_DIR>/admin.db.
--
-- This file is NOT tenant data. It holds records that belong to the whole
-- installation rather than to one organisation: currently admin login tokens.
-- Two consequences worth stating, because both are easy to get wrong:
--
--   1. It must never be joined to an organisation's file. There is no
--      organisation id here and there is no foreign key across files: SQLite
--      cannot enforce one, and a query that tried would be a bug, not a feature.
--   2. Nothing in lib/store/index.js's organisation API can reach it. That API
--      takes an orgId first and resolves it to a path under orgs/; this file is
--      opened by a separate, named function (registry.adminConnection), so an
--      organisation-scoped call cannot widen into it.
--
-- Applied idempotently by lib/store/registry.js on every open, like the
-- organisation schema, so there is no separate migration runner for version 1.

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- One row per issued admin sign-in link.
--
-- The token is stored as a SHA-256 hash, never verbatim, so a database read does
-- not hand over a usable sign-in link. See lib/auth/tokens.js.
CREATE TABLE IF NOT EXISTS login_token (
    id          TEXT PRIMARY KEY,
    email       TEXT NOT NULL,
    -- SHA-256 of the token, lowercase hex. The bearer value exists only in the
    -- emailed link.
    token_hash  TEXT NOT NULL UNIQUE,
    created_at  TEXT NOT NULL,
    -- Sign-in links are short-lived. A link past this instant is refused.
    expires_at  TEXT NOT NULL,
    -- Single use. Set when redeemed; a second redemption sees a non-null value
    -- and is refused.
    used_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_login_token_hash ON login_token(token_hash);
CREATE INDEX IF NOT EXISTS idx_login_token_email ON login_token(email);

-- An admin session survives a server restart, so the signed cookie is not the
-- only state. One row per active session, revoked on logout.
--
-- The cookie carries a session id and an expiry, both signed. The id is looked
-- up here so logout can revoke server-side rather than relying on the cookie
-- alone, which a holder could otherwise keep until it expired.
CREATE TABLE IF NOT EXISTS admin_session (
    id          TEXT PRIMARY KEY,
    email       TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    revoked_at  TEXT
);

-- The demo sessions: a session that may LOOK at the console and not change anything.
--
-- A SEPARATE TABLE RATHER THAN A COLUMN ON admin_session, and that is the schema's
-- constraint rather than a preference. `CREATE TABLE IF NOT EXISTS` applies a NEW
-- TABLE to an existing file on its next open, so this needs NO version bump. A new
-- COLUMN would not be added to an existing file, and would need either a migration
-- (this project deliberately has none) or a bump (which REFUSES every existing file).
--
-- KEYED ON THE SESSION, because read-only is a property of THIS LOGIN and not of the
-- person: the same human can sign in normally and write, and follow a demo link and
-- not. `expires_at` mirrors the session's, so a demo row cannot outlive the session it
-- belongs to, and the session row stays the single authority for validity.
--
-- There is no token column: the demo token lives in configuration, not in the
-- database, so a database read does not hand over the link that leaves the building.
CREATE TABLE IF NOT EXISTS demo_session (
    session_id TEXT PRIMARY KEY REFERENCES admin_session(id) ON DELETE CASCADE,
    org_id     TEXT NOT NULL,
    email      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

-- One row per person who may sign in to the console.
--
-- IN THE INSTALLATION DATABASE, not an organisation's file, because sign-in has
-- to work BEFORE an organisation is known: the first sign-in creates one. A user
-- then points at the organisation it belongs to, and that pointer is what the
-- console scopes every query by.
--
-- There is no foreign key to the organisation, because the organisation lives in
-- a different file and SQLite cannot enforce a constraint across files. The
-- relationship is held by this column and checked by the application; the comment
-- says so rather than implying the engine guards it.
CREATE TABLE IF NOT EXISTS users (
    id              TEXT PRIMARY KEY,
    organisation_id TEXT NOT NULL,
    email           TEXT NOT NULL UNIQUE,
    -- 'admin' or 'user'. Both act the same today; the column exists now because
    -- adding it later would be a migration, and the distinction is expected to
    -- return. Validated in lib/users.js, not by a CHECK constraint, so the error
    -- message can name the problem.
    role            TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

-- Email is the identity used at sign-in, so it is unique across the installation.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);
-- The console lists one organisation's users, so that lookup is indexed.
CREATE INDEX IF NOT EXISTS idx_users_organisation ON users(organisation_id);

-- Which organisation owns a participant token.
--
-- WHY THIS EXISTS, and why it is safe. A participant arrives with a token and NO
-- organisation id: the link is the only thing they have, so something must map
-- the token to a tenant before any organisation file can be opened. That fact is
-- installation-level routing, not tenant data, so it lives here.
--
-- WHAT IT HOLDS: a token hash and an organisation id. No answers, no email, no
-- name, no department. Nothing here identifies a person beyond the token they
-- already hold, so this file cannot become a second copy of the tenant data.
--
-- The token hash is written by the same code that writes the invitation, in the
-- same operation, so the two cannot drift; a token that is not in this table
-- resolves to no organisation and is refused.
CREATE TABLE IF NOT EXISTS token_index (
    token_hash      TEXT PRIMARY KEY,
    organisation_id TEXT NOT NULL,
    -- The invitation this token belongs to, so a resolved token names both the
    -- tenant and the identity in one lookup. Without it, a lookup would find the
    -- organisation and then have to search that file for the hash, which is the
    -- same information held twice.
    invitation_id   TEXT NOT NULL,
    created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_token_index_org ON token_index(organisation_id);

-- Schema bookkeeping for this file.
CREATE TABLE IF NOT EXISTS schema_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('schema_version', '4');
