/* Every number the product reasons about lives here, and every one of them can be
   moved from the environment. Nothing below is hardcoded at a call site. */

const num = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`${name} is not a number: ${raw}`);
  return v;
};

const str = (name, fallback = '') => {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
};

const bool = (name, fallback) => {
  const raw = str(name);
  if (raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
};

/* The cadences a workspace can choose on Settings, in days. 0 is "only when I ask". The
   screen, the route that saves a choice and the default all read this one list. */
export const MEASURE_CHOICES = [0, 1, 5, 10, 30, 90];

/* The cadence a workspace has until it chooses one. It has to be one of the choices: it used
   to be 7, which is not, so a workspace that never chose saw no choice selected on Settings
   while every workload was quietly measured every week, on a cadence nobody could see or
   pick. A value from the environment that is not a choice falls back to 30 and says so,
   rather than recreating that. */
const measureDefault = () => {
  const days = num('MEASURE_EVERY_DAYS', 30);
  if (MEASURE_CHOICES.includes(days)) return days;
  console.warn(`MEASURE_EVERY_DAYS=${days} is not one of the choices on Settings `
    + `(${MEASURE_CHOICES.join(', ')}), so 30 is used instead.`);
  return 30;
};

/* The address customers are given.

   Connect shows this to them as the base URL to point their client at, so getting it wrong
   hands them something that resolves to nothing. Set PUBLIC_URL explicitly if the app sits
   behind your own domain; on a host that hands the app a domain of its own, that domain is
   the answer and is picked up without configuring anything. */
const publicUrl = () => {
  const given = str('PUBLIC_URL');
  if (given) return given.replace(/\/+$/, '');
  const host = str('RAILWAY_PUBLIC_DOMAIN');
  if (host) return `https://${host}`;
  return `http://localhost:${num('PORT', 4600)}`;
};

export const config = {
  PORT: num('PORT', 4600),
  /* Postgres. One database, one connection string. Locally this points at a database on
     your own machine; in production the platform supplies it. */
  DATABASE_URL: str('DATABASE_URL', 'postgresql://localhost:5432/understudy'),
  PG_POOL_MAX: num('PG_POOL_MAX', 10),
  /* Managed Postgres usually presents a certificate the app has no root for, and the
     connection is inside a private network. Off locally, on when a URL says so. */
  PG_SSL: bool('PG_SSL', /[?&]sslmode=require/.test(str('DATABASE_URL'))),
  PUBLIC_URL: publicUrl(),
  /* A session cookie crosses the public internet once this is deployed, so it is marked
     Secure whenever the app is served over https. */
  SECURE_COOKIES: bool('SECURE_COOKIES', publicUrl().startsWith('https://')),

  // routing
  OPENROUTER_API_KEY: str('OPENROUTER_API_KEY'),
  OPENROUTER_BASE: str('OPENROUTER_BASE', 'https://openrouter.ai/api/v1'),
  ROUTING_FEE_PCT: num('ROUTING_FEE_PCT', 1),
  /* A call only reaches a provider that keeps nothing, unless the workspace chose otherwise on
     Settings (it still never reaches one that trains on it). ZDR_FORCED takes the choice away from
     every workspace on this deployment. */
  ZDR_ONLY: bool('ZDR_ONLY', true),
  ZDR_FORCED: bool('ZDR_FORCED', false),
  MODEL_MIN_GAP_MS: num('MODEL_MIN_GAP_MS', 3200),
  UPSTREAM_TIMEOUT_MS: num('UPSTREAM_TIMEOUT_MS', 120000),
  /* The longest we wait before retrying when a provider says it is busy, whatever it asks for.
     Uncapped, one call could wait out any Retry-After three times over and outlast the silence
     a measurement is allowed (EVAL_STALE_MIN), so a slow but live run would be closed as
     abandoned. Capped, the slowest call is four timeouts and three of these waits. */
  UPSTREAM_RETRY_WAIT_MAX_MS: num('UPSTREAM_RETRY_WAIT_MAX_MS', 30000),
  /* A live call is somebody's app waiting. It gets this many retries on a busy provider, each
     waiting at most this long, and then the next way of serving it: the customer's own model. Up to
     three waits of thirty seconds each left a customer's call hanging for a minute and a half. */
  LIVE_RETRIES: num('LIVE_RETRIES', 1),
  LIVE_RETRY_WAIT_MAX_MS: num('LIVE_RETRY_WAIT_MAX_MS', 2000),
  /* The longest an experiment's call may take before it gives way to what serves. */
  EXPERIMENT_TIMEOUT_MS: num('EXPERIMENT_TIMEOUT_MS', 45000),

  // what we keep, and for how long
  RETENTION_DAYS: num('RETENTION_DAYS', 30),

  /* Grouping calls into workloads, as a distance over a 64 bit SimHash of the instruction.
     Measured across 17 same-job pairs and 4 different-job pairs, the worst same-job pair
     sits at 22 and the closest different-job pair at 28, so 24 is in the middle of the gap
     with room either side. Raising it merges jobs that are not the same; lowering it splits
     one job into several. */
  WORKLOAD_MATCH_MAX_DISTANCE: num('WORKLOAD_MATCH_MAX_DISTANCE', 24),
  /* A shape has to be seen this often before it is worth a row on anybody's screen. Below
     it the workload exists and counts, but stays out of the way. */
  WORKLOAD_MIN_CALLS: num('WORKLOAD_MIN_CALLS', 20),
  /* Past this many live workloads the matcher stops making new ones and widens instead, so
     unusual traffic cannot turn into an unreadable list of hundreds. */
  WORKLOAD_MAX_LIVE: num('WORKLOAD_MAX_LIVE', 200),
  /* Naming a workload is a small job that needs a model to FOLLOW AN INSTRUCTION, and
     "whichever is cheapest in the catalogue" is the wrong way to choose one for that: the
     cheapest model changes every time the catalogue does, which is how a router with a
     price of minus two million ended up naming everybody's traffic. Named explicitly, with
     the cheapest as a fallback only if this one is not stocked.

     Chosen by asking four candidates to name the same poetry workload: gpt-4.1-mini said
     poetry-request, mistral-nemo poem-request, claude-haiku generate-creative-poem, and
     gemini-2.5-flash-lite said user-query-interpretation, which is a description of reading
     rather than of the job. Cheapness is not the quality that matters here. */
  WORKLOAD_NAME_MODEL: str('WORKLOAD_NAME_MODEL', 'openai/gpt-4.1-mini'),

  // measurement
  /* How many of a workload's own calls a run replays.
     Never fewer than ten, because a handful of calls cannot tell a real difference from
     luck. Never more than a hundred, because every one is paid for. And never more than half
     of what the workload has, so a measurement is always made on a sample and there is
     always untouched traffic left to check a promoted model against later. */
  EVAL_SAMPLE_MIN: num('EVAL_SAMPLE_MIN', 10),
  EVAL_SAMPLE_MAX: num('EVAL_SAMPLE_MAX', 120),
  EVAL_SAMPLE_SHARE: num('EVAL_SAMPLE_SHARE', 0.5),
  /* So the smallest measurable workload is twice the smallest sample. */
  EVAL_MIN_CALLS: num('EVAL_MIN_CALLS', 20),
  /* How many models a run tries, and the most anybody may ask for. Set per workspace in
     Settings; this is the default and the ceiling. */
  EVAL_MODELS_DEFAULT: num('EVAL_MODELS_DEFAULT', 10),
  EVAL_MODELS_MAX: num('EVAL_MODELS_MAX', 20),
  EVAL_MIN_RUNS: num('EVAL_MIN_RUNS', 100),
  EVAL_FIRST_RUN_MIN_CALLS: num('EVAL_FIRST_RUN_MIN_CALLS', 40),
  EVAL_FLOOR_MULTIPLE: num('EVAL_FLOOR_MULTIPLE', 1.25),
  EVAL_FLOOR_MIN_PCT: num('EVAL_FLOOR_MIN_PCT', 3),
  /* Above this, the customer's own model is not answering consistently enough for a bar to
     mean anything, so nothing may be certified against it. */
  EVAL_NOISE_MAX_PCT: num('EVAL_NOISE_MAX_PCT', 40),
  EVAL_REVIEW_BAND: num('EVAL_REVIEW_BAND', 1.25),
  /* What one measurement may spend. Anybody may ask for one up to EVAL_MAX_USD_PER_RUN; a workload
     worth more may spend more, up to what its expected saving pays back in EVAL_PAYBACK_MONTHS and
     never past EVAL_RUN_CAP_USD. A measurement nobody asked for (a re-check, a new model worth
     trying) only runs when its expected saving pays for it within EVAL_PAYBACK_MONTHS; a workload
     already switched counts EVAL_PROTECT_SHARE of the saving it protects towards that. */
  EVAL_MAX_USD_PER_RUN: num('EVAL_MAX_USD_PER_RUN', 2),
  EVAL_RUN_CAP_USD: num('EVAL_RUN_CAP_USD', 20),
  EVAL_PAYBACK_MONTHS: num('EVAL_PAYBACK_MONTHS', 2),
  EVAL_PROTECT_SHARE: num('EVAL_PROTECT_SHARE', 0.5),
  EVAL_JUDGE_MODEL: str('EVAL_JUDGE_MODEL', 'openai/gpt-5.4-mini'),
  /* The calls a measurement draws on: at most this many from each of the last thirty days, so a busy
     workload is sampled across its month rather than from its last few hours. */
  EVAL_POOL_PER_DAY: num('EVAL_POOL_PER_DAY', 60),
  /* Whether the answer the customer's own model actually gave a call is used as one of the two the bar
     needs, so only one is paid for. */
  EVAL_USE_RECORDED: bool('EVAL_USE_RECORDED', true),
  /* The second look before anything is switched: the cheapest models that cleared (at most this many)
     are measured again on calls they have never seen, on at least EVAL_CONFIRM_MIN calls and on
     EVAL_CONFIRM_MULTIPLE times the fewest a perfect run needs to clear the bar. */
  EVAL_CONFIRM_TRIES: num('EVAL_CONFIRM_TRIES', 2),
  EVAL_CONFIRM_MIN: num('EVAL_CONFIRM_MIN', 30),
  EVAL_CONFIRM_MULTIPLE: num('EVAL_CONFIRM_MULTIPLE', 2),
  /* Written work with no one right answer is held to "at least as good" when it cannot be held to
     "the same answer". */
  EVAL_QUALITY_YARDSTICK: bool('EVAL_QUALITY_YARDSTICK', true),
  /* Re-checks that keep confirming what serves are spaced out, doubling at most this many times;
     a change in the catalogue that could matter to a workload brings its next one forward to within
     EVAL_NUDGE_HOURS. */
  EVAL_BACKOFF_MAX_DOUBLINGS: num('EVAL_BACKOFF_MAX_DOUBLINGS', 3),
  EVAL_NUDGE_HOURS: num('EVAL_NUDGE_HOURS', 6),
  EVAL_NUDGE_MIN_DAYS: num('EVAL_NUDGE_MIN_DAYS', 7),
  /* How a new workload is switched in a workspace that has not chosen: 'ask' (a person approves each
     switch), 'auto' or 'off'. Workspaces choose for themselves in Settings. */
  DEFAULT_OPTIMIZE_MODE: ['ask', 'auto', 'off'].includes(str('DEFAULT_OPTIMIZE_MODE', 'ask')) ? str('DEFAULT_OPTIMIZE_MODE', 'ask') : 'ask',
  /* A measurement nobody asked for waits until it has enough calls to show a cheaper model is as good
     as the customer's own at the bar it expects: the lowest bar for structured answers, and this one
     for written answers, whose own model varies more, until a measurement has set the real one. */
  EVAL_FIRST_FLOOR_TEXT_PCT: num('EVAL_FIRST_FLOOR_TEXT_PCT', 10),
  /* How often a workspace re-measures by itself, in days. Zero means never: measuring is
     then something a person asks for. Set in Settings; this is what a workspace has until it
     chooses, and it is always one of MEASURE_CHOICES. */
  MEASURE_EVERY_DAYS: measureDefault(),
  /* A running measurement writes a heartbeat just before every call it sends. One whose
     heartbeat is older than this has nothing running it any more, usually because a deploy or
     a restart took the process that was, and is closed so its workload can be measured again.
     It has to outlast the slowest single call: four tries of UPSTREAM_TIMEOUT_MS and three
     waits of at most UPSTREAM_RETRY_WAIT_MAX_MS, which by default is nine and a half minutes. */
  EVAL_STALE_MIN: num('EVAL_STALE_MIN', 15),

  /* Choosing which models to measure, and racing them.
     A measurement tries models in order of what they are expected to save, several at once,
     and drops each one the moment it cannot win. It keeps going until the number asked for
     in Settings have answered every call, trying at most this many times that number. */
  EVAL_TRY_MULTIPLE: num('EVAL_TRY_MULTIPLE', 3),
  EVAL_PARALLEL_MODELS: num('EVAL_PARALLEL_MODELS', 5),
  /* The first few calls every model answers before anything is decided about it. */
  EVAL_SCREEN_CALLS: num('EVAL_SCREEN_CALLS', 3),
  /* A model is only tried when at least one provider that keeps nothing answered this share
     of its calls over the last day. */
  EVAL_MIN_UPTIME_PCT: num('EVAL_MIN_UPTIME_PCT', 99),
  /* A model that thinks before it answers needs room to think. When a workload caps its
     answers below this, a thinking model is measured with its thinking switched off, or
     left out when it cannot be switched off. (Without a cap, it is asked to think the way
     the customer's own model does: see thinkingFit in src/eval/select.js.) */
  EVAL_THINKING_ROOM_TOKENS: num('EVAL_THINKING_ROOM_TOKENS', 4000),
  /* A model retiring within this many days is not worth switching anybody to. */
  EVAL_EXPIRY_DAYS: num('EVAL_EXPIRY_DAYS', 30),
  /* How much slower than the customer's own model a switched-to model may be, by setting.
     "same" allows a little, because two measurements of the same speed never match exactly.
     The slow end (one call in ten) is allowed half as much again on top. */
  SPEED_SAME: num('SPEED_SAME', 1.2),
  SPEED_SLOWER_OK: num('SPEED_SLOWER_OK', 1.5),
  SPEED_SLOW_END_EXTRA: num('SPEED_SLOW_END_EXTRA', 0.5),
  /* And never slower by less than this, in milliseconds: a gap nobody would notice is not worth
     turning a model down for, and two measurements of a fast model differ by that much anyway. */
  SPEED_SLACK_MS: num('SPEED_SLACK_MS', 300),
  /* Before anything is spent, a model whose published speed is this many times worse than the
     customer's own model's is not tried at all. Published speeds mix everybody's traffic, so
     this only catches the wildly slow; the calls themselves decide the rest. */
  SPEED_PREFILTER_X: num('SPEED_PREFILTER_X', 3),

  /* Jev, TypeSafe's judging model. It answers a narrow question with a probability rather than
     writing text, which is what judging two answers and ranking models both need.

     It is reached through OpenRouter by default: the same System One API, billed to the
     OpenRouter account the replays already use, and served there by a provider that keeps
     nothing, which TypeSafe's own API offers only on enterprise plans. JEV_VIA picks the route:
     'openrouter', 'typesafe' (TypeSafe's own API, with TYPESAFE_API_KEY), or 'off', in which
     case the model named in EVAL_JUDGE_MODEL judges alone, as it did before. */
  JEV_VIA: str('JEV_VIA', 'openrouter'),
  TYPESAFE_API_KEY: str('TYPESAFE_API_KEY', ''),
  TYPESAFE_BASE: str('TYPESAFE_BASE', 'https://api.typesafe.ai/v1'),
  JEV_MODEL: str('JEV_MODEL', 'jev-latest'),
  JEV_PRICE_PER_MTOK: num('JEV_PRICE_PER_MTOK', 0.042),
  JEV_CONCURRENCY: num('JEV_CONCURRENCY', 12),
  JEV_TIMEOUT_MS: num('JEV_TIMEOUT_MS', 20000),
  /* A cascade's check on a live call: one try, this long at most, and never a wait behind other
     questions. A check that does not come back in time sends the call on to the customer's own
     model, which is always safe; a slow Jev then rests the live checks for a minute. */
  JEV_LIVE_TIMEOUT_MS: num('JEV_LIVE_TIMEOUT_MS', 3000),
  /* Between these, Jev is not sure whether two answers mean the same thing, and the model in
     EVAL_JUDGE_MODEL is asked as well. */
  JEV_UNSURE_LOW: num('JEV_UNSURE_LOW', 0.3),
  JEV_UNSURE_HIGH: num('JEV_UNSURE_HIGH', 0.7),

  /* Learning from live calls, within limits each workload sets.

     A measurement compares answers; what the customer cares about is whether they work, which
     only live calls show. So a small share of a switched workload's calls can go to something
     other than what serves it: half of that share to the customer's own model, as the yardstick
     the serving strategy is held against, and half to runners-up that are cheaper still. "Careful"
     and "normal" are those shares. "Shadow" never changes an answer: a runner-up answers a copy of
     that share of calls in the background, and only how closely it matched is kept. Whatever the
     setting, a day's experiments never add more than the workload's budget to the bill. */
  EXPLORE_SHARE_CAREFUL: num('EXPLORE_SHARE_CAREFUL', 0.02),
  EXPLORE_SHARE_NORMAL: num('EXPLORE_SHARE_NORMAL', 0.05),
  SHADOW_SHARE: num('SHADOW_SHARE', 0.05),
  EXPLORE_BUDGET_USD: num('EXPLORE_BUDGET_USD', 0.5),
  /* How the evidence is weighed: a call counts half as much after this many days; an answer given
     in the background counts this much of one that was used; a call is only read once this many
     minutes have passed, since a retry or a correction takes a moment to arrive. */
  LEARN_HALF_LIFE_DAYS: num('LEARN_HALF_LIFE_DAYS', 14),
  LEARN_SURROGATE_WEIGHT: num('LEARN_SURROGATE_WEIGHT', 0.3),
  LEARN_SETTLE_MIN: num('LEARN_SETTLE_MIN', 10),
  /* What it takes to act on live evidence alone: this many calls on what is being judged, and this
     much certainty that it works at least as often as what it is compared with, give or take this
     tolerance (0.02 is two calls in a hundred). */
  LEARN_MIN_CALLS: num('LEARN_MIN_CALLS', 30),
  LEARN_CONFIDENCE: num('LEARN_CONFIDENCE', 0.95),
  LEARN_TOLERANCE: num('LEARN_TOLERANCE', 0.02),
  /* Live results only decide anything where outcomes are seen often enough for "worked" to mean
     something: at least this share of calls has ever shown a signal, or the customer reports results. */
  LEARN_MIN_DETECTION: num('LEARN_MIN_DETECTION', 0.02),
  /* In "normal" mode the experiment share grows on a quiet workload, up to this, so that evidence
     arrives within a half-life rather than in a year: the yardstick needs about eight calls a day. */
  EXPLORE_SHARE_MAX: num('EXPLORE_SHARE_MAX', 0.1),
  EXPLORE_YARDSTICK_PER_DAY: num('EXPLORE_YARDSTICK_PER_DAY', 8),

  /* How long what we learn stays true. Models improve, providers are added and dropped,
     prices and speeds move, so every fact is read again once it is this old. */
  HEALTH_TTL_MIN: num('HEALTH_TTL_MIN', 60),          // which providers keep nothing, and their uptime
  SPEED_TTL_MIN: num('SPEED_TTL_MIN', 60),            // published first-token times and speeds
  FIT_TTL_DAYS: num('FIT_TTL_DAYS', 14),              // Jev's reading of how a model suits a task
  ARENA_TTL_DAYS: num('ARENA_TTL_DAYS', 7),           // the public Arena leaderboard
  ARENA_LINK_TTL_DAYS: num('ARENA_LINK_TTL_DAYS', 30),
  REPLAY_REUSE_DAYS: num('REPLAY_REUSE_DAYS', 14),    // an answer already paid for
  REPLAY_FAILURE_REUSE_HOURS: num('REPLAY_FAILURE_REUSE_HOURS', 6),  // a refusal, which can be fixed sooner
  JUDGE_CACHE_DAYS: num('JUDGE_CACHE_DAYS', 14),      // a verdict on a pair of answers

  /* Email. Without a key nothing is sent, and the code is written to the log instead so
     the flow can still be walked locally. The FROM address has to be on a domain the
     provider has verified, or every message is silently rejected. */
  /* Encrypts API keys at rest so a customer can be shown their own again. Without it the
     app falls back to showing a prefix, rather than storing keys in the clear: a deployment
     that forgot to set this should be less useful, never less safe. Generate one with
     `openssl rand -hex 32`, and keep it: change it and existing keys can no longer be
     shown, only replaced. */
  KEY_SECRET: str('KEY_SECRET'),

  RESEND_API_KEY: str('RESEND_API_KEY'),

  /* Who hears about a call that did not get through, and how often. The first failure is
     sent at once; everything in the window after it is counted and reported in one message
     when the window closes, because an outage fails every call for as long as it lasts and
     a message per call would be thousands of them. */
  ALERT_EMAIL: str('ALERT_EMAIL', 'sherancorera@gmail.com'),
  ALERTS_ENABLED: bool('ALERTS_ENABLED', true),
  ALERT_WINDOW_MIN: num('ALERT_WINDOW_MIN', 10),

  /* docupath.tech is refused in src/email.js whatever this says: mail from it is quarantined where
     it lands and reported delivered, so nobody would ever know. */
  EMAIL_FROM: str('EMAIL_FROM', 'Understudy <noreply@docupath.ai>'),
  /* Where the contact form on the site sends what people write. Never shown on a page. */
  CONTACT_TO: str('CONTACT_TO', ''),
  LOGIN_CODE_TTL_MIN: num('LOGIN_CODE_TTL_MIN', 10),
  /* Six digits is a million combinations. With five tries a code and five codes an hour, a
     guesser has 25 tries an hour at one address: about one chance in 40,000. Four digits made it
     one in 400, which is days of patient guessing, not years. */
  LOGIN_CODE_DIGITS: num('LOGIN_CODE_DIGITS', 6),
  LOGIN_CODE_MAX_ATTEMPTS: num('LOGIN_CODE_MAX_ATTEMPTS', 5),
  LOGIN_CODE_MAX_PER_HOUR: num('LOGIN_CODE_MAX_PER_HOUR', 5),
  /* Limits per internet address, so one machine cannot work through many accounts or send a
     flood of mail. They count every request the same way whether or not the address has an
     account, which is what keeps them from telling anybody who has one. */
  LIMIT_SIGNIN_PER_IP_15MIN: num('LIMIT_SIGNIN_PER_IP_15MIN', 20),
  LIMIT_CODES_PER_IP_HOUR: num('LIMIT_CODES_PER_IP_HOUR', 20),
  LIMIT_VERIFY_PER_IP_HOUR: num('LIMIT_VERIFY_PER_IP_HOUR', 40),
  LIMIT_SIGNUP_PER_IP_HOUR: num('LIMIT_SIGNUP_PER_IP_HOUR', 10),
  LIMIT_CONTACT_PER_IP_HOUR: num('LIMIT_CONTACT_PER_IP_HOUR', 5),
  LIMIT_CONTACT_PER_DAY: num('LIMIT_CONTACT_PER_DAY', 100),

  // money
  STRIPE_SECRET_KEY: str('STRIPE_SECRET_KEY'),
  /* The Stripe API version every call is made against. Pinned rather than inherited from the
     installed package, so upgrading the package is not the same act as changing the API. */
  STRIPE_API_VERSION: str('STRIPE_API_VERSION', '2026-08-26.dahlia'),
  STRIPE_WEBHOOK_SECRET: str('STRIPE_WEBHOOK_SECRET'),
  /* Whether a payment made with a Stripe TEST key may become balance. Yes on a machine of our own
     (plain http), no on any https deployment unless this says so, because a test key takes the
     public practice card and the models behind the balance are paid for with real money. */
  ALLOW_TEST_PAYMENTS: bool('ALLOW_TEST_PAYMENTS', !publicUrl().startsWith('https://')),
  /* Nobody is given money they did not pay for. A new account starts at zero and adds
     credit before its first routed call; "send us copies" needs no balance at all. */
  STARTER_CREDIT_USD: num('STARTER_CREDIT_USD', 0),
  /* What somebody may put on at once, so a typo cannot charge a card four figures. */
  TOPUP_MIN_USD: num('TOPUP_MIN_USD', 5),
  TOPUP_MAX_USD: num('TOPUP_MAX_USD', 500),
  TOPUP_AMOUNT_USD: num('TOPUP_AMOUNT_USD', 20),
  TOPUP_THRESHOLD_USD: num('TOPUP_THRESHOLD_USD', 5),
  /* The most automatic top ups a workspace gets in a day before it is asked to decide. */
  TOPUP_MAX_PER_DAY: num('TOPUP_MAX_PER_DAY', 10),
  /* Money set aside for a call in flight: what it could cost, reserved before it is sent and given
     back once it is answered. A hold lapses after this long, longer than the slowest call can take,
     so a process that died mid-call cannot freeze a balance. An answer with no length cap is
     reserved as this many tokens, and no answer as more than the second number. */
  HOLD_TTL_MIN: num('HOLD_TTL_MIN', 15),
  /* A provider that keeps nothing can charge more than the list price, so a hold is the list price
     times this; a model with no known price is held at a fixed amount. */
  HOLD_PRICE_MULTIPLE: num('HOLD_PRICE_MULTIPLE', 2),
  HOLD_UNPRICED_USD: num('HOLD_UNPRICED_USD', 0.25),
  HOLD_DEFAULT_OUTPUT_TOKENS: num('HOLD_DEFAULT_OUTPUT_TOKENS', 2000),
  HOLD_MAX_OUTPUT_TOKENS: num('HOLD_MAX_OUTPUT_TOKENS', 32000),
  OBSERVE_PLAN_USD: num('OBSERVE_PLAN_USD', 49),
  EVAL_ALLOWANCE_USD: num('EVAL_ALLOWANCE_USD', 10),

  // background work
  JOBS_ENABLED: bool('JOBS_ENABLED', true),
  JOBS_TICK_MS: num('JOBS_TICK_MS', 5000),
  /* How much background work runs at once, and how many measurements of it. Every tick used to start
     another runner while the last was still busy, so measurements piled up side by side without
     limit, all on the connections live calls use. Background work now has its own connections too. */
  JOBS_CONCURRENCY: num('JOBS_CONCURRENCY', 3),
  EVAL_CONCURRENCY: num('EVAL_CONCURRENCY', 2),
  PG_BG_POOL_MAX: num('PG_BG_POOL_MAX', 6),
  /* One line per customer call, per change made from a screen, and per failure, in the deploy log. */
  REQUEST_LOGS: bool('REQUEST_LOGS', true),
  CATALOG_SYNC_HOURS: num('CATALOG_SYNC_HOURS', 6),
};

/** True when the platform can actually reach a model provider. */
export const canRoute = () => config.OPENROUTER_API_KEY !== '';
/* Which kind of payments the Stripe key takes. A test key takes Stripe's public practice card
   numbers, so on a deployment that spends real money on models, a test payment must never turn
   into balance: anybody could "pay" with the practice card and spend the operator's credit. */
export const stripeMode = () => {
  const k = config.STRIPE_SECRET_KEY;
  if (!k) return 'off';
  return /^(sk|rk)_live_/.test(k) ? 'live' : 'test';
};
/** live, test (allowed, on a machine of our own), test_refused (a test key on a public deployment), or off. */
export const paymentsState = () => {
  const m = stripeMode();
  if (m !== 'test') return m;
  return config.ALLOW_TEST_PAYMENTS ? 'test' : 'test_refused';
};
/** True when the platform can actually take a payment that becomes balance. */
export const canBill = () => ['live', 'test'].includes(paymentsState());
/** True when a message can actually leave the building. */
export const canEmail = () => config.RESEND_API_KEY !== '';
/** True when a key can be shown again after it was made. */
export const canRevealKeys = () => config.KEY_SECRET !== '';
/** True when Jev can be asked to judge and rank. */
export const canJev = () => (config.JEV_VIA === 'openrouter' ? config.OPENROUTER_API_KEY !== ''
  : config.JEV_VIA === 'typesafe' ? config.TYPESAFE_API_KEY !== '' : false);

export default config;
