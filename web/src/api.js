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

/* Money is written by one formatter, in money.js, and every screen that imports it from here
   gets the same one: two decimals from a dollar up, up to four significant figures below it,
   the minus sign before the dollar, and a balance never shown as more than it is. */
export { usd, usdHeld } from './money.js';
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
