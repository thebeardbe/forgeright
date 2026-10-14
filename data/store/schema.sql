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
    -- Null until the admin closes the questionnaire. Once set, no response may be added or
    -- edited: assertOrganisationNotFinished is called by all three response writers.
    finished_at TEXT
);

-- A named person the admin invited, with the department supplied at invitation time so the
-- participant is never asked.
--
-- THE ID IS THE IDENTITY, THE TOKENS ARE CREDENTIALS. `invitation.id` never changes and
-- `response.invitation_id` references it, which is what makes a reset safe: credentials are
-- replaced wholesale while every answer already given stays attached.
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
--
-- EXPIRY IS GENEROUS, in days, because a questionnaire may run for weeks and a participant who
-- returns to a dead link is a lost respondent. The link is long-lived and appears in URLs, so it
-- can end up in browser history and in a proxy log; README "Long-lived participant links"
-- records why that trade is accepted.
CREATE TABLE IF NOT EXISTS participant_tokens (
    id            TEXT PRIMARY KEY,
    invitation_id TEXT NOT NULL REFERENCES invitation(id) ON DELETE CASCADE,
    -- SHA-256 of the token, lowercase hex.
    token_hash    TEXT NOT NULL UNIQUE,
    issued_at     TEXT NOT NULL,
    expires_at    TEXT NOT NULL,
    -- Set by a reset or a lost-link request. A revoked token resolves to nothing, the same as an
    -- unknown one.
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
    -- Participant-confirmed, because the roadmap groups on what the process touches and the
    -- participant can correct the model's guess.
    department    TEXT NOT NULL,
    -- JSON: the questionnaire's fields. THE SHAPE IS DEFINED ELSEWHERE, in the questionnaire spec
    -- and lib/scoring.js, not here - stored as a blob so a new question needs no migration.
    data          TEXT NOT NULL,
    -- JSON: the whole conversation in order, as [{role, content}, ...].
    --
    -- AN ANSWER IS ONLY MEANINGFUL AGAINST ITS QUESTION. "Eight minutes" means one thing asked
    -- about duration and another asked about the invoice count, so keeping the extracted fields
    -- alone gives text with no referent and loses the questions, where the interview's quality
    -- lives.
    --
    -- NULLABLE because a row can predate this column. A response with no transcript is still a
    -- valid response; it is the transcript that is missing, which is a different state.
    transcript    TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    -- Set when this round is finalised. Rounds are independent: a second round appends a new row.
    submitted_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_response_invitation ON response(invitation_id);

-- A process: the work itself, named, independent of who described it.
--
-- THE IDENTITY IS THE PROCESS, NOT THE DESCRIPTION. Three people describing the order-to-supplier
-- loop in different words produce ONE row here and three in the join table below. That is what
-- workflow 2 decides, and it is why this cannot live on a response row: a process spans
-- responses.
--
-- NO PARTICIPANT ROUTE READS THIS. A participant who could see where their answer was grouped
-- would write to influence it, so no participant route imports lib/store/processes.js.
CREATE TABLE IF NOT EXISTS process (
    id         TEXT PRIMARY KEY,
    -- The work as the model named it, as the actual work rather than a category ("Matching
    -- supplier invoices", not "Finance").
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- One grouping judgement: the reasoning, the confidence, and which responses it covered.
--
-- A REVISION IS IMMUTABLE AND NONE IS OVERWRITTEN. A rejudge adds a revision rather than editing
-- the last, so the earlier grouping stays readable for anyone reviewing why the result changed.
-- `is_current` marks which one the console shows, so the common read is a cheap lookup.
CREATE TABLE IF NOT EXISTS process_revision (
    id             TEXT PRIMARY KEY,
    process_id     TEXT NOT NULL REFERENCES process(id) ON DELETE CASCADE,
    -- 1 for the first grouping, 2 after the first rejudge. Monotonic, so the order does not depend
    -- on timestamps.
    revision       INTEGER NOT NULL,
    -- 'model' for a workflow 2 decision, 'admin' for a rejudge the admin asked for.
    decided_by     TEXT NOT NULL,
    -- NOT NULL because the reasoning is the only way this step can be reviewed, and a grouping
    -- without it cannot be argued with.
    reasoning      TEXT NOT NULL,
    -- 'high' | 'medium' | 'low'. RECORDED, NEVER FILTERED ON: the tool does not decide, so no
    -- threshold silently drops a process.
    confidence     TEXT NOT NULL,
    -- The admin's argument when this revision came from a rejudge. It is the input that produced
    -- the revision, so without it the revision cannot be explained.
    admin_reasoning TEXT,
    is_current     INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_process_revision_process ON process_revision(process_id);
-- One revision number per process. THE CODE ALREADY KEEPS THIS TRUE and the index makes it the
-- database's job: `nextRevision` is MAX(revision) + 1 read and written inside one BEGIN
-- IMMEDIATE, so a future writer that computed a number differently would otherwise create a
-- duplicate silently. It is not cosmetic - `needsReviewFromRevisions` reads the creation from the
-- FIRST revision by number, so two rows numbered 1 would make that flag depend on sort order.
--
-- NO schema_version BUMP, AND THIS IS THE RULE FOR EVERY `IF NOT EXISTS` IN THIS FILE: it applies
-- on an existing file's next open with nothing to migrate, where a bump would REFUSE every
-- existing file - the deployed store included - and the project has no migration path by design.
-- A deleted revision is the one state that could still collide here, and no code deletes one; the
-- limit is recorded in lib/store/process-membership.js.
CREATE UNIQUE INDEX IF NOT EXISTS idx_process_revision_number
    ON process_revision(process_id, revision);
-- At most ONE current revision per process, so the database refuses a second rather than the code
-- having to remember.
CREATE UNIQUE INDEX IF NOT EXISTS idx_process_revision_current
    ON process_revision(process_id) WHERE is_current = 1;

-- Which responses a revision covers, and what each one contributed.
--
-- MANY-TO-MANY, because a process spans responses: that is the point of workflow 2. `contributed`
-- is how a reader tells which participant said the eight minutes and which supplied the trigger.
--
-- KEYED ON THE REVISION, not the process: a rejudge can merge two processes, so the set of
-- responses behind a process changes with the judgement and the earlier membership has to stay
-- readable.
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
-- KEYED ON THE REVISION, NOT THE PROCESS, because a score is a judgement about a particular
-- grouping. The path for either kind of disagreement is to re-identify first and regenerate the
-- score from that, so keeping it on the revision makes "which grouping was this number computed
-- from" answerable.
--
-- A DIFFERENT SESSION PRODUCES IT from the one that produced the revision: identification decides
-- sameness, weighing decides the number. Folding the score into the revision would put two
-- independent judgements in one row. It can also be RECOMPUTED WITHOUT RE-GROUPING, which the
-- provisional formula will need.
--
-- SEVERAL ROWS PER REVISION ARE ALLOWED, and `is_current` marks the one to show, the same pattern
-- as revisions.
CREATE TABLE IF NOT EXISTS process_score (
    id          TEXT PRIMARY KEY,
    revision_id TEXT NOT NULL REFERENCES process_revision(id) ON DELETE CASCADE,
    -- A REAL so a provisional formula is free to produce fractions; rounding is a presentation
    -- choice, not a storage one.
    score       REAL NOT NULL,
    -- JSON: the term scores the model reported. Stored so a reader can see why the number came out
    -- where it did, and so a formula change can be compared against the terms.
    terms       TEXT NOT NULL,
    -- NOT NULL for the same reason process_revision.reasoning is: a score nobody can explain
    -- cannot be reviewed.
    reasoning   TEXT NOT NULL,
    -- 1, then 2 after a re-score or a rejudge. Monotonic, so the order does not depend on
    -- timestamps.
    revision_no INTEGER NOT NULL,
    is_current  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_process_score_revision ON process_score(revision_id);
-- One weighing number per revision, so the version history has a defined order.
--
-- THIS ONE WAS REACHABLE, unlike the revision case above, and the fix was in the code rather than
-- here: `nextScoreRevision` was called at the call site, so its MAX read sat outside
-- `insertScore`'s transaction and six concurrent OS processes were measured producing two rows
-- numbered 18. `insertScore` now derives the number inside its own transaction, so this index
-- asserts a property the code holds rather than repairing one it does not.
--
-- AN EXISTING FILE MAY ALREADY HOLD A DUPLICATE, and creating this index would then fail on open.
-- That is the honest outcome for a file whose numbering was already broken by that race.
--
-- THE DERIVATION AND THE INDEX ARE BOTH PINNED BY test/score-numbering.test.js. The interleaving
-- is NOT pinned, deliberately: any test that staged it would have to revert the fix and assert on
-- a state the shipped build cannot reach. NOTES.md "The write-contention test trap" records that,
-- and test/helpers/hold-write-lock.mjs is the project's shape for thread-based write tests.
CREATE UNIQUE INDEX IF NOT EXISTS idx_process_score_number
    ON process_score(revision_id, revision_no);
-- At most ONE current score per revision, the same guard the revisions carry.
CREATE UNIQUE INDEX IF NOT EXISTS idx_process_score_current
    ON process_score(revision_id) WHERE is_current = 1;

-- An admin's correction to one value the score is computed from.
--
-- THE EFFORT FORMULA READS EVERY FIELD FROM `response.data`, so when the MODEL reads that answer
-- wrongly an admin has no way to say so: a rejudge is a reasoned argument about the GROUPING and
-- reaches neither a stored value nor the score computed from it. Measured on the deployed
-- instance, an admin rejudged with "it is not 56 a week, but 56 every morning so 7 times 56" and
-- the weighing still read "fifty-six checks a week, every morning".
--
-- THE PARTICIPANT'S ANSWER IS NOT REWRITTEN. `response.data` keeps what they said, because it is
-- the evidence this tool is an audit of and the answers view shows it. A correction is the
-- ANALYSIS'S READING of that answer, held separately.
--
-- ONE CURRENT CORRECTION PER RESPONSE AND FIELD, enforced by the index below: a second supersedes
-- the first rather than accumulating, and the argument that produced the current one survives in
-- `process_revision.admin_reasoning` on the revision it caused. Additive, so it needs no
-- schema_version bump - the rule stated on the revision index above.
CREATE TABLE IF NOT EXISTS response_field_correction (
    id           TEXT PRIMARY KEY,
    -- ON DELETE CASCADE: a correction has no meaning without the answer it corrects.
    response_id  TEXT NOT NULL REFERENCES response(id) ON DELETE CASCADE,
    -- From a closed set the code validates: the four fields the effort formula reads. A column
    -- rather than a JSON blob, so "what has been corrected" is a query rather than a parse.
    field        TEXT NOT NULL,
    -- JSON: a number for three of the fields, or the `{hours, period}` object `timePerPeriod`
    -- takes. JSON because one of the four is not a scalar.
    value        TEXT NOT NULL,
    -- Required, for the same reason process_revision.reasoning is: a corrected number nobody can
    -- explain cannot be reviewed.
    admin_reasoning TEXT NOT NULL,
    decided_at   TEXT NOT NULL
);

-- One current correction per response and field, so "what is the frequency" has one answer.
CREATE UNIQUE INDEX IF NOT EXISTS idx_field_correction_current
    ON response_field_correction(response_id, field);

-- Schema bookkeeping for this file.
--
-- VERSION 6 ADDS `process_score` FOR WORKFLOW 3 WEIGHING, AND THERE IS STILL NO MIGRATION PATH.
-- That is deliberate: this is the proof of concept, so carrying an upgrade path would be work
-- spent on a schema with no future. The version check exists to REFUSE a file this code does not
-- understand - reading version 5 with version 6 queries would answer the wrong question quietly -
-- not to upgrade one. An older file is a loud error.
CREATE TABLE IF NOT EXISTS schema_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('schema_version', '6');
