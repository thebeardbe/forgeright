# Deploying forgeright

For putting this on your own server, behind a TLS terminator you already run. If you
only want to look at the product on your own machine, stop here and use
`docker compose up` from the README: that gives you a console at
`https://localhost:8443` with a self-signed certificate and nothing to configure.

This document assumes you have done this before. It spends its words on the settings
that are particular to **this application**, and not on Docker networking, which is
your side of the fence.

## What you need

- **Docker with the compose plugin.**
- **An existing TLS terminator**, already serving your hostname, that can forward to
  this application. nginx, Caddy, HAProxy, a cloud load balancer: the shape is the
  same for all of them and this file does not care which.

That is all. The application needs no database server (it uses SQLite through Node's
built-in `node:sqlite`) and no cache.

## The short version

```bash
git clone <this repository> forgeright
cd forgeright
cp .env.example .env
```

Then edit `.env` and set **five things**. Everything else has a sane default.

```bash
# EVERY VALUE BELOW MARKED "generate" MUST COME FROM THE COMMAND, and the commands are
# given in the next section. Nothing here is a real value and nothing here can be copied
# as one: a secret that appears in a document is a secret every reader shares.
SESSION_SECRET=<paste the output of: openssl rand -hex 32>
DEMO_LOGIN_TOKEN=<paste the output of: openssl rand -base64 32>
PUBLIC_BASE_URL=https://forgeright.example.com
ALLOWED_HOST=forgeright.example.com
TRUST_PROXY=uniquelocal
```

**NEVER COPY A SECRET FROM A DOCUMENT, INCLUDING THIS ONE.** `SESSION_SECRET` signs the
admin session cookie, so anyone who knows it can mint a valid admin cookie for any instance
built with it - that is a full authentication bypass, not a weak password. `DEMO_LOGIN_TOKEN`
opens the read-only demo link, which is a real link to a real instance. Both are generated on
your machine, and the commands are two sections below.

Then:

```bash
docker compose -f docker-compose.deploy.yml up -d --build
```

**This uses `docker-compose.deploy.yml`, not the default file.** That one is the
self-contained local console with its own Caddy; this one is for a server, and it expects
the things a server already has.

## What the deploy file expects

**One thing, and it must exist before you start:** an external Docker network that your
terminator is also on.

```bash
docker network create proxy-network       # if you do not already have one
```

The file refers to it as `proxy-network` and marks it `external: true`, so compose will
not create it and will fail with a clear message if it is missing, rather than quietly
making a second network your nginx is not on. **If you already run other services behind
nginx, use the same network you use for those** and change the name in the file.

**The container is named `forgeright`** and is on that network with **no published ports**.
That is the security property, and it is simpler than publishing: nothing on the host can
reach it, nothing on your LAN can reach it, and the only thing that can is whatever is on
`proxy-network` - which is your nginx.

**It binds `0.0.0.0:3000` inside the container** so nginx can reach it by name. Those
defaults come from the image; the deploy file restates them because `.env` would
otherwise override them with the values for running the app directly on the host (see
below).

**It also forces `STORE_DIR=/data/store`, and that one is easy to get wrong because the
container appears to work without it.** `docker-entrypoint.sh` falls back to `/data/store`
on its own, so the entrypoint and the mounted volume agree; the APP does not, because its
fallback is `<project>/data/store` - a path inside the image. The two only agree when the
variable is set explicitly, and `.env` is shared with the host run mode, where a relative
path like `data/store` is correct and resolves inside the image here. **Leave `STORE_DIR`
unset in `.env` for a container**; the deploy file supplies the right value. The symptom of
getting it wrong is in the table at the end.

**HOW TO CHECK IT IS REACHABLE, in one line:**

```bash
docker compose -f docker-compose.deploy.yml ps
```

**That should show exactly ONE line for the application**, named `forgeright`. If you see
two, you are probably running `docker compose ps` with a profile filter, which selects what
*starts* and not what is *running* - both filters show the same containers. **This file has
one service and no profiles, so there is nothing to filter.**

**THEN CHECK THE PORT, which is the second thing that goes wrong silently:**

```bash
docker compose -f docker-compose.deploy.yml exec forgeright \
  node -e "fetch('http://127.0.0.1:3000/healthz').then(r => console.log(r.status))"
```

`200` means the app is listening inside the container. If nginx still cannot reach it, the
container is not on the same network as nginx - `docker compose ps` shows no ports, which
is correct, because nothing is published. **It is reachable BY NAME on `proxy-network`, not
on a host port.**

### If your terminator runs on the host instead

`tailscale serve`, or any nginx outside Docker, forwards to `http://127.0.0.1:3000` and
**needs a host port, which this file deliberately does not publish.** Uncomment the two
lines under `# --- PUBLISHED ONLY IF YOU ASK FOR IT ---`:

```yaml
    ports:
      - "127.0.0.1:3000:3000"
```

`127.0.0.1` rather than `3000` so the publish is loopback-only: your terminator reaches it
and nothing on the LAN or the tailnet can. Without this line there is nothing listening on
the host's 3000, the tunnel is up, and every request fails.

## The nginx block

```nginx
location / {
    proxy_pass http://forgeright:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
}
```

**`X-Forwarded-Proto` IS REQUIRED, and its absence is the failure you will hit.** Without
it nginx forwards a plain-HTTP request, the app concludes the connection is insecure,
`requireSecureConnection` answers **308**, and the browser follows the redirect to the same
place: an infinite loop with a console that never loads. Measured, so it is not a
theoretical risk.

`Host` is needed because the app refuses a Host it was not told about - a name missing from
`ALLOWED_HOST` is answered **421**, which also looks like a broken deploy.

**`proxy_http_version` and `X-Forwarded-For` are NOT needed.** The app reads no client IP
anywhere, so the extra header would be forwarded and ignored. `http://` in `proxy_pass` is
correct: TLS ends at nginx, and the app is told that it did by the header above.

## Generating the two secrets

**These are generated on your machine. They are not issued by anybody and there is
nothing to sign up for.** Each command below is a program you run; it prints a random
string, and you copy that string into `.env` as the value.

**A SECRET WRITTEN DOWN IS NOT A SECRET.** Neither value below is shown filled in, here or
anywhere else in this document, because a real-looking value in a file people copy is a value
every reader of this repository shares. **`SESSION_SECRET` is the more serious of the two:**
it signs the admin session cookie, so anyone who knows it can mint a valid admin cookie for
any instance that used it - a full authentication bypass, not a weak password.

### `SESSION_SECRET` - signs the admin session cookie

Run this **on your own machine** and copy the line it prints:

```bash
openssl rand -hex 32
```

Then paste it as the whole value, leaving nothing of the placeholder behind:

```bash
SESSION_SECRET=<the line openssl printed>
```

It prints a **different line every time**, so yours cannot match anybody else's - and it must
not. **The server refuses to start without this**, and says so plainly. It does not invent one:
a secret generated per process would invalidate every session on each restart, which looks like
a broken login rather than a missing setting.

### `DEMO_LOGIN_TOKEN` - the credential in the read-only demo link

At least 24 characters, and it travels in a URL, so **use the base64url generator**:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

```bash
DEMO_LOGIN_TOKEN=<the line node printed>
```

**Why not `openssl rand -base64 32` here.** It produces `/`, `+` and `=`, which are not safe in
a query string: the token ends up in the demo link and would have to be percent-encoded, and a
link pasted from a terminal that has already been mangled is hard to tell from a wrong token.
The `base64url` form above uses only letters, digits, `-` and `_`.

**Leave `DEMO_LOGIN` unset if you do not want the demo link at all.** The route is not
registered without it, and `/admin/demo` answers like any unknown path.

## The settings that matter

### `AI_PROVIDER` decides whether the interview is real

```bash
AI_PROVIDER=mock
```

**`mock` cannot run a real interview.** It answers every turn with a fixed interview
question, so it exercises the whole flow without calling anything: the transport, the
guardrails, the scoring, the console. That is what makes it the right default for the
test suite and for an instance that only shows the demo.

**Anyone who signs up to be interviewed needs a real provider.** Leave it on `mock`
and they get a questionnaire that asks its questions and never listens to the answers
- and the resulting roadmap is built from nothing. Set `AI_PROVIDER` to `gemini` or
`deepseek` and set that provider's key:

```bash
AI_PROVIDER=deepseek
DEEPSEEK_API_KEY=<your key from the provider>
```

A provider key **is** a credential you obtain from a company, unlike the two above.
See the AI section of `.env.example` for the full list.

### `TRUST_PROXY` names the peer allowed to claim the request was secure

The application refuses plain HTTP: the admin cookie and the participant link are
bearer credentials, and the answers describe how a business runs. Behind a terminator,
the request arrives over plain HTTP on the inside, and the terminator says
`X-Forwarded-Proto: https` to tell the app what the browser actually used. **The app
believes that header only from a peer named here.**

**This is the setting that most often produces a login loop.** Get it wrong and the
app ignores the header, decides the connection is insecure, and redirects - forever.

The accepted values, in the order you should consider them:

| value | means |
|---|---|
| *(unset)* | trust nothing. Correct when nothing is in front. |
| `127.0.0.1` | **a terminator on this host.** The tightest useful value. |
| `loopback` | alias for `127.0.0.1` and `::1`. |
| `uniquelocal` | **any peer in a private range** (RFC 1918: `10.x`, `172.16-31.x`, `192.168.x`). |
| `10.0.0.1,10.0.0.2` | a list, for a terminator that may appear from more than one address. |
| `::ffff:10.0.0.9` | an IPv4-mapped address, the form Node reports for a 4-in-6 peer. |
| `1` | a hop count. See the warning below. |

**If your terminator runs on the host**, use `127.0.0.1`, or `loopback`.

**If your terminator runs in another container** on a private network and you do not
know its address, or do not want to pin it, use:

```bash
TRUST_PROXY=uniquelocal
```

That trusts any peer in a private range, which is a superset of the one container you
mean. It is the pragmatic setting for compose networking, and it is still far narrower
than trusting everybody: a host with a public address is not in a private range. **Once
you know the terminator's address, name it instead** - it is tighter and it does not
silently cover a container you add later.

**A bare `true` is refused, and the server will not start.** A boolean trusts *every*
client, so any request could claim to be secure. A hostname is refused too: these are
addresses, and `TRUST_PROXY=nginx` is not understood.

**A hop count is accepted but warned about.** It means "trust whoever connects to me",
which a client satisfies as easily as a proxy, since it only has to send the header. It
is safe only when the port is unreachable except through the terminator.

### `X-Forwarded-Proto: https` is required at your terminator

This is the other half, and it is this application's requirement rather than a lesson
in proxying. The app resolves `req.secure` from the connection and from that header,
and refuses the whole site when the answer is no.

**What a missing or wrong setting looks like**, and it is worth recognising because it
does not say "misconfigured":

- every page returns **308**, redirecting to the same URL over `https://`;
- **no session cookie is ever set**, so signing in appears to do nothing;
- the loop is on `PUBLIC_BASE_URL`, so the browser is sent to the correct address and
  the app still behaves as though it were insecure.

The log names the cause. A refused request logs the peer it saw:

```
[auth] refusing an insecure request to GET /admin (host forgeright.example.com, peer 172.17.0.1)
```

**That `peer` is the value `TRUST_PROXY` must name.** It is the fastest way to find the
right setting, and reading it is more reliable than reasoning about your network.

The apps' startup log tells you what it currently trusts:

```
[server] trust proxy: uniquelocal: only these peers may forward the protocol header
```

### `ALLOWED_HOST` prevents a wrong value looking like a broken deploy

```bash
ALLOWED_HOST=forgeright.example.com
```

Comma-separated. Compare is on the hostname only, the port is stripped, and it is
case-insensitive. **A host not on this list gets a 421**, which is an unhelpful error
to debug if you were not expecting it: the deploy looks broken rather than
misconfigured. List every name the browser might use, including the bare IP if you
test that way:

```bash
ALLOWED_HOST=forgeright.example.com,www.forgeright.example.com,127.0.0.1
```

Leave it empty to accept any host, which is for development. **Do not leave it empty
in production**: it is what stops a request carrying a Host header you never intended
to serve.

### `PUBLIC_BASE_URL` is the address the browser uses

```bash
PUBLIC_BASE_URL=https://forgeright.example.com
```

Absolute, including the scheme, and **including any path your terminator mounts this
under** - if the app is served at `https://example.com/forgeright`, then this is
`https://example.com/forgeright`. Sign-in links are built from it and redirects are
sent to it, and both are opened by a browser, so it must be the public address rather
than an internal one.

**It is `https://` even though the app itself speaks http inside your network.** The
scheme here is what the browser sees.

If this is wrong, mail links point at a host nobody can reach, and redirects land
somewhere unexpected. The app refuses a value it cannot parse.

### Who may run the questionnaire: an invitation, and nothing else

**There is no shared code and no open sign-up path to the interview.** To answer the
questionnaire a person needs an **invitation token**: an unguessable, single-purpose
value mailed to them, which identifies both the person and the organisation they
belong to. Without one, the API endpoints refuse the request.

An earlier version also accepted a shared `AUDIT_ACCESS_CODE`. **It has been removed**,
along with the environment variable, because it sat outside this application's security
model rather than beside it: an organisation is created for a sign-up, people are
invited, and every credential names somebody. A secret that anybody in the world could
hold, that identified nobody and belonged to no organisation, could not be reconciled
with that - and no page was asking for it any more either.

**What this means for you:** there is nothing to configure here, and you cannot invite
yourself to an interview. To try the questionnaire on a fresh install, use the console
to invite an address you control and read the link out of the container log, which is
where it goes until a mail transport is configured. See **Mail** below.

**Being interviewed is not how you look at the product.** That is what the read-only
demo link is for, and it needs no invitation at all.

## The two links

The point of the deployment.

**The console, at `/admin`.** The working tool. You sign in, invite participants, and
read the grouped and scored roadmap. This is where an audit actually happens, and it
needs a real `AI_PROVIDER`.

**The read-only demo link, at `/admin/demo?token=...`.** For showing somebody what the
output looks like without giving them an account or asking them to answer anything. It
opens **one committed demonstration organisation**, refuses every write, and cannot see
real data. It works on `AI_PROVIDER=mock`, because it only reads what is already
scored.

That second link is worth understanding before you deploy, because it is the thing you
send a prospective client. It is a credential: it is reusable for its whole life
(60 days by default) and it does not require a sign-in. **Rotate `DEMO_LOGIN_TOKEN` to
invalidate every link you have sent.** Treat it as something that leaves the building,
because it does.

**The commit placeholder token is refused on a real hostname.** The repository ships
`local-demo-read-only-token-change-me` in `docker-compose.yml` so that a local
`docker compose up` works with no setup. If `PUBLIC_BASE_URL` names anything other than
this machine, the app **declines to register the demo route** and says so:

```
[demo] the read-only demo route is NOT registered: DEMO_LOGIN=1 with the committed
placeholder token, but this installation is reachable beyond this machine...
```

So if your demo link 404s after deploying, check the log for that line before anything
else. The fix is the `DEMO_LOGIN_TOKEN` you generated above.

### Where the demonstration organisation comes from

**The demo link shows an organisation that has to be BUILT, and the repository does not
carry one that is ready to serve.** Its processes are grouped and scored by the real pipeline,
which means a provider and a key - and doing that on the deployment would cost calls every time
the container restarts. So it is seeded once, into a file, and that file is what gets served.

**Seed it on a machine you can run the provider on, not necessarily the server:**

```bash
AI_PROVIDER=deepseek STORE_DIR=data/demo node scripts/seed-demo-org.js
```

**`STORE_DIR` IS REQUIRED AND MUST NOT BE THE DEFAULT STORE.** The script deletes and rebuilds
its organisation so it can be re-run, and the default store is where real data lives. It
refuses to run against it rather than trusting you to be careful. `data/demo` is the location
meant for this: it is not gitignored, so the seeded file can be committed and travel with the
repository.

**Cost, printed before anything is spent:** one identification per fixture response plus at
most one weighing per resulting process - roughly 8 and 8 for the shipped fixture, fewer in
practice, because responses describing the same work merge into one process and a process is
weighed once. **A missing key, an unreachable provider or a refused call stops the run** and
names the organisation id and what had been completed, so a half-built organisation is never
mistaken for a working one.

**`AI_PROVIDER=mock` CANNOT SEED ANYTHING.** The mock answers every call with the next
scripted interview question, so identification and weighing have nothing to work from. Both
the startup check and the per-reply check say so rather than letting it read as a broken
demo. That is why the deployment itself needs **no provider and no key for the demo**: the
grouping and the scores are already in the file.

**Putting it on the server.** Copy the seeded `.db` to that machine's `data/demo/orgs/`, then
set `STORE_DIR=data/demo` and point `DEMO_LOGIN_ORG` at the organisation's id - which is the
file's name, `example-ltd-demo` for the committed one. The three other `DEMO_LOGIN*` variables
are described in `.env.example`.

## The one case that changes the publish

The container publishes on `127.0.0.1:3000`, deliberately: the app refuses plain HTTP,
so offering one on every interface would expose it to your network. **A terminator
running on the host reaches a loopback listener, because it dials it from the host
itself.** That covers nginx on the host, Caddy on the host, and Tailscale.

**If your terminator is in another container it cannot reach `127.0.0.1` of the host**,
and you have two ways to fix it, both on your side:

- put both containers on a shared docker network and change the publish to `3000:3000`;
- or attach the app's container to your existing proxy network.

Changing the publish to `3000:3000` means **plain HTTP on every interface of this
host**, which is exactly what the app spends its time refusing to serve. If you do
that, make sure the host's own firewall does not let anything else reach port 3000.

## Verifying it worked

```bash
docker compose -f docker-compose.deploy.yml ps
docker compose -f docker-compose.deploy.yml logs -f forgeright
```

The log should end with something like:

```
[server] listening on http://0.0.0.0:3000
[server] trust proxy: uniquelocal: only these peers may forward the protocol header
[server] accepting hosts: forgeright.example.com, 127.0.0.1
[demo] read-only demo login ENABLED for organisation example-ltd-demo, links valid for 60 day(s)
```

Read those four lines and check them against your `.env`: the trust proxy value is what
you set, and the accepted hosts include the name you deploy under. If a line is
missing, that setting is not what you think it is.

Then, from the host:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://forgeright.example.com/healthz
```

`200`. `/healthz` answers on a plain HTTP connection as well, which makes it the one
endpoint you can use to tell an application problem from a proxy problem.

### `docker compose config` prints your secrets. Do not paste its output anywhere.

```bash
docker compose -f docker-compose.deploy.yml config     # for checking, not for sharing
```

It is genuinely useful - it shows the configuration compose will actually run, with `.env`
substituted, which is how you catch a value the file overrides. **But `env_file` means it
renders every variable in plaintext, including `SESSION_SECRET`, `DEMO_LOGIN_TOKEN`,
`GEMINI_API_KEY` and `DEEPSEEK_API_KEY`.** Its output belongs in your terminal and nowhere
else: not a chat message, not a bug report, not a pasted log in an issue. If you need to show
somebody the shape of the config, replace the values first:

```bash
docker compose -f docker-compose.deploy.yml config \
  | sed -E 's/^([[:space:]]*[A-Z_]*(SECRET|TOKEN|KEY|PASSWORD)[A-Z_]*:).*/\1 <redacted>/'
```

**The regex matches the format compose actually prints, which is `KEY: value` with a colon** -
not `KEY=value` as it appears in `.env`. Verifying that is worth doing: the first version of
this line used `=`, redacted nothing at all, and looked like it had worked.

## If something is wrong

| symptom | cause |
|---|---|
| every page 308s, no cookie is ever set | `TRUST_PROXY` does not name the peer the app sees, or the terminator is not sending `X-Forwarded-Proto: https`. The peer is in the refusal log line. |
| **421** on every request | `ALLOWED_HOST` does not include the name in the browser's address bar. |
| the server exits immediately at startup | `SESSION_SECRET` is unset. The log names it. |
| the demo link **404s** | the app refused the placeholder token, or `DEMO_LOGIN` is not `1`. The log says which. |
| sign-in links point at the wrong host | `PUBLIC_BASE_URL` is not the address the browser uses. |
| the interview asks questions and never listens | `AI_PROVIDER=mock`. |
| the questionnaire refuses to start | the invitation link is wrong, expired or revoked. There is no code to enter: a participant must arrive through a valid token. |
| a **403** on the demo link | that is correct: the demo is read-only and refuses every write. |
| `EACCES: permission denied, mkdir '/app/data/store/orgs'` at startup | `STORE_DIR` is being read from `.env` and points inside the image. The entrypoint reports `/data/store` in the line above it while the app disagrees - that split is the tell. **Leave `STORE_DIR` unset in `.env`**; the deploy file forces the right value. |
| the store looks empty after a redeploy, but the entrypoint said it held organisations | the same split seen from the other side: the entrypoint wrote to the volume and the app read somewhere else. Same fix. |
| `proton-cli` fails with **`x509: certificate signed by unknown authority`** while the app's own API calls work | **the image had no system CA bundle, not a Proton or firewall problem.** This is fixed in the Dockerfile; rebuild with `--build` if you are on an older checkout. See the note below, because the signature matters. |

### `proton-cli` and the system CA bundle

**THE TELL IS THE SPLIT: the app's own outbound calls succeed while `proton-cli` fails.**

```
node fetch('https://api.deepseek.com/')  ->  401          a real HTTP response, so TLS VERIFIED
proton-cli account login                 ->  x509: certificate signed by unknown authority
```

**That combination is not a credential problem and not a Proton outage.** Node ships its own
root certificates and ignores the system store; `proton-cli` is a **Go** binary, and Go reads
the **system** trust store. `node:24-slim` ships without `ca-certificates` at all, so the Go
binary has no roots to verify against and refuses the connection before authentication is
attempted. The error names Proton, which is why it reads as a Proton fault.

`ca-certificates` is now installed in the final build stage, so a current image is fine. If you
meet this on an existing deployment, rebuild rather than debugging credentials:

```bash
docker compose -f docker-compose.deploy.yml up -d --build
```

**Signing in, once**, for the mail sender. The session lands in the `forgeright-proton` volume,
so it survives a rebuild and is only needed again if that volume is removed:

```bash
docker compose -f docker-compose.deploy.yml exec forgeright proton-cli account login
```

**Verify the fix without a Proton account**, in one line. An empty but readable bundle file
means the roots are present; a Go binary can then verify peers:

```bash
docker compose -f docker-compose.deploy.yml exec forgeright \
  sh -c 'ls -l /etc/ssl/certs/ca-certificates.crt'
```
