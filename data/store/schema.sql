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
    -- JSON: THE WHOLE CONVERSATION, in order, as [{role, content}, ...].
    --
    -- WHY IT IS STORED AT ALL. An answer is only meaningful against its question:
    -- "eight minutes" means one thing asked about duration and another asked
    -- about the invoice count. Keeping the extracted fields alone gives text with
    -- no referent, so a non-answer cannot be told from a good one, and the
    -- QUESTIONS -- where the interview's quality actually lives -- are lost with
    -- the browser tab.
    --
    -- NULLABLE because a row can predate this column, or be written by a caller
    -- that has no transcript to give. A response with no transcript is still a
    -- valid response; it is the transcript that is missing, and the two are
    -- different states.
    --
    -- A BLOB, NOT A TABLE PER MESSAGE. A long interview is about twenty turns, so
    -- the whole transcript is a few kilobytes and there is nothing to query about
    -- an individual turn. Twenty rows per response would buy nothing and cost a
    -- join on every read.
    transcript    TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    -- Set when this round is finalised. Rounds are independent: a second round
    -- appends a new response row and never overwrites this one.
    submitted_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_response_invitation ON response(invitation_id);

-- A process: the work itself, named, independent of who described it.
--
-- THE IDENTITY IS THE PROCESS, NOT THE DESCRIPTION. Three people describing the
-- order-to-supplier loop in different words produce ONE row here and three rows
-- in the join table below. That is what workflow 2 decides, and it is why this
-- cannot live on a response row: a process spans responses.
--
-- The NAME is a convenience for the console. It is held on the process rather
-- than on each revision because a rejudge normally refines the name rather than
-- replacing the identity, and a reader wants the current one.
--
-- NOTHING ABOUT GROUPING IS HIDDEN FROM THE PARTICIPANT BY OMISSION HERE. They
-- never see any of this: no route exposes it, deliberately, because people would
-- write answers to influence where their process was placed. See the note on
-- exposesToParticipant in lib/store/processes.js.
CREATE TABLE IF NOT EXISTS process (
    id         TEXT PRIMARY KEY,
    -- The work as named by the model, in the language of the responses, as the
    -- actual work rather than a category ("Matching supplier invoices", not
    -- "Finance").
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- One grouping judgement: the reasoning, the confidence, and which responses it
-- covered.
--
-- EVERY JUDGEMENT IS A REVISION AND NONE IS OVERWRITTEN. A rejudge adds one
-- rather than editing the last, because the spec keeps both versions: an admin
-- asks for a reclassification with a reason, and the earlier grouping has to
-- remain readable for anyone reviewing why the result changed. `is_current`
-- marks which one the console shows, so the common read is a cheap lookup rather
-- than a max() over a growing table.
--
-- A REVISION IS IMMUTABLE. It records what was decided and why, at a moment, so
-- editing one would falsify the record rather than correct it.
CREATE TABLE IF NOT EXISTS process_revision (
    id             TEXT PRIMARY KEY,
    process_id     TEXT NOT NULL REFERENCES process(id) ON DELETE CASCADE,
    -- Which judgement this is: 1 for the first grouping, 2 after the first
    -- rejudge. Monotonic, so the order does not depend on timestamps.
    revision       INTEGER NOT NULL,
    -- 'model' for a workflow 2 decision, 'admin' for a rejudge the admin asked
    -- for. Kept so a reader can see which groupings a person challenged.
    decided_by     TEXT NOT NULL,
    -- WHAT THE MODEL REPORTED: why this is or is not the same task, in one or two
    -- sentences. NOT NULL, because the reasoning is the only way this step can be
    -- reviewed and a grouping without it cannot be argued with.
    reasoning      TEXT NOT NULL,
    -- 'high' | 'medium' | 'low'. RECORDED, NEVER FILTERED ON: the spec says the
    -- tool does not decide, so no threshold silently drops a process. A reader
    -- sees the confidence and makes their own call.
    confidence     TEXT NOT NULL,
    -- The admin's own argument, when this revision came from a rejudge. Null for a
    -- model decision. It is kept because it is the input that produced this
    -- revision, and without it the revision cannot be explained.
    admin_reasoning TEXT,
    is_current     INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_process_revision_process ON process_revision(process_id);
-- One revision number per process, so the number identifies a revision on its own.
--
-- THE CODE ALREADY KEEPS THIS TRUE, and the index makes it the DATABASE's job.
-- `nextRevision` is MAX(revision) + 1, read and written inside one BEGIN IMMEDIATE,
-- so eight concurrent OS processes were measured producing nine sequential numbers
-- with no collision. The index closes the remaining route: `nextRevision`'s MAX is
-- the only thing preventing a repeat, so a future writer that computed a number
-- differently would have created a duplicate silently.
--
-- IT IS NOT COSMETIC. `needsReviewFromRevisions` reads the creation from the FIRST
-- revision by number, so two rows numbered 1 make the flag depend on sort order
-- rather than on data.
--
-- NO schema_version BUMP: this is an index, so CREATE ... IF NOT EXISTS applies it
-- to an existing file on its next open with nothing to migrate. Bumping the version
-- would REFUSE every existing file, and the project has no migration path by
-- design, so a bump would cost every operator a fresh file to gain nothing. A DELETED
-- revision is the one state that could still collide on this index, and no code
-- deletes one; see the limit recorded in lib/store/process-membership.js.
CREATE UNIQUE INDEX IF NOT EXISTS idx_process_revision_number
    ON process_revision(process_id, revision);
-- At most ONE current revision per process. A partial unique index, so the
-- database refuses a second rather than the code having to remember.
CREATE UNIQUE INDEX IF NOT EXISTS idx_process_revision_current
    ON process_revision(process_id) WHERE is_current = 1;

-- Which responses a revision covers, and WHAT EACH ONE CONTRIBUTED.
--
-- MANY-TO-MANY, because a process spans responses: that is the whole point of
-- workflow 2. `contributed` records the field names this response supplied to the
-- merged process, which is how a reader can tell which participant said the
-- eight minutes and which supplied the trigger.
--
-- KEYED ON THE REVISION, not on the process. A rejudge can merge two processes,
-- so the set of responses behind a process changes with the judgement, and the
-- earlier membership has to stay readable rather than being overwritten.
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
-- One response appears at most once in one revision. A duplicate would make
-- "the responses behind this process" depend on how many times it was linked.
CREATE UNIQUE INDEX IF NOT EXISTS idx_process_response_once
    ON process_response(revision_id, response_id);

-- One weighing of a revision: the number, the terms behind it, and the paragraph.
--
-- KEYED ON THE REVISION, NOT THE PROCESS, because a score is a judgement about a
-- particular grouping. The spec's path for either kind of disagreement is to
-- re-identify first and regenerate the score from that, so the score follows the
-- grouping rather than the process identity. Keeping it on the revision makes
-- "which grouping was this number computed from" answerable, which a
-- process-level column could not express.
--
-- SEPARATE FROM process_revision RATHER THAN A COLUMN ON IT, for two reasons:
--
--   1. A DIFFERENT SESSION PRODUCES IT. Identification decides sameness; weighing
--      decides the number. A revision is a grouping, and its `reasoning` and
--      `confidence` belong to that judgement, not to the score. Folding the score
--      in would put two independent judgements in one row and make it impossible
--      to see which sentence explains which.
--   2. IT CAN BE RECOMPUTED WITHOUT RE-GROUPING. The spec marks the formula
--      provisional and says it is fine-tuned once there are real responses. A
--      formula change re-scores the same revision, and a column on the revision
--      would force a fake new grouping to record it.
--
-- SEVERAL ROWS PER REVISION ARE ALLOWED, and `is_current` marks the one to show,
-- the same pattern as revisions: a rejudge regenerates rather than overwrites, and
-- the earlier number stays readable for anyone asking why it moved.
CREATE TABLE IF NOT EXISTS process_score (
    id          TEXT PRIMARY KEY,
    revision_id TEXT NOT NULL REFERENCES process_revision(id) ON DELETE CASCADE,
    -- The single number the sort uses. A REAL so a provisional formula is free to
    -- produce fractions; rounding is a presentation choice, not a storage one.
    score       REAL NOT NULL,
    -- JSON: the term scores the model reported, as {"frequency": 5, ...}. Stored
    -- so a reader can see WHY the number came out where it did, and so a change to
    -- the formula can be compared against the terms rather than only the total.
    terms       TEXT NOT NULL,
    -- The paragraph weighing every term. NOT NULL, for the same reason
    -- process_revision.reasoning is: a score nobody can explain cannot be reviewed,
    -- and the spec makes the paragraph part of the output rather than polish.
    reasoning   TEXT NOT NULL,
    -- Which weighing this is for its revision: 1, then 2 after a re-score or a
    -- rejudge. Monotonic, so the order does not depend on timestamps.
    revision_no INTEGER NOT NULL,
    is_current  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_process_score_revision ON process_score(revision_id);
-- At most ONE current score per revision, so the database refuses a second rather
-- than the code remembering. The same guard the revisions carry.
CREATE UNIQUE INDEX IF NOT EXISTS idx_process_score_current
    ON process_score(revision_id) WHERE is_current = 1;

-- Schema bookkeeping for this file.
--
-- VERSION 6 ADDS `process_score` FOR WORKFLOW 3 WEIGHING, AND THERE IS STILL NO
-- MIGRATION PATH.
--
-- That is deliberate and wanted. This is the proof of concept: V2 is a rewrite on
-- a different database, so carrying an upgrade path here would be work spent on a
-- schema with no future. The version check exists to REFUSE a file this code does
-- not understand -- reading version 5 with version 6 queries would answer the
-- wrong question quietly -- not to upgrade one. An older file is a loud error,
-- and someone who wants the data should export it before deleting the file.
CREATE TABLE IF NOT EXISTS schema_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('schema_version', '6');
