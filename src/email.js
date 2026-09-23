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

/* The emails that carry a code. Each carries two ways in, because they suit different moments: the
   link is one tap on the phone the mail arrived on, and the code is for when the mail is on the
   phone but the browser is on the laptop. The link opens a page with a button, and only pressing
   it signs anybody in: mail scanners open links before people do. */
const WORDS = {
  sign_in: {
    subject: (code) => `${code} is your Understudy sign-in code`,
    lead: 'Your sign-in code is',
    button: 'Or sign in with one tap',
    ignore: 'If you did not ask to sign in, you can ignore this. Nobody can get in without this email.',
  },
  verify: {
    subject: (code) => `${code} confirms your Understudy account`,
    lead: 'To finish making your account, enter this code',
    button: 'Or confirm with one tap',
    ignore: 'If you did not sign up for Understudy, you can ignore this. Nothing happens without this code.',
  },
  change_email: {
    subject: (code) => `${code} confirms your new email address`,
    lead: 'To make this your Understudy email address, enter this code',
    button: null,
    ignore: 'If you did not ask for this, you can ignore it. Your account stays as it is.',
  },
};

const box = (inner) => `<!doctype html>
<html><body style="margin:0;background:#f7f7f8;padding:28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:440px;margin:0 auto;background:#ffffff;border:1px solid #e7e7e9;border-radius:14px;padding:28px;">
    <div style="font-weight:700;font-size:16px;letter-spacing:-0.03em;color:#0d0d12;">Understudy</div>
    ${inner}
  </div>
</body></html>`;

export function codeEmail({ purpose = 'sign_in', code, link = null, minutes }) {
  const w = WORDS[purpose] || WORDS.sign_in;
  const subject = w.subject(code);
  const text = [
    `${w.lead}: ${code}`,
    ...(link && w.button ? ['', 'Or open this link and press the button on it:', link] : []),
    '',
    `${link && w.button ? 'Either one works, and only once. Both stop' : 'It works once, and stops'} working in ${minutes} minutes.`,
    '',
    w.ignore,
  ].join('\n');
  const html = box(`
    <p style="font-size:14.5px;line-height:1.6;color:#55555f;margin:18px 0 6px;">${w.lead}</p>
    <div style="font-family:ui-monospace,SFMono-Regular,monospace;font-size:34px;font-weight:700;
                letter-spacing:0.18em;color:#0d0d12;margin:0 0 20px;">${code}</div>
    ${link && w.button ? `<a href="${link}" style="display:inline-block;background:#0f62fe;color:#ffffff;text-decoration:none;
       font-size:14px;font-weight:600;padding:11px 18px;border-radius:9px;">${w.button}</a>` : ''}
    <p style="font-size:12.5px;line-height:1.55;color:#6b6b7b;margin:20px 0 0;">
      ${link && w.button ? 'Either one works, and only once. Both stop' : 'It works once, and stops'} working in ${minutes} minutes.</p>
    <p style="font-size:12.5px;line-height:1.55;color:#6b6b7b;margin:10px 0 0;">${w.ignore}</p>`);
  return { subject, text, html };
}

/** Kept for anything that still asks for the sign-in email by its old name. */
export const signInEmail = ({ code, link, minutes }) => codeEmail({ purpose: 'sign_in', code, link, minutes });

/* Somebody tried to sign up with an address that already has an account. Its owner is told, and
   nobody learns from the form whether the address is taken. */
export function accountExistsEmail({ signInUrl }) {
  const subject = 'Somebody tried to make an Understudy account with your email';
  const text = [
    'Somebody tried to sign up for Understudy with this email address, which already has an account.',
    '',
    'If it was you, sign in instead:',
    signInUrl,
    '',
    'If it was not you, you can ignore this. Nothing about your account changed.',
  ].join('\n');
  const html = box(`
    <p style="font-size:14.5px;line-height:1.6;color:#55555f;margin:18px 0 14px;">
      Somebody tried to sign up for Understudy with this email address, which already has an account.</p>
    <a href="${signInUrl}" style="display:inline-block;background:#0f62fe;color:#ffffff;text-decoration:none;
       font-size:14px;font-weight:600;padding:11px 18px;border-radius:9px;">If it was you, sign in</a>
    <p style="font-size:12.5px;line-height:1.55;color:#6b6b7b;margin:20px 0 0;">
      If it was not you, you can ignore this. Nothing about your account changed.</p>`);
  return { subject, text, html };
}

/* A message about the customer's own workspace: a switch, a switch back, something waiting for
   their approval, money running low. Plain words, the numbers that matter, and a link to the page. */
export function noticeEmail({ title, lines = [], link = null, linkText = 'Open it in Understudy', footer = null }) {
  const subject = title;
  const text = [...lines, ...(link ? ['', `${linkText}: ${link}`] : []), ...(footer ? ['', footer] : [])].join('\n');
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = box(`
    <p style="font-size:15px;line-height:1.5;color:#0d0d12;font-weight:600;margin:18px 0 8px;">${esc(title)}</p>
    ${lines.map((l) => `<p style="font-size:14px;line-height:1.6;color:#55555f;margin:0 0 8px;">${esc(l)}</p>`).join('')}
    ${link ? `<a href="${link}" style="display:inline-block;margin-top:10px;background:#0f62fe;color:#ffffff;text-decoration:none;
       font-size:14px;font-weight:600;padding:11px 18px;border-radius:9px;">${esc(linkText)}</a>` : ''}
    ${footer ? `<p style="font-size:12px;line-height:1.55;color:#6b6b7b;margin:20px 0 0;">${esc(footer)}</p>` : ''}`);
  return { subject, text, html };
}

export default send;
