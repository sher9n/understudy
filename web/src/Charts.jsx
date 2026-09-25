import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { usd } from './money.js';

/* The charts are drawn at the width they are given.
 *
 * They used to be drawn once, 980 units wide, and scaled to fit, which on a phone shrank every
 * word on them to a third of its size: axis labels of three pixels, a legend nobody could read.
 * Now each one measures the box it sits in and draws itself to that width, so a label set at ten
 * pixels is ten pixels on a phone as on a desk, and a narrow chart simply has fewer marks on it. */
export function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const read = () => setW(Math.round(el.getBoundingClientRect().width));
    read();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Below this width a chart is drawn in its narrow form. */
export const NARROW = 560;

/* The spend chart's frame for a given width: how tall, and how much room the labels get. */
function spendFrame(width) {
  const W = width > 0 ? width : 980;
  const narrow = W < NARROW;
  return {
    W,
    narrow,
    H: narrow ? 240 : Math.round(Math.min(408, Math.max(300, W * 0.42))),
    L: narrow ? 56 : 74,
    R: narrow ? 12 : 22,
    T: narrow ? 16 : 26,
    B: narrow ? 42 : 62,
  };
}

// en-GB already abbreviates September as Sept, so appending one gave "Septt"
const dlab = (ms) => new Date(ms).toLocaleDateString('en-GB',
  { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });


/* The day the pointer is over, as a whole date. The axis only labels four days, so the
   tooltip has to say which one this is rather than leaving somebody counting gridlines.
   Named in IST, because which day a call lands on depends on the clock you read it by. */
const dfull = (ms) => new Date(ms).toLocaleDateString('en-GB',
  { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

/* Which days get a date under the axis: the first, the last and one or two between, fewer on a
   narrow chart so the dates never run into each other. */
const markDays = (n, narrow) => (n < 12 || narrow
  ? [...new Set([0, n >> 1, n - 1])]
  : [0, Math.floor(n / 3), Math.floor((2 * n) / 3), n - 1]);

/** Daily spend, with what the same traffic would have cost on the customer's own models. */
export function SpendChart({ series }) {
  const n = series.length;
  const [box, width] = useWidth();
  const [at, setAt] = useState(null);
  const frame = spendFrame(width);
  const { W, H, R, T, B, narrow } = frame;
  const top = n ? Math.max(...series.map((d) => Math.max(d.paid, d.would)), 0.02) : 0.02;
  const max = niceTop(top);
  const ticks = [0, max / 4, max / 2, (max * 3) / 4, max];
  // room on the left for the widest price on the axis, written the way every price is
  const L = Math.max(frame.L, Math.ceil(14 + 6.1 * Math.max(...ticks.map((v) => usd(v).length))));

  /* Which day is under the pointer. The drawing's own units are put back from the pointer's
     position on the screen, which works whatever width the chart is drawn at. */
  const pick = useCallback((clientX) => {
    const el = box.current;
    if (!el || !n) return;
    const r = el.getBoundingClientRect();
    if (!r.width) return;
    const x = ((clientX - r.left) / r.width) * W;
    const span = (W - L - R) / Math.max(1, n - 1);
    const i = Math.round((x - L) / span);
    setAt(Math.max(0, Math.min(n - 1, i)));
  }, [n, W, L, R, box]);

  const step = (by) => setAt((cur) => {
    const next = (cur === null ? n - 1 : cur) + by;
    return Math.max(0, Math.min(n - 1, next));
  });

  if (!n) return <div className="chartwrap" ref={box} />;
  const px = (i) => L + (i * (W - L - R)) / Math.max(1, n - 1);
  const py = (v) => H - B - (v / max) * (H - B - T);
  const path = (key) => series.map((d, i) => `${px(i).toFixed(1)} ${py(d[key]).toFixed(1)}`).join(' L');
  const marks = markDays(n, narrow);

  const day = at === null ? null : series[at];
  /* On a narrow chart the card reading a day spans the top of the chart, rather than sitting
     beside the day and running off the side of the screen. */
  const tipStyle = narrow ? undefined : { left: `${(px(at ?? 0) / W) * 100}%` };
  const tipClass = narrow ? 'charttip wide' : `charttip${px(at ?? 0) > W * 0.62 ? ' left' : ''}`;

  return (
    <div className="chartwrap" ref={box}
      onPointerMove={(e) => pick(e.clientX)}
      onPointerLeave={() => setAt(null)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
        else if (e.key === 'Escape') setAt(null);
      }}
      onFocus={() => setAt((cur) => (cur === null ? n - 1 : cur))}
      onBlur={() => setAt(null)}
      tabIndex={0}
      role="group"
      aria-label="Daily spend. Use the left and right arrow keys to read each day.">
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img"
      aria-label="Daily spend over the window, as a solid line, against what the same traffic would have cost on your own models, dashed.">
      {ticks.map((v) => (
        <g key={v}>
          <line x1={L} y1={py(v)} x2={W - R} y2={py(v)} stroke="var(--line)" strokeWidth="1" />
          <text x={L - 9} y={py(v) + 3.5} className="m" textAnchor="end" fontSize="10" fill="var(--mut)">{usd(v)}</text>
        </g>
      ))}
      <path d={`M${path('would')}`} fill="none" stroke="var(--line-strong)" strokeWidth="2" strokeDasharray="6 5" />
      <path d={`M${px(0).toFixed(1)} ${py(0).toFixed(1)} L${path('paid')} L${px(n - 1).toFixed(1)} ${py(0).toFixed(1)} Z`}
        fill="var(--brand)" opacity="0.10" />
      <path d={`M${path('paid')}`} fill="none" stroke="var(--brand)" strokeWidth="2.4" strokeLinejoin="round" />
      <line x1={L} y1={py(0)} x2={W - R} y2={py(0)} stroke="var(--line-strong)" strokeWidth="1.2" />
      {marks.map((i, k) => (
        <text key={i} x={px(i)} y={H - B + 20} className="m" fontSize="10.5" fill="var(--mut)"
          textAnchor={k === 0 ? 'start' : k === marks.length - 1 ? 'end' : 'middle'}>{dlab(series[i].at)}</text>
      ))}
      {day && (
        <g pointerEvents="none">
          <line x1={px(at)} y1={T - 6} x2={px(at)} y2={py(0)} stroke="var(--line-strong)" strokeWidth="1" />
          {/* the ring is the panel colour, so the dot reads on top of the line it sits on */}
          <circle cx={px(at)} cy={py(day.would)} r="4.5" fill="var(--line-strong)"
            stroke="var(--raise)" strokeWidth="2" />
          <circle cx={px(at)} cy={py(day.paid)} r="5" fill="var(--brand)"
            stroke="var(--raise)" strokeWidth="2" />
        </g>
      )}
    </svg>
    {day && (
      <div className={tipClass} style={tipStyle} aria-live="polite">
        <div className="tipday">{dfull(day.at)}</div>
        <div className="tiprow"><span className="tipkey"><i className="tipdot paid" />What you paid</span>
          <span className="tipval">{usd(day.paid)}</span></div>
        <div className="tiprow"><span className="tipkey"><i className="tipdot would" />On your own models</span>
          <span className="tipval">{usd(day.would)}</span></div>
      </div>
    )}
    </div>
  );
}

/* Where each model's name goes.
 *
 * Beside its own dot, on the right if there is room and on the left if not. When both are
 * taken it moves a line down or up, in widening steps, with a short line back to its dot. A
 * name never covers another name, another model's dot, the axis or the words marking the
 * bar. It used to fall back to the first spot it had tried when nothing was free, on top of
 * whatever was already there, which is how two names came to be printed over each other.
 *
 * When there is truly no clean spot, as there is not with twenty models packed into one
 * price band, the name is left off rather than printed over another: the dot is still
 * there, still tells you its name when you point at it, and the table below lists it.
 * Names are placed by how much they matter, so the ones left off are never yours or one
 * that cleared the bar while there was room for them: your model first, then everything
 * that cleared, then anything close, then the rest. */
const LINE = 15;
const DROPS = [0, LINE, -LINE, 2 * LINE, -2 * LINE, 3 * LINE, -3 * LINE, 4 * LINE, -4 * LINE];
const RANK = { reference: 0, cleared: 1, review: 2 };

function placed(points, px, py, area, avoid) {
  const dots = points.map((r) => ({ r, x: px(r.costMonth), y: py(r.gap) }));
  const taken = [...avoid];
  const out = [];
  const order = [...dots].sort((a, b) => (RANK[a.r.verdict] ?? 3) - (RANK[b.r.verdict] ?? 3)
    || a.x - b.x || a.y - b.y);
  for (const d of order) {
    // JetBrains Mono at 11px advances 6.6px a letter; the rest keeps two names apart
    const w = 6.6 * nameOf(d.r).length + 4;
    const base = d.y + 3.5;   // the baseline that centres a line of text on its dot
    let best = null;
    for (const drop of DROPS) {
      for (const right of [true, false]) {
        const l = right ? d.x + 11 : d.x - 11 - w;
        const box = { l, r: l + w, t: base + drop - 10, b: base + drop + 3 };
        if (box.l < area.l || box.r > area.r || box.t < area.t || box.b > area.b) continue;
        if (taken.some((t) => overlap(box, t) > 0)) continue;
        if (dots.some((o) => o !== d && overlap(box, { l: o.x - 8, r: o.x + 8, t: o.y - 8, b: o.y + 8 }) > 0)) continue;
        best = { box, right, drop };
        break;
      }
      if (best) break;
    }
    if (!best) { out.push({ r: d.r, x: d.x, y: d.y, hidden: true }); continue; }
    taken.push(best.box);
    out.push({ r: d.r, x: d.x, y: d.y, lx: best.right ? d.x + 11 : d.x - 11, ly: base + best.drop,
      right: best.right, drop: best.drop, hidden: false });
  }
  // back into left-to-right order, which is the order the arrow keys step through them
  return out.sort((a, b) => a.x - b.x || a.y - b.y);
}

const overlap = (a, b) => Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l))
  * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));

function niceTop(v) {
  const pow = 10 ** Math.floor(Math.log10(v));
  /* 0.4 / 0.1 is 4.000000000000001 in floating point, which made a top of 0.4 round up to
     0.8 and left half the axis empty; a hair of tolerance lets a value that is already a
     round top stay one. */
  const n = v / pow - 1e-9;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 4 ? 4 : n <= 8 ? 8 : 10) * pow;
}

/** Waiting for a first full day, drawn as an axis rather than a fake line. */
export function WaitingChart({ message }) {
  const [box, width] = useWidth();
  const { W, H, L, R, T, B, narrow } = spendFrame(width);
  return (
    <div ref={box}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={message}>
        {[0, 1, 2, 3, 4].map((k) => (
          <line key={k} x1={L} y1={T + (k * (H - B - T)) / 4} x2={W - R} y2={T + (k * (H - B - T)) / 4}
            stroke="var(--line)" strokeWidth="1" />
        ))}
        <line x1={L} y1={H - B} x2={W - R} y2={H - B} stroke="var(--line-strong)" strokeWidth="1.2" />
        {!narrow && (
          <text x={(L + W - R) / 2} y={(T + H - B) / 2 + 4} textAnchor="middle" fontSize="13" fill="var(--mut-read)">{message}</text>
        )}
      </svg>
      {/* On a phone the sentence would not fit on one line of a drawing, so it is written under it. */}
      {narrow && <p className="waitnote">{message}</p>}
    </div>
  );
}

const shortModel = (m) => String(m).split('/').pop();
/* What a dot is called: a model by its own name, and a strategy by its short name, because
   "cascade:vendor/x" cut at its last slash reads exactly like the plain model beside it. */
const nameOf = (r) => r.name?.short || shortModel(r.model);
