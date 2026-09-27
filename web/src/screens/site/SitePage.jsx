import React, { useEffect, useRef } from 'react';
import { href } from '../../router.js';
import Board from '../../Board.jsx';
import { SkipLink } from '../../nav.jsx';
import { startSiteMotion } from '../../siteMotion.js';
import homeHtml from './home.html?raw';
import howHtml from './how.html?raw';
import routingHtml from './routing.html?raw';
import '../../site.css';

/* The public site's three pages, as the 27 Sep 2026 homepage artboard drew them: the homepage, How it works and How
   models are routed (site.css, and siteMotion.js for what moves). The markup is the board's own, word for word, never
   retyped (Board.jsx); what varies is who is looking and where the links go. The site as it was before stays at
   /legacy, to compare the two (screens/Home.jsx, screens/legal/HowItWorks.jsx and HowRouting.jsx, App.jsx). */

/* The sample address in the code on How it works. It never existed, so the one line the page asks somebody to change
   would point at nowhere; the real address is this deployment's own, which is where they are reading it. */
const SAMPLE_BASE = 'https://api.understudy.dev/v1';
// every page the three link to, by the name the board gives the link (data-go="go_how")
const LINKS = ['home', 'how', 'routing', 'signin', 'signup', 'pricing', 'terms', 'privacy', 'contact'];
// a guide read inside the app sits in the app's own frame, whose <main> it already is, so its own is a plain box
const inAppOf = (html) => html.replace('<main class="w-main" id="main">', '<div class="w-main">').replace('</main>', '</div>');

function SitePage({ html, me, go, dark, setDark, inApp = false, parts = [], moved = {} }) {
  const host = useRef(null);
  const motion = useRef(null);
  const drawn = useRef(false);
  // the pictures move once the page is drawn, and stop, and are taken away again, when it goes
  useEffect(() => {
    const m = startSiteMotion(host.current?.querySelector('.w'));
    motion.current = m;
    return () => { m.stop(); motion.current = null; };
  }, []);
  // the routing picture and the orb are drawn in the page's colours, so a change of theme draws them again
  useEffect(() => {
    if (!drawn.current) { drawn.current = true; return; }
    motion.current?.retheme();
  }, [dark]);
  // arriving from a link to one part of a page (/how-it-works#testing) lands on it, or on the part that took its place
  useEffect(() => {
    const asked = window.location.hash.slice(1);
    const id = moved[asked] ?? asked;
    if (id && parts.includes(id)) document.getElementById(id)?.scrollIntoView({ block: 'start' });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const signedIn = !!me?.signedIn;
  // somebody signed in is offered their own workspace, never a sign-in that would only send them straight back
  const app = me?.onboarded ? 'dash' : 'connect';
  return (
    <div className="sitepage" ref={host}>
      {!inApp && <SkipLink />}
      <Board
        html={inApp ? inAppOf(html) : html}
        vals={{
          pub: !inApp,
          // until the account check answers, neither "Sign in" nor "Open the dashboard" is offered
          signedIn: !!me && signedIn,
          signedOut: !!me && !signedIn,
          modeLabel: dark ? 'Switch to the light theme' : 'Switch to the dark theme',
          appLabel: me?.onboarded ? 'Open the dashboard' : 'Finish connecting',
        }}
        subs={{ [SAMPLE_BASE]: `${window.location.origin}/v1` }}
        hrefs={{ ...Object.fromEntries(LINKS.map((to) => [`go_${to}`, href(to)])), go_app: href(app) }}
        on={{
          ...Object.fromEntries(LINKS.map((to) => [`go_${to}`, () => go(to)])),
          go_app: () => go(app),
          toggleTheme: () => setDark(!dark),
        }}
      />
    </div>
  );
}

/* The homepage. An old link to its "How it works" part (/#how) lands on step 1, connecting once. */
export function SiteHome(props) {
  return <SitePage html={homeHtml} parts={['how']} {...props} />;
}

/* How it works keeps the anchors the page had before, so an old link to /how-it-works#testing still lands on testing. */
export function SiteHow(props) {
  return <SitePage html={howHtml} parts={['connect', 'workloads', 'testing', 'switching', 'learning']} {...props} />;
}

/* How models are routed keeps its steps' anchors too, and sends a link to a part it no longer has (sorting by kind,
   Jev, the simulations) to the step that now says what it said. */
export function SiteRouting(props) {
  return <SitePage html={routingHtml} parts={['garden', 'testing', 'priority', 'second-look', 'after']}
    moved={{ kinds: 'garden', jev: 'testing', numbers: 'second-look' }} {...props} />;
}
