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
  /* Where the database file lives. On a host with an ephemeral filesystem this must point
     at a mounted volume, or every deploy starts from an empty database. */
  DATA_DIR: str('DATA_DIR', 'data'),
  DB_FILE: str('DB_FILE', 'understudy.db'),
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

  // measurement
  EVAL_SAMPLE_SIZE: num('EVAL_SAMPLE_SIZE', 120),
  EVAL_MIN_RUNS: num('EVAL_MIN_RUNS', 100),
  EVAL_FIRST_RUN_MIN_CALLS: num('EVAL_FIRST_RUN_MIN_CALLS', 120),
  EVAL_FLOOR_MULTIPLE: num('EVAL_FLOOR_MULTIPLE', 1.25),
  EVAL_FLOOR_MIN_PCT: num('EVAL_FLOOR_MIN_PCT', 3),
  /* Above this, the customer's own model is not answering consistently enough for a bar to
     mean anything, so nothing may be certified against it. */
  EVAL_NOISE_MAX_PCT: num('EVAL_NOISE_MAX_PCT', 40),
  EVAL_REVIEW_BAND: num('EVAL_REVIEW_BAND', 1.25),
  EVAL_MAX_USD_PER_RUN: num('EVAL_MAX_USD_PER_RUN', 2),
  EVAL_JUDGE_MODEL: str('EVAL_JUDGE_MODEL', 'openai/gpt-5.4-mini'),
  EVAL_RECHECK_HOURS: num('EVAL_RECHECK_HOURS', 24),

  // money
  STRIPE_SECRET_KEY: str('STRIPE_SECRET_KEY'),
  STRIPE_WEBHOOK_SECRET: str('STRIPE_WEBHOOK_SECRET'),
  STARTER_CREDIT_USD: num('STARTER_CREDIT_USD', 1),
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

export default config;
