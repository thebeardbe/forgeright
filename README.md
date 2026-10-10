# forgeright

A workflow audit tool. An employee answers a short questionnaire about the work
they do; the tool scores the answers and produces a ranked view of which tasks
are worth automating, which are not, and why.

**V1 is a standalone application.** It shares no code, no configuration and no
data store with the CV site. That is deliberate: this tool holds client workflow
data, and that should never live beside a personal CV corpus.

## Status

V1, under construction. Running end to end with a mock AI provider.

| Piece | State |
| :--- | :--- |
| Server, routes, trilingual UI | working (NL/EN prompts; FR falls back to EN) |
| Questionnaire flow | working |
| AI providers: mock, Gemini, DeepSeek | working |
| Scoring and aggregation | working, tested |
| Input guardrails | working, tested |
| Roadmap PDF export | not built |
| Guardrail demonstration | not built |
| Accounts, per-business links (multi-tenancy) | V2, not started |

**Reviewed 2026-10-09 and found not to ship.** A serious review by an independent
reviewer found correctness defects in the conflict-collapsing path (a workflow
could be counted twice, or at the inflated estimate the design exists to avoid),
a guardrail that blocked ordinary business answers, and false claims in these
docs. The scoring defects and the guardrail false positives are fixed. The
outstanding items are listed in `NOTES.md` under "Found by review, not yet
fixed"; none of them are hidden. Do not use this as an application artefact
until that list is empty.

## Running it

```bash
npm install
cp .env.example .env      # then set AUDIT_ACCESS_CODE
npm start                 # http://localhost:3000
npm test
```

The default provider is `mock`, which needs no API key and no network. The whole
flow works with it, which is what makes the UI and the scoring layer developable
before any credential exists.

## AI providers

Selected with `AI_PROVIDER` in `.env`. Switching is a config change, not a code
change.

| Value | Notes |
| :--- | :--- |
| `mock` | Canned questions, then a structured audit from a fixture. Default. |
| `gemini` | Needs `GEMINI_API_KEY`. |
| `deepseek` | Needs `DEEPSEEK_API_KEY`. OpenAI-compatible endpoint. |

A missing key warns at startup and fails at request time, rather than silently
falling back to something else.

## How scoring works

```
effortHoursPerWeek = frequencyPerWeek * minutesPerInstance * peopleAffected / 60
score              = effortHoursPerWeek * automabilityFactor
```

`automabilityFactor` is derived from the judgement question (1 = needs a person's
judgement every time, 5 = follows fixed rules) and is discounted further when the
steps vary. **This factor is the point of the tool.** Effort alone ranks the
longest task first, which produces a wish list: contract review takes 75 minutes
a time and is the worst automation candidate in the sample data, not the best.

Results are bucketed into do first, do later, and do not automate. Only the
do-first bucket counts toward the headline total.

### Conflicting answers

Real intake data contradicts itself. When two respondents describe the same
workflow with materially different inputs, the tool:

- reports the disagreement rather than averaging it,
- counts the workflow **once**, at the **lower** estimate.

Both choices are conservative on purpose. Hiding a contradiction, or letting the
louder respondent inflate the hours, would make the roadmap a better pitch and a
worse diagnostic.

**Illustrative data.** The mock fixture is generated to demonstrate the analysis
and is labelled as such everywhere it appears. It is not a real client.

## Layout

```
server.js                  express app, routes, host check
config/ai-config.json      provider definitions
config/tools.js            tool registry (one entry in V1)
ai/config.js               provider resolution, key warnings
ai/provider.js             adapter dispatch
ai/adapters/{mock,gemini,deepseek}.js
ai/audit-core.js           one turn of the questionnaire
ai/security.js             input sanitising, injection detection
ai/fixtures/mock-audit.js  illustrative audit data
lib/scoring.js             scoring and aggregation (pure, tested)
lib/strings.js             UI copy, trilingual
views/audit.ejs            the page
public/js/audit.js         chat and analysis rendering
test/                      tests, written independently of the builder
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

### Editable until closed

Participants can add and edit until the admin calls `finishOrganisation`. After
that, writes throw and reads still work. Adding another process appends a new
response; it never overwrites an earlier round.

### Environment

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `STORE_DIR` | `data/store` | Where the databases live. Point at a volume in production. |
| `STORE_BUSY_TIMEOUT_MS` | `2000` | How long a write waits for another writer's lock. Empty is treated as unset. Clamped to 60s. An explicit `0` is honoured. |

## Deployment

Not yet configured. The intended shape, following the existing tools: its own
container on the VPS, joining the external `proxy-network`, with `ALLOWED_HOST`
set per environment and a volume-mounted store. The subdomain belongs in the
proxy config and in `.env`, never hardcoded in the application.

## Known gaps

- Roadmap PDF export is not built.
- The guardrail demonstration is not built.
- The store exists but the questionnaire does not use it yet. There is no route
  that writes a response, so nothing a participant does is currently persisted.
- No accounts, no per-organisation links, and no admin console. Building those is
  step 2 and step 3.
- The mock provider's scripted flow ignores the participant's actual answers.
  That is fine for developing the UI, but it means the mock proves nothing about
  question quality. Only a real provider can do that.
