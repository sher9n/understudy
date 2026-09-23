/* Every navigation in the app is a real link.

   The address lives on the element as an href, which is what the browser needs before it
   will offer "Open link in new tab", show the destination in the status bar, or let a
   middle click or a cmd-click open a second tab. A handler on a div can do none of that.

   The page still takes over the ordinary case: a plain left click is handled in place, so
   navigating stays instant and nothing reloads. Anything the person did deliberately to
   ask for a new tab or window is left to the browser, untouched. */

import React from 'react';
import { href } from './router.js';

/** Handle the plain left click; hand every other kind of click back to the browser. */
export const plainClick = (fn) => (e) => {
  if (e.defaultPrevented) return;
  if (e.button !== undefined && e.button !== 0) return;      // middle and right are the browser's
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;  // new tab, new window, download
  e.preventDefault();
  fn(e);
};

/* The first thing Tab reaches on a page: a way past the menu to the page itself, shown only
   while it has focus. It moves focus to the page rather than only scrolling to it, so the next
   Tab carries on from there. */
export function SkipLink() {
  return (
    <a className="skiplink" href="#main" onClick={(e) => {
      const main = document.getElementById('main');
      if (!main) return;
      e.preventDefault();
      if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
      main.focus();
      main.scrollIntoView({ block: 'start' });
    }}>Skip to the page</a>
  );
}

/** A link to a screen in the app. `to` is a screen key, `id` opens one workload. */
export default function A({ to, id = null, go, children, ...rest }) {
  return (
    <a href={href(to, id)} onClick={plainClick(() => go(to, id))} {...rest}>
      {children}
    </a>
  );
}
