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
| `deepseek` | Needs `DEEPSEEK_API_KEY`. OpenAI-compatible endpoint, **asked in plain mode**: its JSON mode silently returns whitespace as a conversation grows. See below. |

A missing key warns at startup and fails at request time, rather than silently
falling back to something else.

### DeepSeek is not asked for JSON mode

`response_format: {type:"json_object"}` returns **11 to 16 spaces** with
`finish_reason: "stop"` and HTTP 200, once a conversation has more than about two
exchanges. Not an error, so it looked like a model that had nothing to say.

```
JSON mode, real 7-message conversation:   0/6 non-blank
plain mode, same conversation:            6/6 non-blank
Gemini, same conversation, JSON mode:     4/4 non-blank   (unaffected)
```

So DeepSeek is asked in plain mode (`sendJsonMode: false` in
`config/ai-config.json`, a per-provider setting) and its replies are parsed out of
prose by `ai/json-extract.js`, which handles a fenced block, surrounding
sentences, and a brace inside a string.

Reproduced on this machine when the workaround was written: with JSON mode forced
back on, one of three calls came back blank; with it off, all three returned JSON.
The measurements, and every explanation that was tested and falsified (token
length, turn count, truncation, rate limiting, the model name), are in
`NOTES-deepseek-json-mode.md`.

**Dropping JSON mode traded one failure for another, and that is fixed too.**
Without `response_format`, DeepSeek answers as bare prose at conversation length:

```
DeepSeek, no help:  "What starts one of these off?"           0/5 usable
```

It does not honour the prompt's "one JSON object, nothing outside it" however that
is worded or placed. The fix is a synthetic **trailing assistant turn** in
`runAuditTurn`, which ends the conversation with the assistant's own commitment to
the format, so the model continues in that form:

```
without:  4 turns 0/4   6 turns 0/4
with:     3 turns 4/4   4 turns 4/4   6 turns 4/4   10 turns 4/4   15 turns 4/4
```

**It is added for every provider**, because a provider-specific branch is exactly
the kind of exception that hid this behaviour in the first place, and it costs
nothing where it is not needed.

**A contradiction worth recording:** the builder measured Gemini returning prose
without the turn; three separate tests here could not reproduce that, including
one through Gemini's own adapter with JSON mode on, which returned usable JSON
5/5. Both sets of measurements are real, and they disagree. It does not change the
outcome — Gemini works either way, and the turn is harmless there — but the
Gemini-needs-it claim should not be trusted until someone reproduces it.

The turn is added only when the last message is a participant turn, and it is
never stored, so it cannot appear in the transcript.

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

**Nothing here scores or ranks.** That is workflow 3, not built.

**The participant never sees any of it.** No participant route imports the process
module, deliberately: a participant who could see where their answer was grouped
would write to influence where it landed.

### How a grouping is stored

| table | what it holds |
| :--- | :--- |
| `process` | the work, named. The stable identity: it survives a rejudge. |
| `process_revision` | one grouping judgement: reasoning, confidence, who decided, and the admin's argument when there was one. |
| `process_response` | which responses a revision covers, and what each contributed. |

**Every judgement is a revision and none is overwritten**, because the spec keeps
both versions: an earlier grouping has to stay readable for anyone reviewing why a
result changed. `is_current` marks the one the console shows, enforced by a
partial unique index so the database refuses a second.

**A revision is a snapshot of the process, not a record of one response.** When a
response joins, the new revision carries forward every response the process
already had, or "the responses behind this process" would lose the work it just
merged. Each response keeps the field list **it** contributed.

**One response is one process.** A description containing a chain is one process
with several steps, not several processes, and the prompt says so explicitly.

## How scoring works

```
effortHoursPerWeek = frequencyPerWeek * minutesPerInstance * peopleAffected / 60
score              = effortHoursPerWeek * automabilityFactor
```

`automabilityFactor` is **derived from the per-step `needsReasoning` flags**, not
from anything the participant is asked. A band runs 1 (needs a person) to 5
(follows rules), and the factor runs 0.15 to 1.00 from it. **This factor is the
point of the tool.** Effort alone ranks the longest task first, which produces a
wish list: contract review takes 75 minutes a time and is the worst automation
candidate in the sample data, not the best.

**The interview never asks whether work needs judgement**, because that asks a
participant to assess automability and they are not placed to know. It asks **on
what basis they decide** (`decidedHow`, their words) and the model derives the
flag from that. See `SPEC-three-workflows.md` for the interview.

Results are bucketed into do first, do later, and do not automate. Only the
do-first bucket counts toward the headline total.

**Two caveats while workflow 3 is unbuilt.** The `stepsConsistent` variation
discount is currently inapplicable, because nothing supplies that field any more —
so the sample headline sits at 74.78 rather than the 55.5 it was. And
`timePerPeriod`, which the interview accepts for continuous work, does not yet
contribute hours to the score; see `NOTES.md`.

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
lib/users.js               who may sign in, and which organisation they belong to
lib/provision.js           a sign-in resolved to a user, creating both if new
lib/token-index.js         which organisation owns a participant token
lib/auth/console.js        the console, scoped to the session's organisation
lib/auth/participant-routes.js  the questionnaire link and the lost-my-link form
lib/store/                 per-organisation storage (step 1)
lib/store/processes.js     workflow 2: grouping a response into a process
lib/store/process-sql.js   the process, revision and membership statements
ai/identify-core.js        workflow 2: the comparison, and the shared reply parsing
ai/matrix.js               workflow 1: the completeness matrix and the judgement band
data/prompts/*/identify_*.md  the workflow 2 prompt, per language
lib/auth/tokens.js         sign-in links: hashed, single use, expiring
lib/auth/session.js        signed session cookie, SESSION_SECRET check, loopback test
lib/auth/routes.js         /admin login, logout, console, session guard
lib/auth/require-secure.js the HTTPS-only rule, applied to every route
lib/auth/public-base-url.js the installation's own URL, for links and redirects
lib/auth/rate-limit.js     in-memory limits on the login request
lib/base-path.js           the mount path and the public path, and URL prefixing
lib/landing.js             the landing page at /
lib/routes-api.js          /api/chat and /api/score, and who may use them
lib/theme.js               palette resolution, the theme cookie, its middleware
lib/palettes.js            the 22 palettes as data (dark/light parts beside it)
public/css/palette.css     generated: the 22 palettes as CSS variables
public/css/app.css         semantic roles and the shared components
public/css/questionnaire.css  the conversation and analysis styles
views/partials/            the theme head and the picker, included by every page
scripts/build-palette-css.js  regenerates palette.css from the data
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

**The stored transcript makes that limit wider, and this is accepted too.** Each
response keeps the whole conversation, not just the extracted fields, because an
answer is only meaningful against its question and the questions are where the
interview's quality lives. The transcript holds **whatever the participant
typed**, and free text can contain a name, an employer or a customer even though
the prompt tells the model not to ask for personal data and the guardrails screen
injection. Nothing in this system prevents a participant volunteering one.

That does not change the property above: the console still cannot join an answer
to a person, and the transcript is not shown anywhere in the admin view. What
changed is that the raw text now exists in the database file, so "do not read the
file if you should not know who said what" is load-bearing rather than a
formality. Exporting or sharing an organisation's file now shares the
conversations too.

### Editable until closed

Participants can add and edit until the admin calls `finishOrganisation`. After
that, writes throw and reads still work. Adding another process appends a new
response; it never overwrites an earlier round.

### The two prefixes

A reverse proxy can separate the path a request arrives with from the path the
browser uses, so there are two prefixes:

| | in an incoming request | in an emitted URL |
| :--- | :--- | :--- |
| **`BASE_PATH`** | the mount: what Express strips | not used |
| **`PUBLIC_PATH`** | not used | the prefix on every link, form action, asset and the cookie `Path` |

`PUBLIC_PATH` is derived from the path in `PUBLIC_BASE_URL`, so it is not normally
set. The three deployments:

| proxy behaviour | `BASE_PATH` | `PUBLIC_BASE_URL` |
| :--- | :--- | :--- |
| passes the prefix through | `/forgeright` | `https://host/forgeright` |
| **strips the prefix** | *(empty)* | `https://host/forgeright` |
| no prefix | *(empty)* | `https://host` |

The middle row is `tailscale serve --set-path /forgeright`, which strips the
prefix before forwarding. The app must then expect requests at the root while
still emitting `/forgeright` in its URLs. Setting `BASE_PATH=/forgeright` there
produces a 404, because the app waits for a prefix it is never sent; setting no
public path produces links that leave the mount. Both halves are needed, and they
are what the two variables separate.

The session cookie's `Path` is the **public** prefix (`/forgeright/admin`), because
that is what the browser sees. It has to be: a cookie scoped to `/admin` is not
sent for a request to `/forgeright/admin`, so sign-in would appear to do nothing.

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

### Long-lived participant links, and the trade accepted

A participant link is a credential in a URL, and it stays usable for 90 days. That
is deliberate, and this is the reasoning, recorded rather than left to look like
an oversight:

- **Friction loses respondents.** The premise of this tool is that people fill in
a questionnaire between other work. A link that expires in an hour, or that is
used up on first open, adds a step and loses replies, which is a worse outcome
than the exposure below.
- **So the token appears in places that keep copies**: browser history, any proxy
access log, and the mailbox as plain text (the mail carries it as copyable text so
a mangled link is recoverable).
- **What the exposure is worth, stated exactly.** The token grants one person's
answers to one organisation's questionnaire. It does **not** grant console
access, any role, or any other participant's answers. An observer who takes a
token gets a form to fill in as that person, not an account.
- **Two actions exist to end it.** "Reset all access" in the console and "Lost my
link" on the participant page both revoke every live token for that invitation and
issue one new one. Those are the answer to a link that leaked, and they are one
implementation with two callers.

Admin sign-in is deliberately different: single use, and 15 minutes. It grants an
organisation rather than one person's answers, so the blast radius is not
comparable and neither is the rule.

### Themes

The appearance is one of 22 palettes, chosen per browser.

- The palette is **data** in `lib/palettes.js` (with the colour values in the two
dark parts and the light part beside it), emitted as CSS custom properties by
`scripts/build-palette-css.js`, and the generated `public/css/palette.css` is
committed. A change to a colour is a change to the data and a regeneration.
- `public/css/app.css` maps those variables onto **semantic** roles (`--bg`,
`--card`, `--accent`), and components use only the roles. No component names a
palette colour, so adding a theme cannot break one.
- **The default follows the system**: Catppuccin and Catppuccin Latte when no
choice is stored.
- **The choice is a cookie**, `fr_theme`, not `localStorage`. A cookie reaches the
server, so the palette is in the HTML and the first paint is correct rather than
patched after it. It is `SameSite=Lax`, not `HttpOnly` (the page reads it to keep
the picker in step), and long-lived.

Three palettes have no `orange` (last-horizon, solitude, white). That is a
property of the upstream theme data; the substitution is one line in
`paletteVars`, not a blank value.

### Environment

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `ALLOWED_HOST` | empty | Hosts this instance answers on, comma-separated (`localhost,127.0.0.1,forgeright.bunkens.be`). Empty accepts any host, for development. Compared on hostname only, case-insensitively; empty entries are ignored. |
| `TRUST_PROXY` | `0` | Number of reverse proxies in front. Decides whether `X-Forwarded-Proto` is believed, and therefore whether a request counts as secure. **Set to 1 when one proxy terminates TLS**, or every request looks insecure and the whole site refuses. |
| `BASE_PATH` | empty | Path the app is **mounted** at: the prefix an incoming request carries, which Express strips. Empty means it expects requests at the root. Must be a single safe path, or the server refuses to start. |
| `PUBLIC_PATH` | derived | Path the app is **visible** at: the prefix every emitted URL and the session cookie carry. Normally derived from `PUBLIC_BASE_URL`'s path, so it needs no value. Set it only to override, and it must then agree with that URL. |
| `SESSION_SECRET` | none | Signs the admin session cookie. **Required**: the server refuses to start without it, because a per-process secret would invalidate every session on restart and look like a broken login. |
| `fr_theme` (cookie) | follows the system | The chosen palette, or `system`. Set by the theme picker, read on the server so the page renders in the right theme. |
| `PUBLIC_BASE_URL` | none | Absolute address of this installation. Used for mailed sign-in links, as the target when a plain-HTTP request is redirected to HTTPS, and as the source of the public path. Include the prefix. |
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
- **The questionnaire is persisted only when it is reached from an invitation
  link.** A participant with a token can answer, and answers are stored against
  their invitation, but the bot conversation itself still runs from the browser
  session and does not yet write through the store on every turn.
- Admin sign-in and the console exist (steps 2 and 3). The console shows one
  organisation: its name, its invitations with opened state, and its users.
- **Every address that signs in becomes an admin of its own organisation.**
  There is no allow-list: self-service is the intended first-run behaviour, and
  the login response is identical for a known and an unknown address. Requiring
  an existing admin to invite a colleague is what the `user` role and the console's
  Users section are for.
- **Several links can be live at once.** "Send a link" adds one and leaves the
  others working, which is what a participant who missed the first email needs;
  "Reset all access" and "Lost my link" revoke them all and issue one. Neither a
  resend nor a reset can re-mail the *exact* earlier link: the database keeps only
  a hash, never the readable value. See "Long-lived participant links" above for
  why that is the accepted trade, and the console's help text for what each button
  does.
- **Rate limiting is in memory, per process.** It stops a loop or a script
  filling an inbox; it is not a distributed quota, and a restart clears it.
- The mock provider's scripted flow ignores the participant's actual answers.
  That is fine for developing the UI, but it means the mock proves nothing about
  question quality. Only a real provider can do that.
