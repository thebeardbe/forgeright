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

-- Schema bookkeeping for this file.
CREATE TABLE IF NOT EXISTS schema_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('schema_version', '1');
