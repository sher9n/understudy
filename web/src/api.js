/* The browser's one way to talk to the server.
 *
 * Every failure becomes an ApiError that carries a sentence somebody can read, the status it came
 * with, and whether the request never arrived at all. The server words its refusals two ways,
 * {error: "..."} from the screens' own routes and {error: {message}} from the model routes and
 * from its last-resort crash handler, and passing the second straight to `new Error` is what
 * printed "[object Object]" on the page. Anything without words of its own gets plain words
 * chosen by its status, never a bare number. */

export class ApiError extends Error {
  constructor(message, { status = 0, network = false, signedOut = false } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;          // 0 when the request never got an answer
    this.network = network;        // true when the server could not be reached at all
    this.signedOut = signedOut;    // true when the session behind the request has ended
  }
}

const WORDS = {
  400: 'That was not accepted. Check it and try again.',
  401: 'Your session has ended. Sign in to continue.',
  403: 'That is not allowed from this account.',
  404: 'That could not be found. It may have been removed.',
  408: 'Understudy took too long to answer. Try again in a moment.',
  409: 'That clashes with something that already exists.',
  413: 'That is larger than Understudy can take.',
  429: 'Too many requests in a short time. Wait a moment, then try again.',
  502: 'Understudy could not get an answer from a service it depends on. Try again in a moment.',
  503: 'That part of Understudy is not available right now. Try again in a moment.',
  504: 'Understudy took too long to answer. Try again in a moment.',
};
export const OFFLINE = 'Understudy could not be reached. Check your connection, then try again.';

/** The sentence a failed answer carries, whichever way the server worded it. */
export function messageOf(json, status) {
  const e = json?.error;
  if (typeof e === 'string' && e.trim()) return e.trim();
  if (e && typeof e === 'object' && typeof e.message === 'string' && e.message.trim()) return e.message.trim();
  if (typeof json?.message === 'string' && json.message.trim()) return json.message.trim();
  return WORDS[status] || (status >= 500
    ? 'Something went wrong on our side. Try again in a moment.'
    : `That did not work. The server answered ${status}.`);
}

/* A session that ends while somebody is using the app, told once to whoever is listening: the
   frame, which offers a way to sign in again and come back to the same page. The sign-in routes
   themselves answer 401 for a wrong password, which is not a session ending. */
const endedListeners = new Set();
export const onSignedOut = (fn) => {
  endedListeners.add(fn);
  return () => endedListeners.delete(fn);
};

const send = async (method, path, body) => {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(OFFLINE, { network: true });
  }
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json: a proxy's error page, say */ }
  if (!res.ok) {
    const signedOut = res.status === 401 && !path.startsWith('/auth/') && path !== '/me';
    if (signedOut) for (const fn of endedListeners) fn();
    throw new ApiError(messageOf(json, res.status), { status: res.status, signedOut });
  }
  return json;
};

/* Who wants to hear a workload's name the moment it is read: the frame, which titles the tab
   after the workload whose page is open. */
const nameListeners = new Set();
export const onWorkloadName = (fn) => {
  nameListeners.add(fn);
  return () => nameListeners.delete(fn);
};
const told = (id) => (w) => {
  if (w?.name) for (const fn of nameListeners) fn(id, w.name);
  return w;
};

/* The one address outside /api the screens read: the plain health check, which answers as long
   as the application and its database do. */
const health = async () => {
  let res;
  try { res = await fetch('/health', { cache: 'no-store' }); } catch { throw new ApiError(OFFLINE, { network: true }); }
  if (!res.ok) throw new ApiError(messageOf(null, res.status), { status: res.status });
  return res.json();
};

export const api = {
  me: () => send('GET', '/me'),
  // the public pages: the contact form, and what is working right now
  contact: (b) => send('POST', '/contact', b),
  status: () => send('GET', '/status'),
  health,
  signUp: (b) => send('POST', '/auth/sign-up', b),
  signIn: (b) => send('POST', '/auth/sign-in', b),
  signOut: () => send('POST', '/auth/sign-out'),
  requestCode: (email) => send('POST', '/auth/code/request', { email }),
  verifyCode: (email, code) => send('POST', '/auth/code/verify', { email, code }),
  overview: (days) => send('GET', days ? `/overview?days=${days}` : '/overview'),
  workloads: () => send('GET', '/workloads'),
  workload: (id) => send('GET', `/workloads/${id}`).then(told(id)),
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
  // what live calls are teaching us, how calls turned out, and the tasks they were part of
  learning: (id) => send('GET', `/workloads/${id}/learning`),
  setExplore: (id, b) => send('POST', `/workloads/${id}/explore`, b),
  outcomes: (id) => send('GET', `/workloads/${id}/outcomes`),
  saveOutcomeDef: (id, def) => send('POST', `/workloads/${id}/outcomes/def`, def),
  tasks: (id) => send('GET', `/workloads/${id}/tasks`),
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

/* A moment in full, with its year and its zone named, for a page that may be read long after:
   "23 Sept 2026, 14:05 IST". */
export const stampIST = (ms) => `${new Date(ms).toLocaleString('en-GB', {
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  hour12: false, timeZone: 'Asia/Kolkata',
})} IST`;

export const feedDot = { ok: 'ok', bad: 'bad', run: 'on', connect: 'ok', floor: 'mut', revert: 'bad',
  bill: 'mut', call: 'call', copy: 'copy', test: 'test' };
