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
  // a call only ever reaches a provider that keeps nothing
  ZDR_ONLY: bool('ZDR_ONLY', true),
  MODEL_MIN_GAP_MS: num('MODEL_MIN_GAP_MS', 3200),
  UPSTREAM_TIMEOUT_MS: num('UPSTREAM_TIMEOUT_MS', 120000),

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
  EVAL_SAMPLE_MAX: num('EVAL_SAMPLE_MAX', 100),
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
  EVAL_MAX_USD_PER_RUN: num('EVAL_MAX_USD_PER_RUN', 2),
  EVAL_JUDGE_MODEL: str('EVAL_JUDGE_MODEL', 'openai/gpt-5.4-mini'),
  EVAL_RECHECK_HOURS: num('EVAL_RECHECK_HOURS', 24),
  /* How often a workspace re-measures by itself, in days. Zero means never: measuring is
     then something a person asks for. Set in Settings; this is the default for a new one. */
  MEASURE_EVERY_DAYS: num('MEASURE_EVERY_DAYS', 7),

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

  EMAIL_FROM: str('EMAIL_FROM', 'Understudy <noreply@docupath.tech>'),
  LOGIN_CODE_TTL_MIN: num('LOGIN_CODE_TTL_MIN', 10),
  LOGIN_CODE_DIGITS: num('LOGIN_CODE_DIGITS', 4),
  /* Four digits is ten thousand combinations, so the cap is what makes it safe, not the
     length. Five wrong guesses spends the code and it cannot be retried. */
  LOGIN_CODE_MAX_ATTEMPTS: num('LOGIN_CODE_MAX_ATTEMPTS', 5),
  LOGIN_CODE_MAX_PER_HOUR: num('LOGIN_CODE_MAX_PER_HOUR', 5),

  // money
  STRIPE_SECRET_KEY: str('STRIPE_SECRET_KEY'),
  /* The Stripe API version every call is made against. Pinned rather than inherited from the
     installed package, so upgrading the package is not the same act as changing the API. */
  STRIPE_API_VERSION: str('STRIPE_API_VERSION', '2026-08-26.dahlia'),
  STRIPE_WEBHOOK_SECRET: str('STRIPE_WEBHOOK_SECRET'),
  /* Nobody is given money they did not pay for. A new account starts at zero and adds
     credit before its first routed call; "send us copies" needs no balance at all. */
  STARTER_CREDIT_USD: num('STARTER_CREDIT_USD', 0),
  /* What somebody may put on at once, so a typo cannot charge a card four figures. */
  TOPUP_MIN_USD: num('TOPUP_MIN_USD', 5),
  TOPUP_MAX_USD: num('TOPUP_MAX_USD', 500),
  TOPUP_AMOUNT_USD: num('TOPUP_AMOUNT_USD', 20),
  TOPUP_THRESHOLD_USD: num('TOPUP_THRESHOLD_USD', 5),
  OBSERVE_PLAN_USD: num('OBSERVE_PLAN_USD', 49),
  EVAL_ALLOWANCE_USD: num('EVAL_ALLOWANCE_USD', 10),

  // background work
  JOBS_ENABLED: bool('JOBS_ENABLED', true),
  JOBS_TICK_MS: num('JOBS_TICK_MS', 5000),
  CATALOG_SYNC_HOURS: num('CATALOG_SYNC_HOURS', 12),
};

/** True when the platform can actually reach a model provider. */
export const canRoute = () => config.OPENROUTER_API_KEY !== '';
/** True when the platform can actually take a payment. */
export const canBill = () => config.STRIPE_SECRET_KEY !== '';
/** True when a message can actually leave the building. */
export const canEmail = () => config.RESEND_API_KEY !== '';
/** True when a key can be shown again after it was made. */
export const canRevealKeys = () => config.KEY_SECRET !== '';

export default config;
