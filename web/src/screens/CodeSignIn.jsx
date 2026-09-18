import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

/* Signing in without a password.

   The same email carries two ways in, because they suit different moments: the link is one
   tap on the phone the mail arrived on, and the code is for when the mail is on the phone
   and the browser is on the laptop. Underneath they are one token, so either one spends
   both, and this screen only has to handle the code.

   The pitch panel beside it is the sign-in board's own markup, lifted out rather than
   rewritten, so this screen cannot drift away from the one next to it. */

export default function CodeSignIn({ pitchHtml, digits = 4, onDone, onBack }) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const codeBox = useRef(null);

  useEffect(() => { if (sent) codeBox.current?.focus(); }, [sent]);

  const ask = async (e) => {
    e.preventDefault();
    if (busy || !email.trim()) return;
    setBusy(true); setError('');
    try {
      const r = await api.requestCode(email.trim());
      setSent({ minutes: r.minutes, digits: r.digits ?? digits });
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const verify = async (e) => {
    e.preventDefault();
    if (busy || code.length < (sent?.digits ?? digits)) return;
    setBusy(true); setError('');
    try {
      await api.verifyCode(email.trim(), code);
      onDone();
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
            <a className="lnk" onClick={onBack}>← Use a password instead</a>
          </div>

          {!sent ? (
            <form className="authcard" onSubmit={ask}>
              <h1>Sign in with a code</h1>
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
              {error && <div className="errbox">{error}</div>}
              <button className="btn full" type="submit" disabled={busy}>
                {busy ? 'Sending…' : 'Email me a code'}
              </button>
            </form>
          ) : (
            <form className="authcard" onSubmit={verify}>
              <h1>Check your email</h1>
              <p className="sub">
                If <b>{email.trim()}</b> has an account, a code is on its way. It works once,
                and stops working in {sent.minutes} minutes.
              </p>
              <div className="fields">
                <div>
                  <div className="fl"><label htmlFor="ccode">Your code</label></div>
                  <input className="field codefield m" id="ccode" ref={codeBox}
                    inputMode="numeric" autoComplete="one-time-code" maxLength={sent.digits}
                    placeholder={'0'.repeat(sent.digits)} value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, sent.digits))} />
                </div>
              </div>
              {error && <div className="errbox">{error}</div>}
              <button className="btn full" type="submit"
                disabled={busy || code.length < sent.digits}>
                {busy ? 'Checking…' : 'Sign in'}
              </button>
              <p className="authfoot">
                <a className="lnk" onClick={() => { setSent(null); setCode(''); setError(''); }}>
                  Send it again
                </a>
              </p>
            </form>
          )}
        </main>
      </div>
      </div>
    </div>
  );
}
