import React, { useCallback, useRef, useState } from 'react';
import { usd } from './api.js';

const W = 980;
const H = 408;
const L = 74;
const R = 22;
const T = 26;
const B = 62;

// en-GB already abbreviates September as Sept, so appending one gave "Septt"
const dlab = (ms) => new Date(ms).toLocaleDateString('en-GB',
  { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });

const money = (v, max) => (max <= 0.05 ? `$${v.toFixed(3)}` : max <= 5 ? `$${v.toFixed(2)}` : `$${Math.round(v)}`);

/* The day the pointer is over, as a whole date. The axis only labels four days, so the
   tooltip has to say which one this is rather than leaving somebody counting gridlines.
   Named in IST, because which day a call lands on depends on the clock you read it by. */
const dfull = (ms) => new Date(ms).toLocaleDateString('en-GB',
  { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

/** Daily spend, with what the same traffic would have cost on the customer's own models. */
export function SpendChart({ series }) {
  const n = series.length;
  const box = useRef(null);
  const [at, setAt] = useState(null);

  /* Which day is under the pointer. The drawing is a viewBox scaled to whatever width the
     panel happens to be, so the pointer's position on the screen has to be put back into
     the drawing's own coordinates before it means anything. */
  const pick = useCallback((clientX) => {
    const el = box.current;
    if (!el || !n) return;
    const r = el.getBoundingClientRect();
    if (!r.width) return;
    const x = ((clientX - r.left) / r.width) * W;
    const span = (W - L - R) / Math.max(1, n - 1);
    const i = Math.round((x - L) / span);
    setAt(Math.max(0, Math.min(n - 1, i)));
  }, [n]);

  const step = (by) => setAt((cur) => {
    const next = (cur === null ? n - 1 : cur) + by;
    return Math.max(0, Math.min(n - 1, next));
  });

  if (!n) return null;
  const top = Math.max(...series.map((d) => Math.max(d.paid, d.would)), 0.02);
  const max = niceTop(top);
  const ticks = [0, max / 4, max / 2, (max * 3) / 4, max];
  const px = (i) => L + (i * (W - L - R)) / Math.max(1, n - 1);
  const py = (v) => H - B - (v / max) * (H - B - T);
  const path = (key) => series.map((d, i) => `${px(i).toFixed(1)} ${py(d[key]).toFixed(1)}`).join(' L');
  const marks = n < 12 ? [0, n >> 1, n - 1] : [0, Math.floor(n / 3), Math.floor((2 * n) / 3), n - 1];

  const day = at === null ? null : series[at];

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
          <text x={L - 11} y={py(v) + 3.5} className="m" textAnchor="end" fontSize="10" fill="var(--mut)">{money(v, max)}</text>
        </g>
      ))}
      <path d={`M${path('would')}`} fill="none" stroke="var(--line-strong)" strokeWidth="2" strokeDasharray="6 5" />
      <path d={`M${px(0).toFixed(1)} ${py(0).toFixed(1)} L${path('paid')} L${px(n - 1).toFixed(1)} ${py(0).toFixed(1)} Z`}
        fill="var(--brand)" opacity="0.10" />
      <path d={`M${path('paid')}`} fill="none" stroke="var(--brand)" strokeWidth="2.4" strokeLinejoin="round" />
      <line x1={L} y1={py(0)} x2={W - R} y2={py(0)} stroke="var(--line-strong)" strokeWidth="1.2" />
      {marks.map((i, k) => (
        <text key={i} x={px(i)} y={H - B + 22} className="m" fontSize="10.5" fill="var(--mut)"
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
      <div className={`charttip${px(at) > W * 0.62 ? ' left' : ''}`}
        style={{ left: `${(px(at) / W) * 100}%` }} aria-live="polite">
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

/** Each label sits beside its own dot: right if there is room, otherwise left, and only
    nudged down as a last resort. A label that drifts from its point is worse than none. */
function placed(points, px, py) {
  const taken = [];
  const out = [];
  const sorted = [...points].sort((a, b) => px(a.costMonth) - px(b.costMonth));
  for (const r of sorted) {
    const x = px(r.costMonth);
    const y0 = py(r.gap) + 3.5;
    const w = 7.2 * String(r.model.split('/').pop()).length;
    const hits = (l, y) => taken.some((t) => Math.abs(t.y - y) < 13 && l < t.r && t.l < l + w)
      || sorted.some((o) => o !== r && Math.abs(py(o.gap) - y) < 9
        && l - 7 < px(o.costMonth) && px(o.costMonth) < l + w + 7);
    let best = null;
    for (let drop = 0; drop <= 30 && !best; drop += 15) {
      for (const side of [1, -1]) {
        const l = side === 1 ? x + 12 : x - 12 - w;
        if (l < 0 || l + w > CW) continue;
        if (!hits(l, y0 + drop)) { best = { l, y: y0 + drop, right: side === 1 }; break; }
      }
    }
    const put = best || { l: x + 12, y: y0, right: true };
    taken.push({ l: put.l, r: put.l + w, y: put.y });
    out.push({ r, lx: put.right ? x + 12 : x - 12, ly: put.y, right: put.right,
      drop: Math.round(put.y - y0) });
  }
  return out;
}

function niceTop(v) {
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 4 ? 4 : n <= 8 ? 8 : 10) * pow;
}

/** Waiting for a first full day, drawn as an axis rather than a fake line. */
export function WaitingChart({ message }) {
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={message}>
      {[0, 1, 2, 3, 4].map((k) => (
        <line key={k} x1={L} y1={T + (k * (H - B - T)) / 4} x2={W - R} y2={T + (k * (H - B - T)) / 4}
          stroke="var(--line)" strokeWidth="1" />
      ))}
      <line x1={L} y1={H - B} x2={W - R} y2={H - B} stroke="var(--line-strong)" strokeWidth="1.2" />
      <text x={W / 2} y={(T + H - B) / 2 + 4} textAnchor="middle" fontSize="13" fill="var(--mut-read)">{message}</text>
    </svg>
  );
}

/* Every model tried, placed by what it costs and how far it drifted. Under the line passed. */
const CW = 980;
const CH = 400;
const CL = 64;
const CR = 168;
const CT = 34;
const CB = 56;

export function CandidateChart({ results, floor, reference, referenceCostMonth }) {
  const tried = results.filter((r) => r.costMonth !== null && r.gap !== null && r.runs >= 100);
  if (tried.length < 2) return null;
  /* The model the bar came from belongs on the picture: it is the thing every candidate
     is being compared against, and what it costs is the whole argument. */
  const points = referenceCostMonth === null || referenceCostMonth === undefined
    ? tried
    : [...tried, { model: reference, gap: 0, costMonth: referenceCostMonth, verdict: 'reference' }];
  const xmax = niceTop(Math.max(...points.map((p) => p.costMonth), 0.01));
  // keep the bar visible without squashing every candidate onto the baseline
  const ymax = niceTop(Math.max(...points.map((p) => p.gap), floor * 1.6, 1));
  const px = (v) => CL + (v / xmax) * (CW - CL - CR);
  const py = (v) => CH - CB - (v / ymax) * (CH - CB - CT);
  const yticks = [0, ymax / 4, ymax / 2, (ymax * 3) / 4, ymax];
  const xticks = [0, xmax / 4, xmax / 2, (xmax * 3) / 4, xmax];
  const tone = (r) => (r.model === reference || r.verdict === 'reference' ? 'cur'
    : r.verdict === 'cleared' ? 'pass' : r.verdict === 'review' ? 'near' : 'fail');
  const colour = { cur: 'var(--mut)', pass: 'var(--brand)', near: 'var(--warn)', fail: 'var(--bad)' };
  const short = (m) => m.split('/').pop();

  return (
    <svg viewBox={`0 0 ${CW} ${CH}`} width="100%" role="img"
      aria-label="Every model tested, placed by cost a month and how far it drifted. Anything below the dashed line cleared your bar.">
      {yticks.map((v) => (
        <g key={v}>
          <line x1={CL} y1={py(v)} x2={CW - CR} y2={py(v)} stroke="var(--line)" strokeWidth="1" />
          <text x={CL - 10} y={py(v) + 3.5} className="m" textAnchor="end" fontSize="10" fill="var(--mut)">{v.toFixed(0)}%</text>
        </g>
      ))}
      <rect x={CL} y={py(floor)} width={CW - CL - CR} height={py(0) - py(floor)} fill="var(--brand)" opacity="0.07" />
      <line x1={CL} y1={py(floor)} x2={CW - CR} y2={py(floor)} stroke="var(--brand)" strokeWidth="1.6" strokeDasharray="6 5" />
      <text x={CW - CR + 10} y={py(floor) + 3.5} className="m" fontSize="10" fontWeight="700" fill="var(--brand)">
        YOUR BAR · {floor.toFixed(2)}%
      </text>
      <line x1={CL} y1={py(0)} x2={CW - CR} y2={py(0)} stroke="var(--line-strong)" strokeWidth="1.2" />
      {xticks.map((v) => (
        <text key={v} x={px(v)} y={CH - CB + 20} className="m" fontSize="10" fill="var(--mut)" textAnchor="middle">
          ${v.toFixed(xmax <= 2 ? 2 : xmax <= 20 ? 1 : 0)}
        </text>
      ))}
      <text x={CL} y={CT - 12} className="m" fontSize="10" fontWeight="700" fill="var(--mut)">
        DISAGREEMENT WITH {reference.toUpperCase()}, THE MODEL YOUR BAR CAME FROM
      </text>
      <text x={CW - CR} y={CH - CB + 42} className="m" fontSize="10" fontWeight="700" fill="var(--mut)" textAnchor="end">
        COST A MONTH
      </text>
      {placed(points, px, py).map(({ r, lx, ly, right, drop }) => {
        const k = tone(r);
        return (
          <g key={r.model}>
            {drop > 4 && (
              // the label had to move, so say which dot it belongs to
              <path d={`M${px(r.costMonth)} ${py(r.gap)} L${lx + (right ? -4 : 4)} ${ly - 4}`}
                stroke="var(--line-strong)" strokeWidth="1" fill="none" />
            )}
            {k === 'cur'
              ? <circle cx={px(r.costMonth)} cy={py(r.gap)} r="6.5" fill="var(--raise)" stroke={colour[k]} strokeWidth="2.2" />
              : <circle cx={px(r.costMonth)} cy={py(r.gap)} r="6" fill={colour[k]} />}
            <text x={lx} y={ly}
              className="m" textAnchor={right ? 'start' : 'end'} fontSize="11"
              fontWeight={k === 'pass' ? 600 : undefined}
              fill={k === 'pass' ? 'var(--ink)' : 'var(--mut-read)'}
              stroke="var(--raise)" strokeWidth="3.6" paintOrder="stroke" strokeLinejoin="round">
              {short(r.model)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
