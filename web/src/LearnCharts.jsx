import React, { useCallback, useState } from 'react';
import { num } from './api.js';
import { useWidth, NARROW } from './Charts.jsx';

/* The pictures the learning side of a workload is explained with: how its calls are served, how
 * often each way of serving them worked, where the week's calls went, how calls turned out day by
 * day, and the tasks they were steps in.
 *
 * The diagrams and the rate rows are laid out in HTML rather than drawn, so they reflow on a phone
 * instead of shrinking their words to nothing; the one chart with an axis of days is drawn, like
 * the spend chart it sits beside in spirit, and reads the same way under the pointer and the keys. */

const short = (m) => String(m || '').split('/').pop();
export const pct = (x, dp = 0) => (x === null || x === undefined ? 'not known' : `${(x * 100).toFixed(dp)}%`);
/* A share of calls in words a person reads at a glance: "12 in 100" is easier to picture than a
   percentage for the small shares experiments and a cascade's sent-on calls come to. */
export const inHundred = (x) => {
  if (x === null || x === undefined) return null;
  const n = x * 100;
  if (n > 0 && n < 1) return 'fewer than 1 in 100';
  return `${Math.round(n)} in 100`;
};

/* One box in a diagram: what it is, in small capitals, then its name, then a line about it. */
const Node = ({ eyebrow, title, sub, tone = '' }) => (
  <div className={`fnode ${tone}`}>
    <div className="fe">{eyebrow}</div>
    <div className="ft">{title}</div>
    {sub && <div className="fs">{sub}</div>}
  </div>
);
const Arrow = ({ label }) => (
  <div className="farrow" aria-hidden="true">{label && <span className="flab">{label}</span>}</div>
);

/**
 * How a workload's calls are served now, as a picture. `kind` is how: one model, the customer's
 * own model asked to think less, a cascade (a cheap model answers, a check reads the answer, and a
 * doubtful one goes to the customer's own model) or a router (a small model picks, call by call).
 * `sentOn` is the share of calls that went the long way, from live calls when there are any and
 * from the measurement otherwise; `sentOnFrom` says which.
 */
export function ServingFlow({ kind, first, fallback, reference, sentOn = null, sentOnFrom = null, experiments = null, parts = null, yours = null }) {
  const long = sentOn === null ? null : Math.max(0, Math.min(1, sentOn));
  const from = sentOnFrom === 'live' ? 'of this week’s calls' : sentOnFrom === 'switch' ? 'of the calls since the switch'
    : sentOnFrom === 'measured' ? 'from the measurement' : '';
  // where every path ends: the answer goes back to the app that asked
  const answer = <span className="fend">to your app</span>;
  let body;
  let words;
  if (kind === 'cascade') {
    words = `Each call is answered first by ${short(first)}. A quick check reads the answer; when it is sure, that answer goes back to your app. When it is not, ${short(fallback)} answers the call instead.`;
    body = (
      <>
        <Node eyebrow="Answers first" title={short(first)} sub="the cheaper model" tone="fn-brand" />
        <Arrow />
        <Node eyebrow="Checks the answer" title="Quick check" sub="the right shape, then is it right?" tone="fn-check" />
        <div className="ffork">
          <div className="fbranch">
            <Arrow label={long === null ? 'sure' : `${inHundred(1 - long)} sure`} />
            {answer}
          </div>
          <div className="fbranch">
            <Arrow label={long === null ? 'unsure' : `${inHundred(long)} unsure`} />
            <Node eyebrow="Answers instead" title={short(fallback)} sub={fallback === reference ? 'your own model' : null} />
            <Arrow />
            {answer}
          </div>
        </div>
      </>
    );
  } else if (kind === 'router' && Array.isArray(parts) && parts.length) {
    /* A router by kind of request: each kind it learned goes to one setup, and anything else to the
       customer's own model. The shares are the kinds' shares of the measured calls. */
    const used = parts.filter((x) => x.kinds > 0);
    const kinds = used.reduce((a, x) => a + x.kinds, 0) + (yours?.kinds || 0);
    words = `Each call is matched, before it is sent, to one of ${kinds} kinds of request learned from your own calls. `
      + `${used.map((x) => `${x.label} answers ${x.kinds === 1 ? 'one kind' : `${x.kinds} kinds`}`).join(', ')}, `
      + `and ${short(fallback)} answers ${yours?.kinds ? `${yours.kinds === 1 ? 'one kind' : `${yours.kinds} kinds`} and ` : ''}anything unlike what it learned from. Nothing is checked afterwards, so no call waits twice.`;
    body = (
      <>
        <Node eyebrow="Reads the call first" title="What kind is it?" sub={`${kinds} kinds, learned from your calls`} tone="fn-check" />
        <div className="ffork">
          {used.map((x, i) => (
            // by its place: two setups can be one model asked two ways
            <div className="fbranch" key={x.option ?? i}>
              <Arrow label={x.share === null || x.share === undefined ? `${x.kinds} ${x.kinds === 1 ? 'kind' : 'kinds'}` : `${inHundred(x.share)} calls`} />
              <Node eyebrow="Answers" title={x.label} sub={`${x.kinds} ${x.kinds === 1 ? 'kind' : 'kinds'} of request`} tone="fn-brand" />
              <Arrow />
              {answer}
            </div>
          ))}
          <div className="fbranch">
            <Arrow label={long === null ? 'the rest' : `${inHundred(long)} calls`} />
            <Node eyebrow="Answers" title={short(fallback)} sub={fallback === reference ? 'your own model, for the rest' : 'the rest'} />
            <Arrow />
            {answer}
          </div>
        </div>
      </>
    );
  } else if (kind === 'router') {
    words = `A small model learned from your own calls reads each call before it is sent, and sends the ones ${short(first)} gets right to it, and the rest to ${short(fallback)}. Nothing is checked afterwards, so no call waits twice.`;
    body = (
      <>
        <Node eyebrow="Reads the call first" title="Picker" sub="learned from your calls" tone="fn-check" />
        <div className="ffork">
          <div className="fbranch">
            <Arrow label={long === null ? 'most calls' : `${inHundred(1 - long)} calls`} />
            <Node eyebrow="Answers" title={short(first)} sub="the cheaper model" tone="fn-brand" />
            <Arrow />
            {answer}
          </div>
          <div className="fbranch">
            <Arrow label={long === null ? 'the harder ones' : `${inHundred(long)} calls`} />
            <Node eyebrow="Answers" title={short(fallback)} sub={fallback === reference ? 'your own model' : null} />
            <Arrow />
            {answer}
          </div>
        </div>
      </>
    );
  } else {
    words = kind === 'lighter'
      ? `Every call goes to ${short(first)}, your own model, asked to think less before it answers. Thinking is billed, so the same model costs less.`
      : kind === 'cheapest'
        ? `Every call goes to ${short(first)}, your own model, bought from the provider that sells it most cheaply. It is the same model, run by a different company.`
        : `Every call goes to ${short(first)} instead of ${short(reference)}.`;
    body = (
      <>
        <Node eyebrow="Answers" title={short(first)}
          sub={kind === 'lighter' ? 'your model, thinking less' : kind === 'cheapest' ? 'your model, cheapest provider' : 'the cheaper model'} tone="fn-brand" />
        <Arrow />
        {answer}
      </>
    );
  }
  return (
    <figure className="flowfig">
      <div className="flow" role="img" aria-label={`${words}${long !== null && (kind === 'cascade' || kind === 'router') ? ` ${inHundred(long)} calls go the long way ${from}.` : ''}`}>
        <Node eyebrow="Your app" title="Sends a call" />
        <Arrow />
        {body}
      </div>
      <figcaption className="flowcap">
        {words}
        {long !== null && (kind === 'cascade' || kind === 'router') && from ? ` The shares are ${from}.` : ''}
        {experiments}
      </figcaption>
    </figure>
  );
}

/* The axis for a set of rates: from a round five percent under the lowest range down to at most
   half, up to a hundred, so a difference of a point or two is wide enough to see. Read from the
   strategies with enough calls to have a narrow range; one with four calls has a range that can run
   from sixty percent to a hundred, and followed, it squashed every settled record into a sliver. Its
   range runs off the edge instead, fading as it goes. */
function rateAxis(rows) {
  const settled = rows.filter((r) => r.calls >= 20);
  const los = (settled.length ? settled : rows.filter((r) => r.calls > 0)).map((r) => r.lo);
  const lowest = los.length ? Math.min(...los) : 0.9;
  const min = Math.max(0, Math.min(0.9, Math.floor((lowest - 0.01) * 20) / 20));
  const span = 1 - min;
  const step = span > 0.3 ? 0.1 : span > 0.12 ? 0.05 : 0.02;
  const ticks = [];
  for (let v = 1; v >= min - 1e-9; v -= step) ticks.unshift(Math.round(v * 1000) / 1000);
  return { min, ticks, at: (v) => `${((Math.max(min, Math.min(1, v)) - min) / span) * 100}%` };
}

/* A cost against the customer's own, to a tenth of a percent below one percent: a runner-up at a
   fortieth of the price is not "0% of yours". */
const ofYours = (r) => (r === null || r === undefined ? 'not priced yet' : r >= 0.995 ? 'yours'
  : `${(r * 100).toFixed(r < 0.01 ? 1 : 0)}% of yours`);

/**
 * How often each way of serving a workload worked on live calls: the figure and the dot are what
 * its calls did, the band is where the true rate most likely sits (a nine in ten chance), and it
 * narrows as calls come in. A row can carry one action, such as switching to it.
 * rows: [{ key, label, role, tone, rate, lo, hi, calls, ratio, bg, action }]
 */
export function RateRows({ rows }) {
  if (!rows.length) return null;
  const ax = rateAxis(rows);
  return (
    <div className="rates" role="table" aria-label="How often calls worked, for each way of serving this workload">
      <div className="rrow rhead" role="row">
        <span role="columnheader">Way of serving</span>
        <span role="columnheader" className="raxis" aria-label={`From ${pct(ax.min)} to 100%`}>
          {ax.ticks.map((t) => <i key={t} style={{ left: ax.at(t) }}>{pct(t)}</i>)}
        </span>
        <span role="columnheader" className="rnum">Worked</span>
        <span role="columnheader" className="rnum">Calls</span>
        <span role="columnheader" className="rnum">Cost</span>
      </div>
      {rows.map((r) => {
        /* A runner-up that has only answered in the background has no calls that were used, only
           answers that matched them or not: drawn as a ring rather than a dot, and read as matched. */
        const bg = !r.calls && r.bg?.calls > 0;
        const known = r.calls > 0 || bg;
        // what its calls did, as counted; the smoothed middle of the band only stands in when that is missing
        const shown = r.rate ?? r.mean;
        const bgShare = bg ? (r.bg.same ?? 0) / r.bg.calls : null;
        return (
        <div className={`rrow ${r.tone || ''}`} role="row" key={r.key}>
          <span role="cell" className="rname">
            <span className="rlabel">{r.label}</span>
            <span className={`rrole ${r.tone || ''}`}>{r.role}</span>
            {r.action && <button className="minig rgo" disabled={r.action.busy} onClick={r.action.onClick}>{r.action.label}</button>}
          </span>
          <span role="cell" className="rtrack" aria-label={r.calls ? `${pct(shown, 1)} worked, likely between ${pct(r.lo, 1)} and ${pct(r.hi, 1)}`
            : bg ? `The same answer on ${r.bg.same ?? 0} of ${r.bg.calls} background answers` : 'No calls yet'}>
            {ax.ticks.map((t) => <i key={t} className="rgrid" style={{ left: ax.at(t) }} />)}
            {known ? (
              <>
                <b className={`rband${r.lo < ax.min ? ' past' : ''}${bg ? ' bg' : ''}`} style={{ left: ax.at(r.lo), width: `calc(${ax.at(r.hi)} - ${ax.at(r.lo)})` }} />
                <b className={`rdot${(bg ? bgShare : shown) < ax.min ? ' past' : ''}${bg ? ' ring' : ''}`} style={{ left: ax.at(bg ? bgShare : shown) }} />
              </>
            ) : <em className="rnone">no calls yet</em>}
          </span>
          <span role="cell" className="rnum rstrong" data-label="worked">{r.calls > 0 ? pct(shown, 1) : bg ? <>{pct(bgShare, 1)}<small>the same</small></> : 'none yet'}</span>
          <span role="cell" className="rnum" data-label="calls">{bg ? <>{num(r.bg.calls)}<small>background</small></> : num(r.calls)}</span>
          <span role="cell" className="rnum" data-label="cost">{ofYours(r.ratio)}</span>
        </div>
        );
      })}
    </div>
  );
}

/** Where a set of calls went, as one bar in parts, with each part named under it. */
export function SplitBar({ parts, empty = 'No calls yet.' }) {
  const total = parts.reduce((a, p) => a + p.n, 0);
  if (!total) return <p className="shareempty">{empty}</p>;
  return (
    <div className="shares">
      <div className="sharebar" role="img"
        aria-label={parts.filter((p) => p.n).map((p) => `${p.label}: ${pct(p.n / total, 1)}`).join(', ')}>
        {parts.filter((p) => p.n > 0).map((p, i) => (
          <span key={i} className={`sp ${p.tone || ''}`} style={{ width: `${(p.n / total) * 100}%` }} />
        ))}
      </div>
      <div className="sharekey">
        {parts.filter((p) => p.n > 0).map((p, i) => (
          <span key={i}><i className={`sp ${p.tone || ''}`} />{p.label}
            <b>{pct(p.n / total, p.n / total < 0.1 ? 1 : 0)}</b><em>{num(p.n)} {p.n === 1 ? 'call' : 'calls'}</em></span>
        ))}
      </div>
    </div>
  );
}

/** Background answers, newest last: filled when they matched the answer that was used. */
export function DotStrip({ items }) {
  if (!items.length) return null;
  return (
    <div className="dots" role="img"
      aria-label={`${items.filter((x) => x !== null && x >= 0.999).length} of the last ${items.length} background answers were the same as the live answer`}>
      {items.map((x, i) => <i key={i} className={x === null ? 'na' : x >= 0.999 ? 'yes' : 'no'} />)}
    </div>
  );
}

/* The frame of the day-by-day chart for a given width. Drawn at the width it is given, like the
   spend chart, so its dates and counts keep their size on a phone. */
function barFrame(width) {
  const OW = width > 0 ? width : 980;
  const narrow = OW < NARROW;
  return { OW, narrow, OH: narrow ? 200 : 250, OL: narrow ? 38 : 50, OR: narrow ? 8 : 18, OT: 16, OB: narrow ? 34 : 40 };
}
const niceTop = (v) => {
  if (v <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow - 1e-9;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
};
const dlab = (ms) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
const dfull = (ms) => new Date(ms).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
export const OUTCOME_PARTS = [
  ['problem', 'A problem was seen', 'bad'],
  ['confirmed', 'Confirmed as working', 'good'],
  ['quiet', 'No sign of a problem', 'quiet'],
  ['recent', 'Too recent to tell', 'recent'],
];

/** Calls day by day, each day's bar in the four ways a call can have turned out. */
export function OutcomeBars({ series }) {
  const n = series.length;
  const [box, width] = useWidth();
  const [at, setAt] = useState(null);
  const { OW, OH, OL, OR, OT, OB, narrow } = barFrame(width);
  const pick = useCallback((clientX) => {
    const el = box.current;
    if (!el || !n) return;
    const r = el.getBoundingClientRect();
    if (!r.width) return;
    const x = ((clientX - r.left) / r.width) * OW;
    const i = Math.floor(((x - OL) / (OW - OL - OR)) * n);
    setAt(Math.max(0, Math.min(n - 1, i)));
  }, [n, OW, OL, OR, box]);
  if (!n) return <div className="chartwrap" ref={box} />;
  const top = niceTop(Math.max(...series.map((d) => d.calls), 1));
  const slot = (OW - OL - OR) / n;
  const barW = Math.max(2, Math.min(22, slot * 0.7));
  const py = (v) => OH - OB - (v / top) * (OH - OB - OT);
  const ticks = [0, top / 2, top];
  const marks = n < 12 || narrow ? [...new Set([0, n >> 1, n - 1])] : [0, Math.floor(n / 3), Math.floor((2 * n) / 3), n - 1];
  const fill = { problem: 'var(--bad)', confirmed: 'var(--ok)', quiet: 'var(--ok)', recent: 'var(--line-strong)' };
  const op = { problem: 0.9, confirmed: 0.95, quiet: 0.38, recent: 0.9 };
  const day = at === null ? null : series[at];
  return (
    <div className="chartwrap" ref={box} tabIndex={0} role="group"
      aria-label="Calls each day, by how they turned out. Use the left and right arrow keys to read each day."
      onPointerMove={(e) => pick(e.clientX)} onPointerLeave={() => setAt(null)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') { e.preventDefault(); setAt((c) => Math.max(0, (c ?? n) - 1)); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); setAt((c) => Math.min(n - 1, (c ?? -1) + 1)); }
        else if (e.key === 'Escape') setAt(null);
      }}
      onFocus={(e) => { if (e.currentTarget.matches(':focus-visible')) setAt((c) => (c === null ? n - 1 : c)); }}
      onBlur={() => setAt(null)}>
      <svg viewBox={`0 0 ${OW} ${OH}`} width="100%" role="img" aria-label="Calls each day, stacked by how they turned out">
        {ticks.map((v) => (
          <g key={v}>
            <line x1={OL} y1={py(v)} x2={OW - OR} y2={py(v)} stroke="var(--line)" strokeWidth="1" />
            <text x={OL - 8} y={py(v) + 3.5} className="m" textAnchor="end" fontSize="10" fill="var(--mut)">{num(v)}</text>
          </g>
        ))}
        {series.map((d, i) => {
          let y = py(0);
          const x = OL + i * slot + (slot - barW) / 2;
          return (
            <g key={d.at} opacity={at === null || at === i ? 1 : 0.55}>
              {OUTCOME_PARTS.map(([k]) => {
                if (!d[k]) return null;
                const h = py(0) - py(d[k]);
                y -= h;
                return <rect key={k} x={x} y={y} width={barW} height={Math.max(0.5, h)} fill={fill[k]} opacity={op[k]} rx={barW > 6 ? 1.5 : 0} />;
              })}
            </g>
          );
        })}
        <line x1={OL} y1={py(0)} x2={OW - OR} y2={py(0)} stroke="var(--line-strong)" strokeWidth="1.2" />
        {marks.map((i, k) => (
          <text key={i} x={OL + i * slot + slot / 2} y={OH - OB + 20} className="m" fontSize="10.5" fill="var(--mut)"
            textAnchor={k === 0 ? 'start' : k === marks.length - 1 ? 'end' : 'middle'}>{dlab(series[i].at)}</text>
        ))}
      </svg>
      {day && (
        <div className={narrow ? 'charttip wide' : `charttip${OL + at * slot > OW * 0.62 ? ' left' : ''}`}
          style={narrow ? undefined : { left: `${((OL + at * slot + slot / 2) / OW) * 100}%` }} aria-live="polite">
          <div className="tipday">{dfull(day.at)}, {num(day.calls)} {day.calls === 1 ? 'call' : 'calls'}</div>
          {OUTCOME_PARTS.map(([k, label, tone]) => (day[k] ? (
            <div className="tiprow" key={k}><span className="tipkey"><i className={`osw ${tone}`} />{label}</span>
              <span className="tipval">{num(day[k])}</span></div>
          ) : null))}
        </div>
      )}
    </div>
  );
}

/** How many steps tasks took, as a small bar chart. */
export function StepsBars({ steps }) {
  const top = Math.max(1, ...steps.map((s) => s.n));
  return (
    <div className="stepsbars" role="img" aria-label={steps.map((s) => `${s.n} tasks took ${s.steps} steps`).join(', ')}>
      {steps.map((s) => (
        <div className="sb" key={s.steps}>
          <span className="sbn">{s.n ? num(s.n) : ''}</span>
          <span className="sbbar"><i style={{ height: `${(s.n / top) * 100}%` }} /></span>
          <span className="sbl">{s.steps}</span>
        </div>
      ))}
    </div>
  );
}

const stepTone = (s) => (s.reward === null || s.reward === undefined ? 'quiet' : s.reward >= 0.5 ? 'good' : 'bad');

/** One task, step by step: each call it made, which model answered, the tools it called, and how it went. */
export function TaskChain({ task }) {
  return (
    <ol className="chain" aria-label={`A task of ${task.steps} steps`}>
      {task.detail.map((s, i) => (
        <li key={s.id} className={`cstep ${stepTone(s)}${s.here ? '' : ' other'}`}>
          {i > 0 && <span className="clink" aria-hidden="true" />}
          <span className="cdot" title={s.why?.length ? s.why.join('; ') : 'No sign of a problem'}>{s.step}</span>
          <span className="tmodel">{s.model}</span>
          {s.tools.length > 0 && <span className="ctools">{s.tools.join(', ')}</span>}
          {s.why?.length > 0 && stepTone(s) === 'bad' && <span className="cwhy">{s.why[0]}</span>}
        </li>
      ))}
    </ol>
  );
}
