import React from 'react';
import { href } from '../../router.js';
import { plainClick } from '../../nav.jsx';
import '../../public.css';

/* The frame every public page shares: the home page, and the pages that say what happens to
 * somebody's traffic, what it costs, the terms, and how to reach us.
 *
 * One header and one footer, written once, so the home page and a legal page can never offer
 * different ways out, and a link added here reaches every page at the same moment. The header
 * knows who is looking: somebody already signed in is offered their dashboard, not a sign-in
 * button that would only send them straight back. */

/** The date every legal page was last changed, in the words each page shows it. */
export const UPDATED = '23 September 2026';

/** A link to a screen in the app, handled in place on a plain click and left to the browser
    for anything else, so it can still be opened in a new tab. */
export function To({ to, go, hash = '', search = '', children, ...rest }) {
  const target = `${href(to)}${search}${hash ? `#${hash}` : ''}`;
  return (
    <a href={target} onClick={plainClick(() => go(to, null, { hash, search }))} {...rest}>
      {children}
    </a>
  );
}

const Sun = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19" />
  </svg>
);
const Moon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
    <path d="M21 13a8.5 8.5 0 01-10-10 8.5 8.5 0 1010 10z" />
  </svg>
);

/* "How it works" is a place on the home page. From the home page itself the browser scrolls
   there on its own; from anywhere else it is a trip to the home page, landing on that part. */
function HowLink({ go, here }) {
  if (here === 'home') return <a href="#how">How it works</a>;
  return <To to="home" hash="how" go={go}>How it works</To>;
}

export function PublicHeader({ me, go, dark, setDark, here }) {
  const signedIn = !!me?.signedIn;
  // until the account check answers, neither "Sign in" nor "Open the dashboard" is offered
  const known = !!me;
  const cur = (k) => (here === k ? 'page' : undefined);
  return (
    <header className="pubhead">
      <To to="home" go={go} className="pubwm" aria-label="Understudy, home">Understudy</To>
      <nav className="pubnav" aria-label="Understudy">
        {known && !signedIn && <HowLink go={go} here={here} />}
        <To to="pricing" go={go} aria-current={cur('pricing')}>Pricing</To>
        <To to="traffic" go={go} aria-current={cur('traffic')}>Your traffic</To>
        <To to="status" go={go} aria-current={cur('status')}>Status</To>
      </nav>
      <span className="pubgrow" />
      <div className="pubacts">
        <button type="button" className="pubtheme" onClick={() => setDark(!dark)}
          aria-label={dark ? 'Switch to the light theme' : 'Switch to the dark theme'}>
          {dark ? <Sun /> : <Moon />}
        </button>
        {!known ? null : signedIn ? (
          <To to={me.onboarded ? 'dash' : 'connect'} go={go} className="btn">
            {me.onboarded ? 'Open the dashboard' : 'Finish connecting'}
          </To>
        ) : (
          <>
            <To to="signin" go={go} className="pubsignin">Sign in</To>
            <To to="signup" go={go} className="btn">Get an API key</To>
          </>
        )}
      </div>
    </header>
  );
}

/* The footer is where somebody looks for the small print, so every page of it is here, in
   four short groups, beside the one line about data that matters most. */
const FOOT = [
  ['Product', [['home', 'How it works', 'how'], ['pricing', 'Pricing'], ['status', 'Status']]],
  ['Your data', [['traffic', 'What happens to your traffic'], ['security', 'Security'],
    ['subprocessors', 'Subprocessors']]],
  ['Legal', [['terms', 'Terms of service'], ['privacy', 'Privacy'], ['dpa', 'Data processing terms']]],
  ['Talk to us', [['contact', 'Contact us']]],
];

export function PublicFooter({ go, me }) {
  /* The home page is where somebody signed in is never sent (it takes them to their dashboard),
     so its "How it works" is only offered to people who can read it. */
  const cols = me?.signedIn
    ? FOOT.map(([head, links]) => [head, links.filter(([to]) => to !== 'home')])
    : FOOT;
  return (
    <footer className="pubfoot">
      <div className="pubfootin">
        <div className="pubfootbrand">
          <span className="pubwm">Understudy</span>
          <p>
            Zero data retention at the model provider, asked for on every call. What we store
            ourselves is kept for the window each workspace chooses: 30, 60 or 90 days, or
            indefinitely. New workspaces start at 30 days.
          </p>
        </div>
        <nav className="pubcols" aria-label="More about Understudy">
          {cols.map(([head, links]) => (
            <div key={head}>
              <span className="pubcolh">{head}</span>
              <ul>
                {links.map(([to, label, hash]) => (
                  <li key={label}><To to={to} hash={hash || ''} go={go}>{label}</To></li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </div>
    </footer>
  );
}

/** A public page: the shared header, the page itself, the shared footer. */
export function PublicPage({ me, go, dark, setDark, here, children }) {
  return (
    <div className="pubpage">
      <PublicHeader me={me} go={go} dark={dark} setDark={setDark} here={here} />
      {children}
      <PublicFooter go={go} me={me} />
    </div>
  );
}

/* One document: what kind of page it is, its title, when it last changed, one paragraph that
   says what the page is for, and then its sections. A page that makes commitments carries the
   date, so anybody reading it can tell whether it has moved since they last looked. */
export function Doc({ eyebrow, title, lead, dated = true, children }) {
  return (
    <main className="docpage" id="main">
      <div className="dochead">
        {eyebrow && <div className="eyeb doceyeb">{eyebrow}</div>}
        <h1>{title}</h1>
        {dated && <p className="docdate">Last updated {UPDATED} (IST)</p>}
        {lead && <p className="doclead">{lead}</p>}
      </div>
      <div className="docbody">{children}</div>
    </main>
  );
}

/** A section of a document, with an anchor so it can be linked to directly. */
export function Sec({ id, title, children }) {
  return (
    <section className="docsec" id={id} aria-labelledby={id ? `${id}-h` : undefined}>
      <h2 id={id ? `${id}-h` : undefined}>{title}</h2>
      {children}
    </section>
  );
}
