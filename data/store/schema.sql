-- Schema for ONE organisation's database.
--
-- ONE FILE PER ORGANISATION. Nothing here carries an orgId, because the file IS the tenant
-- boundary: a query physically cannot reach another organisation's rows.
--
-- Applied idempotently on every connection open, so this file is the single source of truth for
-- the shape and there is no separate migration runner.

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- One row. The organisation is the file, so this holds metadata only.
CREATE TABLE IF NOT EXISTS organisation (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    -- Null until the admin closes the questionnaire. Once set, no response may be added or edited.
    finished_at TEXT
);

-- A named person the admin invited, with the department supplied at invitation time.
--
-- The id is the identity and the tokens are credentials: `invitation.id` never changes and
-- `response.invitation_id` references it, which is what makes a reset safe.
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

-- The invitation link credentials. Several may be live for one invitation, because "Send a link"
-- adds one without retiring the last.
--
-- EACH ROW IS A TOKEN, STORED AS A SHA-256 HASH and never verbatim, so a database read yields
-- nothing usable. Revocation is a timestamp rather than a delete, so the console can show what
-- happened to a link.
CREATE TABLE IF NOT EXISTS participant_tokens (
    id            TEXT PRIMARY KEY,
    invitation_id TEXT NOT NULL REFERENCES invitation(id) ON DELETE CASCADE,
    -- SHA-256 of the token, lowercase hex.
    token_hash    TEXT NOT NULL UNIQUE,
    issued_at     TEXT NOT NULL,
    expires_at    TEXT NOT NULL,
    -- Set by a reset or a lost-link request. A revoked token resolves to nothing, like an unknown one.
    revoked_at    TEXT,
    -- 'admin' from the console, 'participant' from lost-my-link.
    issued_by     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_participant_tokens_hash ON participant_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_participant_tokens_invitation ON participant_tokens(invitation_id);
CREATE INDEX IF NOT EXISTS idx_invitation_department ON invitation(department);

-- One round of answers from one participant.
--
-- invitation_id exists so the participant can resume and edit. THE ADMIN PATH MUST NEVER RECEIVE
-- IT: `getResponsesForAnalysis` omits the column and the join. Direct database access can still
-- join the two tables, which is an accepted trade-off rather than an oversight.
CREATE TABLE IF NOT EXISTS response (
    id            TEXT PRIMARY KEY,
    invitation_id TEXT NOT NULL REFERENCES invitation(id) ON DELETE CASCADE,
    -- Participant-confirmed, because the roadmap groups on what the process touches.
    department    TEXT NOT NULL,
    -- JSON: the questionnaire's fields. The shape is defined in the questionnaire spec and
    -- lib/scoring.js, not here - a blob so a new question needs no migration.
    data          TEXT NOT NULL,
    -- JSON: the whole conversation in order, as [{role, content}, ...].
    --
    -- An answer is only meaningful against its question: "eight minutes" means one thing asked
    -- about duration and another asked about the invoice count, so the extracted fields alone are
    -- text with no referent.
    --
    -- NULLABLE because a row can predate this column, which is a different state from an empty one.
    transcript    TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    -- Set when this round is finalised. Rounds are independent: a second round appends a new row.
    submitted_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_response_invitation ON response(invitation_id);

-- A process: the work itself, named, independent of who described it.
--
-- The identity is the process, not the description: three people describing one loop in different
-- words produce ONE row here, which is why this cannot live on a response row.
--
-- No participant route reads this, because a participant who could see where their answer was
-- grouped would write to influence it.
CREATE TABLE IF NOT EXISTS process (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- One grouping judgement: the reasoning, the confidence, and which responses it covered.
--
-- A REVISION IS IMMUTABLE AND NONE IS OVERWRITTEN, so a rejudge adds a revision rather than
-- editing the last and the earlier grouping stays readable. `is_current` marks which one the
-- console shows.
CREATE TABLE IF NOT EXISTS process_revision (
    id             TEXT PRIMARY KEY,
    process_id     TEXT NOT NULL REFERENCES process(id) ON DELETE CASCADE,
    -- 1 for the first grouping, 2 after the first rejudge. Monotonic, not timestamp-ordered.
    revision       INTEGER NOT NULL,
    -- 'model' for a workflow 2 decision, 'admin' for a rejudge the admin asked for.
    decided_by     TEXT NOT NULL,
    -- NOT NULL because the reasoning is the only way this step can be reviewed.
    reasoning      TEXT NOT NULL,
    -- 'high' | 'medium' | 'low'. RECORDED, NEVER FILTERED ON: no threshold silently drops a process.
    confidence     TEXT NOT NULL,
    -- The admin's argument when this revision came from a rejudge.
    admin_reasoning TEXT,
    is_current     INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_process_revision_process ON process_revision(process_id);
-- One revision number per process. The code already keeps this true, and the index makes it the
-- database's job because `needsReviewFromRevisions` reads the creation from the FIRST revision by
-- number, so two rows numbered 1 would make that flag depend on sort order.
--
-- NO schema_version BUMP, AND THIS IS THE RULE FOR EVERY `IF NOT EXISTS` IN THIS FILE: it applies
-- on an existing file's next open with nothing to migrate, where a bump would REFUSE every
-- existing file. The one state that could still collide is a deleted revision, and no code deletes
-- one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_process_revision_number
    ON process_revision(process_id, revision);
-- At most ONE current revision per process, so the database refuses a second.
CREATE UNIQUE INDEX IF NOT EXISTS idx_process_revision_current
    ON process_revision(process_id) WHERE is_current = 1;

-- Which responses a revision covers, and what each one contributed.
--
-- Keyed on the revision rather than the process, because a rejudge can merge two processes and the
-- earlier membership has to stay readable.
CREATE TABLE IF NOT EXISTS process_response (
    id          TEXT PRIMARY KEY,
    revision_id TEXT NOT NULL REFERENCES process_revision(id) ON DELETE CASCADE,
    response_id TEXT NOT NULL REFERENCES response(id) ON DELETE CASCADE,
    -- JSON: an array of field names, as the model reported them.
    contributed TEXT NOT NULL,
    created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_process_response_revision ON process_response(revision_id);
CREATE INDEX IF NOT EXISTS idx_process_response_response ON process_response(response_id);
-- One response appears at most once in one revision, or "the responses behind this process" would
-- depend on how many times it was linked.
CREATE UNIQUE INDEX IF NOT EXISTS idx_process_response_once
    ON process_response(revision_id, response_id);

-- One weighing of a revision: the number, the terms behind it, and the paragraph.
--
-- Keyed on the revision rather than the process, because a score is a judgement about a particular
-- grouping and the path for a disagreement is to re-identify first.
--
-- A different session produces it from the one that produced the revision, so folding the score
-- into the revision would put two independent judgements in one row. SEVERAL ROWS PER REVISION ARE
-- ALLOWED, with `is_current` marking the one to show, the same pattern as revisions.
CREATE TABLE IF NOT EXISTS process_score (
    id          TEXT PRIMARY KEY,
    revision_id TEXT NOT NULL REFERENCES process_revision(id) ON DELETE CASCADE,
    -- A REAL so a provisional formula is free to produce fractions.
    score       REAL NOT NULL,
    -- JSON: the term scores the model reported, so a reader can see why the number came out so.
    terms       TEXT NOT NULL,
    -- NOT NULL for the same reason process_revision.reasoning is.
    reasoning   TEXT NOT NULL,
    -- 1, then 2 after a re-score or a rejudge. Monotonic, not timestamp-ordered.
    revision_no INTEGER NOT NULL,
    is_current  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_process_score_revision ON process_score(revision_id);
-- One weighing number per revision, so the version history has a defined order. The code keeps
-- this true by deriving the number inside `insertScore`'s transaction; this index asserts it.
--
-- An existing file may already hold a duplicate from before that fix, and creating this index
-- would then fail on open, which is the honest outcome for a file whose numbering was broken.
CREATE UNIQUE INDEX IF NOT EXISTS idx_process_score_number
    ON process_score(revision_id, revision_no);
-- At most ONE current score per revision, the same guard the revisions carry.
CREATE UNIQUE INDEX IF NOT EXISTS idx_process_score_current
    ON process_score(revision_id) WHERE is_current = 1;

-- An admin's correction to one value the score is computed from.
--
-- The effort formula reads every field from `response.data`, so when the model reads an answer
-- wrongly a rejudge cannot reach it: a rejudge is a reasoned argument about the GROUPING.
--
-- The participant's answer is not rewritten; a correction is the analysis's reading of it, held
-- separately. One current correction per response and field, enforced by the index below, so a
-- second supersedes the first. Additive, so it needs no schema_version bump.
CREATE TABLE IF NOT EXISTS response_field_correction (
    id           TEXT PRIMARY KEY,
    -- ON DELETE CASCADE: a correction has no meaning without the answer it corrects.
    response_id  TEXT NOT NULL REFERENCES response(id) ON DELETE CASCADE,
    -- From a closed set the code validates: the four fields the effort formula reads. A column
    -- rather than a blob, so "what has been corrected" is a query rather than a parse.
    field        TEXT NOT NULL,
    -- JSON: a number for three of the fields, or the `{hours, period}` object `timePerPeriod`
    -- takes. JSON because one of the four is not a scalar.
    value        TEXT NOT NULL,
    -- Required, for the same reason process_revision.reasoning is.
    admin_reasoning TEXT NOT NULL,
    decided_at   TEXT NOT NULL
);

-- One current correction per response and field, so "what is the frequency" has one answer.
CREATE UNIQUE INDEX IF NOT EXISTS idx_field_correction_current
    ON response_field_correction(response_id, field);

-- Schema bookkeeping for this file.
--
-- THERE IS STILL NO MIGRATION PATH, deliberately: the version check exists to REFUSE a file this
-- code does not understand, because reading an older file with the current queries would answer
-- the wrong question quietly.
CREATE TABLE IF NOT EXISTS schema_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('schema_version', '6');
