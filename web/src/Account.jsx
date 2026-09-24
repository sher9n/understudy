import React, { useEffect, useRef, useState } from 'react';
import { href } from './router.js';
import { plainClick } from './nav.jsx';

/* Who you are, and the way out.
 *
 * One component, used in two places on purpose. The app keeps it at the foot of the sidebar
 * and the getting started guide keeps it at the foot of its steps rail, which is the same
 * corner of the screen, so finishing the guide does not move it. Before this the guide had
 * a plain letter in its top right with nothing behind it: no menu, no settings, and no way
 * to sign out at all except by guessing a URL. */

const S24 = { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.7, strokeLinecap: 'round', 'aria-hidden': true };

/* `down` opens the menu below the button rather than above it, for the phone's top bar. */
export default function Account({ me, dark, setDark, onSignOut, go, down = false }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  const initial = (me?.name || me?.email || 'S').trim()[0].toUpperCase();
  const toSettings = () => { setOpen(false); if (go) go('settings'); };

  return (
    <div className="acctwrap" ref={wrap}>
      <button className="acctbtn" onClick={() => setOpen((v) => !v)} aria-label="Your account"
        aria-expanded={open}>
        <span className="av">{initial}</span>
        <span className="who">{me?.name || me?.email || 'Your workspace'}</span>
      </button>
      {open && (
        <div className={down ? 'acctpop acctdown' : 'acctpop'}>
          <div className="acctid">
            <span className="av avlg">{initial}</span>
            <div>
              <div className="acctn">{me?.name || 'Your account'}</div>
              <div className="accte">{me?.email}</div>
            </div>
          </div>
          <a className="acctrow lnk" href={href('settings')} onClick={plainClick(toSettings)}>
            <svg {...S24}><circle cx="12" cy="8" r="3.4" /><path d="M5 20a7 7 0 0114 0" /></svg>
            Account settings
          </a>
          <a className="acctrow lnk" href={href('settings')} onClick={plainClick(toSettings)}>
            <svg {...S24}><rect x="3" y="6" width="18" height="13" rx="2" /><path d="M3 10.5h18" /></svg>
            Billing and balance
          </a>
          <button className="acctrow acctsw" onClick={() => setDark(!dark)} aria-pressed={dark}>
            <span className="acctswl">
              {dark
                ? <svg {...S24}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19" /></svg>
                : <svg {...S24}><path d="M21 13a8.5 8.5 0 01-10-10 8.5 8.5 0 1010 10z" /></svg>}
              Dark mode
            </span>
            <span className={dark ? 'sw swon' : 'sw'} aria-hidden="true"><i /></span>
          </button>
          <div className="acctsep" />
          {/* The pages anybody can read, reachable from inside the app too: how it works and how models are
              routed (the only way to them on a phone, whose five places leave no room), what it costs, whether it
              is up, and how to reach us. */}
          <div className="acctlinks">
            {[['how', 'How it works'], ['routing', 'Model routing'], ['pricing', 'Pricing'], ['status', 'Status'], ['contact', 'Contact us']].map(([k, label]) => (
              <a key={k} href={href(k)} onClick={plainClick(() => { setOpen(false); if (go) go(k); })}>{label}</a>
            ))}
          </div>
          <button className="acctrow acctout" onClick={() => { setOpen(false); onSignOut(); }}>
            <svg {...S24}><path d="M10 4H6a2 2 0 00-2 2v12a2 2 0 002 2h4" /><path d="M16 15l4-3-4-3" /><path d="M20 12H10" /></svg>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
