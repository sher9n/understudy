# Understudy

Point your OpenAI-compatible client at Understudy instead of your provider. We group your
calls into workloads by the job they do, measure how much your own model disagrees with
itself, and move a workload to a cheaper model only when that model stays inside the same
bar. If it stops clearing, it goes back.

## Run it

```
npm install
cp .env.example .env
npm run build
npm start          # http://localhost:4600
npm test           # the pure parts: fingerprinting, comparison, the bar, sampling
```

`npm run dev:web` runs Vite on 5600 with the API proxied, for working on the screens.

## What needs a key

Everything below works with no keys at all, on real endpoints:

- accounts, sessions, API keys
- `POST /v1/traces`, workload discovery, the screens

These need `OPENROUTER_API_KEY` in `.env`:

- `POST /v1/chat/completions` (it answers 503 without one, rather than pretending)
- the model catalogue, and therefore every price and every money figure
- measurement, since it replays your calls on real models

These need `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`:

- adding credit, automatic top up, the observe subscription

The screens say which of these is missing rather than showing a zero as if it were a fact.

## Seeing it with traffic

```
# sign up in the browser, then mint a key on Settings and:
SEED_KEY=us_live_... npm run seed
```

The seed only ever posts to `/v1/traces`, so what you see is what a customer would see.

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

## Layout

```
src/config.js        every number, all of it from the environment
src/db/              the handle, the migration runner, one numbered SQL baseline
src/keys.js          us_live_ keys, stored as a hash plus a display prefix
src/auth.js          accounts, scrypt passwords, hashed session cookies
src/classify.js      the fingerprint that decides what a workload is
src/traffic.js       recording calls, activity, and what the screens are built from
src/openrouter.js    the provider client, the catalogue, per-call pricing
src/proxy.js         /v1/chat/completions and /v1/traces
src/eval/compare.js  extraction, disagreement, gates, the bar, sampling (all pure)
src/eval/run.js      one measurement run end to end
src/eval/promote.js  switching, switching back, and the certificate
src/billing.js       balance, ledger, gates, automatic top up
src/jobs.js          the background runner, claimed one row at a time
src/api.js           everything the screens call
web/src/             the screens, on the stylesheet lifted from the design board
design/              the design canvases these screens were built from
```

`web/src/app.css` is lifted from `design/final/Main.dc.html` so the app and the artboards
cannot drift. Regenerate it with the scripts in `design/_gen/` after changing the design.
