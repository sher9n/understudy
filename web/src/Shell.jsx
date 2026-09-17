import React, { useEffect, useRef, useState } from 'react';

const S = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
const S24 = { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.7, strokeLinecap: 'round', 'aria-hidden': true };

const NAV = [
  { key: 'dash', label: 'Dashboard', icon: (
    <svg {...S}><rect x="2.2" y="2.2" width="5.2" height="5.2" rx="1.4" /><rect x="8.6" y="2.2" width="5.2" height="5.2" rx="1.4" /><rect x="2.2" y="8.6" width="5.2" height="5.2" rx="1.4" /><rect x="8.6" y="8.6" width="5.2" height="5.2" rx="1.4" /></svg>) },
  { key: 'work', label: 'Workloads', icon: (
    <svg {...S}><rect x="2" y="2.6" width="12" height="3" rx="1.2" /><rect x="2" y="6.5" width="12" height="3" rx="1.2" /><rect x="2" y="10.4" width="12" height="3" rx="1.2" /></svg>) },
  { key: 'models', label: 'Models', icon: (
    <svg {...S}><path d="M8 1.8 L14 5.2 L14 10.8 L8 14.2 L2 10.8 L2 5.2 Z" /><circle cx="8" cy="8" r="2.1" /></svg>) },
  { key: 'connect', label: 'Connect', icon: (
    <svg {...S}><path d="M9.4 3 h3.6 v10 h-3.6" /><path d="M2 8 h7.2" /><path d="M7 5.6 L9.4 8 L7 10.4" /></svg>) },
  { key: 'settings', label: 'Settings', icon: (
    <svg {...S}><path d="M2.6 4.6 h10.8 M2.6 11.4 h10.8" /><circle cx="6" cy="4.6" r="1.9" /><circle cx="10" cy="11.4" r="1.9" /></svg>) },
];

export default function Shell({ here, me, go, onSignOut, dark, setDark, children }) {
  const [navOpen, setNavOpen] = useState(true);
  const [acctOpen, setAcctOpen] = useState(false);
  const wrap = useRef(null);

  useEffect(() => {
    if (!acctOpen) return undefined;
    const away = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setAcctOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setAcctOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [acctOpen]);

  const initial = (me?.name || me?.email || 'S').trim()[0].toUpperCase();
  const at = (key) => (key === here ? 'nv on' : 'nv');
  const open = (key) => () => { setAcctOpen(false); go(key); };

  return (
    <div className="shell">
      <aside className={navOpen ? 'side' : 'side mini'}>
        <div className="sidetop">
          <span className="wm">Understudy</span>
          <button className="collapse" onClick={() => setNavOpen((v) => !v)}
            aria-label={navOpen ? 'Collapse the menu' : 'Expand the menu'}>
            {navOpen
              ? <svg {...S}><path d="M2.5 2.5 v11" /><path d="M13.5 8 h-6" /><path d="M10 5 L7.2 8 L10 11" /></svg>
              : <svg {...S}><path d="M2.5 2.5 v11" /><path d="M7.2 8 h6" /><path d="M10.5 5 L13.3 8 L10.5 11" /></svg>}
          </button>
        </div>
        <nav className="sidenav">
          {NAV.map((n) => (
            <a key={n.key} className={at(n.key)} onClick={open(n.key)}>
              {n.icon}<span className="lbl">{n.label}</span>
            </a>
          ))}
        </nav>
        <div className="sidefoot">
          <div className="acctwrap" ref={wrap}>
            <button className="acctbtn" onClick={() => setAcctOpen((v) => !v)} aria-label="Your account">
              <span className="av">{initial}</span>
              <span className="who">{me?.name || me?.email || 'Your workspace'}</span>
            </button>
            {acctOpen && (
              <div className="acctpop">
                <div className="acctid">
                  <span className="av avlg">{initial}</span>
                  <div>
                    <div className="acctn">{me?.name || 'Your account'}</div>
                    <div className="accte">{me?.email}</div>
                  </div>
                </div>
                <a className="acctrow lnk" onClick={open('settings')}>
                  <svg {...S24}><circle cx="12" cy="8" r="3.4" /><path d="M5 20a7 7 0 0114 0" /></svg>
                  Account settings
                </a>
                <a className="acctrow lnk" onClick={open('settings')}>
                  <svg {...S24}><rect x="3" y="6" width="18" height="13" rx="2" /><path d="M3 10.5h18" /></svg>
                  Billing and balance
                </a>
                <div className="acctsep" />
                <button className="acctrow acctout" onClick={() => { setAcctOpen(false); onSignOut(); }}>
                  <svg {...S24}><path d="M10 4H6a2 2 0 00-2 2v12a2 2 0 002 2h4" /><path d="M16 15l4-3-4-3" /><path d="M20 12H10" /></svg>
                  Sign out
                </button>
              </div>
            )}
          </div>
          <div style={{ flexGrow: 1 }} />
          <button className="ni" style={{ width: 'auto' }} onClick={() => setDark(!dark)}
            aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}>
            {dark
              ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19" /></svg>
              : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M21 13a8.5 8.5 0 01-10-10 8.5 8.5 0 1010 10z" /></svg>}
          </button>
        </div>
      </aside>
      <div className="shellmain">
        <main className="page">{children}</main>
      </div>
    </div>
  );
}
