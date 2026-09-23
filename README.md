# Understudy

Point your OpenAI-compatible client at Understudy instead of your provider. We group your calls
into workloads by the job they do, measure how much your own model disagrees with itself, and
move a workload to a cheaper model only when that model stays inside the same bar twice: once
on the calls it was measured on and again on calls it had never seen. A switch starts on a small
share of the calls and takes more while they hold up. It goes back by itself when it stops
clearing your bar, fails more calls, slows down, or its live calls work less often than your own
model's. Switching back by hand is one click.

Nothing here pretends. Where a key is missing, the screen says so instead of showing a zero as
though it were a fact, and every saving shown is net of our fee and of what finding it cost.

## Run it

```
npm install
cp .env.example .env
npm run build
npm start          # http://localhost:4600
npm test           # every test; the end-to-end ones make their own Postgres database each
```

`npm run dev:web` runs Vite with the API proxied, for working on the screens. Node 22 or newer
is required, and the tests need a Postgres server reachable through `DATABASE_URL` (each test
file creates and drops a database of its own). `node scripts/harness.mjs` prints how often the
measurement and the live decisions are wrong, from simulations; `test/harness.test.js` holds the
numbers that must stay true.

## What needs a key

Everything below works with no keys at all, on real endpoints:

- accounts (sign-up is confirmed by an emailed code), sessions, API keys
- `POST /v1/traces`, workload discovery, every screen, the public pages

These need `OPENROUTER_API_KEY`:

- `POST /v1/chat/completions` (it answers 503 without one, rather than pretending)
- the model catalogue, and therefore every price and every money figure
- measurement, since it replays your calls on real models
- the test call on Connect

These need `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`:

- adding credit, automatic top up, the plan's measuring allowance

`RESEND_API_KEY` sends email (codes, sign-in links, notices). Without it, each email is printed
to the log instead. Email is always sent as `noreply@docupath.ai` unless `EMAIL_FROM` names
another docupath.ai address.

On a public (https) deployment, Stripe payments made in test mode never become balance, unless
`ALLOW_TEST_PAYMENTS=true` says this deployment is for testing. Settings says which state
payments are in.

## Seeing it with traffic

```
node scripts/demo-users.js      # three accounts, password "demo"
SEED_KEY=us_live_... npm run seed
```

`demo-users.js` creates two accounts with traffic plus `new@understudy.demo`, which is left with
none so the getting started guide can always be walked. The seed only ever posts to
`/v1/traces`, so what you see is what a customer would see. `scripts/fake-provider.js` is a
stand-in provider on port 4790 for exercising the measurement engine without spending anything.

## Deploying

Live at **https://understudy.up.railway.app**

It is deployed on Railway, built by Railpack, which needs no build configuration in the repo: it
finds `package.json`, runs `npm install` and `npm run build`, and starts it with `npm start`.

There is deliberately no `railway.json` here. One was added and it broke the build: every
deployment failed about twenty seconds in with a single line of build log and no diagnosis, and
removing the file was what made the build succeed. The settings it was carrying (start command,
health check path and timeout, one replica, restart policy) are set on the service itself.

**Give Postgres a volume, and turn on its backups.** Everything lives in it: accounts, keys,
traffic, measurements, the ledger. The database runs as its own service in the same project,
with a volume at `/var/lib/postgresql/data`, and the app reaches it over the private network
through a reference variable so no password is ever copied between services.

Variables worth setting:

- `OPENROUTER_API_KEY`, or `/v1/chat/completions` answers 503 and no price is known
- `DATABASE_URL`, which on Railway is a reference to the Postgres service
- `PUBLIC_URL`. Connect shows this address to customers as the base URL to point their client
  at, and the sign-in emails build their links from it. **Changing the domain needs a
  redeploy**: the platform's domain arrives as an environment variable, which a running
  container keeps until it restarts
- `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`, if the wallet should be more than read only.
  The webhook endpoint is `POST /api/stripe/webhook`, subscribed to
  `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
  `checkout.session.async_payment_failed`, `payment_intent.succeeded`,
  `payment_intent.payment_failed`, `charge.refunded` and `charge.dispute.created`
- `RESEND_API_KEY`, and `CONTACT_TO` for where the contact form goes
- anything else in `.env.example`. Every number the product reasons about comes from the
  environment (`src/config.js`), and none of it is hardcoded at a call site

Migrations run at boot, so a deploy needs no release step. Session cookies are marked `Secure`
automatically when the app is served over https. `GET /api/status` says which commit is running.

## How a workload is found

No model call is involved. A call's instruction is normalised (digits, quoted strings, URLs and
ids replaced), and matched by its exact structure (tool names, `response_format` and its schema
keys, the shape of the conversation) and by how close its instruction is to ones already seen.
Three things refine that:

- **A name wins.** `x-understudy-workload: <name>` (or `metadata.workload`) puts a call in the
  workload of that name, whatever its words.
- **One workload per model.** The same prompt sent to two models is two workloads, the second
  named after the first with its model beside it: each is held to its own model's answers.
- **Several jobs behind one instruction.** When many calls share one long system prompt and open
  their user turn with a few different instructions ("Summarise the thread below:", "Translate
  this into French:"), each of those becomes a workload of its own once its calls show it.

## How the bar is set, and what clears it

The bar is how much your own model disagrees with itself, measured fresh. We sample your real
calls, spread across the last thirty days and stratified by answer length, and take two answers
from your current model for each: the one it gave you, where it was kept, and one replay. The
disagreement between the two is the noise; the bar is `max(1.25 × noise, 3%)`. A candidate is
replayed once on the same calls and compared against both answers.

Structured answers are compared field by field by what each field is: a deciding field that
differs (a label, an amount, a date, which tool) makes the answer wrong, and a written field that
differs only in wording is read for meaning by a judge. Written answers are judged whole. A
judgement that did not come back is left out of every number rather than counted either way, and
the judge is tested on pairs whose answer is known on every run that leans on it.

A candidate clears only when even the high end of the range its disagreement could be in is
inside the bar (a one-sided 95% bound). That takes about 90 calls for a perfect run at the 3%
floor, so a workload with fewer calls is measured once it has them.

**The second look.** The cheapest model that cleared is measured again on calls it has never
seen, scored the same way and held to a bar read from both samples. Only a model that clears
both times is switched to; one that clears once says so on the workload and waits for a person
or the next measurement. In simulation that took false switches from most runs of ten racing
models to about one in a thousand.

**Only what is shown cheaper.** A model is switched to only when it is priced and costs less
than your own model on your calls once our 1% fee is added.

**Written work with no one right answer** (a story, a slogan) is held to "at least as good" when
your own model varies too much for "the same answer" to be a bar.

If your own model varies too much for either bar, the workload is reported as unmeasurable and
nothing is switched. A bar that everything clears is worse than no bar.

## What a measurement costs, and when it runs

Every measurement is quoted before it starts, second look included, and never spends past what
one measurement of that workload may: at least `EVAL_MAX_USD_PER_RUN`, more for a workload worth
more, never past `EVAL_RUN_CAP_USD`. Answers already paid for, and the ones your own model gave
you, are used again rather than bought twice.

A measurement nobody asked for (the schedule, a new model worth trying) runs only when it can
show something (enough calls for a clear to be possible) and when what it can be expected to
find pays for it within `EVAL_PAYBACK_MONTHS`, net of our fee. A person can always ask. A
workspace can also set its own thirty-day optimizing budget.

Re-checks that keep finding what the last one did space themselves out, doubling up to eight
times the workspace's rhythm. A new or much cheaper model brings a workload's next measurement
forward only when a measurement of that workload would actually try it, never sooner than the
workspace's own rhythm after the last one, and never for a workspace that measures only when asked;
a price rise on the model serving a workload does the same. A workspace that measures only when
asked is never measured by itself, its first measurement included.

## How the models to test are chosen

Every model switched on in Models is a possible replacement, so a measurement first decides which
few are worth paying to test.

**Rule out what cannot do this job**: no provider that keeps nothing (when the workspace requires
that), cannot handle what the requests use, has to think when answers are capped too short, is
being retired, is not answering reliably, or costs as much as the current model at the price that
would really be paid.

**Rank the rest by what each is expected to save**: the saving times the chance it clears. The
chance comes from how it did on this workload before, from the workspace's own other workloads
and from workspaces that chose to share results (Settings, off by default, verdicts only), from
Jev's reading of how it suits the workload, and from its leaderboard rating, and it is read
through how often chances like it came true. Your own model from its cheapest provider, and your
own model thinking less, are candidates of their own.

**Race them**: several at once on the same calls, each dropped as soon as it cannot reach the
bar, is clearly too slow, or its provider refuses it.

A model whose weights anyone can run is served, if it clears, only by the providers that answered
it in the measurement.

## Switching, and learning from live calls

A switch starts on 5% of the workload's calls, grows to 25% and then to all of them
(`ROLLOUT_STAGES`, `ROLLOUT_STAGE_HOURS`, `ROLLOUT_MIN_CALLS`). The rest stay with what served
before, chosen by chance, so the two are compared fairly. It rolls back by itself when its calls
fail more, are seen to work less, or are read as worse. A person approving a switch can give it
every call at once.

Once switched, a small share of calls is answered by your own model as the yardstick, and by
cheaper runners-up. Every live decision (switch back, move to a runner-up, set one aside) is made
on a confidence sequence: a range for the difference that holds at every hourly look at once, so
looking every hour does not turn chance into a decision. Differences in what the traffic shows
(a retry, a tool that failed, a person saying the answer was wrong, an outcome you report) are
held to margins scaled by how often a failure shows at all; with none ever seen, silence decides
nothing. A grader also reads a few of each strategy's answers a day in the background, within a
budget, which can decide on its own and tells how often failures go unseen. A strategy switched
back waits a week before it can return, twice as long each time after, and after the third time
waits for a person.

A conversation stays on the strategy its first call was given.

Each workload is switched one of three ways, chosen per workload and, for new ones, in Settings:
**Optimize automatically** (a model that clears twice is switched to, starting small), **Ask me
first** (it is recommended, emailed about, and waits for approval; new workspaces start here) or
**Never switch** (measured and shown, nothing asks and nothing moves unless a person approves it).
Switching back for safety happens in every mode.

## Headers

- `x-understudy-workload: <name>` names the workload a call belongs to.
- `x-understudy-pin: 1` answers the call with the model it names, whatever the workload was
  switched to. `metadata.understudy_pin` does the same.
- `x-understudy-ref: <yours>` is your reference for a call, to report its outcome later.
- Every answer carries `x-understudy-call-id`, `x-understudy-served-model` (the model that
  answered) and `x-understudy-workload`.

## Money and limits

A call first sets aside the most it can cost, so calls arriving together can never spend the same
balance twice, and gives back what it did not use. The most is a bound, not a guess: the cap the
request names (`max_tokens`), or else the longest answer the model writes, times `n`, at the
dearest provider that keeps nothing; for a model that publishes no longest answer, its whole
context length. The request is sent as it came; only for a model that publishes neither is it
capped at `HOLD_MAX_OUTPUT_TOKENS`. When less is free than a call could cost it
runs only alone, so at most one call's overrun ever lands below zero; a call refused for that says
how much it set aside, and that naming `max_tokens` sets aside less.

An answer that states no cost is charged from its tokens at list price, and a streamed answer that
breaks off part way is charged for what it wrote; both are corrected a minute later to what
OpenRouter recorded for the call. A live stream may run as long as it keeps coming
(`UPSTREAM_IDLE_MS` of silence at most, `UPSTREAM_STREAM_MAX_MS` in all).

Automatic top up is opt-in, charges only a card saved for it at a checkout that said so, runs at
most `TOPUP_MAX_PER_DAY` times a day, and is switched off only by a problem with the card (and the
owner emailed); anything else is retried. Refunds and disputes take the money back off the balance,
and a dispute decided for us gives it back. For that, the Stripe webhook needs these events:
`checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`checkout.session.async_payment_failed`, `payment_intent.succeeded`,
`payment_intent.payment_failed`, `charge.refunded`, `charge.dispute.created`,
`charge.dispute.funds_withdrawn`, `charge.dispute.closed`, `charge.dispute.funds_reinstated` and
`customer.subscription.deleted`. A dispute that is only an inquiry takes nothing off the balance.

A workspace can set daily and monthly spending limits, counted with what calls in flight have set
aside; calls past one are refused with a message saying when they resume (days and months told in
IST).

## Accounts

Signing up sends a code; the account works once the code comes back. The password chosen at
sign-up is kept only when the code is used from the browser that signed up, which holds a secret of
its own for ten minutes; from anywhere else the code still signs in and asks for a password, so
signing up with somebody else's address can never choose their password. Trying a code answers
the same way whether or not the address has an account. Changing the email needs the password,
signs every other session out and tells the old address. Per-address limits read the client's
address from `X-Real-IP`, which Railway's edge sets; with Railway's CDN in front, set
`CLIENT_IP_FROM=xff-first`.

On Anthropic models, a long instruction sent again and again is marked for caching where calls
come often enough to read it back; the saving is counted as ours, and the extra cost of writing
the cache counts against it. A workspace can switch this off.

Emails tell the workspace about a switch made by itself, a candidate waiting for approval, a
switch taken back, a balance running low, a declined top up and a limit reached: each event once,
at most ten a day, each kind switchable in Settings.

## Stopping a measurement

A running measurement has a Stop button. It stops at its next step: the call in flight comes back
and is charged like the rest, every model that answered all of its calls keeps its result, and
nothing is switched on the strength of a measurement that did not finish. One still waiting its
turn is taken out of the queue and costs nothing. After a stop, the next measurement nobody asks
for waits a whole rhythm; after an outage or a failure it tries again after a few hours, longer
each time. A deploy hands the measurements in flight to the new process, which closes the old run
and starts again at once; one a process died in without handing over is closed as interrupted once
it has been quiet for `EVAL_STALE_MIN` minutes. Two measurements of one workload never run at once.

## What is kept, and for how long

Each workspace chooses on Settings: 30, 60 or 90 days, or indefinitely. What ages out is every
copy of what a call said and what was answered, in the call, in measurements, in the answers kept
to reuse, and in a workload's sample. What it cost, which model served it and every measurement
are kept, so a shorter window never changes a chart. `RETENTION_DAYS` is the default.

## Layout

```
src/config.js          every number, all of it from the environment
src/db/                the handle, the migration runner, numbered SQL migrations
src/keys.js            us_live_ keys: a hash to check, sealed copies to show again
src/auth.js            accounts, codes, links, scrypt passwords, hashed session cookies
src/limits.js          per-address rate limits for sign-in, codes and the contact form
src/email.js           the sender and every email's words
src/notify.js          emails about a workspace's own events, each once
src/classify.js        what a call is: its shape, instruction, opening, name and pin
src/workloads.js       which workload a call belongs to, created on first sight
src/workspace.js       workspace choices the proxy reads on every call, kept briefly
src/traffic.js         recording calls, activity, and what the screens are built from
src/openrouter.js      the provider client, the catalogue, how a call is sent upstream
src/proxy.js           /v1/chat/completions and /v1/traces, routeOnce and the stream path
src/billing.js         balance, holds, ledger, gates, limits, allowance, top up
src/stripe-webhook.js  money arriving and leaving through Stripe
src/eval/compare.js    extraction, field-aware disagreement, verdicts with ranges, sampling
src/eval/select.js     which models to test: rule-outs, thinking, ranking (all pure)
src/eval/calibrate.js  how often chances like these came true
src/eval/plan.js       what a measurement would do and cost, and whether it is worth it
src/eval/run.js        one measurement: the bar, the race, the second look, the switch
src/eval/schedule.js   when a workload is next measured by itself
src/eval/judge.js      whether two written answers mean the same, or one is as good
src/eval/actual.js     what routed calls would have cost without us
src/eval/advice.js     savings only the customer can make in their own code
src/eval/promote.js    switching, rolling back, switching back, and the certificate
src/learn/decide.js    live decisions on ranges that hold at every look (all pure)
src/learn/explore.js   experiments, the yardstick, rollouts and the hourly review
src/learn/grade.js     reading a few live answers in the background
src/learn/choose.js    which strategy answers one call
src/jev.js             the Jev client, with places kept for live checks
src/jobs.js            the background runner
src/api.js             everything the screens call
web/src/               the screens
design/                the design canvases these screens were built from
```

`web/src/app.css` is lifted from `design/final/Main.dc.html` so the app and the artboards cannot
drift. `web/src/shell.css` is the app's own and loads after it.
