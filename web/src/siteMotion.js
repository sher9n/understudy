/* The site's three pages, moving (site.css, screens/site/*.html): the homepage's orb of every model tried, its replayed
   switch and its picture of requests being routed, and the guides' pictures.

   Every page is complete at rest, so a still frame, a print or a reader who asked for less motion loses nothing: the
   orb stands still, the switch shows its whole log, and the routing picture shows its routes with nothing moving.
   Everything runs only while it is on the screen, and everything started here is stopped and taken away again when the
   page goes (stop). The routing picture and the orb are drawn in the page's colours, so they are drawn again when the
   theme changes (retheme).

   Step 2, the routing picture, moves as version 2 of the quiet board (27 Sep 2026): small dots in each request's
   colour, setting off at uneven moments, usually a few seconds apart and about one time in three almost together.
   Requests that go together always head for different models, a dot only sets off when its way in is clear of the
   others, and dots leave Understudy a moment apart, so two never run into one another. */

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, text) => {
  const n = document.createElementNS(NS, tag);
  for (const k of Object.keys(attrs)) if (attrs[k] !== null && attrs[k] !== undefined) n.setAttribute(k, attrs[k]);
  if (text !== undefined) n.textContent = text;
  return n;
};
const seeded = (seed) => { let s = seed; return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; };

/* ---------- the orb: 491 model tries, the 40 that passed in blue ---------- */
const FIB = (() => {
  const n = 491, pts = [], ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i += 1) {
    const y = 1 - (i / (n - 1)) * 2, r = Math.sqrt(1 - y * y), a = ga * i;
    pts.push([Math.cos(a) * r, y, Math.sin(a) * r, i % 12 === 0 && i / 12 < 40]);
  }
  return pts;
})();
const ORB = {
  init(W, H, dpr) {
    const R = Math.min(W, H) * 0.4, cx = W / 2, cy = H / 2;
    const off = document.createElement('canvas');
    off.width = Math.round(W * dpr); off.height = Math.round(H * dpr);
    const g = off.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const halo = g.createRadialGradient(cx, cy, R * 0.92, cx, cy, R * 1.32);
    halo.addColorStop(0, 'rgba(110,140,255,0.30)'); halo.addColorStop(0.45, 'rgba(150,175,255,0.10)'); halo.addColorStop(1, 'rgba(150,175,255,0)');
    g.fillStyle = halo; g.fillRect(0, 0, W, H);
    g.save();
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.clip();
    const body = g.createRadialGradient(cx - R * 0.25, cy - R * 0.35, R * 0.05, cx, cy + R * 0.1, R * 1.05);
    body.addColorStop(0, '#3a3e4a'); body.addColorStop(0.5, '#15171d'); body.addColorStop(0.85, '#22252e'); body.addColorStop(1, '#5d6373');
    g.fillStyle = body; g.fillRect(cx - R, cy - R, 2 * R, 2 * R);
    const rnd = seeded(29);
    const count = Math.round(R * R * 0.75);
    for (let i = 0; i < count; i += 1) {
      const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * R;
      const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr;
      const u = (px - cx) / R, v = (py - cy) / R;
      const band = 0.5 + 0.5 * Math.sin(u * 5.2 + v * 3.1 + Math.sin(v * 4.2 + u * 1.7) * 1.9);
      g.fillStyle = `rgba(232,236,245,${(0.02 + 0.22 * band * band).toFixed(3)})`;
      g.fillRect(px, py, 1, 1);
    }
    g.globalCompositeOperation = 'destination-out';
    const fade = g.createLinearGradient(0, cy + R * 0.02, 0, cy + R);
    fade.addColorStop(0, 'rgba(0,0,0,0)'); fade.addColorStop(1, 'rgba(0,0,0,0.94)');
    g.fillStyle = fade; g.fillRect(cx - R, cy - R, 2 * R, 2 * R);
    g.restore();
    return { off, R, cx, cy };
  },
  frame(ctx, W, H, t, s, dark) {
    ctx.clearRect(0, 0, W, H);
    const ring = (from, to) => {
      ctx.save(); ctx.translate(s.cx, s.cy); ctx.rotate(-0.32);
      ctx.strokeStyle = dark ? 'rgba(122,167,255,0.5)' : 'rgba(15,98,254,0.4)'; ctx.lineWidth = 1; ctx.setLineDash([2, 6]);
      ctx.beginPath(); ctx.ellipse(0, 0, s.R * 1.18, s.R * 0.3, 0, from, to); ctx.stroke();
      ctx.restore();
    };
    ring(Math.PI, Math.PI * 2);
    ctx.drawImage(s.off, 0, 0, W, H);
    const a = t * 0.16, b = 0.42, ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
    for (const [x, y, z, hot] of FIB) {
      const x1 = x * ca + z * sa, z1 = -x * sa + z * ca;
      const y2 = y * cb - z1 * sb, z2 = y * sb + z1 * cb;
      if (z2 < 0.05) continue;
      const px = s.cx + x1 * s.R * 0.985, py = s.cy + y2 * s.R * 0.985;
      const fade = Math.min(1, Math.max(0, (s.cy + s.R * 0.96 - py) / (s.R * 0.95)));
      if (hot) {
        ctx.fillStyle = `rgba(76,141,255,${(0.14 * z2 * fade).toFixed(3)})`;
        ctx.beginPath(); ctx.arc(px, py, 7.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = `rgba(92,152,255,${((0.4 + 0.6 * z2) * fade).toFixed(3)})`;
        ctx.beginPath(); ctx.arc(px, py, 2.5, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.fillStyle = `rgba(232,236,245,${((0.1 + 0.45 * z2) * fade).toFixed(3)})`;
        ctx.fillRect(px - 0.75, py - 0.75, 1.5, 1.5);
      }
    }
    ring(0, Math.PI);
    const th = t * 0.6, ox = Math.cos(th) * s.R * 1.18, oy = Math.sin(th) * s.R * 0.3;
    ctx.save(); ctx.translate(s.cx, s.cy); ctx.rotate(-0.32);
    const front = Math.sin(th) > 0;
    ctx.fillStyle = front ? (dark ? '#7aa7ff' : '#0f62fe') : (dark ? 'rgba(122,167,255,0.35)' : 'rgba(15,98,254,0.3)');
    ctx.beginPath(); ctx.arc(ox, oy, front ? 4.2 : 3, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  },
};

/* ---------- step 2: requests from three jobs, each routed to the model proven on it ---------- */
/* the picture's colours in each theme; `active` is the shade a line takes while a dot is on it */
const PAL = {
  light: { ink: '#0e1016', mut: '#585d6c', faint: '#8a8f9d', line: '#dfe1e7', path: '#d3d6de', pathD: '#bfc3cc', card: '#ffffff', cardSoft: '#fafbfc',
    ink2: '#2e323d', inkSoft: '#454a58', win: ['#e7eeff', '#0b4fd0', null], own: ['#eef0f4', '#454a58', null], rehearse: ['#ffffff', '#6b7080', '#b9bec9'],
    node: '#ffffff', nodeLine: '#b9bec9', nodeIcon: '#585d6c', box: '#0e1016', boxLine: null, divider: '#2a2f3b', kind: 'c', active: '#a2a7b3' },
  dark: { ink: '#eef0f5', mut: '#a1a7b4', faint: '#7d8493', line: '#262a33', path: '#2e333d', pathD: '#3c424e', card: '#101319', cardSoft: '#0c0f14',
    ink2: '#c9cdd6', inkSoft: '#b4bac6', win: ['#14203a', '#8fb4ff', null], own: ['#1d212a', '#c3c8d3', null], rehearse: ['#101319', '#8d94a3', '#3c424e'],
    node: '#101319', nodeLine: '#3c424e', nodeIcon: '#a1a7b4', box: '#171b24', boxLine: '#303746', divider: '#303746', kind: 'g', active: '#555c6a' },
};
/* each kind of request keeps one colour all the way: c on the light page, g on the dark page and inside the black box */
const KINDS = {
  trans: { tag: 'Translation', label: 'Translation', c: '#0b7285', g: '#66d9e8' },
  tool: { tag: 'Tool call', label: 'Tool calls', c: '#6741d9', g: '#b197fc' },
  support: { tag: 'Customer support', short: 'Support', label: 'Customer support', c: '#c2410c', g: '#ffa94d' },
};
/* The tool call and translation routes are Understudy's real decisions in our own workspaces (25 and 26 Sep 2026); the
   split of customer support by question is an example, and the page says so under the picture. */
const ROUTING = {
  left: 'Requests arriving', right: 'Answered by',
  models: [
    { id: 'gemma', name: 'Gemma 4 31B', maker: 'Google', chip: 'Switched 25 Sep', tone: 'win', serves: [{ k: 'tool' }], proof: '2 of 2 tests passed · 92% cheaper · 2.3× faster' },
    { id: 'ling', name: 'Ling 3.0 Flash', maker: 'inclusionAI', chip: 'Rehearsing', tone: 'rehearse', serves: [{ k: 'trans', t: 'Translation, on copies' }], proof: '1 of 2 tests passed · 99% cheaper' },
    { id: 'gpt54', name: 'GPT-5.4', maker: 'OpenAI', chip: 'Your own model', tone: 'own', serves: [{ k: 'trans' }, { k: 'support', t: 'Support: billing, new' }], proof: 'Everything not yet proven elsewhere' },
    { id: 'qwen', name: 'Qwen 2.5 7B', maker: 'Qwen', chip: 'Proven on this type', tone: 'win', serves: [{ k: 'support', t: 'Support: order status' }], proof: 'Only the questions it was right on' },
  ],
  routes: { g: { to: 'gemma' }, c: { to: 'ling', dashed: true }, o: { to: 'gpt54' }, so: { to: 'gpt54', via: true }, sq: { to: 'qwen', via: true } },
  pool: [
    { k: 'support', sub: 'Order status', text: 'Where is my order 2061?', r: 'sq', say: ['Qwen 2.5 7B', 'split by question'] },
    { k: 'tool', tool: 'book_table', text: 'Book a table for four at 19:30', r: 'g', say: ['Gemma 4 31B', 'whole job, 2 of 2 tests'] },
    { k: 'trans', text: 'Translate to German: “Order shipped.”', r: 'o', say: ['GPT-5.4', 'Ling 3.0 Flash rehearses'] },
    { k: 'support', sub: 'Billing', text: 'I was charged twice for order 2061', r: 'so', say: ['GPT-5.4', 'small models missed these'] },
    { k: 'tool', tool: 'search_flights', text: 'Find flights to Lisbon on Friday', r: 'g', say: ['Gemma 4 31B', 'whole job, 2 of 2 tests'] },
  ],
};
/* two drawings of the same thing: side by side on a wide screen, top to bottom on a phone */
const WIDE = { name: 'wide', w: 1140, slots: 5, cardX: 0, cardW: 320, cardH: 58, cardGap: 14, top: 34, boxX: 460, boxW: 220, boxH: 168,
  rowX: 820, rowW: 320, rowH: 76, rowGap: 14 };
const NARROW = { name: 'narrow', w: 360, slots: 4, cardX: 26, cardW: 308, cardH: 52, cardGap: 10, top: 28, boxW: 220, boxH: 164,
  rowX: 26, rowW: 308, rowH: 72, rowGap: 10, trunkL: 12, trunkR: 352, trunkRd: 338 };
const NARROW_BELOW = 820;
/* How fast a dot cruises (the picture's own units a millisecond), the share of that speed it keeps as it leaves its card
   and reaches its model (EASE), how long the label names each request (LABEL_HOLD), at most how many dots are on their
   way (MAX_DOTS), how clear of one another dots stay on the way in (CLEAR_PX), how far apart they leave Understudy
   (EXIT_GAP), and how finely each line is sampled to look ahead along it (SAMPLES). */
const V_WIDE = 0.24, V_NARROW = 0.4, EASE = 0.45, LABEL_HOLD = 800, MAX_DOTS = 3, CLEAR_PX = 12, EXIT_GAP = 320, SAMPLES = 80;
// uneven gaps: usually a calm two to four seconds, but about four times in ten the next request sets off almost with it
const nextGap = () => (Math.random() < 0.4 ? 150 + Math.random() * 300 : 2400 + Math.random() * 2000);

const fit = (t, max) => {
  if (t.getComputedTextLength() <= max) return;
  let s = t.textContent;
  while (s.length > 3) {
    s = s.slice(0, -1);
    t.textContent = `${s.trimEnd()}…`;
    if (t.getComputedTextLength() <= max) return;
  }
};

function routingScene(svg, cfg, { reduce, isDark, stops, themed }) {
  const host = svg.parentNode;
  let P = PAL.light, L = null, G = null, cards = [], inPaths = [], inPts = [], outPaths = {}, rows = {}, ro = null, gTok = null;
  let running = false, visible = false, raf = 0, nextAt = 0, lastNow = 0, lastExit = -1e9, built = null, trips = [];
  const kc = (k) => k[P.kind];
  const speed = () => (L.name === 'narrow' ? V_NARROW : V_WIDE);
  const shade = (p, on) => { p.setAttribute('stroke', on ? P.active : p.dataset.base); p.setAttribute('stroke-width', on ? 1.6 : 1.3); };

  const fillCard = (i) => {
    const c = cards[i], req = cfg.pool[i % cfg.pool.length], k = KINDS[req.k], narrow = L.name === 'narrow';
    const x = L.cardX, y = c.y, ty = y + (narrow ? 19 : 22), by = y + (narrow ? 38 : 43);
    c.cc.appendChild(el('circle', { cx: x + 17, cy: ty - 3.4, r: 3.6, fill: kc(k) }));
    const tag = c.cc.appendChild(el('text', { x: x + 27, y: ty, class: 'mono', 'font-size': narrow ? 9 : 9.5, 'letter-spacing': '0.1em', fill: kc(k), 'font-weight': 600 }));
    tag.appendChild(el('tspan', {}, k.tag.toUpperCase()));
    if (req.tool) tag.appendChild(el('tspan', { dx: 8, fill: P.faint, 'font-weight': 400, 'letter-spacing': '0.02em' }, `${req.tool}()`));
    const body = c.cc.appendChild(el('text', { x: x + 17, y: by, fill: P.ink, 'font-size': narrow ? 12.5 : 13.5 }, req.text));
    fit(body, L.cardW - 32);
  };
  const setReadout = (req, animate) => {
    const k = KINDS[req.k];
    const [tag, main, sub] = ro.lines;
    tag.textContent = (req.sub ? `${k.short || k.tag} › ${req.sub}` : k.tag).toUpperCase();
    tag.setAttribute('fill', k.g);
    main.textContent = `→ ${req.say[0]}`;
    sub.textContent = req.say[1];
    for (const t of ro.lines) fit(t, G.box.w - 26);
    if (animate) {
      // the only thing in the box that changes: its words fade to the new request
      ro.g.style.transition = 'none'; ro.g.style.opacity = '0.15'; void ro.g.getBoundingClientRect(); ro.g.style.transition = ''; ro.g.style.opacity = '1';
    }
  };

  const build = () => {
    P = PAL[isDark() ? 'dark' : 'light'];
    const width = host.getBoundingClientRect().width;
    if (!width) { built = null; return; }
    L = width < NARROW_BELOW ? NARROW : WIDE;
    built = L.name;
    svg.dataset.lay = L.name;
    svg.textContent = '';
    cards = []; rows = {}; inPaths = []; outPaths = {}; trips = [];
    const m = cfg.models.length, narrow = L.name === 'narrow';
    const blockH = L.slots * L.cardH + (L.slots - 1) * L.cardGap;
    const rowsH = m * L.rowH + (m - 1) * L.rowGap;
    G = {};
    if (!narrow) {
      G.cy = L.top + blockH / 2;
      G.box = { x: L.boxX, y: G.cy - L.boxH / 2, w: L.boxW, h: L.boxH };
      G.rowY0 = G.cy - rowsH / 2;
      G.H = Math.max(L.top + blockH, G.rowY0 + rowsH) + 14;
    } else {
      const boxY = L.top + blockH + 38;
      G.box = { x: (L.w - L.boxW) / 2, y: boxY, w: L.boxW, h: L.boxH };
      G.cy = boxY + L.boxH / 2;
      G.rowY0 = boxY + L.boxH + 50;
      G.H = G.rowY0 + rowsH + 12;
    }
    svg.setAttribute('viewBox', `0 0 ${L.w} ${G.H}`);
    const gPaths = svg.appendChild(el('g', {}));
    gTok = svg.appendChild(el('g', {}));
    const gTop = svg.appendChild(el('g', {}));
    // the column names
    gTop.appendChild(el('text', { x: L.cardX, y: L.top - (narrow ? 12 : 14), class: 'mono', 'font-size': narrow ? 9.5 : 10.5, 'letter-spacing': '0.12em', fill: P.faint }, cfg.left.toUpperCase()));
    gTop.appendChild(el('text', { x: L.rowX, y: G.rowY0 - (narrow ? 12 : 14), class: 'mono', 'font-size': narrow ? 9.5 : 10.5, 'letter-spacing': '0.12em', fill: P.faint }, cfg.right.toUpperCase()));
    // the models, each with the kinds it answers and why
    cfg.models.forEach((mdl, j) => {
      const x = L.rowX, y = G.rowY0 + j * (L.rowH + L.rowGap), w = L.rowW, h = L.rowH;
      const g = gTop.appendChild(el('g', {}));
      const rehearse = mdl.tone === 'rehearse';
      g.appendChild(el('rect', { x, y, width: w, height: h, rx: 12, fill: rehearse ? P.cardSoft : P.card, stroke: rehearse ? P.pathD : P.line, 'stroke-dasharray': rehearse ? '5 4' : null }));
      const ny = y + (narrow ? 23 : 25);
      const name = g.appendChild(el('text', { x: x + 16, y: ny, fill: rehearse ? P.inkSoft : P.ink, 'font-size': narrow ? 14 : 15, 'font-weight': 700 }));
      name.appendChild(el('tspan', {}, mdl.name));
      name.appendChild(el('tspan', { dx: 7, fill: P.faint, 'font-weight': 400, 'font-size': narrow ? 11.5 : 12 }, mdl.maker));
      const tone = P[mdl.tone];
      const chipT = g.appendChild(el('text', { x: 0, y: ny - 1, class: 'mono', 'font-size': narrow ? 8.5 : 9, 'letter-spacing': '0.08em', fill: tone[1], 'font-weight': 600 }, mdl.chip.toUpperCase()));
      const cw = chipT.getComputedTextLength() + 16, cx0 = x + w - 12 - cw;
      chipT.setAttribute('x', cx0 + 8);
      g.insertBefore(el('rect', { x: cx0, y: ny - 14, width: cw, height: 19, rx: 9.5, fill: tone[0], stroke: tone[2], 'stroke-dasharray': tone[2] ? '3 3' : null }), chipT);
      let sx = x + 16;
      const sy = y + (narrow ? 44 : 48);
      for (const sv of mdl.serves) {
        const k = KINDS[sv.k];
        g.appendChild(el('circle', { cx: sx + 3.5, cy: sy - 4, r: 3.5, fill: kc(k) }));
        const t = g.appendChild(el('text', { x: sx + 12, y: sy, fill: P.ink2, 'font-size': narrow ? 12 : 12.5, 'font-weight': 500 }, sv.t || k.label));
        sx += 12 + t.getComputedTextLength() + 16;
      }
      const pr = g.appendChild(el('text', { x: x + 16, y: y + (narrow ? 62 : 67), fill: P.mut, 'font-size': narrow ? 11.5 : 12.5 }, mdl.proof));
      fit(pr, w - 32);
      rows[mdl.id] = { yr: y + h / 2 };
    });
    // the requests
    for (let i = 0; i < L.slots; i += 1) {
      const y = L.top + i * (L.cardH + L.cardGap);
      const g = gTop.appendChild(el('g', {}));
      g.appendChild(el('rect', { x: L.cardX, y, width: L.cardW, height: L.cardH, rx: 12, fill: P.card, stroke: P.line }));
      cards.push({ cc: g.appendChild(el('g', {})), y });
    }
    cards.forEach((c, i) => fillCard(i));
    // lines in: every request goes into Understudy
    const B = G.box;
    for (let i = 0; i < L.slots; i += 1) {
      const yc = L.top + i * (L.cardH + L.cardGap) + L.cardH / 2;
      let d;
      if (!narrow) { const x0 = L.cardX + L.cardW, x1 = B.x; d = `M${x0} ${yc} C ${x0 + 70} ${yc}, ${x1 - 70} ${G.cy}, ${x1} ${G.cy}`; }
      else { const t = L.trunkL, r = 8, yb = G.cy; d = `M${L.cardX} ${yc} H${t + r} Q${t} ${yc} ${t} ${yc + r} V${yb - r} Q${t} ${yb} ${t + r} ${yb} H${B.x}`; }
      const p = gPaths.appendChild(el('path', { class: 'rt-path', d, fill: 'none', stroke: P.path, 'stroke-width': 1.3 }));
      p.dataset.base = P.path;
      inPaths.push(p);
    }
    // each incoming line sampled once, so looking ahead along it costs nothing while the picture runs
    inPts = inPaths.map((q) => { const n = q.getTotalLength(); return Array.from({ length: SAMPLES + 1 }, (_, k) => q.getPointAtLength((n * k) / SAMPLES)); });
    // lines out: each route to its model, customer support through a second sorting point
    const viaYs = Object.values(cfg.routes).filter((r) => r.via).map((r) => rows[r.to].yr);
    const vy = viaYs.length ? viaYs.reduce((a, b) => a + b, 0) / viaYs.length : 0;
    const vx = B.x + B.w + 64;
    for (const [id, r] of Object.entries(cfg.routes)) {
      const yr = rows[r.to].yr;
      let d;
      if (!narrow) {
        const x0 = B.x + B.w, x1 = L.rowX;
        d = r.via ? `M${x0} ${G.cy} C ${x0 + 30} ${G.cy}, ${vx - 30} ${vy}, ${vx} ${vy} C ${vx + 40} ${vy}, ${x1 - 40} ${yr}, ${x1} ${yr}`
          : `M${x0} ${G.cy} C ${x0 + 70} ${G.cy}, ${x1 - 70} ${yr}, ${x1} ${yr}`;
      } else {
        const t = r.dashed ? L.trunkRd : L.trunkR, rr = 8, yb = G.cy;
        d = `M${B.x + B.w} ${yb} H${t - rr} Q${t} ${yb} ${t} ${yb + rr} V${yr - rr} Q${t} ${yr} ${t - rr} ${yr} H${L.rowX + L.rowW}`;
      }
      const base = r.dashed ? P.pathD : P.path;
      const p = gPaths.appendChild(el('path', { class: 'rt-path', d, fill: 'none', stroke: base, 'stroke-width': 1.3, 'stroke-dasharray': r.dashed ? '5 5' : null }));
      p.dataset.base = base;
      outPaths[id] = p;
    }
    if (viaYs.length && !narrow) {
      gTop.appendChild(el('circle', { cx: vx, cy: vy, r: 12, fill: P.node, stroke: P.nodeLine, 'stroke-width': 1.3 }));
      gTop.appendChild(el('path', { d: `M${vx - 5} ${vy} h4 M${vx - 1} ${vy} l5 -4 M${vx - 1} ${vy} l5 4`, fill: 'none', stroke: P.nodeIcon, 'stroke-width': 1.4, 'stroke-linecap': 'round' }));
      gTop.appendChild(el('text', { x: vx, y: vy + 30, 'text-anchor': 'middle', class: 'mono', 'font-size': 9, 'letter-spacing': '0.1em', fill: P.faint }, 'BY QUESTION'));
    }
    // Understudy, in the middle, naming the request it is routing
    gTop.appendChild(el('rect', { x: B.x, y: B.y, width: B.w, height: B.h, rx: 16, fill: P.box, stroke: P.boxLine }));
    const cx = B.x + B.w / 2, s = 0.95, uy = B.y + 36;
    gTop.appendChild(el('path', { d: `M${cx - 11 * s} ${uy - 15 * s} v${17.5 * s} a${11 * s} ${11 * s} 0 0 0 ${22 * s} 0 V${uy - 15 * s}`, fill: 'none', stroke: '#ffffff', 'stroke-width': 7 * s, 'stroke-linecap': 'round' }));
    gTop.appendChild(el('text', { x: cx, y: B.y + 72, 'text-anchor': 'middle', class: 'mono', fill: '#ffffff', 'font-size': 10, 'letter-spacing': '0.12em' }, 'UNDERSTUDY'));
    gTop.appendChild(el('line', { x1: B.x + 20, y1: B.y + 86, x2: B.x + B.w - 20, y2: B.y + 86, stroke: P.divider, 'stroke-width': 1 }));
    const rg = gTop.appendChild(el('g', { class: 'rt-ro' }));
    ro = { g: rg, lines: [
      rg.appendChild(el('text', { x: cx, y: B.y + 108, 'text-anchor': 'middle', class: 'mono', 'font-size': 9.5, 'letter-spacing': '0.08em', 'font-weight': 600 })),
      rg.appendChild(el('text', { x: cx, y: B.y + 131, 'text-anchor': 'middle', fill: '#ffffff', 'font-size': 15, 'font-weight': 600 })),
      rg.appendChild(el('text', { x: cx, y: B.y + 151, 'text-anchor': 'middle', fill: '#a3a9b6', 'font-size': 11.5 })),
    ] };
    setReadout(cfg.pool[0], false);
  };

  /* a request travels in along its line, through Understudy (unseen behind it, and quicker), and out to its model */
  const ease = (t) => EASE * t + (1 - EASE) * t * t;
  const easeOut = (t) => 1 - (EASE * (1 - t) + (1 - EASE) * (1 - t) * (1 - t));
  const dotR = () => (L.name === 'narrow' ? 3 : 3.4);
  // a line darkens by a shade while any dot is on it, and settles back when the last one leaves
  const shadeCount = new Map();
  const shadeOn = (p) => { const n = (shadeCount.get(p) || 0) + 1; shadeCount.set(p, n); if (n === 1) shade(p, true); };
  const shadeOff = (p) => { const n = (shadeCount.get(p) || 1) - 1; if (n <= 0) { shadeCount.delete(p); shade(p, false); } else shadeCount.set(p, n); };
  /* the label names each request as it reaches Understudy. Requests arriving together take turns, a moment each, so it
     never flickers, and one whose dot has already landed is skipped rather than named late */
  const label = { at: -1e9, queue: [] };
  const showNext = (now) => {
    while (label.queue.length && label.queue[0].done) label.queue.shift();
    if (!label.queue.length || now - label.at < LABEL_HOLD) return;
    setReadout(label.queue.shift().req, true);
    label.at = now;
  };
  const place = (f) => {
    const pt = f.p.getPointAtLength(Math.max(0, Math.min(f.len, f.s)));
    f.dot.setAttribute('cx', pt.x.toFixed(1));
    f.dot.setAttribute('cy', pt.y.toFixed(1));
  };
  const fire = (now, slot) => {
    const req = cfg.pool[slot % cfg.pool.length];
    const p = inPaths[slot], len = p.getTotalLength();
    shadeOn(p);
    const f = { slot, req, phase: 'in', p, len, s: 0, t0: now, dur: ((2 - EASE) * len) / speed(),
      dot: gTok.appendChild(el('circle', { r: dotR(), fill: kc(KINDS[req.k]), opacity: 0.95 })) };
    place(f);
    trips.push(f);
  };
  /* Would a request from this card keep clear of every dot already on its way in? On a phone the lines share a trunk,
     and everywhere they meet at the box, so two dots could otherwise run into one another and read as one blob. */
  const ptIn = (slot, u) => inPts[slot][Math.round(Math.max(0, Math.min(1, u)) * SAMPLES)];
  const clearRun = (slot, now) => {
    const others = trips.filter((f) => f.phase === 'in');
    if (!others.length) return true;
    const dur = ((2 - EASE) * inPaths[slot].getTotalLength()) / speed();
    for (let dt = 0; dt <= dur + 24; dt += 24) {
      const a = ptIn(slot, ease(Math.min(1, dt / dur)));
      for (const f of others) {
        const t = (now + dt - f.t0) / f.dur;
        if (t >= 1) continue;
        const b = ptIn(f.slot, ease(t));
        if (Math.hypot(a.x - b.x, a.y - b.y) < CLEAR_PX) return false;
      }
    }
    return true;
  };
  /* Which request goes next: any not already on its way, preferring one bound for a model no other dot is heading to,
     so requests that set off together fan out, and only from a card with a clear run in. */
  const pickSlot = (now) => {
    const busy = new Set(trips.map((f) => f.slot));
    const headed = new Set(trips.map((f) => cfg.routes[f.req.r].to));
    const free = [...Array(L.slots).keys()].filter((i) => !busy.has(i));
    if (!free.length) return -1;
    const fresh = free.filter((i) => !headed.has(cfg.routes[cfg.pool[i % cfg.pool.length].r].to));
    const from = (fresh.length ? fresh : free).filter((i) => clearRun(i, now));
    if (!from.length) return -1;
    return from[Math.floor(Math.random() * from.length)];
  };
  const step = (now) => {
    if (!running) return;
    // a long gap between frames (a tab in the background) is a pause, not time that passed
    if (lastNow && now - lastNow > 250) {
      const skip = now - lastNow - 16;
      for (const f of trips) f.t0 += skip;
      nextAt += skip;
      label.at += skip;
      lastExit += skip;
    }
    lastNow = now;
    if (now >= nextAt) {
      if (trips.length < MAX_DOTS) {
        const slot = pickSlot(now);
        // no card has a clear run just now: try again in a moment rather than drop this request
        if (slot >= 0) { fire(now, slot); nextAt = now + nextGap(); } else nextAt = now + 90;
      } else {
        nextAt = now + 200;
      }
    }
    const B = G.box;
    for (const f of [...trips]) {
      const t = Math.min(1, Math.max(0, (now - f.t0) / f.dur));
      if (f.phase === 'in') {
        f.s = ease(t) * f.len;
        place(f);
        if (t >= 1) {
          shadeOff(f.p);
          label.queue.push(f);
          // the unseen crossing behind Understudy is quicker, so the picture never seems to stop
          f.phase = 'through'; f.t0 = now; f.dur = B.w / (speed() * 2);
          f.dot.setAttribute('cx', B.x);
          f.dot.setAttribute('cy', G.cy);
        }
      } else if (f.phase === 'through') {
        // out of sight behind the box; if another dot has only just come out, this one waits here so they leave apart
        f.dot.setAttribute('cx', (B.x + (B.w - 8) * t).toFixed(1));
        if (t >= 1 && now - lastExit >= EXIT_GAP) {
          lastExit = now;
          const p = outPaths[f.req.r];
          f.phase = 'out'; f.p = p; f.len = p.getTotalLength(); f.s = 0; f.t0 = now; f.dur = ((2 - EASE) * f.len) / speed();
          shadeOn(p);
          place(f);
        }
      } else {
        f.s = easeOut(t) * f.len;
        place(f);
        if (t >= 1) {
          shadeOff(f.p);
          f.dot.remove();
          f.done = true;
          trips.splice(trips.indexOf(f), 1);
        }
      }
    }
    showNext(now);
    raf = requestAnimationFrame(step);
  };
  const start = () => {
    if (running || reduce || !built) return;
    running = true;
    lastNow = 0;
    nextAt = performance.now() + 400;
    raf = requestAnimationFrame(step);
  };
  const stop = () => {
    if (!running) return;
    running = false;
    cancelAnimationFrame(raf);
    for (const f of trips) f.dot.remove();
    trips = [];
    for (const q of shadeCount.keys()) shade(q, false);
    shadeCount.clear();
    label.queue = [];
  };
  const rebuild = () => { const was = running; stop(); build(); if (was || visible) start(); };

  build();
  themed.push(rebuild);
  if ('ResizeObserver' in window) {
    const rz = new ResizeObserver(() => {
      const width = host.getBoundingClientRect().width;
      const want = !width ? null : (width < NARROW_BELOW ? 'narrow' : 'wide');
      if (want !== built) rebuild();
    });
    rz.observe(host);
    stops.push(() => rz.disconnect());
  }
  let live = true;
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (live && built) rebuild(); });
  if (!reduce && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver((es) => {
      visible = es.some((e) => e.isIntersecting);
      if (visible) start(); else stop();
    }, { threshold: 0.01 });
    io.observe(svg);
    stops.push(() => io.disconnect());
  }
  stops.push(() => { live = false; stop(); svg.textContent = ''; });
}

/* ---------- step 1: a real switch, replayed line by line, again and again ---------- */
const TERM = [
  ['<span class="p">understudy</span> watching tool-initialization-setup', 700],
  ['<span class="mut">trying</span> <span class="hi">google/gemma-4-31b-it</span> <span class="mut">on 108 of your requests</span>', 900],
  ['<span class="ok">✓</span> matched 108 of 108 · 0.7 s <span class="mut">(GPT-5.4 1.6 s)</span> · 92% cheaper', 1100],
  ['<span class="mut">second look on 100 requests it has never seen</span>', 900],
  ['<span class="ok">✓</span> matched 100 of 100', 900],
  ['<span class="mut">rolling out</span> 5% → 25% → all', 1000],
  ['<span class="ok">✓</span> switched · <span class="mut">checked daily against GPT-5.4</span>', 2600],
];

export function startSiteMotion(root) {
  if (!root) return { stop() {}, retheme() {} };
  const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const isDark = () => root.closest('[data-mode]')?.dataset.mode === 'dark';
  const stops = [];     // every loop, watcher and timer started here, undone when the page goes
  const themed = [];    // what draws in the page's colours, drawn again when the theme changes
  /* Every part is complete at rest. When one first comes into view it replays its motion once, from its starting point. */
  const onSeen = (node, fn, threshold = 0.3) => {
    if (!node || reduce) return;
    if (!('IntersectionObserver' in window)) { fn(); return; }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); fn(); } }, { threshold });
    io.observe(node);
    stops.push(() => io.disconnect());
  };
  const replay = (node, cls) => {
    node.classList.add('no-anim', cls);
    void node.getBoundingClientRect();
    node.classList.remove('no-anim');
    requestAnimationFrame(() => requestAnimationFrame(() => node.classList.remove(cls)));
  };
  // keeps a loop running only while its element is on the screen
  const whileVisible = (node, start, stop) => {
    if (reduce || !('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) start(); else stop(); }, { threshold: 0.01 });
    io.observe(node);
    stops.push(() => { io.disconnect(); stop(); });
  };

  /* the orb */
  const cv = root.querySelector('#orbK');
  if (cv && cv.getContext) {
    const ctx = cv.getContext('2d');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let W = 0, H = 0, s = null, raf = 0, running = false, lastW = -1;
    const t0 = performance.now();
    const size = () => {
      const r = cv.getBoundingClientRect();
      if (!r.width) return;
      W = r.width; H = r.height; lastW = r.width;
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      s = ORB.init(W, H, dpr);
    };
    const draw = (t) => { if (s) ORB.frame(ctx, W, H, t, s, isDark()); };
    const frame = (now) => { draw((now - t0) / 1000); if (running) raf = requestAnimationFrame(frame); };
    size();
    draw(0.6);
    themed.push(() => { if (!running) draw((performance.now() - t0) / 1000); });
    if ('ResizeObserver' in window) {
      const rz = new ResizeObserver(() => {
        const r = cv.getBoundingClientRect();
        if (Math.abs(r.width - lastW) > 4) { size(); draw((performance.now() - t0) / 1000); }
      });
      rz.observe(cv);
      stops.push(() => rz.disconnect());
    }
    whileVisible(cv, () => { if (!running) { running = true; raf = requestAnimationFrame(frame); } },
      () => { running = false; cancelAnimationFrame(raf); });
  }

  /* step 1: the whole log shows until the terminal comes into view, then it types itself out, again and again */
  const term = root.querySelector('#termK');
  if (term) {
    const caret = () => { const c = document.createElement('span'); c.className = 't-caret'; return c; };
    term.innerHTML = TERM.map(([h]) => `<div class="t-line">${h}</div>`).join('');
    term.lastElementChild.appendChild(caret());
    if (!reduce) {
      let n = 0, timer = 0;
      const next = () => {
        if (n === 0) term.innerHTML = '';
        const [html, wait] = TERM[n];
        const line = document.createElement('div');
        line.className = 't-line';
        line.innerHTML = html;
        const old = term.querySelector('.t-caret'); if (old) old.remove();
        line.appendChild(caret());
        term.appendChild(line);
        n = (n + 1) % TERM.length;
        timer = setTimeout(next, n === 0 ? wait + 1400 : wait);
      };
      onSeen(term, next, 0.25);
      stops.push(() => clearTimeout(timer));
    }
  }

  /* step 2 */
  const route = root.querySelector('svg.rt');
  if (route) routingScene(route, ROUTING, { reduce, isDark, stops, themed });

  /* the guides: requests travel their arrows while a picture is on the screen, and bars and lines draw in the first time
     it is seen */
  root.querySelectorAll('svg.gd').forEach((svg) => {
    const paths = [...svg.querySelectorAll('.d-flow')];
    if (!paths.length || reduce) return;
    const layer = svg.appendChild(el('g', {}));
    stops.push(() => layer.remove());
    let raf = 0, running = false, flying = [], nextAt = 0, turn = 0;
    const tick = (now) => {
      if (!running) return;
      if (now >= nextAt) {
        const p = paths[turn % paths.length];
        turn += 1;
        flying.push({ p, len: p.getTotalLength(), t0: now, dot: layer.appendChild(el('circle', { r: 3.8, class: p.dataset.dot || 'c-accfill' })) });
        nextAt = now + 760;
      }
      flying = flying.filter((f) => {
        const t = Math.min(1, (now - f.t0) / 1150);
        const e = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
        const pt = f.p.getPointAtLength(f.len * e);
        f.dot.setAttribute('cx', pt.x.toFixed(1));
        f.dot.setAttribute('cy', pt.y.toFixed(1));
        if (t >= 1) { f.dot.remove(); return false; }
        return true;
      });
      raf = requestAnimationFrame(tick);
    };
    whileVisible(svg, () => { if (!running) { running = true; nextAt = 0; raf = requestAnimationFrame(tick); } },
      () => { running = false; cancelAnimationFrame(raf); flying.forEach((f) => f.dot.remove()); flying = []; });
  });
  root.querySelectorAll('.g-fig').forEach((n) => { if (n.querySelector('.d-draw, .d-grow')) onSeen(n, () => replay(n, 'pre'), 0.35); });

  return {
    stop: () => { stops.splice(0).reverse().forEach((f) => f()); themed.length = 0; },
    retheme: () => themed.forEach((f) => f()),
  };
}
