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

The repo carries `railway.json`, so the build command, the start command and the health
check at `/health` are already set. Two things are not optional.

**Mount a volume, and point `DATA_DIR` at it.** Everything lives in one SQLite file:
accounts, keys, traffic, measurements, the ledger. A host with an ephemeral filesystem
throws that away on every deploy. Mount a volume at `/data` and set `DATA_DIR=/data`, and
do it before the first sign-up rather than after.

**Keep it to one instance.** A SQLite file on one volume cannot be shared between
replicas. `railway.json` pins `numReplicas` to 1; scale past that and two instances will
write over each other.

Variables worth setting:

- `OPENROUTER_API_KEY`, or `/v1/chat/completions` answers 503 and no price is known
- `DATA_DIR=/data`, as above
- `PUBLIC_URL`, only if the app sits behind your own domain. On a host that hands the app
  its own domain this is worked out from that, and it matters: Connect shows this address
  to customers as the base URL to point their client at
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
