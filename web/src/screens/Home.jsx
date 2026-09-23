import React, { useEffect } from 'react';
import { href } from '../router.js';
import Board from '../Board.jsx';
import { PublicPage } from './legal/Public.jsx';
import html from './home.html?raw';

/* The board's sample address. It never existed, so the one line the page asks somebody to
   change pointed at nowhere; the real address is this deployment's own, which is where they
   are reading it. */
const SAMPLE_BASE = 'https://api.understudy.dev/v1';

/* The page itself is straight from the design board. The header and the footer are the ones
   every public page shares, so the home page offers the same way to pricing, to what happens to
   somebody's traffic and to the small print as every other page does. */
export default function Home({ me, go, dark, setDark }) {
  // arriving at /#how from another page lands on that part of this one
  useEffect(() => {
    if (window.location.hash === '#how') document.getElementById('how')?.scrollIntoView({ block: 'start' });
  }, []);

  return (
    <PublicPage me={me} go={go} dark={dark} setDark={setDark} here="home">
      <Board
        html={html}
        vals={{ dark, light: !dark }}
        subs={{ [SAMPLE_BASE]: `${window.location.origin}/v1` }}
        hrefs={{
          go_signup: href('signup'), go_signin: href('signin'),
          go_traffic: href('traffic'), go_pricing: href('pricing'),
        }}
        on={{
          go_signup: () => go('signup'),
          go_signin: () => go('signin'),
          go_traffic: () => go('traffic'),
          go_pricing: () => go('pricing'),
        }}
      />
    </PublicPage>
  );
}
