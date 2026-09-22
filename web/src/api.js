const send = async (method, path, body) => {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!res.ok) throw new Error(json?.error || `Something went wrong (${res.status}).`);
  return json;
};

export const api = {
  me: () => send('GET', '/me'),
  signUp: (b) => send('POST', '/auth/sign-up', b),
  signIn: (b) => send('POST', '/auth/sign-in', b),
  signOut: () => send('POST', '/auth/sign-out'),
  requestCode: (email) => send('POST', '/auth/code/request', { email }),
  verifyCode: (email, code) => send('POST', '/auth/code/verify', { email, code }),
  overview: (days) => send('GET', days ? `/overview?days=${days}` : '/overview'),
  workloads: () => send('GET', '/workloads'),
  workload: (id) => send('GET', `/workloads/${id}`),
  workloadRuns: (id) => send('GET', `/workloads/${id}/runs`),
  workloadRun: (id, runId) => send('GET', `/workloads/${id}/runs/${runId}`),
  setModelsTested: (count) => send('POST', '/settings/models-tested', { count }),
  setMeasureEvery: (days) => send('POST', '/settings/measure-every', { days }),
  workloadCalls: (id, { page = 1, q = '' } = {}) =>
    send('GET', `/workloads/${id}/calls?page=${page}&q=${encodeURIComponent(q)}`),
  callText: (id, callId, field) => send('GET', `/workloads/${id}/calls/${callId}/text?field=${field}`),
  setMode: (id, mode) => send('POST', `/workloads/${id}/mode`, { mode }),
  setSpeed: (id, pref) => send('POST', `/workloads/${id}/speed`, { pref }),
  promote: (id, model) => send('POST', `/workloads/${id}/promote`, { model }),
  revert: (id) => send('POST', `/workloads/${id}/revert`),
  measure: (id) => send('POST', `/workloads/${id}/measure`),
  stopMeasuring: (id) => send('POST', `/workloads/${id}/measure/stop`),
  models: () => send('GET', '/models'),
  setModel: (id, enabled) => send('POST', `/models/${id}/enabled`, { enabled }),
  settings: () => send('GET', '/settings'),
  newKey: (name) => send('POST', '/settings/keys', { name }),
  revokeKey: (id) => send('DELETE', `/settings/keys/${id}`),
  profile: (b) => send('POST', '/settings/profile', b),
  autoTopUp: (enabled) => send('POST', '/settings/auto-topup', { enabled }),
  retention: (days) => send('POST', '/settings/retention', { days }),
  connect: () => send('GET', '/connect'),
  testCall: () => send('POST', '/connect/test'),
  finishOnboarding: () => send('POST', '/connect/done'),
  addCredit: (amountUsd) => send('POST', '/billing/checkout', { amountUsd }),
  regenerateKey: () => send('POST', '/connect/regenerate-key'),
};

/* Money, at a precision where the number can actually be seen.
 *
 * Two decimals is right for a bill and wrong for this product. A model call costs a fraction
 * of a cent, so a real spend of $0.00207809 printed as "$0.00", and a balance that had gone
 * down from $10 to $9.99792191 printed as though nothing had happened. Three decimals would
 * still have shown one of those calls as $0.000.
 *
 * So the precision follows the size of the number. Ordinary amounts get two decimals and
 * read as ordinary money. Small ones get four. Anything under a cent gets however many
 * decimals it takes to show two real digits, because that is the whole point: a number small
 * enough to round away is exactly the one somebody is squinting at. Nothing is ever printed
 * as zero unless it is zero, and the minus sign goes before the dollar, not after it.
 */
const FLOOR_DP = 2;      // ordinary money never reads as $10.5
const SMALL_DP = 4;      // under a dollar, four is enough to see a charge move
const MOST_DP = 8;       // and this is as far as it is worth going

export const usd = (n) => {
  const v = Number(n) || 0;
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a === 0) return '$0.00';

  let dp;
  if (a >= 100) dp = FLOOR_DP;                       // sub-cent digits on a hundred are noise
  else if (a >= 0.01) dp = SMALL_DP;
  else dp = Math.min(MOST_DP, -Math.floor(Math.log10(a)) + 1);   // two real digits, wherever they start

  const body = a.toFixed(dp).replace(/0+$/, '');
  const [whole, tail = ''] = body.split('.');
  if (Number(whole) === 0 && tail === '') return `${sign}<$${(10 ** -MOST_DP).toFixed(MOST_DP)}`;
  return `${sign}$${Number(whole).toLocaleString('en-US')}.${tail.padEnd(FLOOR_DP, '0')}`;
};

/* A balance is money you HAVE, so it is only ever rounded DOWN. Showing $10.00 for an
   account holding $9.99997989 overstates it, and the balance is the one number where "why
   has it not moved" is a question somebody actually asks. Rounding down answers it: the
   figure is always something you can spend, and it goes down the moment anything is spent. */
export const usdHeld = (n) => {
  const v = Number(n) || 0;
  if (v <= 0) return usd(v);
  const dp = v >= 100 ? 2 : (v >= 0.01 ? 4 : Math.min(8, -Math.floor(Math.log10(v)) + 1));
  return usd(Math.floor(v * 10 ** dp) / 10 ** dp);
};

export const num = (n) => (Number(n) || 0).toLocaleString('en-US');

/** Relative time, for the activity feed. */
export function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return 'just now';
  if (s < 90) return 'a minute ago';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 24) return h === 1 ? 'an hour ago' : `${h} hours ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  return `${d} days ago`;
}

/** Times we show as a date are shown in IST, labelled, so the zone is never ambiguous. */
export const dateIST = (ms) => new Date(ms).toLocaleDateString('en-GB', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
});

/* A moment, to the minute, in IST. The calls in a workload arrive minutes apart, so a date
   alone would print the same string down the whole table. */
export const timeIST = (ms) => new Date(ms).toLocaleString('en-GB', {
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  hour12: false, timeZone: 'Asia/Kolkata',
});

export const feedDot = { ok: 'ok', bad: 'bad', run: 'on', connect: 'ok', floor: 'mut', revert: 'bad',
  bill: 'mut', call: 'call', copy: 'copy', test: 'test' };
