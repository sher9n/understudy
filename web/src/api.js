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
  setMode: (id, mode) => send('POST', `/workloads/${id}/mode`, { mode }),
  promote: (id, model) => send('POST', `/workloads/${id}/promote`, { model }),
  revert: (id) => send('POST', `/workloads/${id}/revert`),
  measure: (id) => send('POST', `/workloads/${id}/measure`),
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
  regenerateKey: () => send('POST', '/connect/regenerate-key'),
};

export const usd = (n) => `$${(Number(n) || 0).toFixed(2)}`;
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

export const feedDot = { ok: 'ok', bad: 'bad', run: 'on', connect: 'ok', floor: 'mut', revert: 'bad', bill: 'mut' };
