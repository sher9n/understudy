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

/* Every model tried, placed by what it costs and how far it drifted. Under the line passed.
   The frame for a given width: a narrow chart keeps the words about the bar inside the plot
   rather than in a margin of their own, which on a phone would have taken half the width. */
function candFrame(width) {
  const CW = width > 0 ? width : 980;
  const narrow = CW < NARROW;
  return {
    CW,
    narrow,
    CH: narrow ? 300 : 400,
    CL: narrow ? 42 : 64,
    CR: narrow ? 12 : 168,
    CT: 34,
    CB: narrow ? 50 : 56,
  };
}

/* The models the chart can place: every one the measurement judged, and the model the bar
   came from. The page asks this too, before deciding whether to draw the chart at all, so
   the two can never disagree about whether there is anything to show. */
export function chartPoints(results, reference, referenceCostMonth) {
  /* This used to keep only models with a hundred runs or more, a number left over from when
     every measurement replayed 120 calls. Samples are now sized to the workload, ten to a
     hundred, so a workload of 22 calls is measured on 11 of them, and every model it tried
     was filtered out, leaving an empty box above a table full of results. The verdict
     already knows which runs were enough to judge, so the chart trusts it rather than
     keeping a threshold of its own. */
  /* A model that never answered has no disagreement to place, and one dropped part way through
     has only a partial one, so neither is drawn; both are in the table with the reason. */
  const tried = (results || []).filter((r) => r.costMonth !== null && r.gap !== null
    && r.runs > 0 && r.verdict !== 'insufficient' && r.verdict !== 'failed' && !r.stopped);
  /* The model the bar came from belongs on the picture: it is the thing every candidate
     is being compared against, and what it costs is the whole argument. */
  if (referenceCostMonth === null || referenceCostMonth === undefined) return tried;
  return [...tried, { model: reference || 'your model', gap: 0, costMonth: referenceCostMonth, verdict: 'reference' }];
}

const shortModel = (m) => String(m).split('/').pop();
/* What a dot is called: a model by its own name, and a strategy by its short name, because
   "cascade:vendor/x" cut at its last slash reads exactly like the plain model beside it. */
const nameOf = (r) => r.name?.short || shortModel(r.model);
const isStrategy = (r) => !!r.name && r.name.kind !== 'model';

/* What a dot means, in the same words the table under the chart uses. */
const RESULT = {
  reference: 'Your model', cleared: 'Cleared', review: 'Needs review', missed: 'Missed the bar',
  slower: 'Slower than yours',
};

export function CandidateChart({ results, floor, reference, referenceCostMonth }) {
  const [at, setAt] = useState(null);
  const [box, width] = useWidth();
  const points = chartPoints(results, reference, referenceCostMonth);
  if (points.length < 2) return <div ref={box} />;
  const { CW, CH, CL, CR, CT, CB, narrow } = candFrame(width);
  const x = costScale(points.map((p) => p.costMonth), CL, CW - CR);
  // keep the bar visible without squashing every candidate onto the baseline
  const ymax = niceTop(Math.max(...points.map((p) => p.gap), floor * 1.6, 1));
  const px = x.at;
  const py = (v) => CH - CB - (v / ymax) * (CH - CB - CT);
  const yticks = [0, ymax / 4, ymax / 2, (ymax * 3) / 4, ymax];
  /* A model that matched but was too slow is drawn in the same colour the table gives it: it
     can sit under the bar, because its answers were close enough, and red there read as a
     contradiction of the line it sits under. */
  const tone = (r) => (r.model === reference || r.verdict === 'reference' ? 'cur'
    : r.verdict === 'cleared' ? 'pass' : r.verdict === 'review' || r.verdict === 'slower' ? 'near' : 'fail');
  const colour = { cur: 'var(--mut)', pass: 'var(--brand)', near: 'var(--warn)', fail: 'var(--bad)' };

  const barText = `YOUR BAR · ${floor.toFixed(2)}%`;
  /* Where the words marking the bar go: in their own margin on a wide chart, and just above the
     line at its right-hand end on a narrow one, where the margin would have eaten the plot. */
  const barAt = narrow
    ? { x: CW - CR - 2, y: py(floor) - 6, anchor: 'end' }
    : { x: CW - CR + 10, y: py(floor) + 3.5, anchor: 'start' };
  const barBox = narrow
    ? { l: barAt.x - 6.2 * barText.length, r: barAt.x + 2, t: barAt.y - 10, b: barAt.y + 3 }
    : { l: CW - CR + 8, r: CW - CR + 12 + 6.2 * barText.length, t: py(floor) - 8, b: py(floor) + 8 };
  /* Where names may go: inside the plot, clear of the title above it and the prices below
     it, and never over the words that say where the bar is. */
  const area = { l: CL - 2, r: CW - 4, t: CT - 8, b: py(0) + 8 };
  const labels = placed(points, px, py, area, [barBox]);
  const named = labels.filter((l) => !l.hidden);
  const unnamed = labels.length - named.length;
  // the dot being read, by pointer or by the arrow keys; kept in range if the data changes
  const cur = at === null ? null : labels[Math.min(at, labels.length - 1)];
  const step = (by) => setAt((i) => Math.max(0, Math.min(labels.length - 1, (i === null ? -1 : i) + by)));
  const refName = String(narrow ? shortModel(reference || 'your model') : (reference || 'your model')).toUpperCase();

  return (
    <div className="chartwrap" ref={box} tabIndex={0} role="group"
      aria-label="Every model tried. Point at a dot, or use the left and right arrow keys, to read what it is."
      onPointerLeave={() => setAt(null)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
        else if (e.key === 'Escape') setAt(null);
      }}
      /* only a keyboard arriving opens the first card; a click on empty chart must not
         pop up a model the pointer is nowhere near */
      onFocus={(e) => { if (e.currentTarget.matches(':focus-visible')) setAt((i) => (i === null ? 0 : i)); }}
      onBlur={() => setAt(null)}>
    <svg viewBox={`0 0 ${CW} ${CH}`} width="100%" role="img"
      aria-label={`Every model tested, placed by cost a month and how far it drifted. Anything below the dashed line answered within your bar, and a model marked slower did so but took too long.${x.log ? ' Cost is drawn in steps of ten, so each price marked along the bottom is ten times the one before it.' : ''}`}>
      {yticks.map((v) => (
        <g key={v}>
          <line x1={CL} y1={py(v)} x2={CW - CR} y2={py(v)} stroke="var(--line)" strokeWidth="1" />
          {/* a step of 2.5 is written 2.5%: rounded to "3%" it sat just under a bar of 3.00% */}
          <text x={CL - 8} y={py(v) + 3.5} className="m" textAnchor="end" fontSize="10" fill="var(--mut)">
            {Number.isInteger(Math.round(v * 1000) / 1000) ? v.toFixed(0) : v.toFixed(1)}%
          </text>
        </g>
      ))}
      <rect x={CL} y={py(floor)} width={CW - CL - CR} height={py(0) - py(floor)} fill="var(--brand)" opacity="0.07" />
      <line x1={CL} y1={py(floor)} x2={CW - CR} y2={py(floor)} stroke="var(--brand)" strokeWidth="1.6" strokeDasharray="6 5" />
      <text x={barAt.x} y={barAt.y} textAnchor={barAt.anchor} className="m" fontSize="10" fontWeight="700" fill="var(--brand)"
        stroke="var(--raise)" strokeWidth={narrow ? 3.6 : 0} paintOrder="stroke" strokeLinejoin="round">
        {barText}
      </text>
      <line x1={CL} y1={py(0)} x2={CW - CR} y2={py(0)} stroke="var(--line-strong)" strokeWidth="1.2" />
      {x.ticks.map((v, k) => (
        <g key={v}>
          <line x1={px(v)} y1={py(0)} x2={px(v)} y2={py(0) + 5} stroke="var(--line-strong)" strokeWidth="1" />
          <text x={px(v)} y={CH - CB + 20} className="m" fontSize="10" fill="var(--mut)"
            textAnchor={narrow && k === 0 ? 'start' : narrow && k === x.ticks.length - 1 ? 'end' : 'middle'}>
            {x.label(v)}
          </text>
        </g>
      ))}
      <text x={CL} y={CT - 12} className="m" fontSize="10" fontWeight="700" fill="var(--mut)">
        {narrow ? `DISAGREEMENT WITH ${refName}` : `DISAGREEMENT WITH ${refName}, THE MODEL YOUR BAR CAME FROM`}
      </text>
      <text x={CW - CR} y={CH - CB + (narrow ? 38 : 42)} className="m" fontSize="10" fontWeight="700" fill="var(--mut)" textAnchor="end">
        {x.log ? (narrow ? 'COST A MONTH, EACH STEP ×10' : 'COST A MONTH, EACH STEP TEN TIMES THE ONE BEFORE') : 'COST A MONTH'}
      </text>
      {/* Drawn in three passes, so nothing is ever painted over something drawn for another
          model: the lines back to a dot first, then every dot, then every name on top. */}
      {named.filter((l) => Math.abs(l.drop) > 4).map(({ r, x: dx, y: dy, lx, ly, right }) => (
        // the name had to move off its own line, so a short line says which dot it belongs to
        <path key={`lead-${r.model}`} d={`M${dx} ${dy} L${lx + (right ? -3 : 3)} ${ly - 4}`}
          stroke="var(--line-strong)" strokeWidth="1" fill="none" />
      ))}
      {/* a strategy, rather than one model, is a diamond, so the two can be told apart at a glance */}
      {labels.map(({ r, x: dx, y: dy }) => (tone(r) === 'cur'
        ? <circle key={`dot-${r.model}`} cx={dx} cy={dy} r="6.5" fill="var(--raise)" stroke={colour.cur} strokeWidth="2.2" />
        : isStrategy(r)
          ? <rect key={`dot-${r.model}`} x={dx - 5.2} y={dy - 5.2} width="10.4" height="10.4" rx="1.5"
            transform={`rotate(45 ${dx} ${dy})`} fill={colour[tone(r)]} />
          : <circle key={`dot-${r.model}`} cx={dx} cy={dy} r="6" fill={colour[tone(r)]} />))}
      {named.map(({ r, lx, ly, right }) => {
        const k = tone(r);
        return (
          <text key={`name-${r.model}`} x={lx} y={ly}
            className="m" textAnchor={right ? 'start' : 'end'} fontSize="11"
            fontWeight={k === 'pass' ? 600 : undefined}
            fill={k === 'pass' ? 'var(--ink)' : 'var(--mut-read)'}
            stroke="var(--raise)" strokeWidth="3.6" paintOrder="stroke" strokeLinejoin="round">
            {nameOf(r)}
          </text>
        );
      })}
      {cur && (
        <circle cx={cur.x} cy={cur.y} r="10.5" fill="none" stroke="var(--ink)" strokeWidth="1.4" pointerEvents="none" />
      )}
      {/* A dot is small to aim at, so each has a wider ring nobody sees that answers the pointer. */}
      {labels.map(({ r, x: dx, y: dy }, i) => (
        <circle key={`hit-${r.model}`} cx={dx} cy={dy} r="13" fill="transparent"
          style={{ cursor: 'default' }} onPointerEnter={() => setAt(i)} onPointerLeave={() => setAt(null)} />
      ))}
    </svg>
    {cur && (
      <div className={narrow ? 'charttip wide' : `charttip dotcard${cur.x > CW * 0.6 ? ' left' : ''}`} aria-live="polite"
        style={narrow ? undefined : { left: `${(cur.x / CW) * 100}%`, top: `${Math.min(84, Math.max(14, (cur.y / CH) * 100))}%` }}>
        <div className="tipday">{cur.r.name?.label || cur.r.model}</div>
        {isStrategy(cur.r) && cur.r.escalated !== null && cur.r.escalated !== undefined && (
          <div className="tiprow"><span className="tipkey">{cur.r.name.kind === 'cascade' ? 'Sent on after the check' : 'Sent to the dearer model'}</span>
            <span className="tipval">{Number(cur.r.escalated).toFixed(1)}%</span></div>
        )}
        <div className="tiprow"><span className="tipkey">Cost a month</span>
          <span className="tipval">{usd(cur.r.costMonth)}</span></div>
        {cur.r.verdict !== 'reference' && (
          <div className="tiprow"><span className="tipkey">Disagreement</span>
            <span className="tipval">{cur.r.gap.toFixed(2)}%</span></div>
        )}
        {cur.r.latencyP50 ? (
          <div className="tiprow"><span className="tipkey">Typical time</span>
            <span className="tipval">{(cur.r.latencyP50 / 1000).toFixed(1)} s</span></div>
        ) : null}
        <div className="tiprow"><span className="tipkey">Result</span>
          <span className="tipval">{RESULT[cur.r.verdict] || cur.r.verdict}</span></div>
      </div>
    )}
    {labels.some((l) => isStrategy(l.r)) && (
      <p className="cchartnote">
        A diamond is a strategy rather than one model: a cheaper model whose answers are checked, with the doubtful
        ones sent on to yours, or a pick made call by call. Its cost includes every check and every call sent on.
      </p>
    )}
    {unnamed > 0 && (
      <p className="cchartnote">
        {unnamed === 1 ? 'One model is' : `${unnamed} models are`} not named on the chart, because
        there was no room beside {unnamed === 1 ? 'its dot' : 'their dots'} without covering
        another. Point at any dot to see which model it is; the table below lists them all.
      </p>
    )}
    </div>
  );
}

/* Where a price goes across the chart.
 *
 * In a straight line when the prices are close together. When the dearest is ten times the
 * cheapest or more, which is the usual case because the models tried are spread from just
 * below yours down to the cheapest there is, a straight line put every candidate in the left
 * fifth of the chart, on top of one another, with your own model alone on the far right. So
 * the axis then counts in steps of ten ($0.01, $0.10, $1.00, $10.00): every candidate gets room
 * of its own, and it still reads left to right from cheaper to dearer. Every price on the axis
 * is written the way money is written everywhere else in the app. */
function costScale(values, x0, x1) {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  if (lo > 0 && hi / lo >= 10) {
    let a = Math.floor(Math.log10(lo));
    let b = Math.ceil(Math.log10(hi));
    // at least two steps, widened on whichever side the dots come closest to the edge
    while (b - a < 2) {
      if (Math.log10(lo) - a <= b - Math.log10(hi)) a -= 1; else b += 1;
    }
    const inset = 12;   // a dot sitting on a step is not cut in half by the edge of the plot
    const at = (v) => x0 + inset + ((Math.log10(v) - a) / (b - a)) * (x1 - x0 - 2 * inset);
    const ticks = [];
    for (let k = a; k <= b; k += 1) ticks.push(10 ** k);
    return { log: true, at, ticks, label: usd };
  }
  const top = niceTop(Math.max(hi, 0.01));
  const step = top / 4;
  return {
    log: false,
    at: (v) => x0 + (v / top) * (x1 - x0),
    ticks: [0, step, step * 2, step * 3, top],
    label: usd,
  };
}
