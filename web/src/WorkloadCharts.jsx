import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { dayOf } from './dates.js';

/* The drawings on a workload's page (web/src/screens/WorkloadDetail.jsx), each the design artboard's own, drawn
   from the page's figures (src/workloadPage.js): requests a day against the day's limit, how far along the requests
   a first test needs are, every setup a measurement tried by its cost against how often it answered differently,
   the live flow of requests once a workload is switched, the daily checks against the customer's own model, and
   the cost of a request before and now. Every colour is a theme token. */

const DAY = 86400000;

/** A day as a test counts it (UTC, created_at / DAY), by its date: "24 Sep". */
export const dayLabel = (d) => dayOf(d);

const TONE = { ok: 'var(--ok)', warn: 'var(--warn)', bad: 'var(--bad)', mut: 'var(--mut)', brand: 'var(--brand)' };
export const toneColor = (t) => TONE[t] || TONE.mut;

const S = { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true };
export const I = {
  chev: <svg className="wp-chev" {...S} strokeWidth={1.8}><path d="M6 3.5L10.5 8 6 12.5" /></svg>,
  info: <svg {...S}><circle cx="8" cy="8" r="6.2" /><path d="M8 7.2v4M8 4.9v.2" /></svg>,
  gear: <svg {...S} strokeWidth={1.6}><path d="M2.6 4.6h10.8M2.6 11.4h10.8" /><circle cx="6" cy="4.6" r="1.9" /><circle cx="10" cy="11.4" r="1.9" /></svg>,
  text: <svg {...S}><path d="M3 4h10M3 7h10M3 10h6" /></svg>,
  braces: <svg {...S}><path d="M6 2.8C4.4 2.8 4.6 4.6 4.6 6S3.4 8 3.4 8s1.2.6 1.2 2-.2 3.2 1.4 3.2M10 2.8c1.6 0 1.4 1.8 1.4 3.2s1.2 2 1.2 2-1.2.6-1.2 2 .2 3.2-1.4 3.2" /></svg>,
  tools: <svg {...S}><path d="M5.6 4L2 8l3.6 4M10.4 4L14 8l-3.6 4" /></svg>,
  choice: <svg {...S}><circle cx="4" cy="4.5" r="1.3" /><circle cx="4" cy="8" r="1.3" /><circle cx="4" cy="11.5" r="1.3" /><path d="M7 4.5h6.5M7 8h6.5M7 11.5h6.5" /></svg>,
};

/* How wide a drawing is on the screen. A drawing is laid out for the width it has, up to the width it was designed
   at, and scaled up from there: on a wide screen it is the artboard's own, and on a phone its words stay the size
   they are written at rather than shrinking with it to a size nobody can read. */
function useWidthOf(designW, minW) {
  const ref = useRef(null);
  const [box, setBox] = useState(designW);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const read = () => { const w = el.getBoundingClientRect().width; if (w > 0) setBox(w); };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // scaled a little, as the artboard is, until that would shrink its words below four fifths of their size
  return [ref, box >= designW * 0.8 ? designW : Math.max(minW, Math.round(box)), box];
}

/* A round top for an axis: the day's limit when that is the most there is, otherwise 1, 1.5, 2, 2.5, 3, 4, 5, 6 or 8
   of a power of ten. */
function niceTop(v) {
  if (v <= 60) return 60;
  const p = 10 ** Math.floor(Math.log10(v));
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((s) => s * p >= v);
  return step * p;
}

/** Requests a day over thirty days, to scale; with the day's limit, the part of a day past it drawn faint. */
export function DailyChart({ days, cap = null }) {
  const [ref, W] = useWidthOf(560, 300);
  const H = 150; const L = 36; const R = 8; const T = 14; const B = 26; const w = W - L - R; const h = H - T - B;
  const top = niceTop(Math.max(cap ?? 0, ...days.map((x) => x.n)));
  const bw = w / days.length;
  const y = (v) => T + h - (v / top) * h;
  const ticks = top === 60 ? [0, 30, 60] : [0, top / 2, top];
  const label = [0, 14, days.length - 1];
  return (
    <svg ref={ref} className="wp-sv" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={cap ? `Requests a day over the last 30 days, at most ${cap} a day counted` : 'Requests a day over the last 30 days'}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth="1" />
          <text x={L - 6} y={y(t) + 4} textAnchor="end">{t.toLocaleString('en-US')}</text>
        </g>
      ))}
      {days.map((d, i) => {
        const x = L + i * bw + bw * 0.18;
        const bwid = bw * 0.64;
        const counted = cap ? d.counted : d.n;
        const past = cap ? Math.max(0, d.n - d.counted) : 0;
        return (
          <g key={d.d}>
            <title>{`${dayLabel(d.d)}: ${d.n.toLocaleString('en-US')} ${d.n === 1 ? 'request' : 'requests'}${cap && d.n !== d.counted ? `, ${d.counted} counted` : ''}`}</title>
            {past > 0 && <rect x={x} y={y(d.n)} width={bwid} height={Math.max(1, (past / top) * h)} rx="1.5" fill="var(--brand)" opacity="0.22" />}
            {counted > 0
              ? <rect x={x} y={y(counted)} width={bwid} height={Math.max(1, (counted / top) * h)} rx="1.5" fill="var(--brand)" />
              : past > 0 ? null : <rect x={x} y={T + h - 1.5} width={bwid} height="1.5" fill="var(--line-strong)" />}
          </g>
        );
      })}
      {cap && (
        <>
          <line x1={L} x2={W - R} y1={y(cap)} y2={y(cap)} stroke="var(--warn)" strokeDasharray="4 4" strokeWidth="1.2" />
          <text x={W - R} y={y(cap) - 5} textAnchor="end" className="t-warn">at most {cap} a day count</text>
        </>
      )}
      {/* under the first, middle and last day; kept inside the drawing when it is narrower than the artboard's */}
      {label.map((i) => (
        <text key={i} x={W < 560 ? Math.min(W - 24, Math.max(24, L + i * bw + bw / 2)) : L + i * bw + bw / 2} y={H - 6}
          textAnchor="middle">{dayLabel(days[i].d)}</text>
      ))}
    </svg>
  );
}

/** How far along the requests a first test needs are, and when the rest can arrive, at most `perDay` a day. */
export function Meter({ have, need, perDay, steps, auto = true }) {
  const [ref, W] = useWidthOf(520, 280);
  const H = 92; const L = 4; const R = 4; const w = W - L - R; const T = 30;
  const x = (v) => L + (Math.min(v, need) / Math.max(1, need)) * w;
  return (
    <svg ref={ref} className="wp-sv" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={`${have} of the ${need} requests the test needs, at most ${perDay} a day`}>
      <rect x={L} y={T} width={w} height="16" rx="8" fill="var(--grid)" />
      {steps.map((s, k) => {
        const width = x(s.to) - x(s.from);
        return (
          <g key={s.d}>
            <rect x={x(s.from) + 1.5} y={T + 1.5} width={Math.max(0, width - 3)} height="13" rx="6.5" fill="none" stroke="var(--brand)"
              strokeWidth="1.4" strokeDasharray="3 3" opacity={Math.max(0.3, 0.75 - k * 0.15)} />
            {width >= 44 && <text x={(x(s.from) + x(s.to)) / 2} y={T + 34} textAnchor="middle">{s.today ? 'today' : dayLabel(s.d)}</text>}
          </g>
        );
      })}
      {have > 0 && <rect x={L} y={T} width={Math.max(0, x(have) - L)} height="16" rx="8" fill="var(--brand)" />}
      <text x={L} y={T - 10} className="t-brand t-bold">{have} so far</text>
      <line x1={x(need)} x2={x(need)} y1={T - 6} y2={T + 22} stroke="var(--ok)" strokeWidth="2" />
      <text x={x(need)} y={T - 10} textAnchor="end" className="t-ok t-bold">{need}: {auto ? 'starts by itself' : 'ready to test'}</text>
    </svg>
  );
}

/**
 * A measurement that compared nothing, drawn rather than only said: how often the customer's own model's two answers
 * to one request differed (or, held to "at least as good", how often one was clearly worse), against the pass mark it
 * set, or against the most a bar can be set from where it could not set one. Where it ended before it could say even
 * that, how far along its model calls it got.
 */
export function SelfPic({ self, yardstick }) {
  const [ref, W] = useWidthOf(520, 280);
  const H = 78; const L = 4; const R = 4; const w = W - L - R; const T = 26;
  const x = (v) => L + Math.max(0, Math.min(1, Number(v) || 0)) * w;
  const pctw = (v) => `${Math.round(Number(v) * 1000) / 10}%`;
  // a label hung from a point on the track, kept inside the drawing
  const anchor = (v) => (v < 0.3 ? 'start' : v > 0.7 ? 'end' : 'middle');
  if (self?.noise !== null && self?.noise !== undefined) {
    const mark = self.most ?? self.bar;
    const worse = yardstick === 'quality';
    const said = worse ? 'clearly worse than its own other answer' : 'a different answer from its own other one';
    const markWords = self.most ? `${pctw(mark)}: the most a bar can be set from` : `pass mark ${pctw(mark)}`;
    return (
      <svg ref={ref} className="wp-sv" viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label={`Your model gave ${said} on ${pctw(self.noise)} of ${self.n} requests, each asked twice${mark !== null ? `; ${markWords}` : ''}`}>
        <text x={L} y={T - 10} className="t-ink t-bold">{`${worse ? 'Clearly worse than itself' : 'Different from itself'} on ${pctw(self.noise)} of requests`}</text>
        <rect x={L} y={T} width={w} height="16" rx="8" fill="var(--grid)" />
        {self.noise > 0 && <rect x={L} y={T} width={Math.max(16, x(self.noise) - L)} height="16" rx="8" fill={self.most ? 'var(--bad)' : 'var(--brand)'} />}
        {mark !== null && (
          <>
            <line x1={x(mark)} x2={x(mark)} y1={T - 5} y2={T + 21} stroke={self.most ? 'var(--warn)' : 'var(--ok)'} strokeWidth="2" />
            <text x={x(mark)} y={T + 38} textAnchor={anchor(mark)} className={`${self.most ? 't-warn' : 't-ok'} t-bold`}>{markWords}</text>
          </>
        )}
      </svg>
    );
  }
  const share = self?.total > 0 ? Math.min(1, self.done / self.total) : 0;
  const ended = self?.outcome === 'refused' ? 'your model could not answer'
    : self?.outcome === 'interrupted' ? 'interrupted here' : self?.outcome === 'stopped' ? 'stopped here' : 'ended here';
  return (
    <svg ref={ref} className="wp-sv" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={`${self?.done ?? 0} of ${self?.total ?? 0} model calls made before it ${ended === 'ended here' ? 'ended' : ended.replace(' here', '')}`}>
      <text x={L} y={T - 10} className="t-ink t-bold">{`${(self?.done ?? 0).toLocaleString('en-US')} of ${(self?.total ?? 0).toLocaleString('en-US')} model calls made`}</text>
      <rect x={L} y={T} width={w} height="16" rx="8" fill="var(--grid)" />
      {share > 0 && <rect x={L} y={T} width={Math.max(16, x(share) - L)} height="16" rx="8" fill="var(--mut)" />}
      <line x1={x(share)} x2={x(share)} y1={T - 5} y2={T + 21} stroke="var(--ink)" strokeWidth="2" />
      <text x={x(share)} y={T + 38} textAnchor={anchor(share)} className="t-bold">{ended}</text>
    </svg>
  );
}

/* A dollar amount on the cost axis, with as many places as it takes: $0.0001, $0.005. */
const tickUsd = (v) => `$${v >= 1 ? v.toFixed(v % 1 ? 1 : 0) : v.toFixed(Math.max(0, -Math.floor(Math.log10(v) + 1e-9)))}`;

/** Whether a setup can be placed on the chart: it was judged, and what a request costs on it is known. */
export const plotted = (c) => c.gap !== null && c.gap !== undefined && Number(c.perCall) > 0;

/* A top for the share axis whose four steps are whole percents: 2, 3, 5, 10, 15, 20 or 25 a step. */
const SHARE_TOPS = [0.08, 0.12, 0.2, 0.4, 0.6, 0.8, 1];

/**
 * Every setup a measurement tried, by what a request costs on it (less to the left) against how often it answered
 * differently from the customer's own model, or worse: the bar, the region that is cheaper and as good, and the
 * customer's own model. Numbered as the table under it.
 */
export function CompareChart({ run }) {
  const [ref, W] = useWidthOf(600, 320);
  const H = W < 460 ? 270 : 300; const L = 52; const R = 18; const T = 16; const B = 46; const w = W - L - R; const h = H - T - B;
  const pts = run.cands.map((c, i) => ({ ...c, no: i + 1 })).filter(plotted);
  const yours = Number(run.yours?.perCall) > 0 ? Number(run.yours.perCall) : null;
  const costs = [...pts.map((c) => c.perCall), ...(yours ? [yours] : [])];
  if (!pts.length) return null;
  const lo = Math.log10(Math.min(...costs) / 2.5);
  const hi = Math.log10(Math.max(...costs) * 2.5);
  const span = Math.max(hi - lo, 0.8);
  const llo = (lo + hi) / 2 - span / 2;
  const lhi = llo + span;
  const x = (v) => L + ((Math.log10(v) - llo) / (lhi - llo)) * w;
  const want = Math.max(run.bar * 1.6, ...pts.map((c) => c.gap));
  const ymax = SHARE_TOPS.find((v) => v >= want) ?? 1;
  const y = (v) => T + h - (Math.min(Math.max(v, 0), ymax) / ymax) * h;
  const yticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * ymax);
  // the dollar ticks: each power of ten inside the range, then five of one wherever its label has room
  const decades = [];
  for (let k = Math.ceil(llo); k <= Math.floor(lhi); k += 1) decades.push(10 ** k);
  const kept = decades.map((v) => x(v));
  const xticks = [...decades];
  if (decades.length < 3) {
    for (let k = Math.floor(llo); k <= Math.ceil(lhi); k += 1) {
      const v = 5 * 10 ** k;
      if (!(Math.log10(v) > llo && Math.log10(v) < lhi)) continue;
      if (kept.every((at) => Math.abs(at - x(v)) >= 64)) { xticks.push(v); kept.push(x(v)); }
    }
  }
  xticks.sort((a, b) => a - b);
  const barPct = Math.round(run.bar * 1000) / 10;
  const zoneW = yours ? Math.max(0, Math.min(x(yours), W - R) - L) : 0;
  const zoneH = y(0) - y(run.bar);
  return (
    <svg ref={ref} className="wp-sv" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="How the candidates compare with your model on cost and answers">
      {yours && run.bar > 0 && <rect x={L} y={y(run.bar)} width={zoneW} height={zoneH} fill="var(--okq)" />}
      {yours && run.bar > 0 && zoneW > 140 && zoneH > 20 && <text x={L + 8} y={y(run.bar) + 14} className="t-ok ui">Cheaper and as good</text>}
      {yticks.map((t) => (
        <g key={t}>
          <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="var(--grid)" />
          <text x={L - 8} y={y(t) + 4} textAnchor="end">{Math.round(t * 100)}%</text>
        </g>
      ))}
      {xticks.map((v) => (
        <g key={v}>
          <line x1={x(v)} x2={x(v)} y1={T} y2={T + h} stroke="var(--grid)" />
          <text x={x(v)} y={T + h + 16} textAnchor="middle">{tickUsd(v)}</text>
        </g>
      ))}
      <text x={L + w / 2} y={H - 6} textAnchor="middle" className="ui">Cost per call, less to the left</text>
      <text x="14" y={T + h / 2} textAnchor="middle" className="ui" transform={`rotate(-90 14 ${T + h / 2})`}>{run.axis}</text>
      {run.bar > 0 && (
        <>
          <line x1={L} x2={W - R} y1={y(run.bar)} y2={y(run.bar)} stroke="var(--ok)" strokeWidth="1.6" strokeDasharray="6 4" />
          <text x={W - R} y={y(run.bar) - 6} textAnchor="end" className="t-ok t-bold">bar {barPct}%</text>
        </>
      )}
      {yours && (
        <g>
          <title>{`Your own model, ${run.reference}`}</title>
          <path d={`M${x(yours)} ${y(0) - 8} L${x(yours) + 8} ${y(0)} L${x(yours)} ${y(0) + 8} L${x(yours) - 8} ${y(0)} Z`} fill="var(--ink)" />
          <text x={x(yours)} y={y(0) - 13} textAnchor="middle" className="t-ink ui">yours</text>
        </g>
      )}
      {pts.map((c) => (
        <g key={c.key}>
          <title>{`${c.no}. ${c.label}: ${String(run.axis).split(' ')[0].toLowerCase()} on ${(c.gap * 100).toFixed(1)}%`}</title>
          <circle cx={x(c.perCall)} cy={y(c.gap)} r="9.5" fill={toneColor(c.tone)} />
          <text x={x(c.perCall)} y={y(c.gap) + 3.8} textAnchor="middle" className="dotno">{c.no}</text>
        </g>
      ))}
    </svg>
  );
}

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/* A setup's name where there is room for about eighteen letters: whole words of it, never cut in the middle. */
const fitName = (s, room = 18) => {
  const t = String(s || '');
  if (t.length <= room) return t;
  const cut = t.lastIndexOf('-', room);
  return cut > 4 ? t.slice(0, cut) : t.slice(0, room);
};

/* The two ways the flow is laid out: across, as the artboard draws it, and stacked for a narrow screen, where the
   same boxes read top to bottom at the size they are written at. */
const WIDE = {
  vb: '0 0 640 230',
  A: 'M128 115 C170 115 190 115 230 115', C: 'M384 104 C430 96 436 50 478 50', Y: 'M384 126 C430 134 436 180 478 180',
  app: [16, 92, 112, 46], us: [232, 76, 152, 78], cheap: [480, 22, 148, 56], yours: [480, 152, 148, 56],
};
const TALL = {
  vb: '0 0 330 330',
  A: 'M165 58 C165 72 165 82 165 98', C: 'M130 180 C120 204 86 204 84 236', Y: 'M200 180 C210 204 244 204 246 236',
  app: [105, 10, 120, 46], us: [79, 100, 172, 78], cheap: [6, 240, 156, 56], yours: [168, 240, 156, 56],
};

/**
 * What Understudy does with each request of a switched workload, live: requests from the customer's app, most
 * answered by the cheaper setup, the rest sent on to the customer's own model, in the share the record shows.
 * Still, with a few dots placed, for a reader who asked for less motion, and for a switch still waiting for its
 * first request through Understudy.
 */
export function FlowSvg({ d, still = false, waiting = false }) {
  const [ref, , box] = useWidthOf(640, 280);
  const G = box < 520 ? TALL : WIDE;
  // waiting for its first request through Understudy, the customer's own model answers every one, at their provider
  const share = waiting ? 0 : d.share ?? (d.rollout ?? 1);
  const cheapPct = Math.round(share * 100);
  const toYours = Math.max(0, Math.min(1, 1 - share));
  const refShort = String(d.reference || '').split('/').pop();
  const middle = d.kind === 'cascade' ? ['checks each answer', 'with Jev']
    : d.kind === 'sorted' ? ['sorts each request', 'by its kind']
      : d.kind === 'router' ? ['picks for each', 'request']
        : ['sends each request', 'to the cheaper setup'];
  const top = waiting ? `will start at ${Math.round((d.rollout ?? 1) * 100)}%` : `${cheapPct}% answered here`;
  const bottom = waiting ? 'answers all, for now'
    : d.kind === 'cascade' ? `${100 - cheapPct}% sent on, unsure`
      : d.kind === 'model' && d.rollout !== null && d.rollout < 1 ? `${100 - cheapPct}% still here`
        : d.kind === 'model' ? (100 - cheapPct > 0 ? `${100 - cheapPct}% here, as back-up` : 'standing by')
          : `${100 - cheapPct}% sent here`;
  const perDay = Math.round(d.perDay || 0);

  useEffect(() => {
    const svg = ref.current;
    if (!svg) return undefined;
    const P = { A: svg.querySelector('[data-p="A"]'), C: svg.querySelector('[data-p="C"]'), Y: svg.querySelector('[data-p="Y"]') };
    const layer = svg.querySelector('[data-dots]');
    if (!P.A || !layer || typeof P.A.getTotalLength !== 'function') return undefined;
    while (layer.firstChild) layer.removeChild(layer.firstChild);
    const len = { A: P.A.getTotalLength(), C: P.C.getTotalLength(), Y: P.Y.getTotalLength() };
    const NS = 'http://www.w3.org/2000/svg';
    const put = (seg, f, route) => {
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('r', seg === 'A' ? '4' : '4.5');
      c.setAttribute('fill', route === 'Y' && seg !== 'A' ? 'var(--ink)' : seg === 'A' ? 'var(--brand)' : 'var(--ok)');
      const p = P[seg].getPointAtLength(f * len[seg]);
      c.setAttribute('cx', p.x); c.setAttribute('cy', p.y);
      layer.appendChild(c);
      return c;
    };
    if (still || reducedMotion()) {
      [0.2, 0.55, 0.85].forEach((f) => put('A', f, 'C'));
      if (share > 0) [0.25, 0.5, 0.75].forEach((f) => put('C', f, 'C'));
      if (share <= 0) [0.3, 0.7].forEach((f) => put('Y', f, 'Y'));
      else if (toYours > 0.005) put('Y', 0.5, 'Y');
      return () => { while (layer.firstChild) layer.removeChild(layer.firstChild); };
    }
    let raf = 0;
    const dots = [];
    let last = 0;
    let prev = 0;
    // the share sent on, exactly: every request adds its chance of going that way, and one goes when a whole one is due
    let owed = 0;
    const step = (t) => {
      const dt = prev ? Math.min(64, t - prev) : 16;
      prev = t;
      if (t - last > 360) {
        owed += toYours;
        const route = owed >= 1 - 1e-9 ? 'Y' : 'C';
        if (route === 'Y') owed -= 1;
        dots.push({ seg: 'A', f: 0, route, el: put('A', 0, route) });
        last = t;
      }
      for (let i = dots.length - 1; i >= 0; i -= 1) {
        const dot = dots[i];
        dot.f += (dt * 0.11) / len[dot.seg];
        if (dot.f >= 1) {
          if (dot.seg === 'A') {
            dot.seg = dot.route; dot.f = 0;
            dot.el.setAttribute('fill', dot.route === 'Y' ? 'var(--ink)' : 'var(--ok)');
            dot.el.setAttribute('r', '4.5');
          } else { dot.el.remove(); dots.splice(i, 1); continue; }
        }
        const p = P[dot.seg].getPointAtLength(dot.f * len[dot.seg]);
        dot.el.setAttribute('cx', p.x); dot.el.setAttribute('cy', p.y);
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(raf); while (layer.firstChild) layer.removeChild(layer.firstChild); };
  }, [share, toYours, still, G]);

  const box4 = (b) => ({ x: b[0], y: b[1], width: b[2], height: b[3] });
  const mid = (b) => b[0] + b[2] / 2;
  return (
    <svg ref={ref} className="wp-sv" viewBox={G.vb} role="img"
      aria-label={waiting ? `Set up to answer requests with ${d.label} once they come through Understudy; ${d.reference} answers them until then`
        : `${cheapPct}% of requests answered by ${d.label}, the rest sent on to ${d.reference}`}>
      <defs><marker id="wpah" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8Z" fill="var(--line-strong)" /></marker></defs>
      <path data-p="A" d={G.A} fill="none" stroke="var(--line-strong)" strokeWidth="2" markerEnd="url(#wpah)" />
      <path data-p="C" d={G.C} fill="none" stroke="var(--ok)" strokeWidth="2.4" markerEnd="url(#wpah)" />
      <path data-p="Y" d={G.Y} fill="none" stroke="var(--line-strong)" strokeWidth="1.6" strokeDasharray="4 4" markerEnd="url(#wpah)" />
      <rect {...box4(G.app)} rx="12" fill="var(--raise)" stroke="var(--line)" />
      <text x={mid(G.app)} y={G.app[1] + 21} textAnchor="middle" className="t-ink ui t-bold">Your app</text>
      <text x={mid(G.app)} y={G.app[1] + 37} textAnchor="middle">{perDay.toLocaleString('en-US')} a day</text>
      <rect {...box4(G.us)} rx="14" fill="var(--brandq)" stroke="var(--brand)" strokeWidth="1.4" />
      <text x={mid(G.us)} y={G.us[1] + 28} textAnchor="middle" className="t-brand ui t-bold">Understudy</text>
      <text x={mid(G.us)} y={G.us[1] + 46} textAnchor="middle">{middle[0]}</text>
      <text x={mid(G.us)} y={G.us[1] + 62} textAnchor="middle">{middle[1]}</text>
      <rect {...box4(G.cheap)} rx="12" fill="var(--okq)" stroke="var(--ok)" strokeWidth="1.4" />
      <text x={mid(G.cheap)} y={G.cheap[1] + 22} textAnchor="middle" className="t-ok ui t-bold"><title>{d.label}</title>{fitName(d.cheap)}</text>
      <text x={mid(G.cheap)} y={G.cheap[1] + 40} textAnchor="middle" className="t-ok">{top}</text>
      <rect {...box4(G.yours)} rx="12" fill="var(--raise)" stroke="var(--line)" />
      <text x={mid(G.yours)} y={G.yours[1] + 22} textAnchor="middle" className="t-ink ui t-bold">{refShort}, yours</text>
      <text x={mid(G.yours)} y={G.yours[1] + 40} textAnchor="middle">{bottom}</text>
      <g data-dots="" />
    </svg>
  );
}

/** Cost per call before and now, to scale: the longer bar is the whole track less room for its figure. */
export function CostBars({ before, after, fmt }) {
  const most = Math.max(before, after);
  const row = (label, v, fill) => (
    <>
      <span>{label}</span>
      <span className="wp-track">
        <span className="wp-fill" style={{ width: `calc((100% - 64px) * ${(v / most).toFixed(4)})`, background: fill }} />
        <span className="wp-val">{fmt(v)}</span>
      </span>
    </>
  );
  return (
    <div className="wp-cbar" role="img" aria-label={`Cost per call: ${fmt(before)} before, ${fmt(after)} now`}>
      {row('Before', before, 'var(--line-strong)')}
      {row('Now', after, 'var(--ok)')}
    </div>
  );
}

/** The share of checked answers worse than (or different from) the customer's own, each day, against the bar. */
export function QualitySpark({ daily, bar }) {
  const [ref, W] = useWidthOf(260, 130);
  const H = 58; const T = 6; const B = 6; const h = H - T - B;
  const n = daily.length;
  const ymax = [0.1, 0.2, 0.3, 0.5, 1].find((v) => v >= Math.max(bar * 1.2, ...daily)) ?? 1;
  const x = (i) => (n === 1 ? (W - 30) : (i / (n - 1)) * (W - 30));
  const y = (v) => T + h - (Math.min(v, ymax) / ymax) * h;
  const pts = daily.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  const area = `0,${y(0)} ${pts} ${x(n - 1)},${y(0)}`;
  return (
    <svg ref={ref} className="wp-sv" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Share of checked calls worse than yours, each day, against the bar">
      {n > 1 && <polygon points={area} fill="var(--okq)" />}
      {n > 1 && <polyline points={pts} fill="none" stroke="var(--ok)" strokeWidth="1.8" />}
      <line x1="0" x2={W - 30} y1={y(bar)} y2={y(bar)} stroke="var(--bad)" strokeDasharray="4 3" strokeWidth="1.2" />
      <text x={W - 26} y={y(bar) + 4} className="t-ink">{Math.round(bar * 100)}%</text>
      {n > 0 && <circle cx={x(n - 1)} cy={y(daily[n - 1])} r="3.5" fill="var(--ok)" />}
    </svg>
  );
}

/** The three choices in Settings, each with a small picture of what happens. */
export function ChoicePic({ kind }) {
  const tests = (stroke) => (
    <>
      <rect x="2" y="12" width="44" height="22" rx="6" fill="var(--grid)" /><text x="24" y="27" textAnchor="middle">test</text>
      <path d="M50 23h30" stroke={stroke} strokeWidth="2" />
      <rect x="84" y="12" width="44" height="22" rx="6" fill="var(--grid)" /><text x="106" y="27" textAnchor="middle">test</text>
      <path d="M132 23h30" stroke={stroke} strokeWidth="2" />
    </>
  );
  return (
    <svg className="wp-sv" viewBox="0 0 220 46" preserveAspectRatio="xMinYMid meet" aria-hidden="true">
      {kind === 'auto' && (
        <>
          {tests('var(--ok)')}
          <rect x="166" y="10" width="52" height="26" rx="7" fill="var(--ok)" />
          <text x="192" y="27" textAnchor="middle" className="dotno" style={{ fontSize: 11 }}>switch</text>
        </>
      )}
      {kind === 'ask' && (
        <>
          {tests('var(--line-strong)')}
          <rect x="166" y="10" width="52" height="26" rx="7" fill="var(--brandq)" stroke="var(--brand)" />
          <text x="192" y="27" textAnchor="middle" className="t-brand t-bold">you?</text>
        </>
      )}
      {kind === 'off' && (
        <>
          {tests('var(--line-strong)')}
          <rect x="166" y="10" width="52" height="26" rx="7" fill="var(--grid)" />
          <text x="192" y="27" textAnchor="middle" className="t-bold">report</text>
        </>
      )}
    </svg>
  );
}
