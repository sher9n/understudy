import React, { useState } from 'react';
import { api } from '../api.js';

const POINTS = ['No manual benchmarking', 'Same quality bar', 'Up to 24x lower cost'];

const Tick = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="8" cy="8" r="7.2" stroke="var(--ok)" strokeWidth="1.3" />
    <path d="M4.8 8.2 L7 10.3 L11.2 5.9" stroke="var(--ok)" strokeWidth="1.7"
      strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/* The same call answered twice by the customer's own model, and the gap between those
   two answers is the bar. The marks are invented, so no provider is named or implied. */
function Exhibit() {
  const tri = (x, y) => <path d={`M${x} ${y - 4.5} L${x + 7} ${y} L${x} ${y + 4.5} Z`} fill="var(--line-strong)" />;
  const box = (x, y, w, h, brand) => (
    <rect x={x} y={y} width={w} height={h} rx="11"
      fill={brand ? 'var(--brandq)' : 'var(--panel)'}
      stroke={brand ? 'var(--brand)' : 'var(--line-strong)'} strokeWidth="1.2" />
  );
  return (
    <svg viewBox="0 0 800 158" width="100%" role="img"
      aria-label="Your own calls go to your current model twice. The two answers are compared, and how often they differ becomes your bar.">
      {box(4, 46, 152, 66)}
      <text x="80" y="76" textAnchor="middle" fontSize="13" fontWeight="600" fill="var(--ink)">Your own calls</text>
      <text x="80" y="96" textAnchor="middle" className="m" fontSize="10" fill="var(--mut)">NOT A BENCHMARK</text>
      <line x1="160" y1="79" x2="184" y2="79" stroke="var(--line-strong)" strokeWidth="1.4" />{tri(184, 79)}
      {box(198, 46, 160, 66)}
      <text x="278" y="76" textAnchor="middle" fontSize="13" fontWeight="600" fill="var(--ink)">Your current model</text>
      <text x="278" y="96" textAnchor="middle" className="m" fontSize="10" fill="var(--mut)">RUN TWICE</text>
      {[37, 121].map((y) => (
        <g key={y}>
          <path d={`M360 79 C380 79 380 ${y} 394 ${y}`} fill="none" stroke="var(--line-strong)" strokeWidth="1.4" />
          {tri(394, y)}
        </g>
      ))}
      {box(404, 20, 140, 34)}
      <text x="474" y="42" textAnchor="middle" fontSize="13" fill="var(--ink)">answer 1</text>
      {box(404, 104, 140, 34)}
      <text x="474" y="126" textAnchor="middle" fontSize="13" fill="var(--ink)">answer 2</text>
      <text x="474" y="83" textAnchor="middle" className="m" fontSize="10" fontWeight="700" fill="var(--mut)">compared</text>
      <line x1="548" y1="79" x2="572" y2="79" stroke="var(--line-strong)" strokeWidth="1.4" />{tri(572, 79)}
      {box(586, 40, 200, 78, true)}
      <text x="686" y="76" textAnchor="middle" fontSize="16" fontWeight="700" fill="var(--brand)">that gap</text>
      <text x="686" y="102" textAnchor="middle" className="m" fontSize="10" fontWeight="700" fill="var(--brand)">IS YOUR BAR</text>
    </svg>
  );
}

const ThemeButton = ({ dark, setDark }) => (
  <button className="ni" style={{ width: 'auto' }} onClick={() => setDark(!dark)}
    aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}>
    {dark
      ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19" /></svg>
      : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M21 13a8.5 8.5 0 01-10-10 8.5 8.5 0 1010 10z" /></svg>}
  </button>
);

export default function Auth({ mode, go, onDone, dark, setDark }) {
  const signUp = mode === 'signup';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      if (signUp) setKey((await api.signUp({ email, password, name })).key);
      else { await api.signIn({ email, password }); onDone(false); }
    } catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  };

  return (
    <div className="authsplit">
      <aside className="pitch">
        <div className="brand">Understudy</div>
        <div className="pitchmid">
          <div className="pitchtext"><h1 className="pitch-h">Your LLM stack should keep getting better</h1></div>
          <div className="exhibit"><Exhibit /></div>
          <ul className="pts">
            {POINTS.map((p) => <li key={p}><Tick /><span>{p}</span></li>)}
          </ul>
        </div>
      </aside>

      <main className="formside">
        <div className="toprow">
          <a className="lnk" onClick={() => go(signUp ? 'signin' : 'signup')}>
            {signUp ? 'Sign in' : 'Create an account'}
          </a>
          <ThemeButton dark={dark} setDark={setDark} />
        </div>

        {key ? (
          <div className="authcard">
            <h1>Your key, shown once</h1>
            <p className="sub">Copy it now. We keep only its hash, so it can never be shown again.</p>
            <div className="okbox">{key}</div>
            <button className="btn full" style={{ marginTop: 18 }} onClick={() => onDone(true)}>Connect your traffic</button>
          </div>
        ) : (
          <form className="authcard" onSubmit={submit}>
            <h1>{signUp ? 'Create your account' : 'Sign in to Understudy'}</h1>
            <p className="sub">{signUp ? 'One key, one changed line, and measuring starts on its own.' : 'Continue to your workspace.'}</p>
            <div className="fields">
              {signUp && (
                <div>
                  <div className="fl"><label htmlFor="name">Name</label></div>
                  <input className="field" id="name" value={name} autoComplete="name"
                    placeholder="Your name" onChange={(e) => setName(e.target.value)} />
                </div>
              )}
              <div>
                <div className="fl"><label htmlFor="email">Email</label></div>
                <input className="field" id="email" type="email" required value={email} autoComplete="email"
                  placeholder="you@company.com" onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div>
                <div className="fl"><label htmlFor="password">Password</label></div>
                <input className="field" id="password" type="password" required minLength={8} value={password}
                  autoComplete={signUp ? 'new-password' : 'current-password'}
                  placeholder={signUp ? 'At least 8 characters' : 'Your password'}
                  onChange={(e) => setPassword(e.target.value)} />
              </div>
              {err && <div className="errbox">{err}</div>}
              <button type="submit" className="btn full" disabled={busy}>
                {busy ? 'One moment…' : signUp ? 'Create account' : 'Sign in'}
              </button>
            </div>
            <p className="authfoot">
              {signUp ? 'Already have an account? ' : 'New to Understudy? '}
              <a className="lnk" onClick={() => go(signUp ? 'signin' : 'signup')}>
                {signUp ? 'Sign in' : 'Create an account'}
              </a>.
            </p>
          </form>
        )}
      </main>
    </div>
  );
}
