import React, { useEffect, useState } from 'react';
import { api, usd, num, dateIST } from '../api.js';
import { RateRows, SplitBar, DotStrip, pct, inHundred } from '../LearnCharts.jsx';

/* What live calls are teaching us about a workload, and how much it may experiment.
 *
 * A measurement shows that a cheaper way of serving gives the customer's own answers on a sample.
 * Whether answers work only shows afterwards, on live calls, so each way of serving keeps a running
 * record, drawn here as a rate with a range around it. The setting below says how much of the
 * traffic may be used to learn, and the page says, in numbers, what the records will make happen. */

const short = (m) => String(m || '').split('/').pop();

const MODES = [
  ['off', 'Off', 'Nothing is tried. What serves answers every call, and nothing is learned about the runners-up.'],
  ['shadow', 'In the background', 'Runners-up answer copies of a few calls in the background. The answers your app gets never change: you see how closely theirs matched, and decide.'],
  ['careful', 'Careful, 2 in 100', 'Two calls in every hundred are served another way: one by your own model, to compare against, and one by a cheaper runner-up.'],
  ['normal', 'Normal, 5 in 100', 'Five calls in every hundred are served another way, so live results arrive about twice as fast as careful.'],
];

const TONE = { serving: 'serving', yardstick: 'yours', 'runner-up': 'runner', 'set aside': 'aside' };
const ROLE = { serving: 'Serving now', yardstick: 'Your own model', 'runner-up': 'Runner-up', 'set aside': 'Set aside' };

export default function Learning({ w, d, onReload }) {
  const [mode, setMode] = useState(null);
  const [budget, setBudget] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!d) return;
    setMode(d.explore.chosen ? d.explore.mode : 'auto');
    setBudget(Number(d.explore.budgetUsd).toFixed(2));
  }, [d]);

  if (!d) {
    return (
      <section className="opt learn">
        <div className="opthead"><h2>What live calls are teaching us</h2></div>
        <div className="loading">Reading the records…</div>
      </section>
    );
  }

  const ref = w.reference;
  const e = d.explore;
  const rows = [];
  const push = (x) => {
    if (!x) return;
    rows.push({
      key: x.id || x.role, label: x.role === 'yardstick' ? `${short(ref)} (yours)` : x.label,
      role: x.role === 'yardstick' && !d.serving ? 'Your own model, serving now' : ROLE[x.role] || x.role,
      tone: x.role === 'yardstick' && !d.serving ? 'serving' : TONE[x.role], mean: x.live.mean, lo: x.live.lo, hi: x.live.hi,
      calls: x.live.calls, ratio: x.ratio, bg: x.shadow,
    });
  };
  /* Runners-up are only tried when they cost less than what serves now: one that costs more has
     nothing to offer an experiment, and drawn here it said "no calls yet" for ever. */
  const servingRatio = d.serving?.ratio ?? 1;
  const tryable = (o) => o.ratio !== null && o.ratio !== undefined && o.ratio < servingRatio;
  const dearer = d.others.filter((o) => o.role === 'runner-up' && !tryable(o) && !o.live.calls && !o.shadow.calls);
  push(d.serving);
  push(d.baseline);
  d.others.filter((o) => o.role === 'runner-up' && (tryable(o) || o.live.calls > 0)).forEach(push);
  d.others.filter((o) => o.role === 'set aside' && o.live.calls > 0).forEach(push);
  const anyCalls = rows.some((r) => r.calls > 0 || r.bg?.calls > 0);
  const anyBg = rows.some((r) => !r.calls && r.bg?.calls > 0);

  // where this week's calls went, a cascade's sent-on calls shown as their own part
  const parts = [];
  if (d.serving) {
    const sentOn = d.serving.week.escalated || 0;
    parts.push({ label: d.serving.label, n: d.serving.week.calls - sentOn, tone: 'serving' });
    if (sentOn) parts.push({ label: `sent on to ${short(ref)} by the check`, n: sentOn, tone: 'senton' });
  }
  parts.push({ label: d.serving ? `${short(ref)}, to compare` : `${short(ref)} (yours)`, n: d.baseline.week.calls, tone: d.serving ? 'yours' : 'serving' });
  for (const o of d.others) if (o.week.calls) parts.push({ label: o.label, n: o.week.calls, tone: o.role === 'runner-up' ? 'runner' : 'aside' });

  const runners = d.others.filter((o) => o.role === 'runner-up' && tryable(o));
  const matched = d.shadow.recent.filter((x) => x.agreement !== null);

  const save = async (patch) => {
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      await api.setExplore(w.id, patch);
      setSaved(true);
      await onReload();
    } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  const picked = mode === 'auto' ? e.mode : mode;
  const budgetOk = budget !== '' && Number.isFinite(Number(budget)) && Number(budget) >= 0 && Number(budget) <= 1000;

  return (
    <section className="opt learn">
      <div className="opthead">
        <h2>What live calls are teaching us</h2>
        <span className="s">{num(d.weekCalls)} {d.weekCalls === 1 ? 'call' : 'calls'} {d.weekFromSwitch ? 'since the switch' : 'in the last 7 days'}</span>
      </div>
      <div className="cbody">
        <p className="lintro">
          A measurement checks that a cheaper way of serving gives your own answers on a sample of your calls.
          Whether an answer actually <b>worked</b> only shows afterwards: the same call sent again a moment
          later, a tool that failed on what the model gave it, a person saying it was wrong, or a result your
          own system reports to us. Every call adds to a running record for the way it was served.
        </p>

        {anyCalls || rows.length > 1 ? (
          <>
            <RateRows rows={rows} />
            <p className="lkey">
              <span><i className="kdot" />how often its calls worked</span>
              <span><i className="kband" />where the real rate most likely is, a 9 in 10 chance</span>
              {anyBg && <span><i className="kring" />how often its background answers matched yours</span>}
              <span>More calls make the band narrower. A call from {d.halfLifeDays} days ago counts half as much as one from today.</span>
            </p>
            {dearer.length > 0 && (
              <p className="lsmall">
                {dearer.length === 1 ? `${dearer[0].label} also cleared` : `${dearer.length} more also cleared`} the last
                measurement, but {dearer.length === 1 ? 'it costs' : 'they cost'} more than what serves now, so {dearer.length === 1 ? 'it is' : 'they are'} not
                tried: {dearer.map((o) => `${o.label} (${Math.round(o.ratio * 100)}% of yours)`).join(', ')}.
              </p>
            )}
          </>
        ) : (
          <div className="optempty">No calls have come through Understudy on this workload yet. Records start with the first one.</div>
        )}

        <div className="lnext">
          <div className="kk">What happens next</div>
          <ul>{nextSteps(d, w).map((t, i) => <li key={i}>{t}</li>)}</ul>
        </div>

        <div className="lsplit">
          <div className="kk">{d.weekFromSwitch ? `Where calls went since the switch on ${dateIST(d.weekSince)}` : 'Where this week\u2019s calls went'}</div>
          <SplitBar parts={parts} empty="No calls through Understudy in the last 7 days." />
        </div>

        {(matched.length > 0 || e.mode === 'shadow') && (
          <div className="lshadow">
            <div className="kk">Background answers</div>
            {matched.length ? (
              <>
                <DotStrip items={[...matched].reverse().map((x) => x.agreement)} />
                <p className="lsmall">
                  The last {num(matched.length)} background answers, oldest first: filled where the answer matched the one your app got.
                  {' '}{num(matched.filter((x) => x.agreement >= 0.5).length)} of {num(matched.length)} matched.
                  {d.shadow.spentUsd > 0 ? ` They have cost ${usd(d.shadow.spentUsd)} in all, charged like a measurement.` : ''}
                </p>
              </>
            ) : (
              <p className="lsmall">None yet. {runners.length ? `Runners-up answer ${inHundred(e.share)} calls in the background as they arrive.` : 'They start once a measurement finds a runner-up cheaper than what answers now.'}</p>
            )}
          </div>
        )}
      </div>

      <div className="lset">
        <div className="lsethead">
          <div>
            <div className="kk">Experiments on this workload</div>
            <p className="lsmall">{MODES.find((m) => m[0] === picked)?.[2]}{mode === 'auto' ? ` This is what ${w.optimizeMode === 'ask' ? '“Ask me first”' : '“Optimize automatically”'} uses unless you choose.` : ''}</p>
          </div>
        </div>
        <div className="seg lseg" role="radiogroup" aria-label="How much this workload may experiment">
          <button role="radio" aria-checked={mode === 'auto'} className={`segb${mode === 'auto' ? ' on' : ''}`} disabled={busy}
            onClick={() => { setMode('auto'); save({ mode: 'auto' }); }}>Default</button>
          {MODES.map(([k, label]) => (
            <button key={k} role="radio" aria-checked={mode === k} className={`segb${mode === k ? ' on' : ''}`} disabled={busy}
              onClick={() => { setMode(k); save({ mode: k }); }}>{label}</button>
          ))}
        </div>
        <div className="lbudget">
          <label htmlFor={`budget-${w.id}`}>At most</label>
          <span className="lmoney">$<input id={`budget-${w.id}`} className="inp" inputMode="decimal" value={budget}
            onChange={(x) => { setBudget(x.target.value); setSaved(false); }} aria-describedby={`budget-note-${w.id}`} /></span>
          <span>a day added to your bill by experiments</span>
          <button className="minig" disabled={busy || !budgetOk || Number(budget) === Number(e.budgetUsd)}
            onClick={() => save({ budgetUsd: Number(budget) })}>Save</button>
          {saved && !busy && <span className="lsaved">Saved</span>}
        </div>
        <p className="lsmall" id={`budget-note-${w.id}`}>
          Today so far: {usd(e.spentToday)} of {usd(e.budgetUsd)}.
          {' '}{picked === 'shadow'
            ? 'A background answer is paid for in full, like a measurement, because your app still gets its answer from what serves.'
            : picked === 'off' ? 'Nothing is being tried, so nothing is spent.'
              : 'A runner-up cheaper than what serves adds nothing; your own model, used to compare, adds the difference in price.'}
          {e.reason ? ` ${e.reason}` : ''}
        </p>
        {err && <div className="errbox">{err}</div>}
      </div>
    </section>
  );
}

/* What the records will make happen, as sentences with this workload's own numbers in them. */
function nextSteps(d, w) {
  const ref = short(w.reference);
  const e = d.explore;
  const out = [];
  const need = (x) => Math.max(0, 150 - x.live.calls);
  if (e.mode === 'off') {
    out.push('Experiments are off, so nothing else is tried. Records only grow for what serves, and a measurement on your schedule still checks it.');
    return out;
  }
  if (d.serving && e.live) {
    out.push(`If ${d.serving.label} starts working clearly less often than ${ref}, we switch back to ${ref} on our own. `
      + `“Clearly” means we are at least ${Math.round(d.confidence * 100)} in 100 sure it is more than ${Math.round(d.tolerance * 100)} calls in 100 worse, `
      + `from at least ${d.minCalls} of its calls.`);
    // a runner-up is only tried when it costs less than what serves
    const runner = d.others.find((o) => o.role === 'runner-up' && o.ratio !== null && o.ratio < (d.serving.ratio ?? 1));
    if (runner) {
      out.push(`${runner.label} costs less than what serves. Once its calls are shown to work as often, it serves this workload instead. `
        + (need(runner) > 0 ? `That usually takes about 150 of its calls; it has ${num(runner.live.calls)}.` : 'It has enough calls; it moves as soon as its record is as good.'));
    } else {
      out.push('No cheaper runner-up is being tried. The next measurement may find one.');
    }
  } else if (e.mode === 'shadow') {
    out.push('Nothing changes on its own: your app always gets its answers from what serves now.');
    out.push(`When a runner-up has answered at least ${d.minCalls} calls in the background and matched your answers inside your bar, we say so in the activity feed, and you can approve it here.`);
  } else if (!d.serving) {
    out.push('Live experiments start once this workload is switched to something cheaper. Until then your own model answers every call.');
  }
  return out;
}
