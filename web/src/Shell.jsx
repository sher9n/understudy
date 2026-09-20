import React, { useState } from 'react';
import { href } from './router.js';
import { plainClick } from './nav.jsx';
import Account from './Account.jsx';

const S = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };

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
  const at = (key) => (key === here ? 'nv on' : 'nv');
  const open = (key) => () => go(key);

  return (
    <div className="shell">
      <aside className={navOpen ? 'side' : 'side mini'}>
        <div className="sidetop">
          <a className="wm" href={href('dash')} onClick={plainClick(() => go('dash'))}>Understudy</a>
          <button className="collapse" onClick={() => setNavOpen((v) => !v)}
            aria-label={navOpen ? 'Collapse the menu' : 'Expand the menu'}>
            {navOpen
              ? <svg {...S}><path d="M2.5 2.5 v11" /><path d="M13.5 8 h-6" /><path d="M10 5 L7.2 8 L10 11" /></svg>
              : <svg {...S}><path d="M2.5 2.5 v11" /><path d="M7.2 8 h6" /><path d="M10.5 5 L13.3 8 L10.5 11" /></svg>}
          </button>
        </div>
        <nav className="sidenav">
          {NAV.map((n) => (
            <a key={n.key} className={at(n.key)} href={href(n.key)}
              onClick={plainClick(open(n.key))}>
              {n.icon}<span className="lbl">{n.label}</span>
            </a>
          ))}
        </nav>
        <div className="sidefoot">
          <Account me={me} dark={dark} setDark={setDark} onSignOut={onSignOut}
            go={(k) => go(k)} />
        </div>
      </aside>
      <div className="shellmain">
        <main className="page">{children}</main>
      </div>
    </div>
  );
}
