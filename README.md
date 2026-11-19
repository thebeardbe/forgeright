# forgeright

A workflow audit tool. An employee answers a short questionnaire about the work they do
by hand; the tool groups what they describe, weighs each process against ten terms, and
produces a ranked list of what is worth automating first, what can wait, and what should
not be automated at all.

**It shares no code, configuration or data store with anything else.** It holds client
workflow data, which should never live beside another project's.

## Alpha

**The roadmap's score is a model judgement, not a measurement, and the participant
preview is a demonstration. Both are useful and neither is a substitute for your own
judgement.**

The tool is deployed and in use, and it is an alpha: the scoring model is provisional and
will change as real answers come in, and there are known limits recorded in `NOTES.md`
under "Found by review, not yet fixed". Read those before relying on an output.

## See it

**A live, read-only demo**: one organisation's real audit output, with nothing to install
and no account.

```
https://forgeright.bunkens.be/admin/demo?token=7HAJ4SjR8Tq4a4TlEBLGA2QgMf3R-vV_sbhMTqgluCc
```

**It is read-only.** You can open every page and change nothing: the server refuses every
write from a demo session, and the buttons that would change something are shown disabled.
It shows one pinned demonstration organisation and cannot see any real data. The link
carries a token, which is rotated by changing `DEMO_LOGIN_TOKEN` in the deployment's
environment; a rotated token makes the old link stop working.

The same demo runs locally from the container, with no provider key and no network, in the
commands below.

## Run it

```bash
npm install
cp .env.example .env      # then set SESSION_SECRET
openssl rand -hex 32      # paste this as SESSION_SECRET
npm start                 # http://localhost:3000
npm test
```

**`SESSION_SECRET` is required.** The server refuses to start without it, rather than
generating one per process, because a per-process secret invalidates every admin session
on restart and looks like a broken login.

**The default provider is `mock`**, which needs no API key and no network: it asks scripted
questions and returns a fixture audit. The whole flow works with it, so the UI and the
scoring layer are developable before any credential exists. **A deployment runs a real
provider** (`AI_PROVIDER=deepseek` or `gemini`); the mock never finishes an interview.

Sign-in links print to the terminal by default (`MAIL_SENDER=console`), so the admin flow
works locally with no mail account.

### In a container, with the demo already in it

```bash
cp .env.example .env      # then set SESSION_SECRET
docker compose up         # the local console, on https://localhost:8443
```

Then open **https://localhost:8443/admin** and sign in as `demo@example.test`, or open the
read-only demo:

```
https://localhost:8443/admin/demo?token=local-demo-read-only-token-change-me
```

**No provider key is needed** for either: the demo database is committed, so its processes
are already grouped and scored. A provider is needed only to run a live interview or to
reweigh something.

**It is https, and that is not decoration.** The app refuses plain HTTP, because the admin
cookie and the participant link are bearer credentials and the request bodies describe how
a business runs. Caddy terminates TLS in front with its own local CA, so a browser warns
once that the certificate is not from a public authority. Accept it, or trust Caddy's CA:

```bash
docker cp forgeright-proxy-1:/data/caddy/pki/authorities/local/root.crt caddy-root.crt
sudo cp caddy-root.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates
```

**The store is a named volume**, so `docker compose down` and `up` keeps anything you
change; `down -v` is the explicit way to throw it away and return to the committed demo.
`data/demo` is mounted read-only and never written to.

**If a container will not start**, `docker compose logs forgeright` names the reason the
app refused. A missing `SESSION_SECRET` is the common one, and the container shows as
`Restarting` rather than `Up`.

### For a server

**`docker-compose.yml` is the local shape only**: Caddy on `8443`, self-signed, no setup.
A server uses **`docker-compose.deploy.yml`** instead: one service on an external
`proxy-network`, no published ports and no TLS handled in the container, with a proxy in
front terminating it. That is a separate file deliberately, so a deployment does not carry
a second terminator it has to keep working.

**`DEPLOY.md` is the deployment guide**: the settings that cause a login loop when they are
wrong, the two secrets, why a mock provider cannot run a real interview, and what to verify
after a build.

## The two links

A running instance serves two audiences, and they are deliberately separate.

**The console, at `/admin`.** The working tool: invite participants, they answer, and the
console groups and scores what they said. It needs a real `AI_PROVIDER` and a key, because
the intake conversation is an actual conversation.

**The read-only demo, at `/admin/demo`.** For showing somebody the output without an
account. It opens one committed organisation, refuses every write, and cannot see real
data. It works on `AI_PROVIDER=mock`, because it only reads what is already scored.

**A participant reaches the questionnaire only through an invitation.** There is no shared
code and no tokenless way in: the token in the link is the only credential, it names one
person and one organisation, and resolving it is what opens the store. A visit without a
valid token cannot start the interview.

## Where to read next

| | |
| :--- | :--- |
| **`ARCHITECTURE.md`** | how it works: the request flow, the three workflows, storage, the two scorers, the payload shapes |
| **`DEPLOY.md`** | deploying it: settings, secrets, TLS, mail, and what to verify after a build |
| **`SPEC-three-workflows.md`** | the specification the build was written against |
| **`NOTES.md`** | known limits and deferred work, including "Found by review, not yet fixed" |

## Not built

Roadmap PDF export, the guardrail demonstration, and V2's multi-tenancy (accounts and
per-business links; V1 is one file per organisation).
