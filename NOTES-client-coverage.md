# Client-side coverage: `public/js/audit.js`

**Status: no automated coverage. A change to it is unprotected.**

Written down because the finding lived in a subagent session and would otherwise
have died with it. Measured on 2026-10-11.

## Why it matters

`public/js/audit.js` holds the payload decision that decides whether a completed
interview is shown to the participant or silently dropped. It was **wrong** until
`632918d`: `data.audit || (...)` short-circuits on a truthy-but-unusable `audit`,
so a valid `processes` array beside an empty `{}` was discarded, the interview
closed, an empty payload was persisted, and scoring ran against nothing.

That defect survived **five review rounds** because the only thing testing the
behaviour was a hand-copied replica of the expression inside the test file. A copy
agrees with itself. The replica had diverged from the real file and contained the
broken form, so the suite was green while the shipped code was wrong.

## Why there is no test

- **No browser harness exists.** No jsdom, no playwright, no vitest or mocha.
  `node --test` is the entire suite.
- **`puppeteer` is a dependency imported by nothing.** It is in `package.json`; a
  grep finds it only there, in `package-lock.json` and in this file.
- **A browser is available** (`/usr/bin/chromium`, v154) and puppeteer can drive
  it, so the missing piece is harness code rather than a browser.
- **The file is one IIFE with no exports and no seam.** Nothing is callable
  without either a real page or extracting the logic.

## The two ways to close it, cheapest first

1. **Extract the payload decision into a small pure module** (for example
   `public/js/payload.js`) that `audit.js` calls and `node --test` imports. Data
   in, data out, no browser. **Recommended** — it is the decision, not the DOM,
   that is worth a test, and it is pure.
2. **A real browser harness**: a fixture page matching `views/audit.ejs` ids,
   a `window.AUDIT_CONFIG` stub, an intercepted `fetch` returning a canned
   `/api/chat` body, then observe the POSTed `/api/response` and `/api/score`.
   Real coverage of the real file; costs a page fixture, a stub backend, and
   making puppeteer load-bearing.

**A third thing that looks like a way and is not: copying the expression into a
test.** That is what was there, and it is how the defect survived.

## What is covered instead

`test/wire-contract.test.js` pins the **server's** side of the agreement on the
serialised form, so a body that would break the client never reaches it: no
truthy-but-unusable `audit`, and a usable `workflows` array whenever one is
present. That protects the contract, not the consumer.

## The same shape one layer down

`renderAnalysis(result)` trusts `res.json()` from `/api/score` entirely and
dereferences `result.buckets.do_first` without a shape check. `lib/routes-api.js`
cannot return a malformed body on success, so it holds today — the same kind of
unguarded forward-defence as the fixed guard, with no coverage for the same
reason. Not a defect; recorded so it is a known gap rather than an oversight.
