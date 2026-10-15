-- Schema for the INSTALLATION database, at <STORE_DIR>/admin.db.
--
-- NOT TENANT DATA, with two consequences that are easy to get wrong:
--
--   1. It must never be joined to an organisation's file. There is no organisation id here and no
--      foreign key across files: SQLite cannot enforce one, and a query that tried would be a bug.
--   2. Nothing in the organisation API in lib/store/index.js can reach it, because that API
--      resolves a path under orgs/ while this file is opened by registry.adminConnection.
--
-- Applied idempotently on every open, like the organisation schema.

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- One row per issued admin sign-in link. The token is stored as a SHA-256 hash, never verbatim.
CREATE TABLE IF NOT EXISTS login_token (
    id          TEXT PRIMARY KEY,
    email       TEXT NOT NULL,
    -- SHA-256 of the token, lowercase hex. The bearer value exists only in the emailed link.
    token_hash  TEXT NOT NULL UNIQUE,
    created_at  TEXT NOT NULL,
    -- Sign-in links are short-lived. A link past this instant is refused.
    expires_at  TEXT NOT NULL,
    -- Single use. A second redemption sees a non-null value and is refused.
    used_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_login_token_hash ON login_token(token_hash);
CREATE INDEX IF NOT EXISTS idx_login_token_email ON login_token(email);

-- An admin session survives a server restart, so the signed cookie is not the only state. One row
-- per active session, revoked on logout: the id is looked up here so a copied cookie stops working.
CREATE TABLE IF NOT EXISTS admin_session (
    id          TEXT PRIMARY KEY,
    email       TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    revoked_at  TEXT
);

-- The demo sessions: a session that may look at the console and not change anything.
--
-- Keyed on the session, because read-only is a property of this login rather than of the person.
-- There is no token column: the demo token lives in configuration, not here, so a database read
-- does not hand over the link that leaves the building.
CREATE TABLE IF NOT EXISTS demo_session (
    session_id TEXT PRIMARY KEY REFERENCES admin_session(id) ON DELETE CASCADE,
    org_id     TEXT NOT NULL,
    email      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

-- One row per person who may sign in to the console.
--
-- In the installation database rather than an organisation's file, because sign-in has to work
-- before an organisation is known: the first sign-in creates one. The organisation_id column is
-- what the console scopes every query by.
--
-- NO FOREIGN KEY to the organisation, because it lives in a different file and SQLite cannot
-- enforce a constraint across files, so the application checks it rather than the engine.
CREATE TABLE IF NOT EXISTS users (
    id              TEXT PRIMARY KEY,
    organisation_id TEXT NOT NULL,
    email           TEXT NOT NULL UNIQUE,
    -- 'admin' or 'user'. Both act the same today; the column exists now because adding it later
    -- would be a migration. Validated in lib/users.js so the error message can name the problem.
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
-- A participant arrives with a token and no organisation id, so something must map the token to a
-- tenant before any organisation file can be opened: installation-level routing, not tenant data.
--
-- It holds a token hash and an organisation id, with no answers, email, name or department, so this
-- file cannot become a second copy of the tenant data. The hash is written in the same operation
-- as the invitation, so the two cannot drift.
CREATE TABLE IF NOT EXISTS token_index (
    token_hash      TEXT PRIMARY KEY,
    organisation_id TEXT NOT NULL,
    -- So a resolved token names both the tenant and the identity in one lookup.
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
