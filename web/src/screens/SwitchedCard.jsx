import React from 'react';
import { usd, num, timeIST, dateIST } from '../api.js';
import { inHundred } from '../LearnCharts.jsx';
import { routerName } from '../setupNames.js';

/* A workload we moved to a cheaper model: which model it was on, which one it is on now, what
 * that saves, and how much it comes to over time.
 *
 * It used to show an accuracy and a bar read from whichever measurement happened to be newest.
 * When that one could not set a bar, it knew nothing about the model serving the workload, and
 * the card printed the zero it fell back to as though it were a fact: 100% accuracy, a bar of
 * 100%, and a cost drawn as a dash put down to a month of traffic that had nothing to do with it. Every
 * figure here comes from the measurement the switch was actually made on, from the calls that
 * have actually run since, or from list prices, and each one says which. */

const short = (m) => (m ? String(m).split('/').pop() : 'your model');
/* An estimate is shown to the cent once it reaches a dollar: four decimals on a projection of
   $41 claims a precision no estimate has. Below a dollar the app's own precision stays, so a
   saving of a fraction of a cent still reads as something rather than as $0.00. */
const est = (v) => (Math.abs(v) >= 1 ? `$${Number(v).toFixed(2)}` : usd(v));
const pct1 = (v) => `${Number(v).toFixed(1)}%`;
const pct2 = (v) => `${Number(v).toFixed(2)}%`;
const months = (m) => (m === 1 ? 'Next month' : m === 12 ? 'Next 12 months' : `Next ${m} months`);

/* How a switch is served: one model, the customer's own thinking less, the customer's own from the
   provider that sells it most cheaply, a checked cheaper model or a pick made call by call. Read from
   the switch's key first, which names the last two apart ("#lighter", "#cheapest"): the customer's
   own model from its cheapest provider used to be called thinking less. A switch made before
   strategies were kept is one model. */
const kindOf = (s) => {
  if (s.kind === 'cascade' || s.kind === 'router') return s.kind;
  const key = String(s.key || '');
  if (key.endsWith('#cheapest')) return 'cheapest';
  if (key.endsWith('#lighter')) return 'lighter';
  if (s.spec?.kind === 'model' && s.spec.model === s.from) return s.spec.recipe?.pinned && !s.spec.recipe?.reasoning ? 'cheapest' : 'lighter';
  return 'model';
};
const nameOf = (s) => {
  const k = kindOf(s);
  if (k === 'cascade') return `${short(s.spec.first.model)}, checked`;
  if (k === 'router') return routerName(s.spec, s.from);
  if (k === 'lighter') return `${short(s.from)}, thinking less`;
  if (k === 'cheapest') return `${short(s.from)}, from its cheapest provider`;
  return short(s.to);
};

/** Why it was switched, from the measurement it was switched on. */
function whyLine(s) {
  const from = short(s.from);
  const to = nameOf(s);
  const ev = s.evidence;
  if (!ev) return s.how === 'you' ? `You switched it to ${to}.` : `It was switched to ${to}.`;
  const on = ev.escalated === null || ev.escalated === undefined || !['cascade', 'router'].includes(kindOf(s)) ? ''
    : kindOf(s) === 'cascade' ? `, sending ${inHundred(ev.escalated / 100)} calls on to ${from} when the check was unsure`
      : `, sending ${inHundred(ev.escalated / 100)} calls to ${from}`;
  const measured = `its answers differed from ${from}'s on ${pct1(ev.gap)} of ${num(ev.sample)} calls${on}`;
  if (ev.verdict === 'cleared') {
    return `It cleared your bar in the measurement on ${timeIST(ev.at)} IST: ${measured}, inside a bar of ${pct2(ev.floor)}.`;
  }
  return `You approved it after the measurement on ${timeIST(ev.at)} IST, where ${measured}, against a bar of ${pct2(ev.floor)}.`;
}

/* How many more days of saving pay back what is still short. The card has the days that pay back the
   whole of what measuring cost; what is left is that share of it, not all of it again. */
function leftDays(s, so) {
  const m = s.measuring || {};
  const total = (m.spent || 0) + (m.background || 0) + (m.graded || 0);
  if (!(m.paybackDays > 0) || !(total > 0) || !(so?.net < 0)) return null;
  const perDay = total / m.paybackDays;
  return Math.max(1, Math.ceil(-so.net / perDay));
}

/** What the newest measurement since the switch found about it, or when the next one is due. */
function checkLine(s) {
  const from = short(s.from);
  const to = nameOf(s);
  const c = s.latest;
  if (!c) {
    if (!s.cadenceDays) return 'It has not been checked again since. It is only re-measured when you press Measure now.';
    return s.nextCheckAt
      ? `It has not been checked again yet. The next measurement is due around ${dateIST(s.nextCheckAt)} IST.`
      : 'It has not been checked again yet.';
  }
  const when = `Checked again on ${timeIST(c.at)} IST`;
  if (c.outcome === 'unmeasurable') {
    return `${when}, but ${from} gave a different answer to the same call ${pct1(c.noise)} of the time, so no bar `
      + 'could be set and this switch has not been re-confirmed.';
  }
  if (c.gap == null) return `${when}, but ${to} was not among the models tried, so this switch has not been re-confirmed.`;
  const at = `${pct1(c.gap)} against a bar of ${pct2(c.floor)}`;
  if (c.verdict === 'cleared') return `${when}: still inside your bar, ${at}.`;
  if (c.verdict === 'review') return `${when}: just outside your bar, ${at}. Worth a look.`;
  if (c.verdict === 'insufficient') return `${when}, on too few calls to judge.`;
  return `${when}: it no longer clears your bar, ${at}. You may want to switch back.`;
}

/** A saving that is really a cost says so, rather than printing a minus sign in green. */
const Saved = ({ v, fmt = usd }) => (v < 0
  ? <span className="num swmore">{fmt(-v)} more</span>
  : <span className="num swsaved">{fmt(v)}</span>);

/* What the monthly figures are based on, in words: a day is "the last day", not "1 days". The
   saving projected is the one on calls that come through Understudy, since a copy has already
   run on the original model; with none of those yet, it is what routing all of it would save. */
const over = (days, what) => (Math.round(days) <= 1
  ? `At the pace of the last day`
  : `At your ${what} over the last ${num(Math.round(days))} days`);

const basisLine = (v, from) => {
  if (!v.monthly) return 'No calls in the last 30 days, so there is nothing to project.';
  if (v.basis === 'all') {
    return `If all of it ran through Understudy. ${over(v.days, 'volume')}: about ${num(Math.round(v.monthly))} calls a month.`;
  }
  const routedLine = `${over(v.routedDays, 'routed volume')}: about ${num(Math.round(v.monthlyRouted))} calls a month through Understudy.`;
  if (!v.copies) return routedLine;
  return `${routedLine} Another ${num(v.copies)} ${v.copies === 1 ? 'call' : 'calls'} in the last 30 days arrived as copies, `
    + `which already ran on ${from} at your own provider, so they are not in these figures.`;
};

/** Why a model's call has no price: it is not sold, or there is no call of a known size yet. */
const unpriced = (listed) => (listed
  ? 'No call of a known size yet, so a call cannot be priced.'
  : 'Not in the price list, so it cannot be priced.');

export default function SwitchedCard({ s }) {
  const from = short(s.from);
  const to = nameOf(s);
  const kind = kindOf(s);
  const p = s.prices;
  const priced = p.fromPerCall != null && p.toPerCall != null && p.cheaperPct != null;
  const month = s.projection.find((r) => r.months === 1);
  const so = s.soFar;

  return (
    <>
      <span className="eyebrow eyeok">
        {s.how === 'you' ? 'Switched because you approved it' : 'Switched automatically'} · {timeIST(s.at)} IST
      </span>
      <h2>{kind === 'lighter' ? `${from} now thinks less before it answers`
        : kind === 'cheapest' ? `${from} now comes from the provider that sells it most cheaply`
          : `Moved from ${from} to ${to}`}</h2>
      <p>{whyLine(s)} {checkLine(s)}</p>
      {/* How its requests flow now is drawn once, at the top of the page (ValuePipeline.jsx). */}

      <div className="swtiles">
        <div className="kpi">
          <div className="kk">Your original model</div>
          <div className="kv swmodel">{from}</div>
          <div className="ks">
            {p.fromPerCall == null ? unpriced(p.fromListed) : `${usd(p.fromPerCall)} a call at its list price`}
          </div>
        </div>
        <div className="swarrow" aria-hidden="true">→</div>
        <div className="kpi">
          <div className="kk">Running now</div>
          <div className="kv swmodel">{to}</div>
          <div className="ks">
            {p.toPerCall == null ? unpriced(p.toListed)
              : (kind === 'cascade' || kind === 'router') && p.toPricedBy === 'measured'
                ? `${usd(p.toPerCall)} a call on average, counting every check and every call sent on, our ${p.feePct}% fee included`
                : kind === 'router'
                  ? `${usd(p.toPerCall)} a call at the list price of ${short(s.spec?.cheap?.model)}, which answers the most calls, before any sent to ${from}, our ${p.feePct}% fee included`
                  : kind === 'cascade'
                  ? `${usd(p.toPerCall)} a call at the cheaper model's list price, before any check or call sent on, our ${p.feePct}% fee included`
                  : `${usd(p.toPerCall)} a call, our ${p.feePct}% fee included`}
          </div>
        </div>
        <div className="kpi">
          <div className="kk">Saving</div>
          {/* priced means both calls have a price and there is a percentage between them; a
              missing percentage used to read as "0% less", because null >= 0 */}
          <div className="kv">
            {!priced || p.cheaperPct == null ? 'Not priced yet'
              : p.cheaperPct >= 0 ? `${Math.round(p.cheaperPct)}% less` : `${Math.round(-p.cheaperPct)}% more`}
          </div>
          <div className="ks">
            {!priced || p.cheaperPct == null ? 'Both calls need a price to compare them.'
              : !s.volume.monthly ? 'per call. No calls in the last 30 days to put a monthly figure on.'
                /* with nothing routed yet, copies have already run on the original model, so this
                   is what routing would save or cost, not what is happening */
                : s.volume.basis === 'all'
                  ? `per call. About ${est(Math.abs(month.saved))} a month${month.saved < 0 ? ' more' : ''}, once this workload runs through Understudy`
                  : month.saved < 0 ? `per call, about ${est(-month.saved)} a month more on the calls through Understudy`
                    : `per call, about ${est(month.saved)} a month on the calls that come through Understudy`
                      + (s.volume.allMonthSaved != null && s.volume.allMonthSaved > month.saved
                        ? `, or ${est(s.volume.allMonthSaved)} if your copies came through as well` : '')}
          </div>
        </div>
      </div>

      {priced && (
        <div className="swcost">
          <div className="swhead">
            <span className="kk">Estimated cost over time</span>
            <span className="swbasis">{basisLine(s.volume, from)}</span>
          </div>
          <div className="swtable" role="table" aria-label={`What this workload costs on ${from} and on ${to}`}>
            <div className="swrow swth" role="row">
              <span role="columnheader">Period</span>
              <span role="columnheader">On {from}</span>
              <span role="columnheader">On {to}</span>
              <span role="columnheader">You save</span>
            </div>
            {so.calls > 0 ? (
              <div className="swrow swactual" role="row">
                <span role="cell">Since {dateIST(s.at)} IST, {num(so.calls)} {so.calls === 1 ? 'call' : 'calls'} <em>actual</em></span>
                <span role="cell" className="num">{usd(so.wouldHave)}</span>
                <span role="cell" className="num">{usd(so.paid)}</span>
                <span role="cell"><Saved v={so.saved} /></span>
              </div>
            ) : (
              <div className="swrow swempty" role="row">
                <span role="cell">
                  {so.copies > 0
                    ? `Since the switch, ${num(so.copies)} ${so.copies === 1 ? 'call' : 'calls'} arrived as copies. A copy has already run on ${from} at your own provider, so nothing has been saved on them. Send this workload through Understudy and the saving below starts.`
                    : 'No calls have run since the switch yet. The first ones will show here, as actual figures.'}
                </span>
              </div>
            )}
            {s.volume.monthly > 0 && s.projection.map((r) => (
              <div className="swrow" role="row" key={r.months}>
                <span role="cell">{months(r.months)}</span>
                <span role="cell" className="num">{est(r.from)}</span>
                <span role="cell" className="num">{est(r.to)}</span>
                <span role="cell"><Saved v={r.saved} fmt={est} /></span>
              </div>
            ))}
          </div>
          <p className="swnote">
            Estimates use today&rsquo;s list prices and the size of this workload&rsquo;s recent calls.{' '}
            {from} is priced as it costs without us; {to} includes our {p.feePct}% routing fee.
            {so.calls > 0 && so.wouldPricedBy === 'measured'
              ? ` What the actual calls would have cost on ${from} is their cost divided by what the measurement found ${to} costs against it on the same calls.`
              : ''}
          </p>
          {(s.measuring.spent > 0 || s.measuring.background > 0 || s.measuring.graded > 0) && (
            <p className="swnote">
              Finding and checking this switch has cost {usd((s.measuring.spent || 0) + (s.measuring.background || 0) + (s.measuring.graded || 0))}
              {s.measuring.background > 0 || s.measuring.graded > 0
                ? ` (${[`${usd(s.measuring.spent || 0)} measuring`,
                  s.measuring.background > 0 ? `${usd(s.measuring.background)} background answers` : null,
                  s.measuring.graded > 0 ? `${usd(s.measuring.graded)} answers read in the background` : null].filter(Boolean).join(', ')})`
                : ' in measuring'}.
              {so.net != null && so.calls > 0
                ? (so.net >= 0
                  ? ` With that paid for, the switch is ${usd(so.net)} ahead so far.`
                  : ` With that counted, it is ${usd(-so.net)} short of paying for itself so far${leftDays(s, so) ? `, about ${num(leftDays(s, so))} ${leftDays(s, so) === 1 ? 'day' : 'days'} more of saving at this pace` : ''}.`)
                : s.measuring.paybackDays ? ` At the pace above, the saving pays that back in about ${num(s.measuring.paybackDays)} ${s.measuring.paybackDays === 1 ? 'day' : 'days'}.` : ''}
            </p>
          )}
        </div>
      )}
    </>
  );
}
