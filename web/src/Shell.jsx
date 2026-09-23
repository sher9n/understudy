import React, { useState } from 'react';
import { href } from './router.js';
import { plainClick } from './nav.jsx';
import Account from './Account.jsx';

const S = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };

const EMPTY_UNTIL_TRAFFIC = new Set(['dash', 'work', 'models']);
const LOCKED_WHY = 'Available once your first call has arrived';

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

/* The app's frame: the menu, the page, and on a phone a bar at the top and the five places
 * along the bottom.
 *
 * A phone used to get the desktop menu squeezed into a 68 pixel rail down the left: icons with
 * no words, a fifth of the screen gone, and every table beside it cut off. It now gets the
 * layout phones use: the wordmark and your account across the top, and the five places across
 * the bottom with their names under their icons, where a thumb reaches them. Both are always in
 * the page and the stylesheet shows the one that fits, so nothing jumps while it loads. */
export default function Shell({ here, me, go, onSignOut, dark, setDark, locked = false, children }) {
  const [navOpen, setNavOpen] = useState(true);
  const at = (key) => (key === here ? 'nv on' : 'nv');
  const open = (key) => () => go(key);
  const home = locked ? 'connect' : 'dash';

  return (
    <div className="shell">
      <aside className={navOpen ? 'side' : 'side mini'}>
        <div className="sidetop">
          <a className="wm" href={href(home)}
            onClick={plainClick(() => go(home))}>Understudy</a>
          <button className="collapse" onClick={() => setNavOpen((v) => !v)}
            aria-label={navOpen ? 'Collapse the menu' : 'Expand the menu'} aria-expanded={navOpen}>
            {navOpen
              ? <svg {...S}><path d="M2.5 2.5 v11" /><path d="M13.5 8 h-6" /><path d="M10 5 L7.2 8 L10 11" /></svg>
              : <svg {...S}><path d="M2.5 2.5 v11" /><path d="M7.2 8 h6" /><path d="M10.5 5 L13.3 8 L10.5 11" /></svg>}
          </button>
        </div>
        <nav className="sidenav" aria-label="Understudy">
          {/* Dashboard, Workloads and Models are built entirely from traffic that has not
              arrived, so while the guide is unfinished they are shown rather than hidden:
              the customer sees the shape of the app they are setting up, and the furniture
              does not move under them when they finish. They are not links, so there is
              nothing to click into and bounce back from, and each says why when you hover
              it. Settings is NOT one of them: your key, your balance and the way out of the
              account are worth reaching on day one, and the account menu links straight to
              it, so locking it would offer something that works and call it unavailable.
              Each link carries its name as well as showing it: when the menu is narrow the
              words are hidden, and an icon alone has no name to be read out. */}
          {NAV.map((n) => (
            locked && EMPTY_UNTIL_TRAFFIC.has(n.key) ? (
              <span key={n.key} className="nv off" aria-disabled="true" role="link"
                aria-label={`${n.label}, ${LOCKED_WHY.toLowerCase()}`} title={LOCKED_WHY}>
                {n.icon}<span className="lbl">{n.label}</span>
              </span>
            ) : (
            <a key={n.key} className={at(n.key)} href={href(n.key)} aria-label={n.label}
              title={navOpen ? undefined : n.label} aria-current={n.key === here ? 'page' : undefined}
              onClick={plainClick(open(n.key))}>
              {n.icon}<span className="lbl">{n.label}</span>
            </a>)
          ))}
        </nav>
        <div className="sidefoot">
          <Account me={me} dark={dark} setDark={setDark} onSignOut={onSignOut}
            go={(k) => go(k)} />
        </div>
      </aside>

      {/* The phone's own frame. Hidden above phone width by the stylesheet. */}
      <header className="phonetop">
        <a className="wm" href={href(home)} onClick={plainClick(() => go(home))}>Understudy</a>
        <Account me={me} dark={dark} setDark={setDark} onSignOut={onSignOut} go={(k) => go(k)} down />
      </header>

      <div className="shellmain">
        <main className="page" id="main">{children}</main>
      </div>

      <nav className="phonetabs" aria-label="Understudy">
        {NAV.map((n) => (
          locked && EMPTY_UNTIL_TRAFFIC.has(n.key) ? (
            <span key={n.key} className="phonetab off" aria-disabled="true" role="link"
              aria-label={`${n.label}, ${LOCKED_WHY.toLowerCase()}`}>
              {n.icon}<span>{n.label}</span>
            </span>
          ) : (
            <a key={n.key} className={n.key === here ? 'phonetab here' : 'phonetab'} href={href(n.key)}
              aria-current={n.key === here ? 'page' : undefined} onClick={plainClick(open(n.key))}>
              {n.icon}<span>{n.label}</span>
            </a>
          )
        ))}
      </nav>
    </div>
  );
}
