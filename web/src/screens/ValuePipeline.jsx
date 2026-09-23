import React, { useEffect, useMemo, useState } from 'react';
import { api, usd, num, dateIST, timeIST } from '../api.js';
import { useWidth } from '../Charts.jsx';
import { inHundred } from '../LearnCharts.jsx';

/* What Understudy is doing for one workload: the first thing its page says, drawn more than written.
 *
 *   The figures       what its requests cost against sending every one to the customer's own model,
 *                     whether answers work as often and come as fast as before, and how many requests
 *                     were rescued when a provider failed. Each says how it is counted when tapped.
 *   The flow          how every request is served right now, as boxes to tap; the thicker a line, the
 *                     more requests take it. Beside it, what is being tried in the background and the
 *                     safety net that answers when a provider fails.
 *   The setups        every way of serving the workload that was tested: which serves, which passed,
 *                     which is being tried, which did not pass and why.
 *   How it got here   what it has saved since Understudy first saw it, after what testing cost, with
 *                     what happened along the way marked on the line.
 *   Always on         what holds for every request, as this workspace has it set.
 *
 * Every figure comes from the record (src/eval/value.js, the workload itself, and what live requests
 * are teaching us); one the record cannot give says so rather than showing a zero. The words are for
 * somebody who has never seen the product: every idea is said in full where it first appears, and a
 * request is a request, not a call. */

const DAY = 86400000;
const known = (x) => x !== null && x !== undefined;
const short = (m) => (m ? String(m).split('/').pop() : 'your model');
// a tenth of a second is the finest a person reads; below that, milliseconds, so a quick answer is never "0.0 s"
const secs = (ms) => (ms < 100 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`);
const pct = (x, dp = 1) => `${(x * 100).toFixed(dp)}%`;
const whole = (x) => `${Math.round(x * 100)}%`;
const dayIST = (ms) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;

/* Requests a day, in words: a quiet workload is "fewer than 1 request a day", not "0.3 requests". */
function aDay(n, one = 'request', many = 'requests') {
  if (!(n > 0)) return `No ${many} this week`;
  if (n < 0.95) return `Fewer than 1 ${one} a day`;
  const r = n < 9.5 ? Math.round(n * 10) / 10 : Math.round(n);
  return `${num(r)} ${r === 1 ? one : many} a day`;
}

/* A price against the customer's own model, rounded to a whole percent. */
function cheaperWords(p, ref = null) {
  if (!known(p)) return null;
  const r = Math.round(p);
  if (r >= 1) return `${r}% cheaper${ref ? ` than ${ref}` : ''}`;
  if (r <= -1) return `${-r}% dearer${ref ? ` than ${ref}` : ''}`;
  return `about the same price${ref ? ` as ${ref}` : ''}`;
}
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/* How requests are served right now. Copies come first whatever is switched: a request that goes to
   the customer's own provider and reaches us only afterwards was answered there, and a switch set up
   for it waits for the first request that comes through us. */
function servedKind(w, v) {
  if (!v.switched) return 'reference';
  const k = v.spec?.kind;
  if (k === 'cascade' || k === 'router') return k;
  const key = String(w.servingKey || '');
  if (key.endsWith('#cheapest')) return 'cheapest';
  if (key.endsWith('#lighter')) return 'lighter';
  return 'model';
}

function servedLabel(kind, v, w, ref) {
  const s = v.spec;
  if (kind === 'cascade') return `${short(s.first.model)}, checked`;
  if (kind === 'router') return `${short(s.cheap.model)} or ${short(s.strong.model)}`;
  if (kind === 'lighter') return `${ref}, thinking less`;
  if (kind === 'cheapest') return `${ref}, from its cheapest provider`;
  if (kind === 'model') return short(w.model);
  return ref;
}

/* The share of requests a cascade or a router sends the long way: from live requests once there are
   enough of them, and from the test it was switched on until then. */
function sentOnOf(v, w) {
  if (known(v.paths.sentOn)) return { share: v.paths.sentOn, from: 'live' };
  const ev = w.switched?.evidence?.escalated;
  if (known(ev)) return { share: ev / 100, from: 'measured' };
  const r = w.certificate?.results?.find((x) => x.model === w.servingKey);
  if (known(r?.escalated)) return { share: r.escalated / 100, from: 'measured' };
  return { share: null, from: null };
}

/* What is being tried beside what serves, when anything is: runners-up answering copies in the
   background, or a few live requests answered another way. Nothing is said while it is paused. */
function trialOf(learn) {
  const e = learn?.explore;
  if (!e || e.mode === 'off' || e.reason) return null;
  const size = (o) => (o.shadow?.calls || 0) + (o.live?.calls || 0);
  // only a runner-up that may be tried is: one that passed its last test and is cheaper than what serves
  const runners = (learn.others || []).filter((o) => o.role === 'runner-up' && o.tryable).sort((a, b) => size(b) - size(a));
  if (!e.live && !runners.length) return null;
  return { mode: e.live ? 'live' : 'shadow', share: e.share, runner: runners[0] || null, runners, days: e.daysToEvidence ?? null };
}

function contextOf(w, learn, v) {
  const ref = short(v.reference);
  const served = servedKind(w, v);
  const copies = !!w.traffic && !w.traffic.carries;
  const kind = copies ? 'copies' : served;
  const label = servedLabel(served, v, w, ref);
  const { share: sentOn, from: sentOnFrom } = sentOnOf(v, w);
  const monthAgo = v.at - 30 * DAY;
  const outages = (v.history.events || []).filter((e) => e.kind === 'outage' && e.at >= monthAgo);
  const outage = outages.length ? outages.reduce((a, b) => (b.rescued > a.rescued ? b : a)) : null;
  return {
    w, v, learn, ref, kind, served, label, sentOn, sentOnFrom, trial: copies ? null : trialOf(learn), outage,
    switched: v.switched && !copies,
    cheaperPct: known(w.switched?.prices?.cheaperPct) ? w.switched.prices.cheaperPct : null,
    passed: w.switched?.evidence?.verdict === 'cleared',
    lastSwitchAt: Math.max(0, ...(v.history.events || []).filter((e) => e.kind === 'switch').map((e) => e.at)),
    everyDays: w.measure?.everyDays ?? null,
    settleMin: learn?.explore?.settleMinutes ?? null,
  };
}

export default function ValuePipeline({ w, learn, waitsForPerson = false }) {
  const [v, setV] = useState(null);
  const [err, setErr] = useState(null);
  const [tick, setTick] = useState(0);
  // read again whenever the workload is, so a switch or a switch back shows here at once
  useEffect(() => {
    let live = true;
    api.workloadValue(w.id).then((x) => { if (live) { setV(x); setErr(null); } }).catch((e) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [w, tick]);
  const c = useMemo(() => (v ? { ...contextOf(w, learn, v), waitsForPerson } : null), [w, learn, v, waitsForPerson]);

  const head = (
    <div className="vphead">
      <h2 id="vp-h">What Understudy is doing for this workload</h2>
      {c && <p>Everything below is compared with sending every request to {c.ref}, the model you set up.</p>}
    </div>
  );
  if (err && !v) {
    return (
      <section className="opt vp" aria-labelledby="vp-h">
        {head}
        <div className="errbox vperr" role="alert">
          This could not be read: {err}{' '}
          <button type="button" className="linkbtn" onClick={() => setTick((n) => n + 1)}>Try again</button>
        </div>
      </section>
    );
  }
  if (!c) {
    return (
      <section className="opt vp" aria-labelledby="vp-h" aria-busy="true">
        {head}
        <div className="loading vploading">Reading what this workload has saved…</div>
      </section>
    );
  }
  // nothing has come in yet: the page above says how to connect, and there is nothing to show here
  if (!c.v.history.firstSeen) return null;

  return (
    <section className="opt vp" aria-labelledby="vp-h">
      {head}
      <Figures c={c} />
      <Flow c={c} />
      <Setups c={c} />
      <History c={c} />
      <Guards c={c} />
    </section>
  );
}

/* The four figures ------------------------------------------------------------------------------- */

function figuresOf(c) {
  const { v, ref, label, switched } = c;
  const m = v.money;
  const since = v.switchedAt ? `since the switch on ${dateIST(v.switchedAt)} IST` : 'since the switch';

  let cost;
  const costLabel = 'Cost in the last 30 days';
  if (m.calls > 0) {
    const verdict = m.saved > 0 ? `That leaves you ${usd(m.saved)} better off.`
      : m.saved < 0 ? `That is ${usd(-m.saved)} more than ${ref} alone, ${switched
        ? 'because finding and checking the switch has cost more than it has saved so far'
        : m.optimizing > 0 ? `because every request still goes to ${ref}, and testing cheaper setups costs a little before one can serve`
          : `which is our ${m.feePct}% fee, since every request still goes to ${ref}`}.`
        : 'The two come to the same.';
    cost = {
      id: 'cost', label: costLabel, big: usd(m.now), sub: `instead of ${usd(m.before)}`, tone: m.saved > 0 ? 'ok' : '',
      explain: `Your ${plural(m.calls, 'request')} through Understudy in the last 30 days cost ${usd(m.paid)}, our ${m.feePct}% fee included`
        + (m.optimizing > 0 ? `, and testing cheaper setups cost ${usd(m.optimizing)} more` : '')
        + `. Sent straight to ${ref}, the same requests would have cost ${usd(m.before)}. ${verdict}`,
    };
  } else if (m.optimizing > 0) {
    cost = {
      id: 'cost', label: costLabel, big: usd(m.optimizing), sub: 'spent on testing', tone: '',
      explain: `No requests went through Understudy in the last 30 days${c.kind === 'copies'
        ? ', because your requests reach it only as copies, after your own provider has answered them' : ''}. `
        + 'This is what testing cheaper setups on your requests cost.',
    };
  } else {
    cost = {
      id: 'cost', label: costLabel, big: usd(0), sub: 'nothing through Understudy yet', tone: '',
      explain: `No requests went through Understudy in the last 30 days, so there is nothing to compare with ${ref} yet.`,
    };
  }

  const q = v.quality;
  const counted = 'An answer counts as worked when the request succeeded and nothing afterwards showed it went wrong: '
    + 'it was not cut off or broken, the same request was not sent again straight away, a tool it called did not fail, '
    + 'and your app did not report a problem.'
    + (c.settleMin ? ` The last ${plural(c.settleMin, 'minute')} are left out, so there is time for that to show.` : '');
  const worked = { id: 'worked', label: 'Answers that worked', tone: '' };
  if (q.now) {
    worked.big = pct(q.now.rate);
    worked.sub = q.before ? `was ${pct(q.before.rate)}` : `on ${plural(q.now.calls, 'request')}`;
    worked.explain = `${counted} ${switched
      ? `The first figure is ${label}, ${since}, on ${plural(q.now.calls, 'request')}.${q.before
        ? ` It was ${pct(q.before.rate)} on ${ref} in the 30 days before, on ${plural(q.before.calls, 'request')}.` : ''}`
      : `This is ${ref} on ${plural(q.now.calls, 'request')} in the last 30 days.`}`;
  } else {
    worked.big = switched ? 'Too early' : 'Not known';
    worked.sub = switched ? (q.before ? `was ${pct(q.before.rate)}` : 'too few requests since the switch') : 'no finished requests yet';
    worked.explain = `${counted} ${switched ? 'Too few requests have finished since the switch to say yet.'
      : 'No requests have finished in the last 30 days.'}`;
  }

  const s = v.speed;
  const ttft = s.metric === 'ttft';
  const how = `This is the middle time: half of the requests ${ttft ? 'started answering' : 'were answered'} faster than this, and half slower.`
    + (ttft ? ' Most of these requests stream their answer word by word, so this is how long your users waited for it to start.'
      : ' It is the time until the whole answer arrived.');
  const speed = { id: 'speed', label: ttft ? 'Typical wait for the first word' : 'Typical response time', tone: '' };
  if (s.now) {
    speed.big = secs(s.now.ms);
    speed.sub = s.before ? `was ${secs(s.before.ms)}` : `on ${plural(s.now.calls, 'request')}`;
    speed.explain = `${how} ${switched
      ? `The first figure is ${label}, ${since}.${s.before ? ` It was ${secs(s.before.ms)} on ${ref} in the 30 days before.` : ''}`
      : `This is ${ref} over the last 30 days.`}`;
  } else {
    speed.big = switched ? 'Too early' : 'Not known';
    speed.sub = switched ? (s.before ? `was ${secs(s.before.ms)}` : 'too few requests since the switch') : 'no timed requests yet';
    speed.explain = `${how} ${switched ? 'Too few requests have been timed since the switch to say yet.'
      : 'No requests were timed in the last 30 days.'}`;
  }

  const n = v.rescued.count;
  const rescued = {
    id: 'rescued', label: 'Requests rescued', big: num(n), sub: n > 0 ? 'in 30 days' : 'none needed in 30 days', tone: '',
    explain: 'A request is rescued when its first try failed, because the company running the model was down, too busy '
      + `or too slow, and it was then answered another way, usually by ${ref}. Your app got its answer and never saw the error.`
      + (switched ? '' : ` Rescues start once a cheaper setup serves, with ${ref} behind it as the safety net.`),
  };
  return [cost, worked, speed, rescued];
}

function Figures({ c }) {
  const [open, setOpen] = useState(null);
  const tiles = figuresOf(c);
  const shown = tiles.find((t) => t.id === open);
  return (
    <div className="vpfigs">
      <div className="vptiles">
        {tiles.map((t) => (
          <button key={t.id} type="button" className={`vptile${t.tone ? ` ${t.tone}` : ''}${open === t.id ? ' on' : ''}`}
            aria-expanded={open === t.id} aria-controls="vp-explain" onClick={() => setOpen(open === t.id ? null : t.id)}>
            <span className="vptk">{t.label}</span>
            <span className="vptv"><span className="vptb m">{t.big}</span>{t.sub && <span className="vpts">{t.sub}</span>}</span>
          </button>
        ))}
      </div>
      <p id="vp-explain" className={`vpexplain${shown ? ' on' : ''}`} aria-live="polite">
        {shown ? <><b>{shown.label}.</b> {shown.explain}</> : 'Tap a figure to see how it is counted.'}
      </p>
    </div>
  );
}

/* The flow ---------------------------------------------------------------------------------------- */

/* Every box in the picture and what it says when tapped, and how they join: the boxes in a row, the
   fork a strategy splits requests at, the box after the fork, what runs in the background above the
   row, and the safety net below it. */
function flowModel(c) {
  const { v, w, ref, kind, label, sentOn, sentOnFrom, trial, outage } = c;
  const p = v.paths;
  const fee = v.money.feePct;
  const nodes = {};
  const add = (n) => { nodes[n.id] = n; return n.id; };
  const results = w.certificate?.results || [];
  const refCost = w.certificate?.referenceCostMonth;
  const cheaperOf = (r) => (refCost > 0 && known(r?.costMonth) ? (1 - r.costMonth / refCost) * 100 : null);
  const copies = kind === 'copies';
  const perDay = copies ? p.copiesPerDay : p.perDay;

  add({
    id: 'app', eyebrow: 'Your app', title: aDay(perDay), note: copies ? 'sent to your own provider' : 'sent through Understudy',
    detail: {
      title: 'Your requests',
      text: copies
        ? `Your app sends its requests to ${ref} at your own provider, as it always has, and sends Understudy a copy of each one afterwards. Understudy learns from the copies, but it cannot change what your users get.`
        : `Your app sends its requests to Understudy instead of straight to ${ref}. Connecting only needed a new address and key in your code.`,
      big: perDay > 0 ? num(perDay >= 9.5 ? Math.round(perDay) : Math.round(perDay * 10) / 10) : '0',
      small: copies ? 'copies a day, over the last week' : 'requests a day, over the last week',
    },
  });

  let cols = ['app'];
  let fork = null;
  let end = null;
  let first = 'app';
  let bottomTo = null;
  let intro;
  const notes = [];
  const sent = (eyebrow, noteText, text, extra = {}) => add({
    id: 'sent', eyebrow, title: 'Answer sent to your app', note: noteText, tone: 'ok',
    detail: { title: 'The answer goes straight back', text, big: '', small: '', ...extra },
  });
  const answeredHere = v.switchedAt && v.switchedAt > v.at - 7 * DAY ? 'answered this way since the switch' : 'answered this way in the last 7 days';

  if (copies || kind === 'reference') {
    add({
      id: 'ref', eyebrow: 'Answers', title: ref, note: copies ? 'at your own provider' : 'your own model, unchanged', tone: 'brand',
      detail: copies ? {
        title: `${ref} answers, at your own provider`,
        text: `Your requests never pass through Understudy, so ${ref} answers every one at your own provider, exactly as before.`,
        big: '', small: '',
      } : {
        title: `${ref} answers every request`,
        text: `Nothing has been switched yet, so every request is answered by ${ref}, the model you set up, exactly as before. ${nextStep(c)}`,
        big: known(p.ownPerCall) ? usd(p.ownPerCall) : '', small: known(p.ownPerCall) ? 'per request, on average' : '',
      },
    });
    sent('Every request', 'as before', `${ref}'s answer goes straight back to your app, as it did before you connected.`);
    cols = ['app', 'ref', 'sent'];
    first = copies ? 'copy' : 'ref';
    intro = copies
      ? `Your requests go to ${ref} at your own provider, and Understudy only receives copies of them. Nothing can be switched until requests go through Understudy, which is one change of address in your code.${v.switched ? ` A switch to ${label} is set up, and it starts with the first request that comes through Understudy.` : ''}`
      : `Nothing has been switched yet, so ${ref} answers every request, exactly as before.${trial ? ' In the background, Understudy is trying a cheaper setup on copies of a few requests.' : ''}`;
  } else if (kind === 'cascade') {
    const s = v.spec;
    const fb = short(s.fallback.model);
    const fbOwn = s.fallback.model === v.reference;
    const solo = results.find((r) => r.model === s.first.model && (r.name?.kind ?? 'model') === 'model');
    const singles = results.filter((r) => (r.name?.kind ?? 'model') === 'model');
    const soloFailed = singles.length > 0 && !singles.some((r) => r.verdict === 'cleared');
    add({
      id: 'first', eyebrow: 'Answers first', title: short(s.first.model),
      note: known(cheaperOf(solo)) ? cheaperWords(cheaperOf(solo), ref) : 'a cheaper model', tone: 'ok',
      detail: {
        title: 'A cheaper model answers first',
        text: `${short(s.first.model)} answers every request first. ${solo && solo.verdict !== 'cleared'
          ? 'On its own it did not pass the test, so it does not get the last word: '
          : 'It does not get the last word: '}a quick check reads every answer before your app sees it.`,
        big: known(p.shortPerCall) ? usd(p.shortPerCall) : '',
        small: known(p.shortPerCall) ? 'per request when the check is sure, the check included' : '',
      },
    });
    add({
      id: 'check', eyebrow: 'Quick check', title: 'Is this answer good enough?', note: 'set from your requests',
      detail: {
        title: 'A quick check reads the answer',
        text: 'First it makes sure the answer has the right shape. Then Jev, an AI model that estimates how likely an answer is to be right, reads it. '
          + 'How sure Jev has to be was set from your own requests when this setup was tested, so it lets through the answers it can trust and holds back the rest.',
        big: known(sentOn) ? inHundred(1 - sentOn) : '',
        small: known(sentOn) ? `passed the check${sentOnFrom === 'measured' ? ', in the test' : ''}` : '',
      },
    });
    add({
      id: 'sent', eyebrow: !known(sentOn) || sentOn <= 0.5 ? 'Most requests' : 'When sure', title: 'Answer sent to your app',
      note: known(sentOn) ? `${inHundred(1 - sentOn)} requests` : 'when the check is sure', tone: 'ok',
      detail: {
        title: 'When the check is sure, the answer goes back',
        text: `When the check is sure, ${short(s.first.model)}'s answer goes straight back to your app. That is where the saving comes from.`,
        big: known(sentOn) ? whole(1 - sentOn) : '',
        small: known(sentOn) ? (known(p.shortPerCall) ? `of requests, at ${usd(p.shortPerCall)} each` : 'of requests') : '',
      },
    });
    add({
      id: 'fallback', eyebrow: 'When unsure', title: `${fb} answers instead`,
      note: known(sentOn) ? `${inHundred(sentOn)} requests` : 'when the check is unsure', tone: 'brand',
      detail: {
        title: `${fb} answers the hard ones`,
        text: `When the check is not sure, ${fbOwn ? `${ref}, your own model,` : fb} answers instead, so harder requests still get ${fbOwn ? 'the answer your own model gives' : 'its answer'}. `
          + `These cost a little more than before, because they also pay for the cheap try and the check${known(sentOn) ? `, but they are only ${inHundred(sentOn)}` : ''}.`,
        big: known(sentOn) ? whole(sentOn) : '',
        small: known(sentOn) ? (known(p.longPerCall) ? `of requests, at ${usd(p.longPerCall)} each` : 'of requests') : '',
      },
    });
    cols = ['app', 'first', 'check'];
    fork = [
      { id: 'sent', share: known(sentOn) ? 1 - sentOn : null, tone: 'ok',
        label: known(sentOn) ? `${inHundred(1 - sentOn)} requests: the check is sure` : 'When the check is sure' },
      { id: 'fallback', share: known(sentOn) ? sentOn : null, tone: 'brand',
        label: known(sentOn) ? `${inHundred(sentOn)} requests: the check is unsure` : 'When the check is unsure' },
    ];
    bottomTo = fbOwn ? 'fallback' : 'sent';
    first = 'check';
    intro = `${soloFailed ? 'No single cheaper model was good enough on its own, so Understudy' : 'Understudy'} built a small pipeline out of two models and a check. The thicker the line, the more requests take that path.`;
  } else if (kind === 'router') {
    const s = v.spec;
    const cheap = short(s.cheap.model);
    const strong = short(s.strong.model);
    const strongOwn = s.strong.model === v.reference;
    add({
      id: 'sorter', eyebrow: 'Sorts first', title: 'Easy or hard?', note: 'learned from your requests',
      detail: {
        title: 'A sorter reads each request first',
        text: `A small rule, learned from your own requests, reads each request before it is sent. The ones ${cheap} usually gets right go to it, and the rest go to ${strong}. Nothing is checked afterwards, so no request waits for two answers.`,
        big: known(sentOn) ? inHundred(1 - sentOn) : '', small: known(sentOn) ? `go to ${cheap}` : '',
      },
    });
    add({
      id: 'cheap', eyebrow: 'Easy ones', title: cheap, note: known(sentOn) ? `${inHundred(1 - sentOn)} requests` : 'most requests', tone: 'ok',
      detail: {
        title: `${cheap} answers the easy ones`,
        text: `${cheap} answers the requests the sorter judged easy. That is where the saving comes from.`,
        big: known(p.shortPerCall) ? usd(p.shortPerCall) : '', small: known(p.shortPerCall) ? 'per request' : '',
      },
    });
    add({
      id: 'strong', eyebrow: 'Hard ones', title: strong, note: known(sentOn) ? `${inHundred(sentOn)} requests` : 'the harder requests', tone: 'brand',
      detail: {
        title: `${strong} answers the hard ones`,
        text: strongOwn ? `${ref}, your own model, answers the requests the sorter judged hard, so they get the answer they would have got before.`
          : `${strong} answers the requests the sorter judged hard.`,
        big: known(p.longPerCall) ? usd(p.longPerCall) : '', small: known(p.longPerCall) ? 'per request' : '',
      },
    });
    sent('Every request', 'from either model', 'Whichever model answered, its answer goes straight back to your app.');
    cols = ['app', 'sorter'];
    fork = [
      { id: 'cheap', share: known(sentOn) ? 1 - sentOn : null, tone: 'ok',
        label: known(sentOn) ? `${inHundred(1 - sentOn)} requests: judged easy` : 'Judged easy' },
      { id: 'strong', share: known(sentOn) ? sentOn : null, tone: 'brand',
        label: known(sentOn) ? `${inHundred(sentOn)} requests: judged hard` : 'Judged hard' },
    ];
    end = 'sent';
    bottomTo = strongOwn ? 'strong' : 'sent';
    first = 'sorter';
    intro = 'A small sorter, learned from your own requests, picks which of two models answers each one. The thicker the line, the more requests take that path.';
  } else {
    const passedLine = c.passed ? `It passed the test on your own requests, so its answers were as good as ${ref}'s.`
      : c.w.switched?.how === 'you' ? 'You approved it after it was tested on your own requests.' : '';
    const what = kind === 'lighter'
      ? `${ref} still answers every request, but it is asked to think less before it answers. Thinking is billed, so the same model costs less.`
      : kind === 'cheapest'
        ? `${ref} still answers every request, but it is bought from the company that runs it most cheaply. It is the same model, only run by a different company.`
        : `${label} answers every request instead of ${ref}.`;
    add({
      id: 'serving', eyebrow: 'Answers', title: label,
      note: known(c.cheaperPct) ? cheaperWords(c.cheaperPct, ref) : kind === 'model' ? 'a cheaper model' : 'your own model', tone: 'ok',
      detail: {
        title: kind === 'lighter' ? `${ref} thinks less first` : kind === 'cheapest' ? `${ref} from its cheapest provider` : `${label} answers every request`,
        text: `${what} ${passedLine} It is watched on every request, and switched back if it does worse.`.replace(/\s+/g, ' ').trim(),
        big: known(p.perCall) ? usd(p.perCall) : '', small: known(p.perCall) ? `per request, our ${fee}% fee included` : '',
      },
    });
    sent('Every request', 'straight back', `The answer goes straight back to your app, in the same form ${ref}'s answers came in, so nothing else in your code has to change.`,
      p.calls > 0 ? { big: num(p.calls), small: answeredHere } : {});
    cols = ['app', 'serving', 'sent'];
    bottomTo = 'sent';
    first = 'serving';
    intro = kind === 'lighter'
      ? `${ref} still answers every request, asked to think less first, because that passed the test on your own requests.`
      : kind === 'cheapest'
        ? `${ref} still answers every request, bought from the company that runs it most cheaply.`
        : `${label} answers every request instead of ${ref}${c.passed ? ', because it passed the test on your own requests' : ''}.`;
  }

  if (!copies && c.switched && known(p.rolloutShare) && p.rolloutShare < 1) {
    notes.push(`Right now this setup answers ${inHundred(p.rolloutShare)} requests while it takes over step by step. `
      + `The other ${inHundred(1 - p.rolloutShare)} go straight to ${ref}, so the two can be compared fairly.`);
  }
  if ((kind === 'cascade' || kind === 'router') && sentOnFrom === 'measured') {
    notes.push('The shares are from the test, until enough live requests have gone through.');
  }

  let top = null;
  if (copies) {
    top = add({
      id: 'copy', eyebrow: 'Afterwards', title: 'A copy comes to Understudy', note: aDay(p.copiesPerDay, 'copy', 'copies'),
      tone: 'mut', dashed: true,
      detail: {
        title: 'Understudy learns from copies',
        text: `After ${ref} has answered, your code sends Understudy a copy of the request and the answer, and Understudy tests cheaper setups on these copies. `
          + (v.switched ? `A switch to ${label} is set up, and it starts with the first request that comes through Understudy. That takes one change of address in your code.`
            : 'For a cheaper setup to answer, requests have to go through Understudy, which is one change of address in your code.'),
        big: '', small: '',
      },
    });
  } else if (trial) {
    const o = trial.runner;
    if (trial.mode === 'shadow') {
      const calls = o?.shadow?.calls || 0;
      const same = o?.shadow?.same || 0;
      top = add({
        id: 'trial', eyebrow: 'In the background', title: o ? `Trying ${o.label}` : 'Trying a runner-up',
        note: `${inHundred(trial.share)} requests, copied`, tone: 'warn', dashed: true,
        detail: {
          title: 'Learning in the background',
          text: `${o ? o.label : 'A cheaper runner-up'} also answers a copy of about ${inHundred(trial.share)} requests in the background. Your users still get the normal answer; Understudy only compares the two.`
            + (calls > 0 ? ` So far it gave the same answer ${num(same)} ${same === 1 ? 'time' : 'times'} out of ${num(calls)}.` : ' It has not answered any yet.')
            + (trial.days ? ` At this volume, gathering enough to decide takes about ${plural(trial.days, 'day')}.` : ''),
          big: calls > 0 ? `${num(same)} of ${num(calls)}` : 'None yet', small: calls > 0 ? 'gave the same answer so far' : 'background answers so far',
        },
      });
    } else {
      const liveCalls = o?.live?.calls || 0;
      top = add({
        id: 'trial', eyebrow: 'Experiments', title: `Up to ${inHundred(trial.share)} requests`,
        note: 'answered another way, to compare', tone: 'warn', dashed: true,
        detail: {
          title: 'Small experiments on live requests',
          /* With no runner-up to try, the whole share goes to the customer's own model, as the yardstick
             what serves is compared with (explorePlan in src/learn/explore.js). */
          text: o
            ? `To keep checking that ${label} is still the best choice, up to ${inHundred(trial.share)} requests are answered another way: about half by ${ref}, to compare against, and half by a cheaper runner-up, now ${o.label}. If an experiment fails, the request is answered the usual way, so your users never see an error.`
            : `To keep checking that ${label} is still the best choice, up to ${inHundred(trial.share)} requests are answered by ${ref} instead, so there is always a fresh comparison with what serves now. If one of those fails, the request is answered the usual way, so your users never see an error.`,
          big: liveCalls > 0 && known(o.live.rate) ? pct(o.live.rate, 0) : '',
          small: liveCalls > 0 && known(o.live.rate) ? `of the runner-up's ${plural(liveCalls, 'answer')} worked so far` : '',
        },
      });
    }
  }

  let bottom = null;
  if (!copies && kind !== 'reference') {
    const rescued = v.rescued.count;
    const title = kind === 'lighter' ? `If that fails, ${ref} answers as usual`
      : kind === 'cheapest' ? 'If that company fails, another one answers'
        : kind === 'model' ? `If ${label} fails, ${ref} answers` : `If a company fails, ${ref} answers`;
    bottom = add({
      id: 'safety', eyebrow: 'Safety net', title,
      note: rescued > 0 ? `${plural(rescued, 'time')} in the last 30 days` : 'not needed in the last 30 days', tone: 'mut', dashed: true,
      detail: {
        title: 'The safety net',
        text: `If the company running ${kind === 'model' ? label : 'the model'} is down, too busy or too slow, the request goes to ${ref} straight away${kind === 'cheapest' ? ', from any company that runs it' : ''}, so your users never see an error.`
          + (outage ? ` The most in one hour was on ${timeIST(outage.at)} IST, when ${plural(outage.rescued, 'request was', 'requests were')} rescued.` : ''),
        big: num(rescued), small: 'requests rescued in the last 30 days',
      },
    });
  }
  return { nodes, cols, fork, end, top, bottom, bottomTo, first, intro, notes };
}

const candName = (cand) => (cand.name && cand.name.kind !== 'model' ? cand.name.label : short(cand.model));

/* What happens to the setup the newest test would switch to, as the workload has it: switched back from
   before and so never switched to by itself again, waiting for a person, or taking over by itself. */
function candidateWhy(c) {
  const cand = c.w.candidate;
  if (cand?.heldBack) return 'It was switched back once before, so it is not switched to by itself again. You can still approve it in the card below.';
  if (c.waitsForPerson) return 'It is waiting for your approval in the card below.';
  return 'This workload switches by itself, so it starts on a small share of requests first.';
}

/* What happens next while the customer's own model still answers everything, as the workload has it. */
function nextStep(c) {
  const { w } = c;
  const cand = w.candidate;
  if (cand && !w.promotedAt) return `A cheaper setup, ${candName(cand)}, has passed the test. ${candidateWhy(c)}`;
  const again = c.everyDays > 0
    ? 'Understudy tests again on its own schedule, and sooner when a new model or a price change could matter.'
    : 'Press Measure now below to test again.';
  if (w.certificate) return `No cheaper setup has passed the test yet. ${again}`;
  return 'The first test runs once there are enough of your requests to test on.';
}

// how thick a line is for the share of requests that takes it
const thick = (share) => (known(share) ? Math.max(2.5, Math.min(10, 10 * share)) : 5);
const TONE_LINE = { ok: 'var(--ok)', brand: 'var(--brand)', warn: 'var(--warn)', mut: 'var(--mut)' };

/* Where each box goes on a wide screen: the row across the middle, the fork's two boxes one above the
   other, what runs in the background in a lane above, and the safety net in a lane below. */
function layoutWide(model, W) {
  const P = 16;
  const n = model.cols.length + (model.fork ? 1 : 0) + (model.end ? 1 : 0);
  const weights = n === 4 ? [0.17, 0.2, 0.2, 0.24] : [0.2, 0.28, 0.28];
  const usable = W - 2 * P;
  const gap = (usable - usable * weights.reduce((a, b) => a + b, 0)) / (n - 1);
  const col = [];
  let x = P;
  for (const wt of weights) { col.push({ x, w: usable * wt }); x += usable * wt + gap; }
  // room for a label, a name over two lines and a note over two, which a long model name needs
  const TOP_H = 92;
  const MAIN_H = 120;
  const FORK_H = 104;
  const FORK_GAP = 20;
  const BOTTOM_H = 92;
  const LANE = 36;
  let y = 16;
  const topY = model.top ? y : null;
  if (model.top) y += TOP_H + LANE;
  const mainTop = y;
  const mainH = model.fork ? FORK_H * 2 + FORK_GAP : MAIN_H;
  const mid = mainTop + mainH / 2;
  y += mainH;
  const bottomY = model.bottom ? y + LANE : null;
  if (model.bottom) y += LANE + BOTTOM_H;
  const H = y + 16;

  const box = {};
  model.cols.forEach((id, i) => { box[id] = { x: col[i].x, y: mid - MAIN_H / 2, w: col[i].w, h: MAIN_H }; });
  if (model.fork) {
    const k = model.cols.length;
    model.fork.forEach((b, i) => { box[b.id] = { x: col[k].x, y: mainTop + i * (FORK_H + FORK_GAP), w: col[k].w, h: FORK_H }; });
    if (model.end) box[model.end] = { x: col[k + 1].x, y: mid - MAIN_H / 2, w: col[k + 1].w, h: MAIN_H };
  }
  const span = Math.min(460, col[2].x + col[2].w - col[1].x);
  if (model.top) box[model.top] = { x: col[1].x, y: topY, w: span, h: TOP_H };

  const edges = [];
  const curve = (x1, y1, x2, y2) => {
    if (Math.abs(y1 - y2) < 0.5) return `M${x1} ${y1} H${x2}`;
    const mx = (x1 + x2) / 2;
    return `M${x1} ${y1} C${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
  };
  for (let i = 0; i + 1 < model.cols.length; i += 1) {
    const a = box[model.cols[i]];
    const b = box[model.cols[i + 1]];
    edges.push({ key: `m${i}`, d: curve(a.x + a.w, mid, b.x, mid), width: 10, color: 'var(--brand)', opacity: 0.5 });
  }
  if (model.fork) {
    const a = box[model.cols[model.cols.length - 1]];
    for (const b of model.fork) {
      const t = box[b.id];
      edges.push({ key: `f${b.id}`, d: curve(a.x + a.w, mid, t.x, t.y + t.h / 2), width: thick(b.share), color: TONE_LINE[b.tone], opacity: 0.85 });
      if (model.end) {
        const e = box[model.end];
        edges.push({ key: `e${b.id}`, d: curve(t.x + t.w, t.y + t.h / 2, e.x, mid), width: thick(b.share), color: TONE_LINE[b.tone], opacity: 0.85 });
      }
    }
  }
  const app = box.app;
  const ax = app.x + Math.min(app.w / 2, 60);
  const r = 10;
  if (model.top) {
    const t = box[model.top];
    const ty = t.y + t.h / 2;
    edges.push({ key: 'top', d: `M${ax} ${app.y} V${ty + r} Q${ax} ${ty} ${ax + r} ${ty} H${t.x}`, width: 1.6,
      color: TONE_LINE[model.nodes[model.top].tone] || 'var(--mut)', dash: '3 5' });
  }
  if (model.bottom) {
    const target = box[model.bottomTo] || box.sent;
    const tx = target.x + target.w / 2;
    const by = bottomY + BOTTOM_H / 2;
    box[model.bottom] = { x: col[1].x, y: bottomY, w: Math.max(200, Math.min(460, tx - 30 - col[1].x)), h: BOTTOM_H };
    edges.push({ key: 'bottom', d: `M${ax} ${app.y + app.h} V${by - r} Q${ax} ${by} ${ax + r} ${by} H${tx - r} Q${tx} ${by} ${tx} ${by - r} V${target.y + target.h}`,
      width: 1.6, color: 'var(--mut)', dash: '6 6' });
  }
  return { H, box, edges };
}

function NodeButton({ n, on, onPick, style }) {
  return (
    <button type="button" className={`vpnode${n.tone ? ` ${n.tone}` : ''}${n.dashed ? ' dashed' : ''}${on ? ' on' : ''}`}
      style={style} aria-pressed={on} onClick={() => onPick(n.id)}>
      <span className="vpne">{n.eyebrow}</span>
      <span className="vpnt">{n.title}</span>
      {n.note && <span className="vpnn m">{n.note}</span>}
    </button>
  );
}

function Flow({ c }) {
  const model = useMemo(() => flowModel(c), [c]);
  const [pick, setPick] = useState(model.first);
  useEffect(() => { if (!model.nodes[pick]) setPick(model.first); }, [model, pick]);
  const [box, width] = useWidth();
  const wide = width >= 720;
  const n = model.nodes[pick] || model.nodes[model.first];
  const L = wide ? layoutWide(model, width) : null;
  const node = (id, style) => <NodeButton key={id} n={model.nodes[id]} on={pick === id} onPick={setPick} style={style} />;

  return (
    <div className="vpsec" aria-labelledby="vp-flow-h">
      <div className="vpsechead">
        <h3 id="vp-flow-h">How every request flows right now</h3>
        <p>{model.intro} Tap any box to see what it does.</p>
        {model.notes.map((t) => <p key={t} className="vpnote">{t}</p>)}
      </div>
      <div ref={box} className="vpflowwrap">
        {wide ? (
          <div className="vpflow" style={{ height: L.H }}>
            <svg className="vpflowsvg" width={width} height={L.H} viewBox={`0 0 ${width} ${L.H}`} aria-hidden="true">
              {L.edges.map((e) => (
                <path key={e.key} d={e.d} fill="none" stroke={e.color} strokeWidth={e.width} strokeLinecap="round"
                  strokeDasharray={e.dash} opacity={e.opacity ?? 1} />
              ))}
            </svg>
            {Object.keys(L.box).map((id) => node(id, { left: L.box[id].x, top: L.box[id].y, width: L.box[id].w, height: L.box[id].h }))}
          </div>
        ) : (
          <div className="vpstack">
            {model.cols.map((id, i) => (
              <React.Fragment key={id}>
                {i > 0 && <span className="vpstem" aria-hidden="true" />}
                {node(id)}
              </React.Fragment>
            ))}
            {model.fork && (
              <>
                <span className="vpstem" aria-hidden="true" />
                <div className="vpfork">
                  {model.fork.map((b) => (
                    <div key={b.id} className={`vpbranch ${b.tone}`} style={{ borderLeftWidth: Math.max(2, Math.round(thick(b.share) / 2)) }}>
                      <span className="vpblab m">{b.label}</span>
                      {node(b.id)}
                    </div>
                  ))}
                </div>
                {model.end && (<><span className="vpstem" aria-hidden="true" />{node(model.end)}</>)}
              </>
            )}
            {(model.top || model.bottom) && (
              <div className="vpalso">
                {model.top && node(model.top)}
                {model.bottom && node(model.bottom)}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="vpdetail" aria-live="polite">
        <div className="vpdtext">
          <b>{n.detail.title}</b>
          <span>{n.detail.text}</span>
        </div>
        {n.detail.big && (
          <div className="vpdfig">
            <span className="m">{n.detail.big}</span>
            <span>{n.detail.small}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/* The setups ------------------------------------------------------------------------------------- */

const FAMILIES = ['cascade', 'model', 'lighter', 'cheapest', 'router'];
const RANK = { serving: 0, passed: 1, trial: 2, unsure: 3, dearer: 4, failed: 5 };

function familyWords(f, ref) {
  if (f === 'cascade') return { name: 'Check first', what: `A cheaper model answers, a quick check decides, and ${ref} answers when the check is unsure.` };
  if (f === 'router') return { name: 'A sorter', what: `A small rule, learned from your requests, sends easy ones to a cheaper model and hard ones to ${ref}.` };
  if (f === 'lighter') return { name: `${ref}, thinking less`, what: 'The same model, set to think less before it answers. Thinking is billed, so it costs less.' };
  if (f === 'cheapest') return { name: `${ref} from its cheapest provider`, what: 'Exactly the same model, bought from whichever company runs it most cheaply.' };
  return { name: 'One cheaper model on its own', what: 'Every request goes to a single cheaper model, with no check.' };
}

/* One tested setup's result in a few words, for the list under a card. */
function resultWords(r, floor, ref) {
  const gap = known(r.gap) ? `${Number(r.gap).toFixed(1)}%` : null;
  if (r.verdict === 'cleared') return 'passed';
  if (r.verdict === 'failed') return 'its company could not answer during the test';
  if (r.verdict === 'slower') return 'too slow';
  if (r.stopped === 'bar') return 'stopped early, once it could no longer pass';
  if (r.verdict === 'review') return 'close to the pass mark, not clearly inside it';
  if (r.verdict === 'insufficient') return 'not enough test requests to decide';
  if (r.verdict === 'missed' && gap) return `differed from ${ref} on ${gap} of requests${known(floor) ? `, at most ${Number(floor).toFixed(1)}% allowed` : ''}`;
  return 'did not pass';
}

/* Why the best of a group that did not pass fell short, in a sentence. */
function missWhy(r, c) {
  const { ref, w } = c;
  const floor = w.certificate?.floor;
  if (r.verdict === 'slower') return 'Its answers were good enough, but it was slower than your speed setting allows.';
  if (r.verdict === 'failed') return 'The company running it could not answer during the test, so its answers were never judged. It is tried again in later tests.';
  if (r.stopped === 'bar') return 'It was stopped early, once it could no longer reach the pass mark, so the test did not spend more on it.';
  if (known(r.gap) && known(floor)) {
    return `Its answers differed from ${ref}'s on ${Number(r.gap).toFixed(1)}% of the test requests. The pass mark allows ${Number(floor).toFixed(1)}%, `
      + `which is how often ${ref}'s own two answers to the same request differ from each other.`;
  }
  return `Its answers were not close enough to ${ref}'s.`;
}

function setupsOf(c) {
  const { w, v, ref, label, trial } = c;
  const cert = w.certificate;
  const results = cert?.results || [];
  const refCost = cert?.referenceCostMonth;
  const cheaperOf = (r) => (refCost > 0 && known(r.costMonth) ? (1 - r.costMonth / refCost) * 100 : null);
  const nameOf = (r) => (r.name && r.name.kind !== 'model' ? r.name.label : short(r.model));
  const byCost = (a, b) => (cheaperOf(b) ?? -Infinity) - (cheaperOf(a) ?? -Infinity);
  const again = c.everyDays > 0
    ? `It is tested again on its own schedule${w.measure?.nextAt ? `, next around ${dateIST(w.measure.nextAt)} IST` : ''}, and sooner when a new model or a price change could matter. A test only runs by itself when what it could find is worth more than it costs.`
    : 'It is tested again when you press Measure now.';
  const cards = [];
  let servingShown = false;
  // a switch set up for requests that reach us only as copies, waiting for the first that comes through us
  const setUp = v.switched && c.kind === 'copies';
  const waitWhy = 'It passed the test on your own requests, and a switch to it is set up. It starts answering with the first request '
    + 'that comes through Understudy, which is one change of address in your code.';

  for (const f of FAMILIES) {
    const members = results.filter((r) => (r.name?.kind || 'model') === f).sort(byCost);
    if (!members.length) continue;
    const words = familyWords(f, ref);
    const list = members.map((r) => ({ name: nameOf(r), result: resultWords(r, cert.floor, ref), cost: cheaperWords(cheaperOf(r)) }));
    const serving = c.switched || setUp ? members.find((r) => r.model === w.servingKey) : null;
    const cleared = members.filter((r) => r.verdict === 'cleared');
    const cheaper = cleared.filter((r) => (cheaperOf(r) ?? 1) > 0);
    const unsure = members.filter((r) => r.verdict === 'review' || r.verdict === 'insufficient');
    let card;
    if (serving && setUp) {
      servingShown = true;
      card = {
        key: 'serving', status: 'Set up, waiting', tone: 'brand',
        result: `${cap(cheaperWords(known(c.cheaperPct) ? c.cheaperPct : cheaperOf(serving)) || 'not priced yet')}. Answers as good.`,
        why: waitWhy,
      };
    } else if (serving) {
      servingShown = true;
      const p = known(c.cheaperPct) ? c.cheaperPct : cheaperOf(serving);
      card = {
        key: 'serving', status: 'Serving now', tone: 'ok',
        result: `${cap(cheaperWords(p) || 'not priced yet')}. ${c.passed ? 'Answers as good.' : 'Approved by you.'}`,
        why: `${c.passed ? 'It passed the test on your own requests' : 'You approved it after it was tested on your own requests'}, and it now answers ${known(v.paths.rolloutShare) && v.paths.rolloutShare < 1 ? `${inHundred(v.paths.rolloutShare)} requests while it takes over` : 'every request'}. ${again}`,
      };
    } else if (cheaper.length) {
      const best = cheaper[0];
      /* The newest test's pick. It is only offered while nothing is switched: a switched workload's page
         offers a switch back, not another approval. */
      const isCand = !!w.candidate && cheaper.some((r) => r.model === w.candidate.model);
      const offered = !c.switched && isCand;
      // what serves now saves more, unless the prices say otherwise
      const servingSavesMore = c.switched && !(known(c.cheaperPct) && known(cheaperOf(best)) && cheaperOf(best) > c.cheaperPct);
      const tried = !!trial && trial.runners.some((o) => o.key === best.model);
      // the last time it was switched back, when it was, and why, from the history
      const back = [...(v.history.events || [])].reverse().find((e) => e.kind === 'back' && e.fromKey === best.model);
      const backLine = back ? `It was switched back on ${dateIST(back.at)} IST. ${back.by === 'you' ? 'You switched it back.' : backWhy(back.reason)}`.trim() : '';
      let why;
      if (offered) why = `It passed the test. ${candidateWhy(c)}`;
      else if (servingSavesMore) why = `It passed, but ${label} saves more, so ${label} was chosen.`;
      else if (c.switched && isCand && w.candidate.heldBack) {
        why = `It saves more than ${label}, but it was switched back before, so it is not switched to by itself again. ${backLine}`.trim();
      } else if (c.switched && tried) {
        why = `It saves more than ${label}. It is being tried in the background first, to see whether it holds up on your live requests.`;
      } else if (c.switched) why = `It saves more than ${label}. ${backLine ? `${backLine} ` : ''}It is looked at again in the next test.`;
      else why = w.candidate ? `It passed, but ${candName(w.candidate)} saves more.` : 'It passed the test.';
      card = {
        key: 'passed', status: offered && !w.candidate.heldBack ? 'Passed, ready to switch' : c.switched ? 'Passed, standing by' : 'Passed',
        tone: 'brand',
        result: `${members.length > 1 ? `Best: ${nameOf(best)}, ` : ''}${cheaperWords(cheaperOf(best)) || 'not priced yet'}. Answers as good.`,
        why,
      };
    } else if (cleared.length) {
      const best = cleared[0];
      card = {
        key: 'dearer', status: 'Passed, but costs more', tone: 'mut',
        result: `Answers as good, but ${cheaperWords(cheaperOf(best)) || 'not priced'}.`,
        why: `Its answers were as good as ${ref}'s, but it costs more, so it is not worth switching to.`,
      };
    } else if (unsure.length) {
      const close = unsure.some((r) => r.verdict === 'review');
      card = {
        key: 'unsure', status: close ? 'Too close to call' : 'Not enough data yet', tone: 'mut',
        result: close ? 'Close to the pass mark.' : 'Needs more test requests.',
        why: close ? 'Its answers came close to the pass mark without being clearly inside it, so it is not switched to by itself. You can still approve it.'
          : 'The test ran out of requests before it could decide. The next test looks at it again.',
      };
    } else {
      const best = members.find((r) => known(cheaperOf(r))) || members[0];
      card = {
        key: 'failed', status: 'Didn’t pass', tone: 'bad',
        result: `${members.length > 1 ? `Best: ${nameOf(best)}, would be ` : 'Would be '}${cheaperWords(cheaperOf(best)) || 'not priced'}.`,
        why: `${members.length > 1 ? `The best of these, ${nameOf(best)}, did not pass. ` : ''}${missWhy(best, c)}`,
      };
    }
    cards.push({ ...words, ...card, family: f, list: members.length > 1 ? list : null });
  }

  // what serves now, or waits to, when the newest test did not include it
  if ((c.switched || setUp) && !servingShown) {
    const f = c.served === 'reference' ? 'model' : c.served;
    const words = familyWords(f, ref);
    cards.push({
      ...words, name: f === 'model' ? label : words.name, key: 'serving', family: f, list: null,
      status: setUp ? 'Set up, waiting' : 'Serving now', tone: setUp ? 'brand' : 'ok',
      result: `${cap(cheaperWords(c.cheaperPct) || 'not priced yet')}. ${c.passed ? 'Answers as good.' : 'Approved by you.'}`,
      why: setUp ? waitWhy
        : `${c.passed ? 'It passed the test on your own requests' : 'You approved it after it was tested on your own requests'}${w.switched?.evidence?.at ? ` on ${dateIST(w.switched.evidence.at)} IST` : ''}. The newest test did not include it. ${again}`,
    });
  }

  // what is being tried now, beside what serves
  if (trial) {
    for (const o of trial.runners.slice(0, 2)) {
      const shadow = trial.mode === 'shadow';
      const calls = shadow ? o.shadow?.calls || 0 : o.live?.calls || 0;
      cards.push({
        key: 'trial', family: 'trial', tone: 'warn', list: null,
        status: shadow ? 'Trying in the background' : 'Trying on a few requests', name: o.label,
        what: shadow ? `Answers a copy of about ${inHundred(trial.share)} requests in the background, so it can be compared without affecting your users.`
          : `Answers a few live requests, so it can be compared with ${label}.`,
        result: !calls ? 'No answers yet.'
          : shadow ? `Same answer ${num(o.shadow.same || 0)} of ${num(calls)} times so far.`
            : known(o.live.rate) ? `Worked on ${pct(o.live.rate, 0)} of ${num(calls)} so far.` : `${plural(calls, 'answer')} so far.`,
        why: `${trial.days ? `At this volume, gathering enough evidence to decide takes about ${plural(trial.days, 'day')}. ` : ''}`
          + (w.optimizeMode === 'auto' ? 'If it does better, it can take over by itself, on a small share of requests first.'
            : 'If it does better, you are asked whether to switch.'),
      });
    }
  }
  return cards.sort((a, b) => RANK[a.key] - RANK[b.key]);
}

/* Why there is nothing to show yet, and when there will be: a test running or waiting, one that could not
   compare anything and why, or the first test still to come, by itself or when asked. */
function emptySetups(c) {
  const { w, v, ref } = c;
  const cert = w.certificate;
  const running = w.measure?.running;
  if (running) return running.queued ? 'No setups have been tested yet. A test is waiting to start.' : 'No setups have been tested yet. A test is running now.';
  if (cert?.outcome === 'unmeasurable') {
    return `No setups could be compared yet: ${ref} gave different answers to the same requests too often, so no pass mark could be set. `
      + `The pass mark is how often ${ref}'s own two answers to the same request differ from each other.`;
  }
  if (cert?.outcome === 'refused') return `No setups could be compared yet: ${ref} could not answer these requests when they were replayed.`;
  if (cert) return 'The last test did not compare any setups. The next one looks again.';
  const t = v.tests || {};
  if (t.runs > 0) {
    return t.auto ? 'No test has finished yet. Understudy tries again on its own schedule.'
      : 'No test has finished yet. Press Measure now below to try again.';
  }
  if (!t.auto) return 'No setups have been tested yet. This workspace only tests when asked, so press Measure now below when you are ready.';
  if (t.seen >= t.firstAfter) return 'No setups have been tested yet. The first test starts soon.';
  return `No setups have been tested yet. The first test starts by itself once Understudy has seen ${num(t.firstAfter)} of your requests. `
    + `It has seen ${num(t.seen)} so far.`;
}

function Setups({ c }) {
  const cards = useMemo(() => setupsOf(c), [c]);
  const [pick, setPick] = useState(0);
  const shown = cards[Math.min(pick, cards.length - 1)];
  const again = c.everyDays > 0 ? 'and tests them again as models and prices change' : 'and tests them again when you ask';
  return (
    <div className="vpsec" aria-labelledby="vp-setups-h">
      <div className="vpsechead">
        <h3 id="vp-setups-h">Every setup we considered for this workload</h3>
        <p>
          Understudy does not just look for one cheaper model. It builds and tests different setups, keeps the best one serving
          {c.trial ? ', keeps trying the runners-up' : ''}, {again}. Tap a setup to see how it did.
        </p>
      </div>
      {!cards.length ? (
        <div className="vpempty">{emptySetups(c)}</div>
      ) : (
        <>
          <div className="vpgarden">
            {cards.map((s, i) => (
              <button key={`${s.key}-${s.family}-${s.name}`} type="button" className={`vpcard${shown === s ? ' on' : ''}`}
                aria-pressed={shown === s} onClick={() => setPick(i)}>
                <span className={`vpchip ${s.tone}`}>{s.status}</span>
                <span className="vpct">{s.name}</span>
                <span className="vpcw">{s.what}</span>
                <span className="vpcr m">{s.result}</span>
              </button>
            ))}
          </div>
          <div className="vpwhy" aria-live="polite">
            <p><b>{shown.name}: </b>{shown.why}</p>
            {shown.list && (
              <ul className="vplist" aria-label={`Every ${shown.name.toLowerCase()} setup tested`}>
                {shown.list.map((r) => (
                  <li key={r.name}><span className="vpln">{r.name}</span><span className="vplr">{r.result}</span>{r.cost && <span className="vplc m">{r.cost}</span>}</li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* How it got here --------------------------------------------------------------------------------- */

/* A reason recorded for a switch back, in plain words where it is one of the usual ones. */
function backWhy(reason) {
  const r = String(reason || '');
  if (/^live results/i.test(r)) return 'On live requests it did worse than what it replaced.';
  if (/typical live answer/.test(r)) return 'Its answers came slower than your speed setting allows.';
  if (/calls failed|live calls failed/.test(r)) return 'More of its requests failed than before the switch.';
  if (/no longer offered|keeps nothing|keeping what it is sent/.test(r)) return 'It could no longer be served the way this workspace requires.';
  return r ? `${r.charAt(0).toUpperCase()}${r.slice(1)}${/[.!?]$/.test(r) ? '' : '.'}` : '';
}

function eventWords(e, c, next) {
  const { ref } = c;
  if (e.kind === 'connected') {
    return e.via === 'trace'
      ? { title: 'Copies started arriving', text: `Copies of your requests started reaching Understudy, after ${ref} had answered them at your own provider. Understudy learns from the copies; your requests themselves did not change.` }
      : { title: 'Connected', text: `Requests started going through Understudy. Nothing changed yet: ${ref} still answered every one while Understudy learned what this workload needs.` };
  }
  if (e.kind === 'test') {
    const title = e.trigger === 'first' ? 'First test' : e.trigger === 'manual' ? 'Test, started by you' : 'Regular re-test';
    let text;
    if (e.outcome === 'unmeasurable') text = `${ref} gave different answers to the same requests too often, so no pass mark could be set and nothing was compared.`;
    else if (e.outcome === 'refused') text = `${ref} could not answer these requests when they were replayed, so there was nothing to compare against.`;
    else if (e.outcome === 'no_balance') text = 'The balance ran out part way, so the test stopped before it had compared everything.';
    else if (!e.tried) text = 'No setups were tried in this test.';
    else if (e.passed) text = `${plural(e.tried, 'setup was', 'setups were')} tested on your own requests, and ${num(e.passed)} passed. The cheapest that passed: ${e.best}.`;
    else text = `${plural(e.tried, 'setup was', 'setups were')} tested on your own requests. None passed, so nothing changed.`;
    if (e.spend > 0) text += ` The test cost ${usd(e.spend)}.`;
    return { title, text };
  }
  if (e.kind === 'switch') {
    const small = next?.kind === 'step' ? ' It started on a small share of requests, so a problem could only reach a few.' : '';
    const why = e.by === 'you' ? 'You approved it.'
      : /^live results/i.test(String(e.reason || '')) ? 'It switched by itself, because it did better on live requests.'
        : 'It passed the test, and this workload switches by itself.';
    // the switch still waiting for its first request through Understudy says so
    const waits = c.v.waiting && e.at === c.lastSwitchAt ? ' It starts with the first request that comes through Understudy.' : '';
    return { title: `Switched to ${e.to}`, text: `${why}${small}${waits}` };
  }
  if (e.kind === 'back') {
    return {
      title: e.toOwn ? `Back on ${ref}` : `Back on ${e.to}`,
      text: e.by === 'you' ? 'You switched it back.' : `It switched back by itself. ${backWhy(e.reason)}`.trim(),
    };
  }
  if (e.kind === 'step') {
    return e.share >= 1
      ? { title: 'Now answers every request', text: 'The new setup took over all requests.' }
      : { title: `Now answers ${inHundred(e.share)} requests`, text: 'The new setup was given a bigger share of requests, one step closer to answering all of them.' };
  }
  if (e.kind === 'trial') {
    return { title: `Started trying ${e.label}`, text: `${e.label} began answering copies of a few requests in the background, to compare with what serves. Your users kept getting the normal answer. It has answered ${num(e.answers)} so far.` };
  }
  if (e.kind === 'outage') {
    return { title: 'A provider failed, requests rescued', text: `In this hour, ${plural(e.rescued, 'request')} failed at the first try because the company running the model was down, too busy or too slow. Each was answered another way, so your app saw no error.` };
  }
  if (e.kind === 'ready') {
    return { title: `${e.label} is ready for you`, text: 'It matched your answers on live requests. Nothing switches until you approve it.' };
  }
  return { title: 'Something changed', text: '' };
}

const MARK_TONE = { switch: 'ok', step: 'ok', ready: 'ok', back: 'warn', outage: 'bad' };

function History({ c }) {
  const { v, ref, switched } = c;
  const series = v.history.series;
  const [box, width] = useWidth();
  const W = width || 900;
  const narrow = W < 560;
  const H = narrow ? 150 : 180;
  const R = 14;
  const T = 18;
  const B = 16;
  const t0 = series.length ? series[0].at - DAY : v.at - DAY;
  const t1 = v.at;
  const pts = [{ at: t0, saved: 0 }, ...series];
  const vals = pts.map((p) => p.saved);
  let lo = Math.min(0, ...vals);
  let hi = Math.max(0, ...vals);
  /* Never taller than five cents' worth: a fraction of a cent drawn to fill the chart reads as a plunge,
     and the amount itself is said above the chart. */
  const MIN_SPAN = 0.05;
  if (hi - lo < MIN_SPAN) {
    if (hi <= 0) lo = hi - MIN_SPAN;
    else if (lo >= 0) hi = lo + MIN_SPAN;
    else { const mid = (hi + lo) / 2; lo = mid - MIN_SPAN / 2; hi = mid + MIN_SPAN / 2; }
  }
  const pad = (hi - lo) * 0.08;
  lo -= lo < 0 ? pad : 0;
  hi += pad;
  // where the line dips below nothing saved, the zero line is marked, in a margin of its own so no mark sits on it
  const L = lo < 0 ? 40 : 14;
  const px = (at) => L + ((at - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const py = (val) => T + ((hi - val) / (hi - lo)) * (H - T - B);
  const zero = py(0);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${px(p.at).toFixed(1)} ${py(p.saved).toFixed(1)}`).join(' ');
  const area = `${line} L${px(t1).toFixed(1)} ${zero.toFixed(1)} L${px(t0).toFixed(1)} ${zero.toFixed(1)} Z`;
  const valueAt = (at) => {
    for (let i = 1; i < pts.length; i += 1) {
      if (at <= pts[i].at) {
        const a = pts[i - 1];
        const b = pts[i];
        return a.saved + ((at - a.at) / Math.max(1, b.at - a.at)) * (b.saved - a.saved);
      }
    }
    return pts[pts.length - 1].saved;
  };

  // events close together on the line share one mark, which lists them all
  const clusters = useMemo(() => {
    const evs = (v.history.events || []).filter((e) => e.at >= t0 && e.at <= t1);
    const out = [];
    for (const [i, e] of evs.entries()) {
      const x = px(e.at);
      const last = out[out.length - 1];
      const item = { e, next: evs[i + 1] || null };
      if (last && x - last.x0 < 24) { last.items.push(item); last.x1 = x; } else out.push({ x0: x, x1: x, items: [item] });
    }
    return out.map((k) => {
      const x = (k.x0 + k.x1) / 2;
      const at = t0 + ((x - L) / Math.max(1, W - L - R)) * (t1 - t0);
      const top = k.items.find((it) => MARK_TONE[it.e.kind] === 'bad') || k.items.find((it) => MARK_TONE[it.e.kind] === 'warn')
        || k.items.find((it) => MARK_TONE[it.e.kind] === 'ok');
      return { ...k, x, y: py(valueAt(at)), tone: top ? MARK_TONE[top.e.kind] : '' };
    });
  }, [v, W]);
  const [pick, setPick] = useState(null);
  const at = pick === null || pick >= clusters.length ? clusters.length - 1 : pick;
  const shown = clusters[at];
  const saved = v.history.saved;
  const firstDay = v.history.firstSeen && v.history.firstSeen >= t0 ? v.history.firstSeen : t0 + 1;
  const clipped = v.history.firstSeen && v.history.firstSeen < t0;
  /* A shortfall says what it came from: testing, our fee on requests nothing cheaper answered yet, or
     both. Copies carry no fee, so a workload seen only through copies is short only by what testing cost. */
  const testing = v.history.testing || 0;
  const cause = testing <= 0.00005 ? 'from our fee'
    : -saved - testing > 0.00005 ? 'from testing and our fee'
      : switched ? 'because testing cost more than the switch has saved so far' : 'from testing';
  const summary = saved > 0.005 ? <>Saved so far: <b className="m vpgood">{usd(saved)}</b>, after what testing cost</>
    : saved < -0.00005 ? <>So far: <b className="m">{usd(-saved)}</b> more than {ref} alone, {cause}</>
      : <>Nothing saved or spent yet</>;
  const idp = `vp-${c.w.id}`;

  return (
    <div className="vpsec" aria-labelledby="vp-hist-h">
      <div className="vpsechead">
        <h3 id="vp-hist-h">How it got here</h3>
        <p>What Understudy has saved you since it first saw this workload, after what testing cost. Tap a point to see what happened.</p>
        <p className="vpsum">{summary}{clipped ? '. Showing the last 365 days.' : '.'}</p>
      </div>
      <div ref={box} className="vphist" style={{ height: H }}
        onKeyDown={(e) => {
          if (!clusters.length) return;
          if (e.key === 'ArrowLeft') { e.preventDefault(); setPick(Math.max(0, at - 1)); }
          else if (e.key === 'ArrowRight') { e.preventDefault(); setPick(Math.min(clusters.length - 1, at + 1)); }
        }}>
        <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
          aria-label={`What this workload has saved over time, after testing costs: ${saved >= 0 ? `${usd(saved)} saved` : `${usd(-saved)} more than ${ref} alone`} so far.`}>
          <defs>
            <clipPath id={`${idp}-up`}><rect x="0" y="0" width={W} height={Math.max(0, zero)} /></clipPath>
            <clipPath id={`${idp}-down`}><rect x="0" y={zero} width={W} height={Math.max(0, H - zero)} /></clipPath>
          </defs>
          {lo < 0 && <line x1={L} x2={W - R} y1={zero} y2={zero} stroke="var(--line-strong)" strokeDasharray="4 4" />}
          <path d={area} fill="var(--ok)" opacity="0.08" clipPath={`url(#${idp}-up)`} />
          <path d={area} fill="var(--warn)" opacity="0.08" clipPath={`url(#${idp}-down)`} />
          <path d={line} fill="none" stroke="var(--ok)" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" clipPath={`url(#${idp}-up)`} />
          <path d={line} fill="none" stroke="var(--warn)" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" clipPath={`url(#${idp}-down)`} />
        </svg>
        {lo < 0 && <span className="vpzero m" style={{ top: zero - 8 }}>$0</span>}
        {clusters.map((k, i) => {
          const titles = k.items.map((it) => eventWords(it.e, c, it.next).title);
          return (
            <button key={`${k.x0}-${i}`} type="button" className={`vpmark${k.tone ? ` ${k.tone}` : ''}${i === at ? ' on' : ''}`}
              style={{ left: `${(k.x / W) * 100}%`, top: k.y }} aria-pressed={i === at}
              aria-label={`${timeIST(k.items[0].e.at)} IST: ${titles.join(', then ')}`} onClick={() => setPick(i)}>
              <i aria-hidden="true" />
              {k.items.length > 1 && <span className="vpmn m" aria-hidden="true">{k.items.length}</span>}
            </button>
          );
        })}
      </div>
      <div className="vphaxis m" aria-hidden="true"><span>{dayIST(firstDay)}</span><span>today</span></div>
      {shown && (
        <div className="vpevents" aria-live="polite">
          {shown.items.map((it) => {
            const words = eventWords(it.e, c, it.next);
            return (
              <div key={`${it.e.kind}-${it.e.at}`} className="vpev">
                <span className="vpevd m">{timeIST(it.e.at)} IST</span>
                <div><b>{words.title}</b>{words.text && <span>{words.text}</span>}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* Always on --------------------------------------------------------------------------------------- */

function Guards({ c }) {
  const g = c.v.guards;
  const stages = (g.stages || []).map((s) => Math.round(s * 100));
  const small = stages.length
    ? `A new setup starts on ${stages[0]} of every 100 requests${stages.slice(1).map((s) => `, then ${s}`).join('')}, then all of them. If its answers get worse at any step, it goes back.`
    : 'A new setup is watched from its very first request, and goes back if its answers get worse.';
  const mode = g.mode === 'auto' ? ' This workload switches by itself once a setup passes the test twice.'
    : g.mode === 'off' ? ' This workload never switches by itself.' : ' Nothing switches until you approve it.';
  const cards = [
    g.zdr
      ? { t: 'Your data isn’t kept', s: 'Your requests only go to AI companies that delete them as soon as they have answered. This is called zero data retention.' }
      : { t: 'Your data isn’t trained on', s: 'Your requests never go to an AI company that trains its models on them. The stricter setting, zero data retention, where companies delete requests as soon as they answer, is off for this workspace; you can turn it on in Settings.' },
    { t: 'A price ceiling', s: 'Every request carries the most an AI company may charge for it, so no company can charge more than the amount set aside for it.' },
    { t: 'Changes start small', s: `${small}${mode}` },
    { t: 'Switches back by itself', s: `If more of its requests fail, its answers come slower than your speed setting allows, its answers get worse, or the model stops being offered, the workload goes back to ${c.ref} on its own. You can also switch back yourself at any time.` },
  ];
  return (
    <div className="vpsec" aria-labelledby="vp-guards-h">
      <div className="vpsechead"><h3 id="vp-guards-h">Always on, for every request</h3></div>
      <div className="vpguards">
        {cards.map((x) => (
          <div key={x.t} className="vpguard"><b>{x.t}</b><span>{x.s}</span></div>
        ))}
      </div>
      <a className="vphow" href="#measure" onClick={(e) => {
        const el = document.getElementById('measure');
        if (!el) return;
        e.preventDefault();
        if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
        el.focus({ preventScroll: true });
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }}>How we test a setup before it serves any requests</a>
    </div>
  );
}
