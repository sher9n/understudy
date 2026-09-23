import React, { useEffect } from 'react';
import { href } from '../router.js';
import Board from '../Board.jsx';
import { SkipLink } from '../nav.jsx';
import html from './home.html?raw';

/* The board's sample address. It never existed, so the one line the page asks somebody to
   change pointed at nowhere; the real address is this deployment's own, which is where they
   are reading it. */
const SAMPLE_BASE = 'https://api.understudy.dev/v1';

// the pages the footer's small row of links leads to
const FOOT = ['pricing', 'terms', 'privacy', 'contact'];

/* Straight from the design board, with its own header and footer. The live parts are the calls
   to action, the theme switch, and the footer's links to pricing and the small print. */
export default function Home({ go, dark, setDark }) {
  // arriving at /#how from another page lands on that part of this one
  useEffect(() => {
    if (window.location.hash === '#how') document.getElementById('how')?.scrollIntoView({ block: 'start' });
  }, []);

  return (
    <>
      <SkipLink />
      <Board
        html={html}
        vals={{ dark, light: !dark }}
        subs={{ [SAMPLE_BASE]: `${window.location.origin}/v1` }}
        hrefs={{
          go_signup: href('signup'), go_signin: href('signin'),
          ...Object.fromEntries(FOOT.map((to) => [`go_${to}`, href(to)])),
        }}
        on={{
          go_signup: () => go('signup'),
          go_signin: () => go('signin'),
          ...Object.fromEntries(FOOT.map((to) => [`go_${to}`, () => go(to)])),
          toggleTheme: () => setDark(!dark),
        }}
      />
    </>
  );
}
