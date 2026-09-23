/* Sending email.

   One provider, one function, and a deliberate fallback: with no API key nothing is sent and
   the message is written to the log instead. That is not a pretend send. It says plainly
   that nothing left the building, and it means the sign-in flow can still be walked on a
   machine with no credentials, which is how most of this was built. */

import config, { canEmail } from './config.js';

const ENDPOINT = 'https://api.resend.com/emails';

/* Who the mail says it is from.

   Mail from docupath.tech is quarantined by the receiving side at Docupath: the provider takes it,
   reports it delivered, and it never reaches anybody. That is invisible from here, so it is refused
   in code rather than left to a setting somebody has to remember: a docupath.tech address, or one
   that is not an address at all, is replaced by the one that is known to arrive. */
const FALLBACK_FROM = 'Understudy <noreply@docupath.ai>';
const ADDRESS = /<?([^<>\s@]+@([^<>\s@]+\.[^<>\s@]+))>?\s*$/;

export function senderFor(given) {
  const raw = String(given || '').trim();
  const m = ADDRESS.exec(raw);
  if (!m) return { from: FALLBACK_FROM, refused: raw ? 'not an address' : null };
  if (/(^|\.)docupath\.tech$/i.test(m[2]) || /docupath\.tech/i.test(raw)) {
    return { from: FALLBACK_FROM, refused: 'docupath.tech is quarantined where it lands' };
  }
  return { from: raw, refused: null };
}

const sender = senderFor(config.EMAIL_FROM);
if (sender.refused && config.EMAIL_FROM) {
  console.warn(`EMAIL_FROM "${config.EMAIL_FROM}" was not used (${sender.refused}); sending as ${sender.from}.`);
}
export const emailFrom = () => sender.from;

export async function send({ to, subject, text, html, replyTo = null }) {
  if (!canEmail()) {
    console.log(`\n[no RESEND_API_KEY, so nothing was sent]\n  to: ${to}\n  ${subject}\n${text}\n`);
    return { ok: true, delivered: false, reason: 'no email provider configured' };
  }
  try {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: sender.from, to: [to], subject, text, html, ...(replyTo ? { reply_to: replyTo } : {}),
      }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      // the caller still answers the customer the same way, so a bad key cannot enumerate accounts
      console.error(`email to ${to} was refused: ${r.status} ${body?.message || ''}`);
      return { ok: false, delivered: false, reason: body?.message || `http ${r.status}` };
    }
    return { ok: true, delivered: true, id: body?.id };
  } catch (err) {
    console.error(`email to ${to} failed: ${err.message}`);
    return { ok: false, delivered: false, reason: err.message };
  }
}

/* The sign-in message carries both ways to get in, because they suit different moments: the
   link is one tap on the phone the mail arrived on, and the code is for when the mail is on
   the phone but the browser is on the laptop. They are the same token underneath, so using
   either spends both. */
export function signInEmail({ code, link, minutes }) {
  const subject = `${code} is your Understudy sign-in code`;
  const text = [
    `Your sign-in code is ${code}`,
    '',
    `Or open this link to sign in directly:`,
    link,
    '',
    `Either one works, and only once. Both stop working in ${minutes} minutes.`,
    '',
    'If you did not ask to sign in, you can ignore this. Nobody can get in without this email.',
  ].join('\n');

  const html = `<!doctype html>
<html><body style="margin:0;background:#f7f7f8;padding:28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:440px;margin:0 auto;background:#ffffff;border:1px solid #e7e7e9;border-radius:14px;padding:28px;">
    <div style="font-weight:700;font-size:16px;letter-spacing:-0.03em;color:#0d0d12;">Understudy</div>
    <p style="font-size:14.5px;line-height:1.6;color:#55555f;margin:18px 0 6px;">Your sign-in code is</p>
    <div style="font-family:ui-monospace,SFMono-Regular,monospace;font-size:34px;font-weight:700;
                letter-spacing:0.18em;color:#0d0d12;margin:0 0 20px;">${code}</div>
    <a href="${link}" style="display:inline-block;background:#0f62fe;color:#ffffff;text-decoration:none;
       font-size:14px;font-weight:600;padding:11px 18px;border-radius:9px;">Or sign in with one tap</a>
    <p style="font-size:12.5px;line-height:1.55;color:#6b6b7b;margin:20px 0 0;">
      Either one works, and only once. Both stop working in ${minutes} minutes.</p>
    <p style="font-size:12.5px;line-height:1.55;color:#6b6b7b;margin:10px 0 0;">
      If you did not ask to sign in, you can ignore this. Nobody can get in without this email.</p>
  </div>
</body></html>`;

  return { subject, text, html };
}

export default send;
