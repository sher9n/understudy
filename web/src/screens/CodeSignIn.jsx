import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

/* Signing in without a password, and confirming a new account.

   The same email carries two ways in, because they suit different moments: the link is one
   tap on the phone the mail arrived on, and the code is for when the mail is on the phone
   and the browser is on the laptop. This screen handles the code; the link opens its own page.

   `purpose` is "sign_in" (asked for here) or "verify" (sent by signing up, with `initial` saying
   where it went and `resend` sending another with the same password on it).

   The pitch panel beside it is the sign-in board's own markup, lifted out rather than
   rewritten, so this screen cannot drift away from the one next to it. */

const WORDS = {
  sign_in: {
    askTitle: 'Sign in with a code',
    sentTitle: 'Check your email',
    sent: (email, minutes) => <>If <b>{email}</b> has an account, a code is on its way. It works once, and stops working in {minutes} minutes.</>,
    button: 'Sign in',
    back: 'Use a password instead',
  },
  verify: {
    sentTitle: 'Confirm your email',
    sent: (email, minutes) => <>We sent a code to <b>{email}</b>. Enter it to finish making your account. It works once, and stops working in {minutes} minutes.</>,
    button: 'Confirm and continue',
    back: 'Use a different email',
  },
};

export default function CodeSignIn({ pitchHtml, digits = 6, purpose = 'sign_in', initial = null, resend = null, onDone, onBack }) {
  const w = WORDS[purpose] || WORDS.sign_in;
  const [email, setEmail] = useState(initial?.email || '');
  const [sent, setSent] = useState(initial?.sent ? { minutes: initial.sent.minutes, digits: initial.sent.digits ?? digits } : null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const codeBox = useRef(null);

  useEffect(() => { if (sent) codeBox.current?.focus(); }, [sent]);

  const ask = async (e) => {
    e.preventDefault();
    if (busy || !email.trim()) return;
    setBusy(true); setError(''); setNote('');
    try {
      const r = await api.requestCode(email.trim());
      setSent({ minutes: r.minutes, digits: r.digits ?? digits });
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const again = async () => {
    if (busy) return;
    setBusy(true); setError(''); setNote(''); setCode('');
    try {
      if (resend) await resend(); else await api.requestCode(email.trim());
      setNote('A new code is on its way. The one before it no longer works.');
      codeBox.current?.focus();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const verify = async (e) => {
    e.preventDefault();
    if (busy || code.length < (sent?.digits ?? digits)) return;
    setBusy(true); setError(''); setNote('');
    try {
      const r = await api.verifyCode(email.trim(), code);
      // the first key, made when the email answered, and whether the password typed at sign-up was kept
      onDone(r?.fresh || purpose === 'verify', r?.key || null, r?.passwordKept ?? null);
    } catch (err) { setError(err.message); setCode(''); codeBox.current?.focus(); }
    finally { setBusy(false); }
  };

  return (
    /* The wrapper matters: shell.css lays out `.board > div` as a flex column, which is
       what the lifted screens need. Without an intermediate element the two column split
       below would inherit that and drop the form underneath the panel. */
    <div className="board">
      <div>
      <div className="authsplit">
        <aside className="pitch" dangerouslySetInnerHTML={{ __html: pitchHtml }} />
        <main className="formside">
          <div className="toprow">
            <a className="lnk" href={purpose === 'verify' ? '/signup' : '/signin'}
              onClick={(e) => { e.preventDefault(); onBack(); }}>← {w.back}</a>
          </div>

          {!sent ? (
            <form className="authcard" onSubmit={ask}>
              <h1>{w.askTitle}</h1>
              <p className="sub">
                We will email you a {digits} digit code and a link. Either one signs you in,
                and you do not need your password.
              </p>
              <div className="fields">
                <div>
                  <div className="fl"><label htmlFor="cmail">Email</label></div>
                  <input className="field" id="cmail" name="email" type="email" required
                    autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
              </div>
              {error && <div className="errbox" role="alert">{error}</div>}
              <button className="btn full" type="submit" disabled={busy}>
                {busy ? 'Sending…' : 'Email me a code'}
              </button>
            </form>
          ) : (
            <form className="authcard" onSubmit={verify}>
              <h1>{w.sentTitle}</h1>
              <p className="sub">{w.sent(email.trim(), sent.minutes)}</p>
              <div className="fields">
                <div>
                  <div className="fl"><label htmlFor="ccode">Your code</label></div>
                  <input className="field codefield m" id="ccode" ref={codeBox}
                    inputMode="numeric" autoComplete="one-time-code" maxLength={sent.digits}
                    placeholder={'0'.repeat(sent.digits)} value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, sent.digits))} />
                </div>
              </div>
              {error && <div className="errbox" role="alert">{error}</div>}
              {note && <div className="okbox" role="status">{note}</div>}
              <button className="btn full" type="submit"
                disabled={busy || code.length < sent.digits}>
                {busy ? 'Checking…' : w.button}
              </button>
              <p className="authfoot">
                <button type="button" className="lnk linkbtn" onClick={again} disabled={busy}>
                  Send it again
                </button>
              </p>
            </form>
          )}
        </main>
      </div>
      </div>
    </div>
  );
}
