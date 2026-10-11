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
| Admin sign-in (magic link, session cookie) | working, tested |
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
cp .env.example .env      # then set AUDIT_ACCESS_CODE and SESSION_SECRET
openssl rand -hex 32      # paste this as SESSION_SECRET
npm start                 # http://localhost:3000
npm test
```

`SESSION_SECRET` is required: the server refuses to start without it, rather than
generating one per process, because that would invalidate every admin session on
restart and look like a broken login. The sign-in link is printed to the terminal
(`MAIL_SENDER=console`), so the admin flow works locally with no mail account.

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
lib/store/                 per-organisation storage (step 1)
lib/auth/tokens.js         sign-in links: hashed, single use, expiring
lib/auth/session.js        signed session cookie, SESSION_SECRET check, loopback test
lib/auth/routes.js         /admin login, logout, console, session guard
lib/auth/require-secure.js the HTTPS-only rule, applied to every route
lib/auth/public-base-url.js the installation's own URL, for links and redirects
lib/auth/rate-limit.js     in-memory limits on the login request
lib/base-path.js           BASE_PATH: normalisation, validation, URL prefixing
lib/mail/                  mail sending behind one interface (console, proton)
views/audit.ejs            the questionnaire page
views/admin-login.ejs      the sign-in page and the cookie notice
views/admin-console.ejs    where signing in lands; the real console is step 3
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

### HTTPS only

**Everything is served over HTTPS, except localhost.** The questionnaire, the API,
the static assets and the admin console all refuse a plain-HTTP request. A refused
request is redirected (308, so a POST stays a POST) to the same path at the HTTPS
address in `PUBLIC_BASE_URL`, or answered with an explanation when no HTTPS
address is configured.

Why the questionnaire is included, not just the admin console:

- The **participant link is a bearer credential**. It is single-use and short-lived,
  but a token sent in cleartext can be used by anyone who observes it *before* the
  participant does, submitting answers in someone else's name and corrupting the
  roadmap the client then acts on.
- The **answers are employees describing how the business runs**, which is the
  sensitive material this product exists to collect.
- `AUDIT_ACCESS_CODE` travels in the request body of `/api/chat` and `/api/score`.

`req.secure` decides, so a proxy that terminates TLS must be trusted for this to
work: set `TRUST_PROXY=1` when exactly one proxy sits in front, and only when that
proxy is the only thing able to reach the port. A client that can reach the port
directly could otherwise send `X-Forwarded-Proto` itself.

**Localhost is exempt**, and the exemption requires both a loopback peer and a
loopback `Host`, so neither half alone grants it: a local process cannot claim a
public hostname, and a remote client cannot claim loopback. A loopback connection
never crosses a network, so there is no wire to read a credential from, and
without the exemption nothing is testable locally.

**`/healthz` is exempt too**, deliberately. It reports a boolean and nothing else,
so there is no data or credential on the wire, and refusing it would make a
plain-HTTP liveness probe fail and have an orchestrator restart a healthy
container. A security control that causes an outage is worse than the exposure it
prevents. If the endpoint ever reports anything else, it loses the exemption.

### Environment

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `ALLOWED_HOST` | empty | Hosts this instance answers on, comma-separated (`localhost,127.0.0.1,forgeright.bunkens.be`). Empty accepts any host, for development. Compared on hostname only, case-insensitively; empty entries are ignored. |
| `TRUST_PROXY` | `0` | Number of reverse proxies in front. Decides whether `X-Forwarded-Proto` is believed, and therefore whether a request counts as secure. **Set to 1 when one proxy terminates TLS**, or every request looks insecure and the whole site refuses. |
| `BASE_PATH` | empty | Prefix this app is served under, when a proxy mounts it on one (`/forgeright`). Empty means the domain root. Must be a single safe path, or the server refuses to start. |
| `SESSION_SECRET` | none | Signs the admin session cookie. **Required**: the server refuses to start without it, because a per-process secret would invalidate every session on restart and look like a broken login. |
| `PUBLIC_BASE_URL` | none | Absolute address of this installation. Used for mailed sign-in links **and** as the target when a plain-HTTP request is redirected to HTTPS. Include the base path. |
| `LOGIN_LINK_TTL_MINUTES` | `15` | How long a sign-in link stays valid. A link is single-use regardless. |
| `SESSION_TTL_HOURS` | `12` | How long an admin session lasts. |
| `MAIL_SENDER` | `console` | `console` prints the message to stdout (no credentials); `proton` sends through `proton-cli`. An unknown value refuses to start rather than silently falling back. |
| `MAIL_PROTON_PROFILE` | `jobsearch` | The `proton-cli` profile to send from when `MAIL_SENDER=proton`. |
| `STORE_DIR` | `data/store` | Where the databases live. Point at a volume in production. |
| `STORE_BUSY_TIMEOUT_MS` | `2000` | How long a write waits for another writer's lock. Empty is treated as unset. Clamped to 60s. An explicit `0` is honoured. |

### Mail

Magic links and invitations are sent through one `send({ to, subject, body })`
interface, so the mechanism is testable without a mailbox and the transport can be
swapped without touching the login flow.

**Development and testing send from `beard_jobagent@proton.me`** (the `jobsearch`
profile). That mailbox is disposable on purpose: a bug here costs nothing, which
is not true of the address a client would see.

**Production will send from a `bunkens.be` address.** The transport, the profile
and the address are all configuration, so switching is an environment change
rather than a code change.

Two things to get right when this runs unattended, because both fail quietly:

- A Proton session can expire. If it has, the sender must fail loudly rather than
  the message simply never arriving.
- The sending address must not be hardcoded, so the change from the test mailbox
  to the business one is deliberate and visible.

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
- Admin sign-in exists (step 2): an emailed magic link, a signed session cookie,
  and a login page. **The console behind it is a placeholder** that shows who is
  signed in; listing organisations and their progress is step 3.
- **Any well-formed address can request a sign-in link.** There is no allow-list
  yet, so the admin console is not restricted to particular people. Adding one is
  part of step 3, and the login response is already identical for a known and an
  unknown address so that adding it does not change observable behaviour.
- **Rate limiting is in memory, per process.** It stops a loop or a script
  filling an inbox; it is not a distributed quota, and a restart clears it.
- The mock provider's scripted flow ignores the participant's actual answers.
  That is fine for developing the UI, but it means the mock proves nothing about
  question quality. Only a real provider can do that.
