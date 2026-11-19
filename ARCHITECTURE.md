# Architecture

Scope: the V1 workflow audit tool. V2 (multi-tenant product) is a rewrite and is
not described here.

## Why this is standalone

The engine was originally going to be copied from the CV scoping tool. It is not,
for two reasons:

1. **Data separation.** The scoping tool is welded to the CV bootstrap: its route
   helper calls `getCommonData`, which loads `cv-data.json` and personal CV
   translations, and its overrides live under `data/cv/overrides/`. Copying "just
   the engine" means copying the CV site. That puts client workflow data in the
   same process and store as a personal CV corpus, which is the specific thing
   to avoid.
2. **The abstraction was wrong.** The scoping tool registers routes from a
   `referrers.json` config whose semantics are "one CV site, many personas". V1
   has exactly one tool. Reusing a routing config built for a different problem
   would import assumptions that do not hold.

What is reused is the **pattern**, not the code: a config-driven provider
registry, a trilingual prompt with language fallback, JSON response mode, and a
pipeline that separates automated gathering from human judgement.

## Request flow

```
GET  /                        landing page: sign in, or paste a token (lib/landing.js)
GET  /admin                   sign-in form when signed out, the console when signed in
POST /admin/login             issue a sign-in link; unknown address creates an organisation
GET  /admin/login/verify      redeem the link, set the session cookie
POST /admin/logout            revoke the session server-side

GET  /q/:token                the questionnaire for a participant token
GET  /q                       paste-a-token form, for a link a mail client stripped
GET  /lost-link               participant recovery: reset every token, issue one
POST /api/response            save an answer; the organisation comes from the token

POST /api/chat                ai/audit-core.js -> ai/provider.js -> adapters/*
POST /api/score               lib/scoring.js (pure); the participant preview
GET  /settings/theme          store the theme choice in a cookie
GET  /healthz                 liveness; the only route exempt from the HTTPS rule
GET  /admin/demo              establish a read-only demo session (only when DEMO_LOGIN=1)

Admin console, behind the session guard. These read the organisation from the session via
`scopeForSession`, never from the request:

GET  /admin                   the console page (the same path as the sign-in form, chosen by
                              the session) with the organisation and user list
POST /admin/organisation/name rename the organisation
POST /admin/invitations       invite an address, minting its first token
POST /admin/invitations/:id/send   add another link, leaving the existing ones live
POST /admin/invitations/:id/reset  revoke every token, issue one replacement
POST /admin/users             add a user to this organisation
POST /admin/users/:id/role    change a user's role, within this organisation

GET  /admin/answers           view 1: every answer with the process it was matched to
POST /admin/answers/:id/rejudge    re-identify an answer, then reweigh
POST /admin/answers/:id/correct    correct ONE stored value, then reweigh
GET  /admin/roadmap           view 2: processes sorted by score
POST /admin/roadmap/:id/rejudge    re-identify a process from its first response, then reweigh
```

### Tenancy and identity

Three identifiers, and they are deliberately separate:

| | What it is | Where it lives |
| :--- | :--- | :--- |
| **organisation id** | the tenant, and the filename | the session, **never the request** |
| **invitation id** | who a participant is, stable for the life of the invitation | the org file |
| **token** | a credential that can be replaced | hashed, in `participant_tokens` |

**`token_index` is the installation-level table that makes a participant work at all.**
A participant arrives holding a token and no organisation id, so something must resolve
the token to a tenant **before any organisation file can be opened**. `token_index` holds
a token hash, an organisation id and an invitation id and nothing else - no answers, no
email, no name - so it is routing rather than tenant data. It lives in `admin.db` beside
`users`, `login_token` and `demo_session`, and it is written in the same operation as the
invitation so the two cannot drift.

**The identity is the invitation id and the credential is the token.** They are
separate so a reset can retire a leaked link without orphaning the answers already
given: a participant who resets returns to their existing responses.

`scopeForSession` (`lib/auth/console.js`) is the only place a console route learns
its organisation, and it reads it from the user row the session points at. **No
route takes a tenant from a parameter, a query string or a body field.** That is
the one mistake in this area that shows a client another client's data.

A participant token resolves to an organisation through `lib/token-index.js`,
because the token alone must find its tenant before any file can be opened. The
index holds a token hash and an organisation id and nothing else: no email, no
answers.

### The questionnaire turn

```
messages from client
  -> ai/security.js: sanitizeInput, checkPromptInjection
       blocked  -> { status: 'rejected' }, conversation continues
       allowed  -> continue
  -> load prompt for (tool, lang), falling back en -> nl
  -> provider.generateText(temperature 0.3, JSON mode)
  -> parseModelResponse: validate shape
  -> { status: 'asking' | 'complete', content, audit? }
```

The model contract is a JSON object, never prose. That is what lets the scoring
layer be pure logic: it receives structured data instead of parsing a document.

The interview contract also carries the completeness matrix and, on completion,
the `processes` payload. `processes` is the authoritative field: `parseModelResponse`
resolves the payload BY CONTENT, so a valid `processes` beats an empty or stale
`audit.workflows`. The older single-shot shape is still accepted.

```
{ "status": "asking",   "content": "<one question>",
  "have": [...], "missing": [...], "processes": [ ... ] }

{ "status": "complete", "content": "<closing line>",
  "have": [...], "missing": [], "processes": [ ... ] }
```

`have` and `missing` are the model's claim about the matrix. `reconcileMatrix`
recomputes both from `processes` and the model's claim is only reconciled against
it, never trusted: a reply claiming `complete` with a field still missing is
downgraded to `asking` rather than closing. A step's `needsReasoning` is derived
by the model, and `reasoningBasis` optionally carries the phrase from
`decidedHow` that decided it, so a misread step is visible to a reader.

**Two shapes are stored, and this is one of the invariants a reader must know.**
A live interview round saves the payload wrapped:

```json
{ "workflows": [ { "task": "...", "steps": [ ... ] } ] }
```

An imported round - the seed, `POST /api/score`, an export - saves the workflow
directly at the top level:

```json
{ "task": "...", "steps": [ ... ] }
```

**`ai/response-shape.js` is the one resolver** (`responseWorkflow`), and every
reader goes through it: the step merge, the weighing, the console views and the
answer headings. **Reading the wrong shape does not fail loudly - it finds no
fields**, which renders a live interview as an untitled answer with nothing in it.
Adding a third reader that reaches into `response.data.task` directly reintroduces
that defect. `lib/view-format.js` re-exports the resolver so view code has one
import; `ai/merge-steps.js` uses it so two readers cannot disagree.

### From a finished round to a process, automatically

**A participant never triggers identification, and an admin never has to.** When a round
is finalised, `POST /api/response` calls `identifyFinishedResponse`
(`lib/auth/identify-response.js`), which runs workflow 2 and records the result:

```
round finalised (submitted_at set)
  -> alreadyIdentified?  yes -> do nothing
  -> runIdentification: the round's payload against every existing process
  -> recordIdentification (decidedBy: 'model')
```

**It is deliberately not awaited.** The model call takes seconds and the participant is
waiting for this turn's reply, so the reply goes first. **Every failure is swallowed and
logged**, because the answers are already saved: the worst outcome is an answer that still
reads "not yet read", which the console renders and an admin can fix with Rejudge.

**The guard exists for a specific reason.** The identify prompt tells the model to answer
`matches: null` when it is unsure, and a second `recordIdentification` with `matches: null`
creates a second process of the same name. Checking `alreadyIdentified` before the call
means a response that already has a grouping never costs a call or risks a duplicate.

**It is not a rejudge.** No admin argument is passed and `decidedBy` stays `model`, so the
console does not read every live interview as a console full of corrections.

### An admin's correction: a value, not a grouping

**Distinct from rejudge, and the distinction is the point.** A rejudge is a reasoned
argument about **which process a response belongs to**; it can never reach a stored value.
A correction changes **one stored value** that the score is computed from, because the
effort formula reads every factor from `response.data` and the model can read an answer
wrongly.

```
POST /admin/answers/:id/correct   field, value, reason
  -> readCorrectedValue: the field is one of CORRECTABLE_FIELDS, the value is valid
  -> response is in a process?      no -> refuse, there is no score to change
  -> recordFieldCorrection: INSERT OR REPLACE, one current row per (response, field)
  -> reweighProcess: the new score is produced immediately
```

**The participant's answer is never rewritten.** The correction is held in its own table
(`response_field_correction`), so the answers view keeps showing what they said while the
score uses the corrected figure. A correction always carries the admin's reasoning, for
the same reason a reweighing does: a changed number has to be reviewable.

**`CORRECTABLE_FIELDS` is a closed set** - `frequencyPerWeek`, `minutesPerInstance`,
`peopleAffected`, `timePerPeriod` - because those are the four the effort formula reads. A
field the score depends on and cannot be corrected would be the bug. A second correction
of the same field supersedes the first rather than accumulating, enforced by a unique
index.

**The reweigh is immediate and tolerated.** A correction beside an uncorrected score is
the state this exists to avoid, so the weighing runs in the same request; if the model is
unreachable the correction still stands, and the roadmap shows the process as not weighed.

### Providers

`config/ai-config.json` defines providers; `AI_PROVIDER` selects one. Each
provider type maps to an adapter:

| type | adapter | note |
| :--- | :--- | :--- |
| `mock` | `adapters/mock.js` | no key, no network |
| `gemini` | `adapters/gemini.js` | translate to `contents` / `system_instruction` |
| `openai-compatible` | `adapters/deepseek.js` | DeepSeek, OpenAI-shaped |

An unknown provider or missing adapter throws at startup rather than degrading to
a different provider, because answering a client's questionnaire with the wrong
model is worse than failing.

## Scoring

**Two scorers exist and they are not comparable. This section describes both, because a
reader who meets only one will misread the other.**

### The roadmap score: workflow 3, the weighing

**This is the number on the roadmap.** A process is sent to the model with its steps, and
the model scores ten terms on 0-100 and composes them into one score on the same scale:

```
frequency  time  people  results  consequences  departments  complexity
automatableShare  reasoningSteps  buildEffort
```

**Four terms are costs** (`departments`, `complexity`, `reasoningSteps`, `buildEffort`,
named in `COST_TERMS`), so a high value makes the process a worse candidate. The
composition itself is the model's and lives in the prompt; what `lib/store/weighing.js`
enforces is the shape: all ten present, every term and the score within 0-100, and a
reasoning paragraph, or the reply is refused.

**A weighing is keyed on the revision, not the process**, because a score is a judgement
about a particular grouping; a rejudge adds a weighing rather than editing one. The score
always carries its ten terms and its paragraph, so a reader can see why the number came
out where it did. A process with no weighing sorts last rather than disappearing.

**The composition is provisional**, and tuned by editing the prompt as real answers come
in. The cost of keeping it in the prompt rather than in code is real: two models can weight
the same terms differently, so a score is comparable **within one set of processes** and not
necessarily between runs.

`lib/scoring.js`, described below, is a separate calculation and is live only for the
participant preview at `POST /api/score`. **Nothing joins the two numbers.**

### The participant preview: `lib/scoring.js`

Pure functions in `lib/scoring.js`. No I/O, no rendering, so the ranking can be
inspected and tested directly.

```
effortHoursPerWeek = frequency * minutes * people / 60
score              = effortHoursPerWeek * automabilityFactor
automabilityFactor = RULES_FACTOR[band]   from the per-step needsReasoning flags
```

**The unit is person-hours per week, not recovered hours.** `peopleAffected`
multiplies the effort, so one workflow at 40x/week, 60 minutes, 6 people reports
240 hours per week. That is the sum across everyone involved.

**The judgement input changed shape.** The interview no longer asks whether work
needs judgement; it asks **on what basis the participant decides** (`decidedHow`)
and the model derives a `needsReasoning` flag **per step**. `judgementBandFor`
reduces those flags to a band 1–5, and `RULES_FACTOR` runs 0.15 to 1.00 from it.

**Per step, not per process, and that is the point.** A chain of five mechanical
steps with one judgement call in the middle reads as five automatable steps with a
known boundary, rather than as a whole process that needs a person.

**That boundary is carried by the flags, not by the score.** The band is a share
of flagged steps, so one judgement call among six dilutes: `judgementBandFor`
gives 4, against 5 for a purely mechanical chain. The per-step flags and the
console still show the boundary plainly. The bands are guidelines, not
fixed-answer logic, so the dilution is accepted rather than corrected here.

Buckets: do first, do later, do not automate. Judgement-bound work is separated
before the score threshold is applied, because a high-effort task needing
judgement every time is a different conversation from one that is merely harder.
Only do-first counts toward the headline total.

### Contradictory input

Records describing one workflow are collapsed into a single scored entry at the
**lower** estimate, with the disagreement reported separately.

- `conflictsWith` is **undirected** and chains are followed. Three records for
  one task form one group and count once.
- **All three effort fields** are compared (`frequencyPerWeek`,
  `minutesPerInstance`, `peopleAffected`). A disagreement on any of them is a
  disagreement about the workflow.
- **`judgementScore` and `stepsConsistent` are compared too**, and reported as
  `bucketDisagreements`. They are not effort, but they decide the bucket, so a
  disagreement there can move a task between "do first" and "do not automate".

  **Note as of the matrix work:** the interview no longer produces either field. It
  records `needsReasoning` per step, and `stepsConsistent` is now supplied by
  nothing. This comparison path still works for a payload that carries them, and
  is inert for the matrix shape — which is why the sample headline moved from 55.5
  to 74.78. Workflow 3 replaces this scorer and restates the rule in terms of the
  per-step flags.
  The merged record takes the **lowest** judgement rating and treats steps as
  varying if any respondent said they vary. Both push away from a
  recommendation, which is the safer error for a document that is also a sales
  pitch.

  **This was a defect.** Those two fields were previously inherited from whichever
  record the model listed first, so the same two answers produced a different
  verdict depending on array order, and no disagreement was reported. It was
  caught on the tool's own sample data: two respondents who disagreed on
  judgement and on step consistency had the disagreement silently dropped. Fixing
  it lowered the sample headline from 55.5 to 49.02 person-hours, because the
  earlier figure was inheriting the friendlier rating.
- A field is **unmeasured only when no record supplies a usable value**, or when
  every respondent reported zero. A value that is absent, `null`, an empty
  string, non-numeric or negative is not a measurement. When at least one record
  supplies a usable value, that value is the measurement and the records that
  omitted it are reported as **partial**.
- A partial field means the lower-estimate rule could not be applied, and the
  note says so explicitly rather than implying the remaining answers agreed.
- An unmeasured field is deleted from the collapsed record rather than carrying a
  fabricated zero into the score.
- The conflict note is **client-facing**, so it uses human labels and units
  ("Time for one instance differs by 64% (8 min vs 22 min)"), never raw field
  names.

**A disagreement can remove a task from the headline.** Two rules interact:
collapsing takes the lower estimate, and only the do-first bucket counts. When the
lower estimate drops a task below the do-first threshold, it moves to "do later"
and contributes nothing to the headline total. The conflict is still reported, so
the task is visible, but a reader would not predict it from the two rules stated
separately. This is intended (the conservative estimate is the honest one) and is
now pinned by a test rather than left to chance.

The single rule for "is this a number" lives in one place (`measuredNumber`),
used by the scoring, the conflict and the effort paths, because two readers
disagreeing is how the same data gets scored two ways.

Each of these rules was a defect found by an independent reviewer, and each has a
regression test.

## Workflow 2: identification

**Input:** one completed response. **Output:** the process it belongs to, and the
responses behind it.

A second model session, separate from the interview, whose only job is **sameness**:
deciding whether this describes work somebody has already described. Three people
describing the order-to-supplier loop in different words are one process.

**It reports, it does not decide.** The model returns `matches` (an existing
process id, or null), a `confidence`, its `reasoning`, and which fields the
response `contributed`. The code validates that shape and refuses anything
unusable. **The confidence is recorded and never filtered on**: a threshold would
silently drop a process, and the spec says the tool proposes rather than decides.

**The reasoning is required, not decoration.** It is the only way the step can be
reviewed, so a reply without it is refused rather than stored. An admin who
disagrees does not set a category: they ask for a **rejudge with a reason**, which
re-runs identification for that process with their argument. The model is free to
push back, and measurably does when the argument turns on the desk or the system
rather than on the work itself.

**The participant never sees any of it.** Identification runs on the way out of
`POST /api/response`, its outcome is never in the response body, and the
participant's next turn cannot reflect it back. What must never happen is the
result being *shown*, not the module being reached: a participant who could see
where their answer was grouped would write to influence where it landed.

### How a grouping is stored

| table | what it holds |
| :--- | :--- |
| `process` | the work, named. The stable identity: it survives a rejudge. |
| `process_revision` | one grouping judgement: reasoning, confidence, who decided, and the admin's argument when there was one. |
| `process_response` | which responses a revision covers, and what each contributed. |

**Every judgement is a revision and none is overwritten**, so an earlier grouping
stays readable for anyone reviewing why a result changed. `is_current` marks the one
the console shows, enforced by a partial unique index so the database refuses a second.

**A revision is a snapshot of the process, not a record of one response.** When a
response joins, the new revision carries forward every response the process
already had, or "the responses behind this process" would lose the work it just
merged. Each response keeps the field list **it** contributed.

**One response is one process.** A description containing a chain is one process
with several steps, not several processes, and the prompt says so explicitly.

## Deliberate omissions

- **No roadmap generation.** The first roadmaps are written by hand, so the
  output shape can be learned before it is automated.
- **No PDF export yet.** The scoring output is on screen and downloadable as
  Markdown.
- **No platform-level admin.** Each organisation's console sees only its own
  data, and nothing in the application can cross that boundary. There is
  deliberately no view of all organisations; adding one is the first thing that
  would need its own isolation argument.
- **No cross-organisation reporting.** Consequence of the file-per-organisation
  store: no single query spans two tenants, so any aggregate across organisations needs
  a deliberate export rather than a join.

  **One exception, and it is a loop rather than a query:**
  `resetAccessForAddress` (`lib/auth/participant-routes.js`) asks each organisation in
  turn for the lost-link form, because an address is not a key that can be looked up
  globally. It reads only invitations, opens one file at a time, and stops at the first
  match - so the isolation property holds, but "no query spans tenants" is not the same
  claim as "no code touches more than one tenant".

## Guardrails

`ai/security.js` runs on every participant message:

1. `sanitizeInput`: strips control characters, caps length at 3000 characters.
2. `checkPromptInjection`: folds homoglyphs (Cyrillic and Greek lookalikes),
   normalises, then matches against `ai/injection-patterns.json`.

### Two rule lists, matched differently

`injection-patterns.json` has `keywords` and `patterns`:

- `keywords` are matched as **literal substrings**.
- `patterns` are compiled as **regular expressions**.

**Fixed, previously false:** an earlier version of this file concatenated the two
lists and substring-matched everything, which turned each regex into a literal
string containing parentheses and pipe characters. Every regex failed to match
while the checkpoint still reported inputs as checked. Five rules were dead. That
is fixed, and `test/security.test.js` now asserts one true positive per entry in
`patterns`, with a count assertion so a new rule cannot ship untested.

### Known limitation: substring matching

The guardrail still matches substrings, so a phrase only has to be *contained* in
an answer. The keyword list was cut and colliding phrases moved to
context-bearing regexes, which removed the worst false positives: "You are now
responsible for approving invoices", "We update the system prompt in our CRM tool
weekly" and "Every Monday I receive new instructions from my manager" are all
answers this questionnaire invites, and all three were blocked before that change
and pass now.

This is a mitigation, not a solution, and it is a real trade:

- **Still exposed to false positives.** Any phrasing that happens to contain a
  remaining keyword can be blocked, and a blocked answer is data loss on a
  questionnaire field.
- **Still exposed to false negatives.** Instruction phrasings not in the list get
  through. The prompt instructs the model to ignore instructions in an answer, so
  this is defence in depth rather than the only layer, but it is not complete.
- A participant whose answer is blocked is not yet told which phrase caused it.

Unicode zero-width and bidi control characters are also not stripped by
`sanitizeInput`.

### Other properties

Detection is conservative by design. A false positive costs the participant one
rephrased answer; a false negative places injected text in the prompt's context.
The tradeoff is made in that direction on purpose.

A blocked message returns `status: 'rejected'` and the conversation continues,
rather than erroring the session.

The rules file is overridable with `INJECTION_PATTERNS_PATH`, which exists so the
loader's failure branches can be tested against fixtures. Default is the shipped
file, so behaviour is unchanged when the variable is unset.

A missing or empty rules file falls back to a built-in minimum and logs the fact,
rather than silently passing everything through. An invalid regex is skipped with
a log naming the rule, and the remaining rules stay active.

## Layout

```
server.js                  express app, routes, host check
config/ai-config.json      provider definitions
config/tools.js            tool registry (one entry in V1)
ai/audit-core.js           the interview turn, the matrix gate, the completion guard
ai/field-shapes.js         what a value must look like to count as supplied
ai/matrix.js               what is missing, and the judgement band
ai/identify-core.js        workflow 2: which process a response belongs to
ai/weigh-core.js           workflow 3: the weighing, and its reply parsing
ai/response-shape.js       the one resolver for the two stored payload shapes
ai/workflow-identity.js    the id and title a workflow is given
data/prompts/<tool>/       the prompts, one per language
lib/store/                 SQLite, one file per organisation
lib/auth/                  sessions, sign-in, the console, the participant routes
lib/mail/                  console and Proton transports
views/                     EJS templates
public/                    client script, styles, committed theme data
```

## Storage

**One SQLite database file per organisation**, at `<STORE_DIR>/orgs/<orgId>.db`.

This is the isolation mechanism, not an implementation detail. The schema carries
no `orgId` column, because the file *is* the tenant boundary: a query that forgot a
`WHERE` clause would lose a row, and could not reach another organisation's rows.
Only `lib/store/registry.js` opens a connection, so a code path cannot widen its
scope by accident. A symlink in place of an organisation's file is refused rather
than followed.

V2 replaces this with one database and row-level security, which moves the same
boundary into the database engine. The registry is the seam.

### Anonymity, and its limit

A participant's answers are stored against their invitation, so they can return
and edit them until the questionnaire closes. **The admin path must never receive
that link**, and it does not: `getResponsesForAnalysis(orgId)` omits the join in
the query, so the attribution is not in the row and cannot be leaked by a view.

The accepted limit: **a person with direct access to the database file can join
the two tables and see who said what.** That is a deliberate decision, not an
oversight. The honest phrasing is *"the admin console does not show who said
what"*, never *"answers are anonymous"*.

**The stored transcript makes that limit wider, and this is accepted too.** Each
response keeps the whole conversation, not just the extracted fields, because an
answer is only meaningful against its question and the questions are where the
interview's quality lives. The transcript holds **whatever the participant
typed**, and free text can contain a name, an employer or a customer even though
the prompt tells the model not to ask for personal data and the guardrails screen
injection.

That does not change the property above: the console still cannot join an answer
to a person. What it means is that the raw text exists in the database file, so
"do not read the file if you should not know who said what" is load-bearing.
Exporting or sharing an organisation's file shares the conversations too.

### The round model

**A round is the work of one process.** It is the unit the interview is saved and
scored in, and every turn belongs to exactly one.

A turn **continues the open round**: the participant's answers, and the whole
conversation, are written on every turn, so nothing is lost if they close the tab.
When the model reports that the matrix is satisfied - `status: "complete"`, which the
server computes rather than trusting - **the round is finalised** in the same reply
that carries the closing question *"is there another process?"*, so a finished process
is on disk before that question can be answered. Saying yes **starts a new round**.

`submitted_at` is the boundary: **null is a partial round, a timestamp is a finished
one.** A partial round is readable in the answers view, marked "still in progress"
there, and **excluded from the roadmap's sorting and scoring** - no figure is computed
from work the participant did not finish. A participant who reopens their link resumes
the open round, with their conversation replayed.

`processes` in a reply holds **the process being worked on now**, not every process of
the interview. That is a prompt instruction rather than something the server enforces;
`alreadyIdentified` is what stops a finished process being identified twice.

### Editable until closed

Participants can add and edit until the admin calls `finishOrganisation`. After
that, writes throw and reads still work.
