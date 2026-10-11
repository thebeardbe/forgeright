-- Schema for ONE organisation's database.
--
-- ONE FILE PER ORGANISATION. Nothing in this schema carries an orgId, because
-- the file IS the tenant boundary: a query physically cannot reach another
-- organisation's rows, however wrong the WHERE clause is. Isolation therefore
-- needs a path bug, not a query bug.
--
-- Applied idempotently by lib/store/registry.js on every connection open, so
-- this file is the single source of truth for the shape and there is no
-- separate migration runner for version 1. Bump schema_version and add real
-- migrations when the shape changes.

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- One row. The organisation is the file, so this table holds metadata only.
CREATE TABLE IF NOT EXISTS organisation (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    -- Null until the admin closes the questionnaire. Once set, no response may
    -- be added or edited anywhere: see assertOrganisationNotFinished.
    finished_at TEXT
);

-- A named person the admin invited. The admin supplies the department at this
-- point, so the participant is never asked and never spends a click on it.
--
-- NO TOKEN COLUMN. The credential lives in participant_tokens, one row per issued
-- link, because several may be live at once: "Send a link" adds one without
-- retiring the last, and the two reset actions revoke them all and issue one.
--
-- THE ID IS THE IDENTITY, THE TOKENS ARE CREDENTIALS. invitation.id never changes
-- and response.invitation_id references it, which is what makes a reset safe: the
-- credentials are replaced wholesale while the identity, and therefore every
-- answer already given, stays attached. A participant who resets returns to their
-- existing work rather than starting over.
CREATE TABLE IF NOT EXISTS invitation (
    id           TEXT PRIMARY KEY,
    email        TEXT NOT NULL,
    department   TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    -- Progress the admin may see. Answer content is never exposed here.
    opened_at    TEXT,
    last_seen_at TEXT,
    completed_at TEXT
);

-- The invitation link credentials, several of which may be live for one
-- invitation.
--
-- EACH ROW IS A TOKEN, STORED AS A SHA-256 HASH and never verbatim, so a database
-- read yields nothing usable. Revocation is a timestamp rather than a delete, so
-- the console can show what happened to a link rather than the row vanishing.
--
-- EXPIRY IS GENEROUS, in days, because a questionnaire may run for weeks and a
-- participant who returns to a dead link is a lost respondent. That is a
-- deliberate trade: the link is long-lived and appears in URLs, so it can end up
-- in browser history and in a proxy log. See README "Long-lived participant
-- links" for why that is accepted and what limits the exposure.
CREATE TABLE IF NOT EXISTS participant_tokens (
    id            TEXT PRIMARY KEY,
    invitation_id TEXT NOT NULL REFERENCES invitation(id) ON DELETE CASCADE,
    -- SHA-256 of the token, lowercase hex.
    token_hash    TEXT NOT NULL UNIQUE,
    issued_at     TEXT NOT NULL,
    expires_at    TEXT NOT NULL,
    -- Set by a reset or a lost-link request. A revoked token resolves to nothing,
    -- the same as an unknown one.
    revoked_at    TEXT,
    -- Who issued it: 'admin' from the console, 'participant' from lost-my-link.
    -- Recorded so a support conversation can tell which action produced a link.
    issued_by     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_participant_tokens_hash ON participant_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_participant_tokens_invitation ON participant_tokens(invitation_id);
CREATE INDEX IF NOT EXISTS idx_invitation_department ON invitation(department);

-- One round of answers from one participant.
--
-- invitation_id exists so the participant can resume and edit. The admin path
-- must never receive it: getResponsesForAnalysis() omits the column and the
-- join. A person with direct database access can still join the two tables,
-- which is an accepted, documented trade-off, not an oversight.
CREATE TABLE IF NOT EXISTS response (
    id            TEXT PRIMARY KEY,
    invitation_id TEXT NOT NULL REFERENCES invitation(id) ON DELETE CASCADE,
    -- Participant-confirmed. Stored because the roadmap groups on what the
    -- process touches, and the participant can correct the model's guess.
    department    TEXT NOT NULL,
    -- JSON: the questionnaire's fields. THE SHAPE IS DEFINED ELSEWHERE, in the
    -- questionnaire spec and lib/scoring.js, not in this schema. It is stored
    -- as a blob so a new question does not need a migration per organisation.
    data          TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    -- Set when this round is finalised. Rounds are independent: a second round
    -- appends a new response row and never overwrites this one.
    submitted_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_response_invitation ON response(invitation_id);

-- Schema bookkeeping for this file.
CREATE TABLE IF NOT EXISTS schema_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('schema_version', '3');
