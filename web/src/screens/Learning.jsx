import React, { useEffect, useState } from 'react';
import { api, usd, num } from '../api.js';
import { RateRows, SplitBar, DotStrip, inHundred } from '../LearnCharts.jsx';

/* What live calls are teaching us about a workload, and how much it may experiment.
 *
 * A measurement shows that a cheaper way of serving gives the customer's own answers on a sample.
 * Whether answers work only shows afterwards, on live calls, so each way of serving keeps a running
 * record, drawn here as a rate with a range around it. The setting below says how much of the
 * traffic may be used to learn, and the page says, in numbers, what the records will make happen.
 * Which runners-up can be tried is the server's to say, never worked out again here. */

const short = (m) => String(m || '').split('/').pop();

// what each setting does, in words, with the shares the server actually uses
const modesFor = (shares) => [
  ['off', 'Off', 'Nothing is tried. What serves answers every call, and nothing is learned about the runners-up.'],
  ['shadow', 'In the background', `Runners-up answer copies of about ${inHundred(shares.shadow)} calls in the background. The answers your app gets never change: you see how closely theirs matched, and decide.`],
  ['careful', `Careful, ${inHundred(shares.careful)}`, `Up to ${inHundred(shares.careful)} calls are served another way: half by your own model, to compare against, and half by a cheaper runner-up when there is one.`],
  ['normal', `Normal, ${inHundred(shares.normal)}`, `Up to ${inHundred(shares.normal)} calls are served another way, so live results arrive faster than careful.`],
];

const TONE = { serving: 'serving', yardstick: 'yours', 'runner-up': 'runner', 'set aside': 'aside' };
const ROLE = { serving: 'Serving now', yardstick: 'Your own model', 'runner-up': 'Runner-up', 'set aside': 'Set aside' };

export default function Learning({ w, d, err: loadErr, onReload, onSwitched }) {
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
        {loadErr ? <div className="errbox" style={{ margin: 16 }}>The records could not be read: {loadErr}</div>
          : <div className="loading">Reading the records…</div>}
      </section>
    );
  }

  const ref = w.reference;
  const e = d.explore;
  const MODES = modesFor(e.shares);
  const ask = w.optimizeMode === 'ask';

  const switchTo = async (o) => {
    setBusy(true);
    setErr(null);
    try {
      await api.promote(w.id, o.key);
      await onSwitched?.();
    } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };

  const rows = [];
  const push = (x, action = null) => {
    if (!x) return;
    rows.push({
      key: x.id || x.role, label: x.role === 'yardstick' ? `${short(ref)} (yours)` : x.label,
      role: x.role === 'yardstick' && !d.serving ? 'Your own model, serving now' : ROLE[x.role] || x.role,
      tone: x.role === 'yardstick' && !d.serving ? 'serving' : TONE[x.role],
      rate: x.live.rate, mean: x.live.mean, lo: x.live.lo, hi: x.live.hi, calls: x.live.calls, ratio: x.ratio, bg: x.shadow, action,
      // answers read in the background, where there are any: how many, and how many were right
      graded: x.graded || null,
    });
  };
  // the ones that can be tried now, said by the server; the rest that cleared are counted in one line
  const runners = d.others.filter((o) => o.role === 'runner-up' && o.tryable);
  const dearer = d.others.filter((o) => o.role === 'runner-up' && !o.tryable && !o.live.calls && !o.shadow.calls);
  push(d.serving);
  push(d.baseline);
  for (const o of d.others.filter((x) => x.role === 'runner-up' && (x.tryable || x.live.calls > 0 || x.shadow.calls > 0))) {
    push(o, o.key ? { label: ask ? 'Approve this' : 'Switch to this', busy, onClick: () => switchTo(o) } : null);
  }
  d.others.filter((o) => o.role === 'set aside' && o.live.calls > 0).forEach((o) => push(o));
  const anyCalls = rows.some((r) => r.calls > 0 || r.bg?.calls > 0);
  const anyBg = rows.some((r) => !r.calls && r.bg?.calls > 0);

  // where the calls went, a strategy's calls to your own model shown as their own part
  const parts = [];
  if (d.serving) {
    const sentOn = d.serving.week.escalated || 0;
    parts.push({ label: d.serving.label, n: d.serving.week.calls - sentOn, tone: 'serving' });
    if (sentOn) {
      parts.push({ label: d.serving.kind === 'router' ? `picked for ${short(ref)}` : `sent on to ${short(ref)} by the check`, n: sentOn, tone: 'senton' });
    }
  }
  parts.push({ label: d.serving ? `${short(ref)}, to compare` : `${short(ref)} (yours)`, n: d.baseline.week.calls, tone: d.serving ? 'yours' : 'serving' });
  for (const o of d.others) if (o.week.calls) parts.push({ label: o.label, n: o.week.calls, tone: o.role === 'runner-up' ? 'runner' : 'aside' });

  const matched = d.shadow.recent.filter((x) => x.agreement !== null);
  const same = matched.filter((x) => x.agreement >= 0.999).length;

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
  const typed = Number(budget);
  const budgetOk = budget.trim() !== '' && Number.isFinite(typed) && typed >= 0 && typed <= 1000 && (typed === 0 || typed >= 0.01);
  const liveOnAsk = ask && (picked === 'careful' || picked === 'normal');

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
            {rows.some((r) => r.graded?.calls > 0) && (
              <p className="lsmall">
                Read in the background:{' '}
                {rows.filter((r) => r.graded?.calls > 0)
                  .map((r) => `${r.label}, ${num(r.graded.right)} of ${num(r.graded.calls)} answers right`).join('; ')}.
                {' '}The same reader reads every strategy, so a difference between them is theirs.
              </p>
            )}
            <p className="lkey">
              <span><i className="kdot" />how often its calls worked</span>
              <span><i className="kband" />where the real rate most likely is, a 9 in 10 chance</span>
              {anyBg && <span><i className="kring" />how often its background answers were the same as yours</span>}
              <span>More calls make the band narrower. A call from {d.halfLifeDays} days ago counts half as much as one from today.</span>
            </p>
            {dearer.length > 0 && (
              <p className="lsmall">
                {dearer.length === 1 ? `${dearer[0].label} also cleared` : `${dearer.length} more also cleared`} the last
                measurement but {dearer.length === 1 ? 'is' : 'are'} not tried, because {dearer.length === 1 ? 'it costs' : 'they cost'} more
                than what answers now{e.servingCostKnown ? '' : ', or because what serves has no measured cost yet'}:{' '}
                {dearer.map((o) => `${o.label} (${o.ratio === null || o.ratio === undefined ? 'not priced yet'
                  : `${(o.ratio * 100).toFixed(o.ratio < 0.01 ? 1 : 0)}% of yours`})`).join(', ')}.
              </p>
            )}
          </>
        ) : (
          <div className="optempty">No calls have come through Understudy on this workload yet. Records start with the first one.</div>
        )}

        <div className="lnext">
          <div className="kk">What happens next</div>
          <ul>{nextSteps(d, w, runners).map((t, i) => <li key={i}>{t}</li>)}</ul>
        </div>

        <div className="lsplit">
          <div className="kk">{d.weekFromSwitch ? 'Where calls went since the switch' : 'Where this week’s calls went'}</div>
          <SplitBar parts={parts} empty="No calls through Understudy in the last 7 days." />
        </div>

        {(matched.length > 0 || e.mode === 'shadow') && (
          <div className="lshadow">
            <div className="kk">Background answers</div>
            {matched.length ? (
              <>
                <DotStrip items={[...matched].reverse().map((x) => x.agreement)} />
                <p className="lsmall">
                  The last {num(matched.length)} background answers, oldest first: filled where the answer was the same as the one your app got.
                  {' '}{num(same)} of {num(matched.length)} were the same.
                  {d.shadow.spentUsd > 0 ? ` They have cost ${usd(d.shadow.spentUsd)} in all, charged like a measurement.` : ''}
                </p>
              </>
            ) : (
              <p className="lsmall">None yet. {runners.length ? `Runners-up answer about ${inHundred(e.shares.shadow)} calls in the background as they arrive.` : 'They start once a measurement finds a runner-up cheaper than what answers now.'}</p>
            )}
          </div>
        )}
      </div>

      <div className="lset">
        <div className="lsethead">
          <div>
            <div className="kk">Experiments on this workload</div>
            <p className="lsmall">
              {MODES.find((m) => m[0] === picked)?.[2]}
              {mode === 'auto' ? ` This is what ${ask ? '“Ask me first”' : '“Optimize automatically”'} uses unless you choose.` : ''}
              {liveOnAsk ? ' Switches still wait for your approval, but these experimental calls are answered another way without asking.' : ''}
            </p>
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
          <label htmlFor={`budget-${w.id}`}>Daily limit for experiments, at most</label>
          <span className="lmoney">$<input id={`budget-${w.id}`} className="inp" inputMode="decimal" value={budget}
            onChange={(x) => { setBudget(x.target.value); setSaved(false); }} aria-describedby={`budget-note-${w.id}`} /></span>
          <span>a day added to your bill</span>
          <button className="minig" disabled={busy || !budgetOk || typed === Number(e.budgetUsd)}
            onClick={() => save({ budgetUsd: Math.round(typed * 100) / 100 })}>Save</button>
          {saved && !busy && <span className="lsaved" role="status">Saved</span>}
        </div>
        <p className="lsmall" id={`budget-note-${w.id}`}>
          Today so far (IST): {usd(e.spentToday)} of {usd(e.budgetUsd)}, our fee included.
          {' '}{picked === 'shadow'
            ? 'A background answer is paid for in full, like a measurement, because your app still gets its answer from what serves.'
            : picked === 'off' ? 'Nothing is being tried, so nothing is spent.'
              : 'A runner-up cheaper than what serves adds nothing; your own model, used to compare, adds the difference in price.'}
          {!budgetOk && budget.trim() !== '' ? ' The limit has to be $0, or between one cent and $1,000.' : ''}
          {e.reason ? ` ${e.reason}` : ''}
        </p>
        {err && <div className="errbox">{err}</div>}
      </div>
    </section>
  );
}

/* What the records will make happen, as sentences with this workload's own numbers in them. */
function nextSteps(d, w, runners) {
  const ref = short(w.reference);
  const e = d.explore;
  const ask = w.optimizeMode === 'ask';
  const out = [];
  if (e.mode === 'off') {
    out.push('Experiments are off, so nothing else is tried. Records only grow for what serves, and a measurement on your schedule still checks it.');
    return out;
  }
  if (d.serving && e.live) {
    out.push(`If ${d.serving.label} starts working clearly less often than ${ref}, we switch back to ${ref} on our own. `
      + `“Clearly” means more than ${Math.max(1, Math.round((d.tolerance * 100) / 2))} calls in 100 worse, from at least ${d.minCalls} calls on each since the switch, `
      + 'shown by a range that holds however often we look, so a switch back is almost never chance.');
    if (d.graded) {
      out.push(`We also read about ${num(d.graded.perDay)} of each strategy's answers a day in the background, to see how often each is right where `
        + 'a wrong answer shows nothing in your traffic. Those readings can switch back, or move on, by themselves.');
    }
    const runner = runners[0];
    if (!e.servingCostKnown) {
      out.push('No runner-up is tried until a measurement prices what serves now against your own model.');
    } else if (runner) {
      out.push(`${runner.label} cleared the bar and costs less than what serves. Once its calls are shown to work no more than `
        + `${Math.round(d.tolerance * 100)} calls in 100 less often than what serves and than ${ref}, however often we look, `
        + (ask ? 'we tell you in the activity feed, and you can approve it here.' : 'it starts serving this workload, a share of the calls at a time.')
        + ` That usually takes a thousand or more of its calls, and as many of ${ref}'s; it has ${num(runner.live.calls)}.`);
    } else {
      out.push('No cheaper runner-up is being tried. The next measurement may find one.');
    }
  } else if (e.mode === 'shadow') {
    out.push('Background answers never change an answer your app gets, and nothing is switched to without your approval.');
    out.push(`When a runner-up has answered at least ${d.minCalls} calls in the background and given the same answer as yours inside your bar, we say so in the activity feed, and you can approve it here.`);
  } else if (!d.serving) {
    out.push('Live experiments start once this workload is switched to something cheaper. Until then your own model answers every call.');
  }
  return out;
}
