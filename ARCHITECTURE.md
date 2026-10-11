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
POST /api/score               lib/scoring.js (pure)
GET  /settings/theme          store the theme choice in a cookie
GET  /healthz                 liveness; the only route exempt from the HTTPS rule
```

### Tenancy and identity

Three identifiers, and they are deliberately separate:

| | What it is | Where it lives |
| :--- | :--- | :--- |
| **organisation id** | the tenant, and the filename | the session, **never the request** |
| **invitation id** | who a participant is, stable for the life of the invitation | the org file |
| **token** | a credential that can be replaced | hashed, in `participant_tokens` |

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
  store: there is no query that spans tenants, so any aggregate across
  organisations needs a deliberate export rather than a join.

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
