/* The home page's drawings, moving: option E of the homepage artboard (25 Sep 2026), ported from its flowC and animateB.

   The top's example is the workload page's own live drawing of what Understudy does with each request (FlowSvg in
   WorkloadCharts.jsx): requests from the app go through Understudy, most on to the cheaper model as its roll out goes to
   5% of requests, then 25%, then 98%, and the rest to the original, which stays as back-up. The cards' drawings and the
   data panel's carry dots along their own lines, in the shares they state. The code box's two lines light up when it is
   scrolled to.

   The page is drawn complete before anything moves, so a still frame, a print or less motion loses nothing: for a reader
   who asked for less motion, the top's drawing stands rolled out with a few dots placed, as the app draws it then, and
   nothing moves. A drawing moves only while it is on the screen. Everything added here is taken away again when the page
   goes, so coming back to it draws it once. */

const NS = 'http://www.w3.org/2000/svg';

/* A drawing's text sizes are set as style rather than as attributes: a sheet's text rule outranks an attribute. */
const el = (tag, attrs = {}, text) => {
  const n = document.createElementNS(NS, tag);
  let size = null;
  for (const [k, v] of Object.entries(attrs)) { if (k === 'font-size') size = v; else n.setAttribute(k, v); }
  if (size !== null) n.style.fontSize = `${size}px`;
  if (text !== undefined) n.textContent = text;
  return n;
};

export function startHomeMotion(root) {
  if (!root) return () => {};
  const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const added = [];            // everything drawn here, removed on the way out
  const add = (parent, node) => { parent.appendChild(node); added.push(node); return node; };
  const $ = (id) => root.querySelector(`#${id}`);

  /* Every animation is one of these: a tick of the time it has been on the screen, and the element it lives in. One
     frame loop drives them all, only while one of them is on the screen. */
  const loops = [];
  const seen = new Map();
  const loop = (target, tick) => { loops.push({ target, tick, t: 0 }); };
  let raf = 0;
  let prev = 0;
  const frame = (now) => {
    const dt = prev ? Math.min(64, now - prev) : 16;
    prev = now;
    let any = false;
    for (const l of loops) {
      if (!seen.get(l.target)) continue;
      any = true;
      l.t += dt;
      l.tick(l.t, dt);
    }
    raf = any ? requestAnimationFrame(frame) : 0;
    if (!any) prev = 0;
  };
  const wake = () => { if (!raf && !reduced) raf = requestAnimationFrame(frame); };
  const io = 'IntersectionObserver' in window ? new IntersectionObserver((es) => {
    for (const e of es) seen.set(e.target, e.isIntersecting);
    wake();
  }, { threshold: 0.05 }) : null;
  const watch = (target) => { if (io) io.observe(target); else seen.set(target, true); };

  /* Dots that travel a drawing's own lines. A route is one or more lines taken in turn; where one line ends away from the
     next (the two sides of a box) the dot goes inside for a moment and comes out on the far side. Routes are taken in the
     shares the drawing states. Speed is in drawing units a millisecond. */
  function dots(svg, routes, { every = 700, speed = 0.06, r = 3, dwell = 280 } = {}) {
    if (!svg) return;
    const layer = add(svg, el('g'));
    const owed = routes.map(() => 0);
    const live = [];
    let last = -1e9;
    const ends = (a, b) => { const p = a.getPointAtLength(a.getTotalLength()); const q = b.getPointAtLength(0); return Math.hypot(p.x - q.x, p.y - q.y) > 3; };
    loop(svg, (t, dt) => {
      if (t - last > every) {
        routes.forEach((rt, i) => { owed[i] += rt.share ?? 1 / routes.length; });
        let k = 0; for (let i = 1; i < routes.length; i += 1) if (owed[i] > owed[k]) k = i;
        owed[k] -= 1;
        const rt = routes[k];
        if (!rt.gaps) rt.gaps = rt.segs.map((s, i) => (i > 0 && ends(rt.segs[i - 1], s)));
        const c = el('circle', { r, fill: rt.color(0) });
        layer.appendChild(c);
        live.push({ rt, seg: 0, f: 0, wait: 0, c });
        last = t;
      }
      for (let i = live.length - 1; i >= 0; i -= 1) {
        const d = live[i];
        if (d.wait > 0) { d.wait -= dt; if (d.wait > 0) continue; d.c.setAttribute('opacity', 1); }
        let q = d.rt.segs[d.seg];
        d.f += (dt * speed) / Math.max(1, q.getTotalLength());
        if (d.f >= 1) {
          d.seg += 1; d.f = 0;
          if (d.seg >= d.rt.segs.length) { d.c.remove(); live.splice(i, 1); continue; }
          q = d.rt.segs[d.seg];
          d.c.setAttribute('fill', d.rt.color(d.seg));
          if (d.rt.gaps[d.seg]) { d.wait = dwell; d.c.setAttribute('opacity', 0); }
        }
        const at = q.getPointAtLength(d.f * q.getTotalLength());
        d.c.setAttribute('cx', at.x); d.c.setAttribute('cy', at.y);
      }
    });
    watch(svg);
  }

  /* The top's example: across on a wide screen and top to bottom on a phone, in the app's own shapes, colours and dot pace. */
  function flow() {
    const G = {
      w: { A: 'M132 126 C176 126 196 126 222 126', C: 'M404 112 C446 104 440 55 474 55', Y: 'M404 140 C446 148 440 195 474 195',
        app: [8, 100, 124, 52], us: [224, 82, 180, 86], cheap: [476, 24, 158, 62], yours: [476, 164, 158, 62] },
      t: { A: 'M165 58 C165 70 165 80 165 92', C: 'M128 180 C118 202 84 202 84 228', Y: 'M202 180 C212 202 246 202 246 228',
        app: [103, 6, 124, 52], us: [70, 94, 190, 86], cheap: [6, 230, 156, 62], yours: [168, 230, 156, 62] },
    };
    // the roll out, as time goes by with it on the screen: 5% of requests, 25%, then all but the few kept as back-up
    const STAGES = [[0, 0.05], [3600, 0.25], [7200, 0.98]];
    const views = ['w', 't'].map((k) => {
      const svg = $(`hm-flow-${k}`);
      if (!svg) return null;
      const g = G[k];
      const defs = add(svg, el('defs'));
      const mk = el('marker', { id: `hm-ah-${k}`, viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto' });
      mk.appendChild(el('path', { d: 'M0 0L8 4L0 8Z', fill: 'var(--line-strong)' }));
      defs.appendChild(mk);
      const P = {
        A: add(svg, el('path', { d: g.A, fill: 'none', stroke: 'var(--line-strong)', 'stroke-width': 2, 'marker-end': `url(#hm-ah-${k})` })),
        C: add(svg, el('path', { d: g.C, fill: 'none', stroke: 'var(--ok)', 'stroke-width': 2.4, 'marker-end': `url(#hm-ah-${k})` })),
        Y: add(svg, el('path', { d: g.Y, fill: 'none', stroke: 'var(--line-strong)', 'stroke-width': 1.6, 'stroke-dasharray': '4 4', 'marker-end': `url(#hm-ah-${k})` })),
      };
      const box = (b, fill, stroke, w, rx) => add(svg, el('rect', { x: b[0], y: b[1], width: b[2], height: b[3], rx, fill, stroke, 'stroke-width': w }));
      const mid = (b) => b[0] + b[2] / 2;
      const text = (x, y, cls, s) => add(svg, el('text', { x, y, 'text-anchor': 'middle', ...(cls ? { class: cls } : {}) }, s));
      box(g.app, 'var(--raise)', 'var(--line)', 1, 12);
      text(mid(g.app), g.app[1] + 22, 'ui t-ink', 'Your app'); text(mid(g.app), g.app[1] + 40, '', '4,800 a day');
      box(g.us, 'var(--brandq)', 'var(--brand)', 1.4, 14);
      text(mid(g.us), g.us[1] + 30, 'ui t-brand', 'Understudy');
      // what it sends where follows the roll out, in the app's words (setShare below)
      const says = [text(mid(g.us), g.us[1] + 52, '', ''), text(mid(g.us), g.us[1] + 70, '', '')];
      box(g.cheap, 'var(--okq)', 'var(--ok)', 1.4, 12);
      text(mid(g.cheap), g.cheap[1] + 26, 'ui t-ok', 'Gemma 4 26B'); const top = text(mid(g.cheap), g.cheap[1] + 46, 't-ok', '');
      box(g.yours, 'var(--raise)', 'var(--line)', 1, 12);
      text(mid(g.yours), g.yours[1] + 26, 'ui t-ink', 'GPT-5.4, original'); const bottom = text(mid(g.yours), g.yours[1] + 46, '', '');
      const layer = add(svg, el('g'));
      return { svg, P, says, top, bottom, layer, len: null, dots: [], last: 0, owed: 0 };
    }).filter(Boolean);
    if (!views.length) return;
    /* the app's own words for each state (FlowSvg): the share it sends while the roll out is under way and "each request"
       once it is done; "still here" while rolling out, "as back-up" once rolled out */
    const setShare = (s) => views.forEach((v) => {
      const done = s >= 0.98;
      v.says[0].textContent = done ? 'sends each request' : `sends ${Math.round(s * 100)}% to the`;
      v.says[1].textContent = done ? 'to the cheaper model' : 'cheaper model';
      v.top.textContent = `${Math.round(s * 100)}% answered here`;
      v.bottom.textContent = s >= 0.98 ? `${Math.round((1 - s) * 100)}% here, as back-up` : `${Math.round((1 - s) * 100)}% still here`;
    });
    const shownNow = (v) => v.svg.getBoundingClientRect().width > 0;
    const lens = (v) => { if (!v.len) v.len = { A: v.P.A.getTotalLength(), C: v.P.C.getTotalLength(), Y: v.P.Y.getTotalLength() }; return v.len; };
    const put = (v, seg, f, route) => {
      const c = el('circle', { r: seg === 'A' ? 4 : 4.5, fill: route === 'Y' && seg !== 'A' ? 'var(--ink)' : seg === 'A' ? 'var(--brand)' : 'var(--ok)' });
      const p = v.P[seg].getPointAtLength(f * lens(v)[seg]);
      c.setAttribute('cx', p.x); c.setAttribute('cy', p.y);
      v.layer.appendChild(c);
      return c;
    };
    if (reduced) {
      // at rest, rolled out, as the app draws it for less motion: a few dots placed on each route that carries requests
      setShare(STAGES[STAGES.length - 1][1]);
      for (const v of views) {
        if (!shownNow(v)) continue;
        [0.2, 0.55, 0.85].forEach((f) => put(v, 'A', f, 'C'));
        [0.25, 0.5, 0.75].forEach((f) => put(v, 'C', f, 'C'));
        put(v, 'Y', 0.5, 'Y');
      }
      return;
    }
    setShare(STAGES[0][1]);
    let shown = null;
    const fig = views[0].svg.closest('figure') || views[0].svg;
    loop(fig, (t, dt) => {
      let share = STAGES[0][1];
      for (const [at, s] of STAGES) if (t >= at) share = s;
      if (share !== shown) { shown = share; setShare(share); }
      for (const v of views) {
        if (!shownNow(v)) continue;
        const len = lens(v);
        // the share sent on, exactly: every request adds its chance of going that way, and one goes when a whole one is due
        if (t - v.last > 360) {
          v.owed += 1 - share;
          const route = v.owed >= 1 - 1e-9 ? 'Y' : 'C';
          if (route === 'Y') v.owed -= 1;
          v.dots.push({ seg: 'A', f: 0, route, el: put(v, 'A', 0, route) });
          v.last = t;
        }
        for (let i = v.dots.length - 1; i >= 0; i -= 1) {
          const d = v.dots[i];
          d.f += (dt * 0.11) / len[d.seg];
          if (d.f >= 1) {
            if (d.seg === 'A') {
              d.seg = d.route; d.f = 0;
              d.el.setAttribute('fill', d.route === 'Y' ? 'var(--ink)' : 'var(--ok)'); d.el.setAttribute('r', 4.5);
            } else { d.el.remove(); v.dots.splice(i, 1); continue; }
          }
          const p = v.P[d.seg].getPointAtLength(d.f * len[d.seg]);
          d.el.setAttribute('cx', p.x); d.el.setAttribute('cy', p.y);
        }
      }
    });
    watch(fig);
  }

  flow();
  if (!reduced) {
    const byId = (k) => $(`hm-${k}`);
    const all = (k, sel) => [...(byId(k)?.querySelectorAll(sel) || [])];
    // 1: calls go into the automatic step and come out sorted into their jobs
    const JOB = ['var(--brand)', 'var(--ok)', 'var(--warn)'];
    const outs = all('c1', '[data-out]');
    if (outs.length) {
      dots(byId('c1'), all('c1', '[data-in]').map((p, i) => ({ segs: [p, outs[i % outs.length]], color: (k) => (k === 0 ? 'var(--mut)' : JOB[i % 3]) })),
        { every: 600, speed: 0.06, r: 2.6, dwell: 340 });
    }
    // 2: sampled calls tried four ways
    const TRY = ['var(--bad)', 'var(--ok)', 'var(--brand)', 'var(--mut)'];
    dots(byId('c2'), all('c2', '[data-try]').map((p, i) => ({ segs: [p], color: () => TRY[i] })), { every: 500, speed: 0.05, r: 2.6 });
    // 3: what happened next, into the record
    const EV = ['var(--ok)', 'var(--warn)', 'var(--bad)', 'var(--brand)'];
    dots(byId('c3'), all('c3', '[data-ev]').map((p, i) => ({ segs: [p], color: () => EV[i] })), { every: 650, speed: 0.05, r: 2.6 });
    // data controls: every call through the endpoint to a provider
    const din = byId('p3')?.querySelector('[data-dc="in"]');
    const da = byId('p3')?.querySelector('[data-dc="a"]');
    const db = byId('p3')?.querySelector('[data-dc="b"]');
    if (din && da && db) {
      dots(byId('p3'), [{ segs: [din, da], color: () => 'var(--brand)' }, { segs: [din, db], color: () => 'var(--brand)' }], { every: 1000, speed: 0.06, r: 3 });
    }
    root.classList.add('hm-play');
  }

  // the code box's two lines light up when it is scrolled to; with less motion, or no way to tell, they are simply lit
  const endbox = root.querySelector('.hm-endbox');
  let endIo = null;
  if (endbox && !reduced && 'IntersectionObserver' in window) {
    endbox.classList.add('hm-await');
    endIo = new IntersectionObserver((es) => es.forEach((e) => {
      if (!e.isIntersecting) return;
      endbox.classList.remove('hm-await'); endbox.classList.add('hm-seen');
      endIo.disconnect();
    }), { threshold: 0.6 });
    endIo.observe(endbox);
  }

  wake();
  return () => {
    cancelAnimationFrame(raf);
    raf = 0;
    if (io) io.disconnect();
    if (endIo) endIo.disconnect();
    for (const n of added) n.remove();
    root.classList.remove('hm-play');
    if (endbox) endbox.classList.remove('hm-await', 'hm-seen');
  };
}
