# Understudy

Point your OpenAI-compatible client at Understudy instead of your provider. We group your
calls into workloads by the job they do, measure how much your own model disagrees with
itself, and move a workload to a cheaper model only when that model stays inside the same
bar. If it stops clearing, it goes back.

Nothing here pretends. Where a key is missing, the screen says so instead of showing a zero
as though it were a fact.

## Run it

```
npm install
cp .env.example .env
npm run build
npm start          # http://localhost:4600
npm test           # the pure parts: fingerprinting, comparison, the bar, sampling
```

`npm run dev:web` runs Vite with the API proxied, for working on the screens. Node 22 or
newer is required.

## What needs a key

Everything below works with no keys at all, on real endpoints:

- accounts, sessions, API keys
- `POST /v1/traces`, workload discovery, every screen

These need `OPENROUTER_API_KEY`:

- `POST /v1/chat/completions` (it answers 503 without one, rather than pretending)
- the model catalogue, and therefore every price and every money figure
- measurement, since it replays your calls on real models
- the test call on Connect

These need `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`:

- adding credit, automatic top up, the observe subscription

## Seeing it with traffic

```
node scripts/demo-users.js      # three accounts, password "demo"
SEED_KEY=us_live_... npm run seed
```

`demo-users.js` creates two accounts with traffic plus `new@understudy.demo`, which is
deliberately left with none so the getting started guide can always be walked. The other
two go straight to the dashboard, because an account with traffic is already connected and
onboarding is not for them.

The seed only ever posts to `/v1/traces`, so what you see is what a customer would see.
`scripts/fake-provider.js` is a stand-in provider on port 4790 for exercising the
measurement engine without spending anything.

## Deploying

Live at **https://understudy.up.railway.app**

It is deployed on Railway, built by Railpack, which needs no build configuration in the
repo: it finds `package.json`, runs `npm install` and `npm run build`, and starts it with
`npm start`.

There is deliberately no `railway.json` here. One was added and it broke the build: every
deployment failed about twenty seconds in with a single line of build log and no
diagnosis, and removing the file was what made the build succeed, even though the file
validated against Railway's own schema. The settings it was carrying (start command,
health check path and timeout, one replica, restart policy) are set on the service itself
instead, where they can be read back and checked. If you reintroduce the file, watch the
first build rather than assuming.

**Give Postgres a volume.** Everything lives in it: accounts, keys, traffic,
measurements, the ledger. The database runs as its own service in the same project, with a
volume at `/var/lib/postgresql/data`, and the app reaches it over the private network
through a reference variable so no password is ever copied between services.

More than one instance is fine now. It was not when this ran on SQLite, where a single
file on a single volume could not be shared, and the service is still pinned to one
replica; that is now a choice rather than a constraint.

Variables worth setting:

- `OPENROUTER_API_KEY`, or `/v1/chat/completions` answers 503 and no price is known
- `DATABASE_URL`, which on Railway is a reference to the Postgres service rather than a
  literal
- `PUBLIC_URL`. On a host that hands the app its own domain this is worked out from that,
  so it can be left unset, but setting it explicitly is safer and this deployment does.
  It matters more than it looks: Connect shows this address to customers as the base URL
  to point their client at, and the sign-in emails build their magic link from it.

  **Changing the domain needs a redeploy.** The platform's domain arrives as an environment
  variable, which a running container keeps until it restarts, so renaming the service
  leaves the app quietly handing customers an endpoint that no longer answers. It is not
  visible from the outside: health is fine, the screens load, and only the one line a
  customer is meant to copy is wrong
- `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`, if the wallet should be more than read
  only. The webhook endpoint is `POST /stripe/webhook`
- anything else in `.env.example`. Every number the product reasons about comes from the
  environment, and none of it is hardcoded at a call site

Migrations run at boot, so a deploy needs no release step. Session cookies are marked
`Secure` automatically when the app is served over https.

## How a workload is found

No model call is involved. A call's system prompt is normalised (digits, quoted strings,
URLs and ids replaced), then hashed together with the ordered tool names, the
`response_format` kind and its schema keys, and the sequence of message roles. The same
job with different data collapses to one workload; a different job does not.

## How the bar is set

The bar is how much your own model disagrees with itself, measured fresh. We sample your
real calls, stratified by answer length, and run each one twice on your current model. The
disagreement between those two answers is the noise; the bar is
`max(1.25 × noise, 3%)`. A candidate is replayed once on the same calls and compared
against both reference answers. A failure, timeout, truncation or unparseable answer counts
as total disagreement and is never skipped. Nothing is judged on fewer than 100 runs.

If a model disagrees with itself more often than `EVAL_NOISE_MAX_PCT`, there is no steady
bar to hold anything to, so the workload is reported as unmeasurable and nothing is
switched. A bar that everything clears is worse than no bar.

A workspace is measured again every 30 days until it chooses otherwise on Settings, where
the choices are only when asked, or every 1, 5, 10, 30 or 90 days. The default comes from
`MEASURE_EVERY_DAYS` and has to be one of those.

## Stopping a measurement

A running measurement has a Stop button. It stops at its next step: the call in flight comes
back and is charged like the rest, every model that answered all of its calls keeps its
result, and nothing is switched on the strength of a measurement that did not finish. One
still waiting its turn is taken out of the queue and costs nothing.

A running measurement writes a heartbeat after every call. One that a deploy or a restart
left behind goes quiet, and once it has been quiet for `EVAL_STALE_MIN` minutes it is closed
as interrupted, so it cannot sit on the page as a bar that never moves or keep Measure now
from starting another.

## What is kept, and for how long

Each workspace chooses on Settings: 30, 60 or 90 days, or indefinitely. What ages out is
the content of a call, the request and the answer. What it cost, which model served it and
every measurement are kept, so choosing a shorter window never changes a chart.
`RETENTION_DAYS` is the default a new workspace starts with.

## Layout

```
src/config.js        every number, all of it from the environment
src/db/              the handle, the migration runner, numbered SQL migrations
src/keys.js          us_live_ keys, stored as a hash plus a display prefix
src/auth.js          accounts, scrypt passwords, hashed session cookies
src/classify.js      the fingerprint that decides what a workload is
src/traffic.js       recording calls, activity, and what the screens are built from
src/openrouter.js    the provider client, the catalogue, per-call pricing
src/proxy.js         /v1/chat/completions and /v1/traces, and routeOnce, the one path
                     every routed call takes, the Connect test call included
src/eval/compare.js  extraction, disagreement, gates, the bar, sampling (all pure)
src/eval/run.js      one measurement run end to end
src/eval/promote.js  switching, switching back, and the certificate
src/billing.js       balance, ledger, gates, automatic top up
src/jobs.js          the background runner, claimed one row at a time
src/api.js           everything the screens call
web/src/router.js    every screen has an address, so every navigation is a real link
web/src/Board.jsx    renders a screen lifted from the design board and fills its holes
web/src/             the screens, on the stylesheet lifted from the design board
design/              the design canvases these screens were built from
```

`web/src/app.css` is lifted from `design/final/Main.dc.html` so the app and the artboards
cannot drift. Regenerate it with the scripts in `design/_gen/` after changing the design.
`web/src/shell.css` is the app's own and loads after it: anything the lifted sheet gets
wrong for the app belongs there, with a note saying why.
