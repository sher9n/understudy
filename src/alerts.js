/* Telling somebody when a call to the model provider fails.
 *
 * Two things make this harder than "send an email on error". The first is volume: a provider
 * outage does not fail once, it fails every call for as long as it lasts, and a mail per call
 * would be thousands of messages and a blocked sending domain. The second is that the most
 * important failures are the quietest: a 401 means our key is wrong and a 402 means our
 * credit is gone, and either one breaks EVERY customer at once while looking, in the log,
 * exactly like one more error.
 *
 * So: the first failure goes out at once, because that is the one worth interrupting
 * somebody for. After that a window opens, everything inside it is counted rather than sent,
 * and when the window closes one message reports the whole window. Nothing is dropped, and
 * nobody is buried. */

import config, { canEmail } from './config.js';
import { send } from './email.js';

/* What is happening right now, per kind of failure. A kind is coarse on purpose: "the
   provider refused us" is one story whether it happened on one model or six. */
const windows = new Map();

const MAX_SAMPLES = 6;

/* The line that explains WHY, in words somebody reading it on a phone can act on. An
   upstream status is not self-explanatory and the two that matter most look like the rest. */
function meaning(status) {
  if (status === 401) return 'Our OpenRouter key was refused. Every routed call is failing until it is replaced.';
  if (status === 402) return 'Our OpenRouter credit has run out. Every routed call is failing until it is topped up.';
  if (status === 403) return 'OpenRouter refused the request. This is often a model that our account may not use.';
  if (status === 404) return 'No provider matched. With zero-retention required, a model with no such provider answers this way.';
  if (status === 429) return 'We are being rate limited, after the retries the client already makes.';
  if (status === 408 || status === 504) return 'The provider did not answer in time.';
  if (status >= 500) return 'The provider failed on its side.';
  if (status === 503) return 'Routing is not configured on this deployment.';
  return 'The call did not get through.';
}

/* What a failure means depends on whose it is: Stripe's for a top up, ours for a call we answered and
   could not charge, OpenRouter's otherwise. */
function meaningFor(kind, status) {
  if (kind === 'automatic top up') {
    if (status === 401) return 'Our Stripe key was refused. No automatic top up can be made until it is replaced.';
    if (status === 403) return 'Stripe refused the request for our account: a permission our key does not have.';
    if (status === 404) return 'A Stripe customer or saved card we had on file no longer exists.';
    if (status === 429) return 'Stripe is rate limiting us.';
    if (status >= 500) return 'Stripe failed on its side.';
    return 'An automatic top up did not go through for a reason that is not the customer\'s card.';
  }
  if (kind === 'charging a call') return 'An answer was sent to a customer and charging for it failed. Its hold was given back, and the call is not charged.';
  if (kind === 'model catalogue' || kind === 'provider list') return 'A list we read from OpenRouter looked wrong, so the one we have was kept.';
  return meaning(status);
}

const headlineFor = (kind) => ({
  'automatic top up': 'An automatic top up failed',
  'charging a call': 'An answered call could not be charged',
  'model catalogue': 'The model list from OpenRouter looked wrong',
  'provider list': 'The provider list from OpenRouter looked wrong',
}[kind] || 'A call to the model provider failed');

function compose(kind, w) {
  const many = w.count > 1;
  const headline = headlineFor(kind);
  const subject = many
    ? `Understudy: ${w.count} failed calls (${kind})`
    : `Understudy: a call failed (${kind})`;

  const lines = [
    many
      ? `${w.count} calls failed in the last ${Math.round((Date.now() - w.openedAt) / 60000)} minutes.`
      : `${headline}.`,
    '',
    meaningFor(kind, w.worstStatus),
    '',
    'What failed:',
    ...w.samples.map((s) => `  ${s.at}  ${s.model || 'no model'}  http ${s.status}  ${s.message}`),
  ];
  if (w.count > w.samples.length) lines.push(`  ... and ${w.count - w.samples.length} more`);
  lines.push('', `Where: ${config.PUBLIC_URL}`, '', 'You are getting this because you are the alert address for Understudy.');

  const text = lines.join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#f7f7f8;padding:28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e7e7e9;border-radius:14px;padding:26px;">
    <div style="font-weight:700;font-size:16px;letter-spacing:-0.03em;color:#0d0d12;">Understudy</div>
    <p style="font-size:15px;line-height:1.55;color:#0d0d12;margin:16px 0 4px;font-weight:600;">${
      many ? `${w.count} calls failed in the last ${Math.round((Date.now() - w.openedAt) / 60000)} minutes` : headline}</p>
    <p style="font-size:14px;line-height:1.6;color:#55555f;margin:0 0 18px;">${meaningFor(kind, w.worstStatus)}</p>
    <div style="font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px;line-height:1.7;color:#0d0d12;
                background:#f7f7f8;border:1px solid #e7e7e9;border-radius:9px;padding:12px 14px;white-space:pre-wrap;">${
      w.samples.map((s) => `${s.at}  ${escape(s.model || 'no model')}  http ${s.status}  ${escape(s.message)}`).join('\n')
      }${w.count > w.samples.length ? `\n... and ${w.count - w.samples.length} more` : ''}</div>
    <p style="font-size:12.5px;line-height:1.55;color:#6b6b7b;margin:18px 0 0;">
      <a href="${config.PUBLIC_URL}" style="color:#0b52d6;text-decoration:none;">${config.PUBLIC_URL}</a></p>
  </div></body></html>`;

  return { subject, text, html };
}

const escape = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

async function flush(kind) {
  const w = windows.get(kind);
  if (!w || !w.count) { windows.delete(kind); return; }
  windows.delete(kind);
  const { subject, text, html } = compose(kind, w);
  await send({ to: config.ALERT_EMAIL, subject, text, html });
}

/* Called wherever a call to the provider did not come back. Never throws and never waits:
   an alert that could break the request it is reporting on would be worse than no alert. */
export function reportCallFailure({ kind = 'routed call', model, status = 0, message = '', workspaceId } = {}) {
  if (!config.ALERTS_ENABLED || !config.ALERT_EMAIL) return;
  const at = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false });
  const sample = {
    at: `${at} IST`,
    model: model || null,
    status: Number(status) || 0,
    message: String(message || '').slice(0, 200) || 'no message',
    workspaceId: workspaceId ?? null,
  };

  const open = windows.get(kind);
  if (open) {
    open.count += 1;
    if (sample.status > open.worstStatus) open.worstStatus = sample.status;
    if (open.samples.length < MAX_SAMPLES) open.samples.push(sample);
    return;
  }

  /* The first one goes out on its own, immediately, and opens the window that swallows the
     rest. The timer is unref'd so it can never hold the process open on shutdown. */
  const w = { count: 1, worstStatus: sample.status, samples: [sample], openedAt: Date.now() };
  windows.set(kind, w);
  const first = compose(kind, w);
  void send({ to: config.ALERT_EMAIL, subject: first.subject, text: first.text, html: first.html })
    .catch((e) => console.error(`alert email failed: ${e.message}`));
  w.count = 0;
  w.samples = [];

  const t = setTimeout(() => { void flush(kind); }, config.ALERT_WINDOW_MIN * 60000);
  if (typeof t.unref === 'function') t.unref();
}

/* Something threw where nothing was meant to. Same window as a failed call, because the
   shape of the problem is the same: it happens once or it happens on every request, and the
   second must not become a thousand emails. */
export function reportCrash({ where = 'the server', err, fatal = false } = {}) {
  const message = `${fatal ? 'FATAL ' : ''}${where}: ${err?.message || String(err)}`;
  console.error(message);
  if (err?.stack) console.error(err.stack.split('\n').slice(0, 5).join('\n'));
  reportCallFailure({ kind: fatal ? 'the server stopped' : 'an error on the server',
    model: where, status: fatal ? 500 : 0, message: err?.message || String(err) });
}

/** True when a failure would actually reach somebody. */
export const canAlert = () => config.ALERTS_ENABLED && !!config.ALERT_EMAIL && canEmail();

/** Used by the tests, and on shutdown, so nothing counted is left unsent. */
export async function flushAllAlerts() {
  for (const kind of [...windows.keys()]) await flush(kind);
}
