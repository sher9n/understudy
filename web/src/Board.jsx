import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/* Renders a screen lifted from the design board and fills in its holes from live state.

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
export default function Board({ html, vals = {}, on = {}, hrefs = {}, subs, repeat, slots, onSubmit,
  className = '' }) {
  const host = useRef(null);
  /* The board's markup is written in one go, so its slot elements do not exist until after
     the first paint. This re-renders once they do, and the portals go in then. */
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
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
  });

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

  const portals = [];
  if (mounted && slots && host.current) {
    for (const [name, node] of Object.entries(slots)) {
      if (!node) continue;
      const into = host.current.querySelector(`[data-slot="${name}"]`);
      if (into) portals.push(<React.Fragment key={name}>{createPortal(node, into)}</React.Fragment>);
    }
  }

  return (
    <>
      <div
        ref={host}
        className={`board ${className}`.trim()}
        onClick={click}
        onSubmit={submit}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {portals}
    </>
  );
}
