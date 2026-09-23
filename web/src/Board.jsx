import React, { useEffect, useRef } from 'react';

/* Renders a screen lifted from the design board and fills in its holes from live state.

   The wrapper is called `lifted`, not `board`: the design's own stylesheet uses `.board` for
   a card, with a border and a background, so naming the wrapper that drew a box around every
   screen this renders. It has bitten twice. A name of our own cannot collide again.

   The markup is never retyped, so the app shows what was signed off. What varies is only
   what the board itself marked as varying:

     data-if="x"    shown when vals.x is true
     data-cls="x"   className comes from vals.x
     data-text="x"  text content comes from vals.x
     data-go="x"    click calls on.x()

   Two more, for the places a design has to carry example content:

     subs    text to swap, so the board's sample key and host become this workspace's
     repeat  a list the board drew with example rows; its first row is the template

   Both of those rewrite the DOM, so the original text and the original row are kept and
   every pass works from those. Substituting into an already-substituted node would only
   work once, and the screen would then be stuck on whatever it first showed.

   Real inputs are left alone, so typing is never wiped by a re-render. */
export default function Board({ html, vals = {}, on = {}, hrefs = {}, subs, repeat, onSubmit,
  className = '' }) {
  const host = useRef(null);
  const original = useRef(new Map());   // text node -> what the board said
  const rows = useRef(new Map());       // selector -> { template, parent, marker }

  useEffect(() => {
    const root = host.current;
    if (!root) return;

    if (repeat) {
      for (const [sel, items] of Object.entries(repeat)) {
        let kept = rows.current.get(sel);
        if (!kept) {
          const found = [...root.querySelectorAll(sel)];
          if (!found.length) continue;
          const marker = document.createComment(`rows:${sel}`);
          found[found.length - 1].after(marker);
          kept = { template: found[0].cloneNode(true), parent: found[0].parentNode, marker };
          rows.current.set(sel, kept);
        }
        for (const el of root.querySelectorAll(sel)) el.remove();
        for (const item of items) {
          const node = kept.template.cloneNode(true);
          for (const [cls, text] of Object.entries(item)) {
            const cell = node.querySelector(`.${cls}`);
            if (cell) cell.textContent = text;
          }
          kept.parent.insertBefore(node, kept.marker);
        }
      }
    }

    if (subs) {
      const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        if (!original.current.has(n)) original.current.set(n, n.nodeValue);
        let t = original.current.get(n);
        for (const [find, put] of Object.entries(subs)) {
          if (put && t.includes(find)) t = t.split(find).join(put);
        }
        if (t !== n.nodeValue) n.nodeValue = t;
      }
    }

    for (const el of root.querySelectorAll('[data-if]')) {
      el.hidden = !vals[el.getAttribute('data-if')];
    }
    for (const el of root.querySelectorAll('[data-cls]')) {
      const next = vals[el.getAttribute('data-cls')];
      if (typeof next === 'string') el.setAttribute('class', next);
    }
    for (const el of root.querySelectorAll('[data-text]')) {
      const next = vals[el.getAttribute('data-text')];
      el.textContent = next === undefined || next === null ? '' : String(next);
    }
    /* A board control that goes somewhere gets that address put on it, so the browser can
       offer to open it in a new tab. Controls that only change what this screen is showing
       (a language tab, the next step) have no address and stay plain. */
    for (const el of root.querySelectorAll('[data-go]')) {
      const to = hrefs[el.getAttribute('data-go')];
      if (to && el.tagName === 'A') el.setAttribute('href', to);
    }
    /* A board control drawn as plain text, a span or a box that is clicked, gets what a button
       has: it can be reached with Tab, it is announced as a button, and Enter or Space presses it
       (see `press` below). The wizard's "I have already connected", "Back" and "Or send us copies
       instead" were words a mouse could click and a keyboard could not reach at all. */
    for (const el of root.querySelectorAll('[data-go]')) {
      if (el.matches('a[href], button, input, select, textarea')) continue;
      if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    }
    // a block of code that scrolls sideways can be reached with the keyboard, to be scrolled
    for (const el of root.querySelectorAll('pre')) {
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    }
  });

  const press = (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const hit = e.target.closest('[data-go]');
    if (!hit || !host.current.contains(hit) || hit !== e.target) return;
    if (hit.matches('a[href], button, input, select, textarea')) return;   // those press themselves
    e.preventDefault();
    hit.click();
  };

  const click = (e) => {
    const hit = e.target.closest('[data-go]');
    if (!hit || !host.current.contains(hit)) return;
    // a click asking for a new tab or window belongs to the browser, not to this screen
    if (hit.hasAttribute('href') && (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) return;
    const fn = on[hit.getAttribute('data-go')];
    if (!fn) return;
    e.preventDefault();
    fn(e);
  };

  const submit = (e) => {
    if (!onSubmit) return;
    e.preventDefault();
    onSubmit(Object.fromEntries(new FormData(e.target).entries()), e.target);
  };

  return (
    <div
      ref={host}
      className={`lifted ${className}`.trim()}
      onClick={click}
      onKeyDown={press}
      onSubmit={submit}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
