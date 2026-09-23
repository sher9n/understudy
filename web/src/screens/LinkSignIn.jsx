import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

/* The page an emailed link opens.

   Opening the link does nothing by itself: mail scanners open links before people do, and a link
   that signed in on opening signed the scanner in and left the person holding a dead code. So this
   page says whose sign-in it is and waits for a press of the button. The token travels after a #,
   which a browser never sends to any server, so it is not in anybody's logs either. */

const tokenFrom = () => {
  const m = String(window.location.hash || '').match(/[#&]t=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : '';
};

export default function LinkSignIn({ pitchHtml, onDone }) {
  const [token] = useState(tokenFrom);
  const [state, setState] = useState({ phase: token ? 'checking' : 'dead' });
  const [tries, setTries] = useState(0);

  /* Only an answer that says the link is spent or expired means it has run out. A connection that
     dropped, a busy server or too many tries from one place used to say "That link has run out" too,
     and the person asked for a new link they did not need; those say what happened, and offer to
     check again. */
  useEffect(() => {
    if (!token) return undefined;
    let live = true;
    setState((s) => ({ ...s, phase: 'checking' }));
    api.peekLink(token)
      .then((r) => { if (live) setState(r?.ok ? { phase: 'ready', email: r.email, purpose: r.purpose } : { phase: 'dead' }); })
      .catch((e) => {
        if (!live) return;
        const passing = e?.network || e?.status === 429 || (e?.status >= 500);
        setState({ phase: passing ? 'trouble' : 'dead', error: e.message });
      });
    return () => { live = false; };
  }, [token, tries]);

  const press = async () => {
    setState((s) => ({ ...s, busy: true, error: '' }));
    try {
      const r = await api.redeemLink(token);
      // the token has done its job: keep it out of the history and off the screen
      window.history.replaceState(null, '', '/signin/link');
      onDone(!!r?.fresh, r?.key || null, r?.passwordKept ?? null);
    } catch (e) {
      setState((s) => ({ ...s, busy: false, error: e.message }));
    }
  };

  const confirming = state.purpose === 'verify';
  return (
    <div className="board">
      <div>
        <div className="authsplit">
          <aside className="pitch" dangerouslySetInnerHTML={{ __html: pitchHtml }} />
          <main className="formside">
            <div className="toprow">
              <a className="lnk" href="/signin">← Sign in another way</a>
            </div>
            <div className="authcard">
              {state.phase === 'checking' && <><h1>One moment</h1><p className="sub">Checking the link from your email.</p></>}
              {state.phase === 'ready' && (
                <>
                  <h1>{confirming ? 'Confirm your email' : 'Sign in'}</h1>
                  <p className="sub">
                    {confirming
                      ? <>This finishes making the account for <b>{state.email}</b>.</>
                      : <>This signs you in as <b>{state.email}</b>.</>}
                  </p>
                  {state.error && <div className="errbox" role="alert">{state.error}</div>}
                  <button className="btn full" type="button" onClick={press} disabled={state.busy}>
                    {state.busy ? 'One moment…' : confirming ? 'Confirm and continue' : `Continue as ${state.email}`}
                  </button>
                </>
              )}
              {state.phase === 'trouble' && (
                <>
                  <h1>We could not check the link</h1>
                  <p className="sub">{state.error}</p>
                  <button className="btn full" type="button" onClick={() => setTries((n) => n + 1)}>Check it again</button>
                </>
              )}
              {state.phase === 'dead' && (
                <>
                  <h1>That link has run out</h1>
                  <p className="sub">
                    Links work once, for ten minutes. Ask for a new one and it will be in your inbox in a moment.
                  </p>
                  <a className="btn full" href="/signin/code">Email me a new code and link</a>
                </>
              )}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
