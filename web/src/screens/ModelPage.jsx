import React, { useCallback, useEffect, useRef, useState } from 'react';
import { href, modelHref } from '../router.js';
import { plainClick } from '../nav.jsx';
import { api, num, timeIST } from '../api.js';
import { I } from '../WorkloadCharts.jsx';
import { Help, ColumnWords, SampledWords } from './WorkloadDetail.jsx';
import '../workload-page.css';
import '../model-page.css';

/* One model in one of a workload's tests, on a page of its own (the model page artboard the user approved on 26 Sep
 * 2026). Its answers used to open inside the test's table, where a long request ran off the table's edge and every
 * request was a tall card, so reading 120 of them meant a long scroll. Here:
 *   - Back to the test, where you are, and the test's next model;
 *   - one paragraph saying what happened and why the outcome is what it is;
 *   - four figures, each against the original model: how often it differed, how many requests it was tested on, what a
 *     thousand requests cost, and its typical time;
 *   - its requests as a table, twenty to a page with page numbers, narrowed to one result if asked, each request one line
 *     (the instruction every request shares is said once above it), a row opening in place with Previous and Next.
 * The figures come from the test's page (runPageOf) and the answers from runAnswersOf, both in src/workloadPage.js. */

const PER = 20;
const pct1 = (x) => `${(x * 100).toFixed(1)}%`;
const secs = (ms) => (ms < 95 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const cents = (v) => {
  const x = Number(v) || 0;
  if (x !== 0 && Math.abs(x) < 0.005) return x < 0 ? 'under -$0.01' : 'under $0.01';
  return `${x < 0 ? '-' : ''}$${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
// what one request costs, to a hundredth of a cent (as the workload page writes it)
const perCall = (v) => {
  const x = Number(v) || 0;
  if (Math.abs(x) >= 1) return cents(x);
  if (x !== 0 && Math.abs(x) < 0.00005) return 'under $0.0001';
  return `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(4)}`;
};
/* What a thousand requests cost: to the cent, and below a cent to the one figure that says something ("$0.004"),
   because $0.05 reads more easily than $0.0001 a request. */
const perThousand = (v) => {
  const x = (Number(v) || 0) * 1000;
  if (x >= 0.01 || x === 0) return cents(x);
  return `$${Number(x.toPrecision(1))}`;
};
const scoreWords = (s) => String(Math.round(Number(s) * 100) / 100);
const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : many}`;

/* What the page says first: how the model did on this test's requests, on its second look if it had one, and what
   follows from it, in words, from the test's own figures. */
function leadOf(c, got, rp) {
  const quality = rp.yardstick === 'quality';
  const keeps = rp.yardstick === 'keeps';
  const ref = rp.referenceName || 'the original model';
  const L = got?.looks || {};
  const n = L.first || c.n || 0;
  const out = [];
  if (c.serving) out.push('This is the model answering this workload now.');
  if (c.gap !== null && c.gap !== undefined && n > 0) {
    if (c.gap === 0) {
      out.push(keeps ? `Its answer kept everything that matters in ${ref}'s answers, and got nothing wrong, on all ${num(n)} requests in this test.`
        : quality ? `Its answer was at least as good as ${ref}'s on all ${num(n)} requests in this test.`
          : `It gave the same answer as ${ref} on all ${num(n)} requests in this test.`);
    } else {
      out.push(keeps
        ? `Its answer missed something that matters in ${ref}'s answers, or got something wrong, on ${pct1(c.gap)} of the ${num(n)} requests in this test, where ${pct1(rp.bar)} is allowed.`
        : quality
          ? `Its answer was clearly worse than ${ref}'s on ${pct1(c.gap)} of the ${num(n)} requests in this test, where ${pct1(rp.bar)} is allowed.`
          : `It answered differently from ${ref} on ${pct1(c.gap)} of the ${num(n)} requests in this test, where ${pct1(rp.bar)} is allowed.`);
    }
  }
  const second = Number(L.second) || 0;
  if (second > 0) {
    const f = L.figure;
    const all = keeps ? 'it kept what matters on every one' : quality ? 'its answer was at least as good on every one' : 'it gave the same answer on every one';
    const some = keeps ? `it missed something that matters on ${pct1(f)} of them` : quality ? `its answer was clearly worse on ${pct1(f)} of them`
      : `it answered differently on ${pct1(f)} of them`;
    out.push(f === null || f === undefined ? `A second look then tried it on ${num(second)} new requests.`
      : f === 0
        ? `A second look then tried it on ${num(second)} new requests, and ${all}.`
        : `A second look then tried it on ${num(second)} new requests, and ${some}.`);
    const bar = L.bar;
    const inside = f !== null && f !== undefined && bar !== null && bar !== undefined && f <= bar;
    if (L.verdict === 'cleared') out.push('So it passed twice.');
    else if (L.verdict === 'live') out.push('It then passed on live requests too.');
    else if (L.verdict === 'slower') out.push('It was too slow on them, so nothing switches to it.');
    else if (L.verdict === 'review' && inside) out.push(`That is inside the ${pct1(bar)} allowed, but not by enough for the test to be sure, so nothing has switched to it yet.`);
    else if ((L.verdict === 'review' || L.verdict === 'missed') && bar !== null && bar !== undefined) out.push(`That is more than the ${pct1(bar)} allowed, so nothing switches to it.`);
    // its provider could not keep up on the second look (src/eval/run.js lookAgain): why it failed, as its row says it
    else if (L.verdict === 'busy' && c.why) out.push(c.why);
  } else if (L.verdict === 'insufficient') {
    out.push("There weren't enough new requests for a second look yet, so nothing switches to it until there are.");
  } else if (L.verdict === 'not_reached') {
    /* why no second look came to it (notReachedWhy in src/workloadPage.js), and, where none passed instead, that it still
       has one to come */
    out.push(L.notReached === 'cut' ? "Its second look wasn't reached, because the test ended before it got there."
      : L.notReached === 'tries' ? `Its second look wasn't reached, because each test gives a second look to only the first ${num(L.tries || 3)} models in line.`
        : L.notReached === 'part' ? "Its second look wasn't reached, because this second look was only for the setup it was tested as part of."
          : L.notReached === 'held' ? "Its second look wasn't reached, because this workload was switched back from it before, so it isn't switched to by itself again."
            : "Its second look wasn't reached, because another model passed first.");
    if (['cut', 'tries', 'part'].includes(L.notReached)) out.push('It is tested again on new requests before anything switches to it.');
  } else if (c.verdict === 'Passed once') {
    out.push('It is tested again on new requests before anything switches to it.');
  } else if (c.why && !(c.gap === 0 && /allowed difference/.test(c.why))) {
    out.push(c.why);
  }
  return out.join(' ');
}

/* The instruction every request on the page starts with, where there is one: the longest shared start, cut back to where
   a line or a sentence ends so it is whole, and long enough to be worth saying once. */
function sharedStart(texts) {
  const xs = texts.filter((t) => typeof t === 'string' && t.length);
  if (xs.length < 2) return '';
  let p = xs[0];
  for (const t of xs.slice(1)) {
    let i = 0;
    while (i < p.length && i < t.length && p[i] === t[i]) i += 1;
    p = p.slice(0, i);
    if (!p) return '';
  }
  const ends = [...p.matchAll(/[\n]|[:.!?](?=\s)/g)].map((m) => m.index + 1);
  const cut = ends.length ? ends[ends.length - 1] : 0;
  const whole = p.slice(0, cut).trim();
  return whole.length >= 20 ? p.slice(0, cut) : '';
}
// one request as one line: what follows the shared instruction, its first two lines
const lineOf = (asked, start) => {
  if (!asked) return null;
  const rest = start && asked.startsWith(start) ? asked.slice(start.length) : asked;
  const lines = rest.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const said = lines.slice(0, 2).join(' · ');
  return said.length > 120 ? `${said.slice(0, 119)}…` : said;
};

export default function ModelPage({ wid, runId, model, go, goTo }) {
  const [w, setW] = useState(null);
  const [rp, setRp] = useState(null);
  const [got, setGot] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [openCall, setOpenCall] = useState(null);
  const want = useRef('');
  const tableTop = useRef(null);

  useEffect(() => {
    let live = true;
    Promise.all([api.workload(wid), api.workloadRunPage(wid, runId)])
      .then(([a, b]) => { if (live) { setW(a); setRp(b); } })
      .catch((e) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [wid, runId]);

  /* One page of answers, of one look, of one result or all of them. `then` opens a row once it is read: the first, for
     Next from the last row of the page before, and the last, for Previous from the first row of the page after. */
  const read = useCallback((page, look, result, { then = null, scroll = false } = {}) => {
    const key = `${look}:${result || ''}:${page}`;
    want.current = key;
    setBusy(true);
    api.runAnswers(wid, runId, model, page, look, { per: PER, result })
      .then((x) => {
        if (want.current !== key) return;
        setGot(x);
        setErr(null);
        setOpenCall(then === 'first' ? x.rows[0]?.callId ?? null : then === 'last' ? x.rows[x.rows.length - 1]?.callId ?? null : null);
        const el = tableTop.current;
        const pad = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0;
        if (scroll && el && el.getBoundingClientRect().top < pad) el.scrollIntoView({ block: 'start' });
      })
      .catch((e) => { if (want.current === key) setErr(e.message); })
      .finally(() => { if (want.current === key) setBusy(false); });
  }, [wid, runId, model]);
  useEffect(() => { read(1, 1, null); }, [read]);

  const testHref = `${href('work', wid)}#${runId}`;
  const toTest = plainClick(() => go('work', wid, { hash: runId }));
  const toWorkload = plainClick(() => go('work', wid));

  // a model this test never tried says so, whatever reading its answers said (they are "not found")
  if (rp && !rp.cands.some((x) => x.key === model)) {
    return (
      <div className="wp-page"><div className="wp mp">
        <div className="mp-top">
          <a className="mp-back" href={testHref} onClick={toTest}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.8 3.5 5.3 8l4.5 4.5M5.6 8h7.4" /></svg>Back to the test
          </a>
        </div>
        <p className="wp-loadline">This model wasn't tried in this test. The test's page lists every model it tried.</p>
      </div></div>
    );
  }
  if (err && !(rp && got)) {
    return (
      <div className="wp-page"><div className="wp mp">
        <div className="mp-top">
          <a className="mp-back" href={testHref} onClick={toTest}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.8 3.5 5.3 8l4.5 4.5M5.6 8h7.4" /></svg>Back to the test
          </a>
        </div>
        <div className="errbox" role="alert">This model's page could not be read: {err}</div>
      </div></div>
    );
  }
  if (!w || !rp || !got) return <div className="loading">Reading this model's answers…</div>;
  const i = rp.cands.findIndex((x) => x.key === model);
  const c = rp.cands[i];
  if (!c) {
    return (
      <div className="wp-page"><div className="wp mp">
        <div className="mp-top"><a className="mp-back" href={testHref} onClick={toTest}>Back to the test</a></div>
        <p className="wp-loadline">This model wasn't tried in this test.</p>
      </div></div>
    );
  }
  const next = rp.cands[i + 1] || null;
  const quality = rp.yardstick === 'quality';
  const keeps = rp.yardstick === 'keeps';
  const ref = rp.referenceName || 'the original model';
  const second = got.look === 2;
  const k = got.counts;
  const L = got.looks;
  const hasSecond = !got.from && (L.second > 0 || L.kept > 0);
  const pages = Math.max(1, Math.ceil((got.matched ?? got.total) / PER));
  const start = sharedStart(got.rows.map((x) => x.asked));
  const idx = got.rows.findIndex((x) => x.callId === openCall);
  const first = (got.page - 1) * got.per + 1;
  const words = {
    same: keeps ? 'Kept what matters' : quality ? 'At least as good' : 'Same answer',
    // a half under the three judges is a difference nobody could call (judgeChoices), never a partly worse answer
    partly: keeps ? 'Partly missed' : quality ? (got.panel ? "Couldn't call" : 'Partly worse') : 'Matched one of the two',
    different: keeps ? 'Missed something' : quality ? 'Clearly worse' : 'Different',
    failed: 'Failed', busy: 'Provider busy', unjudged: 'Not judged',
  };
  const chips = ['same', 'different', 'failed', 'partly', 'busy', 'unjudged'].filter((x) => ['same', 'different', 'failed'].includes(x) || k[x] > 0);
  const choose = (res) => read(1, got.look, res === got.filter ? null : res);
  const step = (d) => {
    const at = idx + d;
    if (at >= 0 && at < got.rows.length) { setOpenCall(got.rows[at].callId); return; }
    if (d > 0 && got.more) read(got.page + 1, got.look, got.filter, { then: 'first' });
    if (d < 0 && got.page > 1) read(got.page - 1, got.look, got.filter, { then: 'last' });
  };
  const time = rp.metric === 'ttft' ? 'Time to first word' : 'Typical time';
  const axis = keeps ? 'Missed' : quality ? 'Worse' : 'Different';
  const refPer = rp.yours?.perCall ?? null;
  const refP50 = rp.yours?.p50 ?? null;
  // the scale of the difference drawn: to twice the allowed, and far enough for the figure itself
  const most = Math.max(0.01, (rp.bar || 0) * 2, (c.gap || 0) * 1.15);
  const at = (x) => Math.max(5, Math.min(195, (x / most) * 200));
  const barW = (v, top) => (top > 0 ? Math.max(2.5, (v / top) * 110) : 0);
  const topCost = Math.max(c.perCall || 0, refPer || 0);
  const topTime = Math.max(c.p50 || 0, refP50 || 0);
  const less = refPer > 0 && c.perCall !== null ? 1 - c.perCall / refPer : null;
  const faster = refP50 > 0 && c.p50 ? refP50 - c.p50 : null;
  const pageNos = (() => {
    const p = got.page;
    const set = new Set([1, pages, p - 1, p, p + 1].filter((x) => x >= 1 && x <= pages));
    const list = [...set].sort((a, b) => a - b);
    const out = [];
    list.forEach((x, j) => { if (j && x - list[j - 1] > 1) out.push('gap'); out.push(x); });
    return out;
  })();

  return (
    <div className="wp-page">
      <div className="wp mp">
        <div className="mp-top">
          <a className="mp-back" href={testHref} onClick={toTest}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.8 3.5 5.3 8l4.5 4.5M5.6 8h7.4" /></svg>Back to the test
          </a>
          <nav className="mp-crumbs" aria-label="Where you are">
            <a href={href('work')} onClick={plainClick(() => go('work'))}>Workloads</a><i aria-hidden="true">/</i>
            <a className="m" href={href('work', wid)} onClick={toWorkload}>{w.name}</a><i aria-hidden="true">/</i>
            <a href={testHref} onClick={toTest}>Test of {timeIST(rp.at)} IST</a>
          </nav>
          <span className="mp-grow" />
          {next && (
            <a className="mp-nextm" href={modelHref(wid, runId, next.key)} onClick={plainClick(() => goTo(modelHref(wid, runId, next.key)))}>
              <span className="mp-nextw">Next model</span><span className="m">{next.label}</span>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.2 3.5 10.7 8l-4.5 4.5" /></svg>
            </a>
          )}
        </div>

        <header className="mp-head">
          <div className="mp-name">
            <h1 className="m">{c.label}</h1>
            <span className={`wp-pill is-${c.tone}`}><span className="wp-pd" />{c.verdict}</span>
          </div>
          {got.from && <p className="mp-from">{got.from.why}</p>}
          <p className="mp-lead">{leadOf(c, got, rp)}</p>
        </header>

        <div className="mp-tiles">
          <div className="mp-tile">
            <span className="mp-k">{axis}<Help label={keeps ? 'Missed something that matters' : quality ? 'Worse than original model' : 'Different from original model'}><ColumnWords rp={rp} /></Help></span>
            <span className="mp-v m">{c.gap === null ? 'not judged' : pct1(c.gap)}</span>
            {c.gap !== null && rp.bar > 0 && (
              <svg className="mp-meter" viewBox="0 0 200 36" role="img" aria-label={`${pct1(c.gap)}, where ${pct1(rp.bar)} is allowed`}>
                <rect x="0" y="12" width="200" height="8" rx="4" className="tr" />
                <line x1={at(rp.bar)} y1="6" x2={at(rp.bar)} y2="26" className="lim" />
                <circle cx={at(c.gap)} cy="16" r="5" className={c.gap <= rp.bar ? 'dot' : 'dot bad'} />
                {/* the allowed mark near either end is labelled from that end, so it never runs over "0%" or off the tile */}
                {at(rp.bar) >= 70 && <text x="0" y="35" className="lb">0%</text>}
                <text x={at(rp.bar) < 70 ? Math.max(0, at(rp.bar) - 4) : at(rp.bar) > 130 ? Math.min(200, at(rp.bar) + 4) : at(rp.bar)} y="35" className="lb"
                  textAnchor={at(rp.bar) < 70 ? 'start' : at(rp.bar) > 130 ? 'end' : 'middle'}>{pct1(rp.bar)} allowed</text>
              </svg>
            )}
          </div>
          <div className="mp-tile">
            <span className="mp-k">Requests sampled<Help label="Requests sampled"><SampledWords /></Help></span>
            <span className="mp-v m">{num(c.n)}{L.second > 0 && <em> + {num(L.second)} new</em>}</span>
            <span className="mp-n">
              {L.second > 0 ? `${num(c.n)} in this test, then ${num(L.second)} new ones on its second look.`
                : rp.sample && c.n < rp.sample ? `${num(c.n)} of the ${num(rp.sample)} requests in this test.` : `All ${num(c.n)} requests in this test.`}
            </span>
          </div>
          <div className="mp-tile">
            <span className="mp-k">Cost per 1,000 requests</span>
            <span className="mp-v m">{c.perCall === null ? 'not priced' : perThousand(c.perCall)}</span>
            {c.perCall !== null && refPer > 0 && (
              <svg className="mp-bars" viewBox="0 0 200 30" role="img" aria-label={`${perThousand(c.perCall)} per 1,000 requests, against ${perThousand(refPer)} on ${ref}`}>
                <rect x="0" y="2" width={barW(c.perCall, topCost)} height="9" rx="2" className="me" /><text x="200" y="10" className="bl" textAnchor="end">this model</text>
                <rect x="0" y="18" width={barW(refPer, topCost)} height="9" rx="2" className="ref" /><text x="200" y="26" className="bl" textAnchor="end">{ref}</text>
              </svg>
            )}
            {less !== null && (
              <span className="mp-n">
                {Math.abs(less) < 0.005 ? `About the same as ${ref}, ${perThousand(refPer)}.`
                  : less > 0 ? <><b>{Math.min(99, Math.round(less * 100))}% less</b> than {ref}, which costs {perThousand(refPer)}.</>
                    : <><b className="up">{Math.round(-less * 100)}% more</b> than {ref}, which costs {perThousand(refPer)}.</>}
              </span>
            )}
          </div>
          <div className="mp-tile">
            <span className="mp-k">{time}</span>
            <span className="mp-v m">{c.p50 ? secs(c.p50) : 'not timed'}</span>
            {c.p50 && refP50 > 0 && (
              <svg className="mp-bars" viewBox="0 0 200 30" role="img" aria-label={`${secs(c.p50)}, against ${secs(refP50)} on ${ref}`}>
                <rect x="0" y="2" width={barW(c.p50, topTime)} height="9" rx="2" className="me" /><text x="200" y="10" className="bl" textAnchor="end">this model</text>
                <rect x="0" y="18" width={barW(refP50, topTime)} height="9" rx="2" className="ref" /><text x="200" y="26" className="bl" textAnchor="end">{ref}</text>
              </svg>
            )}
            {faster !== null && (
              <span className="mp-n">
                {Math.abs(faster) < 50 ? `About as fast as ${ref}, ${secs(refP50)}.`
                  : faster > 0 ? <><b>{secs(faster)} faster</b> than {ref}, which takes {secs(refP50)}.</>
                    : <><b className="up">{secs(-faster)} slower</b> than {ref}, which takes {secs(refP50)}.</>}
              </span>
            )}
          </div>
        </div>

        <section className="mp-reqs" aria-labelledby="mp-reqs-h" ref={tableTop}>
          <div className="mp-reqbar">
            <h2 id="mp-reqs-h">Requests</h2>
            <span className="mp-grow" />
            {hasSecond && (
              <span className="mp-seg" role="group" aria-label="Which of its looks to show">
                <button type="button" className={second ? '' : 'on'} aria-pressed={!second} disabled={busy} onClick={() => { if (second) read(1, 1, null); }}>
                  First look <span className="m">{num(L.first)}</span>
                </button>
                <button type="button" className={second ? 'on' : ''} aria-pressed={second} disabled={busy} onClick={() => { if (!second) read(1, 2, null); }}>
                  Second look <span className="m">{num(L.second || L.kept)} new</span>
                </button>
              </span>
            )}
          </div>
          {second && !got.total ? (
            <p className="wp-loadline">
              {`On its second look this model was tested on ${plural(L.second, 'new request', 'new requests')} before anything could switch to it${L.ended ? `, and ${L.ended}` : ''}. This test ran before Understudy kept the answers to a second look, so only its result is shown here.`}
            </p>
          ) : !got.total ? (
            <p className="wp-loadline">No answers were kept for this model in this test.</p>
          ) : (
            <>
              <div className="mp-filters">
                <button type="button" className={`mp-chip${!got.filter ? ' on' : ''}`} aria-pressed={!got.filter} disabled={busy} onClick={() => read(1, got.look, null)}>
                  All <b className="m">{num(got.total)}</b>
                </button>
                {chips.map((x) => {
                  const nOf = x === 'different' ? k.different : k[x];
                  return (
                    <button type="button" key={x} className={`mp-chip${got.filter === x ? ' on' : ''}`} aria-pressed={got.filter === x}
                      disabled={busy || !nOf} onClick={() => choose(x)}>
                      {words[x]} <b className="m">{num(nOf)}</b>
                    </button>
                  );
                })}
                <span className="mp-grow" />
                <details className="mp-how">
                  <summary>{I.info}How is each request scored?</summary>
                  <p>
                    {keeps
                      ? "The original model answered every request twice. The facts both of its answers give, and that matter to someone relying on the answer, such as a figure, a date, a decision or what happens next, are listed once. This model's answer scores 0 when it gives every one of those facts, in any words, gets nothing wrong compared with the request, and follows the request's instructions as the original model does. It scores 1 when it leaves one of those facts out, gets something wrong, isn't in the original model's language, or breaks a rule the request's instructions set."
                      : quality && got.panel
                        ? `Where this model's answer differs from the original model's, two judges read the request and both answers, each twice, once in each order, and where they disagree ${ref} settles it. It scores 0 when this model's answer is at least as good, 1 when it is clearly worse or changes a figure ${ref} gave the same way both times, and 0.5 when nobody can call it.`
                      : quality
                        ? "A judge reads this model's answer beside the original model's twice, once in each order. It scores 0 when this model's answer is at least as good, and 1 when both readings find it clearly worse or it breaks a rule the request's instructions set."
                        : "The original model answered every request twice, because it doesn't always give the same answer. This model's answer is compared with each of those two answers. It scores 0 when it matches both, 0.5 when it matches one of them, and 1 when it matches neither."}
                    {' '}A request it failed to answer scores 1.
                    {got.average !== null && !got.from ? ` The average score is ${pct1(got.average)}, the ${second ? 'figure its second look found' : `${axis} figure above`}.` : ''}
                  </p>
                </details>
              </div>
              {start && (
                <p className="mp-shared">
                  Every request on this page starts with the same instruction, <q>{start.trim()}</q>, so each row shows only what follows it.
                </p>
              )}
              <div className="mp-tablewrap">
                <table className="mp-table">
                  <colgroup><col className="c-no" /><col /><col className="c-when" /><col className="c-res" /><col className="c-t" /><col className="c-t" /><col className="c-op" /></colgroup>
                  <thead>
                    <tr>
                      <th>No.</th><th>Request</th><th>Sent</th><th>Result</th>
                      <th className="r">{rp.metric === 'ttft' ? 'First word' : 'Time'}</th>
                      <th className="r">{rp.metric === 'ttft' ? `${ref} first word` : `${ref} time`}</th>
                      <th><span className="vh">Open</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {got.rows.map((x, j) => {
                      const open = x.callId === openCall;
                      const line = x.purged ? 'Text no longer kept' : lineOf(x.asked, start) || 'Nothing written was asked';
                      return (
                        <React.Fragment key={`${got.look}-${x.callId}-${x.n}`}>
                          <tr className={`mp-row${open ? ' is-open' : ''}${x.counted ? '' : ' is-left'}`} onClick={() => setOpenCall(open ? null : x.callId)}>
                            <td className="m mp-no">{num(x.n)}</td>
                            <td className="mp-inv"><span className={x.purged ? 'mp-gone' : ''}>{line}</span></td>
                            <td className="mp-when">{x.at ? `${timeIST(x.at)} IST` : ''}</td>
                            <td className="mp-res"><span className={`wp-tag is-${x.verdict.tone}`}>{x.verdict.text}</span></td>
                            <td className="r m mp-t1">{x.ms ? secs(x.ms) : 'not timed'}</td>
                            <td className="r m mp-t2">{x.original_ms ? secs(x.original_ms) : ''}</td>
                            <td className="mp-op">
                              <button type="button" className="mp-ibtn" aria-expanded={open} aria-controls={`mp-d-${j}`}
                                aria-label={`${open ? 'Close' : 'Open'} request ${x.n}`} onClick={(e) => { e.stopPropagation(); setOpenCall(open ? null : x.callId); }}>
                                <svg viewBox="0 0 16 16" aria-hidden="true"><path d={open ? 'M4.5 9.8 8 6.3l3.5 3.5' : 'M4.5 6.2 8 9.7l3.5-3.5'} /></svg>
                              </button>
                            </td>
                          </tr>
                          {open && (
                            <tr className="mp-detailrow" id={`mp-d-${j}`}>
                              <td colSpan={7}>
                                <RequestDetail x={x} got={got} total={got.total}
                                  canPrev={j > 0 || got.page > 1} canNext={j < got.rows.length - 1 || got.more} busy={busy}
                                  onPrev={() => step(-1)} onNext={() => step(1)} onClose={() => setOpenCall(null)} />
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="mp-pager">
                <span className="mp-pgtext">
                  {got.filter
                    ? `Showing ${num(first)} to ${num(first + got.rows.length - 1)} of the ${plural(got.matched, 'request', 'requests')} marked ${words[got.filter]}`
                    : `Requests ${num(first)} to ${num(first + got.rows.length - 1)} of ${num(got.total)}`}
                </span>
                {pages > 1 && (
                  <span className="mp-pgbtns">
                    <button type="button" className="mp-sbtn" disabled={busy || got.page <= 1} onClick={() => read(got.page - 1, got.look, got.filter, { scroll: true })}>
                      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.8 3.5 5.3 8l4.5 4.5" /></svg>Previous
                    </button>
                    {pageNos.map((p, j) => (p === 'gap'
                      ? <span key={`g${j}`} className="mp-pggap" aria-hidden="true">…</span>
                      : (
                        <button type="button" key={p} className={`mp-pg${p === got.page ? ' on' : ''}`} aria-current={p === got.page ? 'page' : undefined}
                          aria-label={`Page ${p}`} disabled={busy} onClick={() => { if (p !== got.page) read(p, got.look, got.filter, { scroll: true }); }}>{p}</button>
                      )))}
                    <button type="button" className="mp-sbtn" disabled={busy || !got.more} onClick={() => read(got.page + 1, got.look, got.filter, { scroll: true })}>
                      Next<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.2 3.5 10.7 8l-4.5 4.5" /></svg>
                    </button>
                  </span>
                )}
              </div>
              {err && <p className="wp-loadline">That page could not be read: {err}</p>}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

/* One request opened in place: what was asked (and the whole request on asking), the original model's answers beside
   this model's, where a structured answer differed from each, what the judge said where answers are held to "at least as
   good", and the score, how it was compared, and the time and cost beside the original model's. Previous and Next step
   through the requests, across pages. Kept content goes with the workspace's retention window, and then it says so,
   keeping everything else. Long text scrolls inside its own box, so nothing runs off the page. */
function RequestDetail({ x, got, total, canPrev, canNext, busy, onPrev, onNext, onClose }) {
  const [whole, setWhole] = useState(false);
  const quality = got.yardstick === 'quality';
  const [a, b] = x.original;
  // the original model's two answers are shown once when they were the same
  const twice = a !== null && a === b;
  const differs = (i) => {
    const f = x.fields?.[i];
    if (!f) return null;
    if (!f.decide.length && !f.written.length) return <p className="wp-ansnote is-ok">Matches this model's answer</p>;
    return (
      <>
        {f.decide.length > 0 && <p className="wp-ansnote is-decide">Differs from this model's answer in <span className="wp-mdl">{f.decide.join(', ')}</span></p>}
        {f.written.length > 0 && (
          <p className="wp-ansnote is-written">Worded differently in <span className="wp-mdl">{f.written.join(', ')}</span>, which a judge reads for meaning</p>
        )}
      </>
    );
  };
  // the fields to mark: in one of the original model's answers, where it differs from this model's; in this model's, where
  // it differs from any it was compared with
  const setOf = (pick, only = null) => new Set((x.fields || []).flatMap((f, i) => (f && (only === null || only === i) ? f[pick] : [])));
  const shown = (text, value, i = null) => (value !== undefined && value !== null
    ? <div className="wp-anstext is-json"><JsonView value={value} shape={got.shape} decide={setOf('decide', i)} written={setOf('written', i)} /></div>
    : <div className="wp-anstext">{text ?? 'No answer came back.'}</div>);
  const mine = got.from ? got.from.name : null;
  return (
    <div className="mp-detail">
      <div className="mp-dhead">
        <b>{`Request ${num(x.n)} of ${num(total)}`}</b>
        {x.at && <span className="mp-dwhen">sent {timeIST(x.at)} IST</span>}
        <span className={`wp-tag is-${x.verdict.tone}`}>{x.verdict.text}</span>
        <span className="mp-grow" />
        <button type="button" className="mp-sbtn" disabled={busy || !canPrev} onClick={onPrev}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.8 3.5 5.3 8l4.5 4.5" /></svg>Previous
        </button>
        <button type="button" className="mp-sbtn" disabled={busy || !canNext} onClick={onNext}>
          Next<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.2 3.5 10.7 8l-4.5 4.5" /></svg>
        </button>
        <button type="button" className="mp-sbtn ico" aria-label="Close this request" onClick={onClose}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>
        </button>
      </div>
      {x.purged ? (
        <p className="wp-loadline">What was asked and answered is no longer kept, as your retention setting says. How it was scored is still here.</p>
      ) : (
        <>
          <div className="wp-ansblock">
            <p className="wp-sub">What was asked</p>
            <div className="wp-anstext">{x.asked || 'Nothing written was asked.'}</div>
            {x.request && (
              <>
                <button type="button" className="wp-textbtn wp-anstoggle" aria-expanded={whole} onClick={() => setWhole((v) => !v)}>
                  {whole ? 'Hide the whole request' : `Show the whole request, all ${num(x.messages)} messages`}
                </button>
                {whole && <div className="wp-anstext is-long">{x.request}</div>}
              </>
            )}
          </div>
          <div className="wp-anspair">
            <div className="wp-ansblock">
              <p className="wp-sub">{got.referenceName ? `${got.referenceName}, the original model` : 'The original model'}</p>
              {twice ? (
                <>
                  {shown(a, x.values?.original?.[0], 0)}
                  <p className="wp-ansnote">It gave this answer both times.</p>
                  {differs(0)}
                </>
              ) : [a, b].map((o, i) => (
                // a second answer "at least as good" was not held to is left out
                (quality && !x.heldTo[i] && i === 1) ? null : (
                  <div key={i} className="wp-ansone">
                    <p className="wp-ansmini">{i === 0 ? 'First answer' : 'Second answer'}{!x.heldTo[i] && o !== null ? ', not compared' : ''}</p>
                    {shown(o, x.values?.original?.[i], i)}
                    {differs(i)}
                  </div>
                )
              ))}
            </div>
            <div className="wp-ansblock">
              <p className="wp-sub">{mine ? `This model, ${mine}` : 'This model'}</p>
              {shown(x.answer, x.values?.answer)}
              {x.difference && <p className="wp-ansnote">How it differs: {x.difference}</p>}
            </div>
          </div>
        </>
      )}
      {/* part of how it was scored, which is kept whatever the retention setting removes: none of the answers' text */}
      {x.readings && <Readings r={x.readings} facts={x.facts} />}
      <dl className="wp-ansfacts">
        <div><dt>Score</dt><dd>{x.score === null ? 'none' : scoreWords(x.score)}{!x.counted && x.score !== null ? ", doesn't count" : ''}</dd></div>
        {x.compared && <div><dt>Compared</dt><dd>{x.compared}</dd></div>}
        <div><dt>{got.metric === 'ttft' ? 'Time to first word' : 'Time'}</dt>
          <dd>{x.ms ? secs(x.ms) : 'not timed'}{x.original_ms ? `, the original model ${secs(x.original_ms)}` : ''}</dd></div>
        <div><dt>Cost</dt>
          <dd>{x.reused ? 'nothing new, reused from an earlier test' : x.cost === null ? 'not priced' : perCall(x.cost)}{x.original_cost ? `, the original model ${perCall(x.original_cost)}` : ''}</dd></div>
      </dl>
    </div>
  );
}

/* A structured answer laid out as JSON is written out, two spaces to a level, with the fields a test found different marked
   where they stand: a field that decides something in red, a written one that differs only in its words in amber. A
   field is named as the test names it (leaves in src/eval/compare.js): "total", "items[0].price", and for a tool call
   its arguments under "[0]"; "the answer" is a whole answer of one value, and "the tool called" the tool's name. */
function JsonView({ value, shape, decide, written }) {
  const lines = [];
  const markOf = (path) => (decide.has(path) || decide.has('the answer') ? 'is-decide' : written.has(path) ? 'is-written' : '');
  const walk = (v, path, depth, key, last) => {
    const pad = '  '.repeat(depth);
    const name = key === null ? '' : `${JSON.stringify(key)}: `;
    const comma = last ? '' : ',';
    if (v === null || typeof v !== 'object') {
      lines.push({ text: `${pad}${name}${JSON.stringify(v)}${comma}`, mark: markOf(path || '$') });
      return;
    }
    const list = Array.isArray(v);
    const kids = list ? v.map((x, i) => [i, x]) : Object.entries(v);
    if (!kids.length) { lines.push({ text: `${pad}${name}${list ? '[]' : '{}'}${comma}`, mark: '' }); return; }
    lines.push({ text: `${pad}${name}${list ? '[' : '{'}`, mark: '' });
    kids.forEach(([k, x], i) => walk(x, list ? `${path}[${k}]` : (path ? `${path}.${k}` : k), depth + 1, list ? null : k, i === kids.length - 1));
    lines.push({ text: `${pad}${list ? ']' : '}'}${comma}`, mark: '' });
  };
  if (shape === 'tool_call' && Array.isArray(value)) {
    value.forEach((call, i) => {
      if (i) lines.push({ text: '', mark: '' });
      lines.push({ text: `CALLED ${call?.name ?? 'a tool'}`, mark: decide.has('the tool called') ? 'is-decide' : '' });
      walk(call?.args ?? {}, `[${i}]`, 0, null, true);
    });
  } else walk(value, '', 0, null, true);
  return lines.map((l, i) => <span key={i} className={l.mark ? `wp-jline ${l.mark}` : 'wp-jline'}>{l.text || ' '}</span>);
}

/* What the judge said of one answer held to "at least as good" (readingsWords in src/workloadPage.js). It reads the two
   answers twice, swapped round the second time, because a judge can lean to whichever answer it reads first; an answer
   counts as worse only when both readings find the original model's better, or when it breaks a rule in the request's
   instructions, or changes a figure the original model gave both times. A lean too slight to count is shown as the tie
   it was read as, with what it leaned to. */
const SIDE_WORDS = { answer: "this model's answer was better", original: "the original model's answer was better", equal: 'about equally good' };
const sureWords = (p) => (p === null || p === undefined || !Number.isFinite(Number(p)) ? '' : `, ${Math.round(Number(p) * 100)}% sure`);
const pctOf = (p) => `${Math.round(Number(p) * 100)}%`;
// an average a line decides on, to one decimal, so one just under the line never reads as on it
const pctAvg = (p) => `${(Math.round(Number(p) * 1000) / 10).toFixed(1)}%`;
// the chance Jev gave, said as a chance rather than as how sure it was, since the line it is held to is a setting
const chanceOf = (p, what) => (p === null || p === undefined || !Number.isFinite(Number(p)) ? '' : `Jev gave it a ${pctOf(p)} chance of ${what}`);
// who reads, named once on every block: Jev the main judge, a small model built to read meaning, and the second judge
const JUDGES = 'Jev, the main judge, is a small model built to read meaning. Where it is unsure, the second judge, a larger language model, reads it too.';
// what Jev named a difference, in words (the kinds in src/eval/judge.js)
const NAMED_WORDS = {
  wording: 'only the wording', omission: 'one leaves something out', fact: 'a different fact or figure', decision: 'a different decision',
  refusal: 'one refuses', unrelated: 'one answers something else', worse: "the original model's answer reads as better",
};
function Readings({ r, facts }) {
  if (r.way === 'keeps') return <KeepsReadings r={r} facts={facts} />;
  if (r.way === 'same') return <SameReadings r={r} />;
  if (r.way === 'choices') return <ChoiceReadings r={r} />;
  return <QualityReadings r={r} />;
}

/* What the judges said of a structured answer that differed from the original model's (readingsWords in src/workloadPage.js).
   Two judges each read the request and both answers twice, swapped round the second time, because a judge can lean to
   whichever answer it reads first. Where they agreed, that decided it; where they did not, or one could not tell, the
   original model read the two answers twice too and settled it. Where nobody could call it, it counts half. */
const WHO_WORDS = { jev: 'Jev', llm: 'The second judge', tie: 'The original model, settling it' };
const CALLED_WORDS = {
  worse: "found the original model's answer better both times",
  better: "found this model's answer better both times",
  fine: "didn't find the original model's answer better either time",
  unsure: "couldn't tell: one reading found the original model's answer better and the other didn't",
};
function ChoiceReadings({ r }) {
  const judges = Array.isArray(r.judges) ? r.judges : [];
  const panel = judges.filter((j) => j.who !== 'tie');
  const settledBy = judges.some((j) => j.who === 'tie');
  const said = r.verdict === 'worse' ? "So it counts as clearly worse."
    : r.verdict === 'unsure' ? "So nobody could call it, and it counts as half a difference."
      : r.verdict === 'better' ? "So it counts as at least as good, and better."
        : "So it counts as at least as good.";
  // who read it, as it happened: both judges, one of them, or the original model alone where no judge could
  const who = panel.length >= 2 ? 'Two judges, Jev and a larger language model, each read'
    : panel.length === 1 ? `${panel[0].who === 'jev' ? 'Jev' : 'A larger language model'} read`
      : 'No judge could read it, so the original model read';
  const reading = (e, k) => {
    const where = k === 0 ? 'first' : 'swapped round';
    // a lean too slight to count was read as a tie, and is said as one
    return e.leaned
      ? `${where}, about equally good (it leaned to ${e.leaned === 'answer' ? "this model's answer" : "the original model's"}${sureWords(e.sure)}, too little to count)`
      : `${where}, ${SIDE_WORDS[e.side] || SIDE_WORDS.equal}${sureWords(e.sure)}`;
  };
  return (
    <div className="wp-ansblock wp-readings">
      <p className="wp-sub">What the judges said</p>
      <p className="wp-ansnote">
        {who} the request and both answers twice, swapped round the second time.
        {panel.length && settledBy ? ' They did not settle it between them, so the original model read them twice too and settled it.' : ''}
      </p>
      {judges.length > 0 && (
        <ul className="wp-readlist">
          {judges.map((j, i) => (
            <li key={i}>
              <b>{WHO_WORDS[j.who] || j.who}:</b>{' '}
              {(j.each || []).map(reading).join('; ')}.
              {j.verdict && CALLED_WORDS[j.verdict] ? ` It ${CALLED_WORDS[j.verdict]}.` : ''}
            </li>
          ))}
        </ul>
      )}
      <p className={`wp-ansnote${r.verdict === 'worse' ? ' is-decide' : ''}`}>{said}</p>
    </div>
  );
}

/* What the judge said of one answer held to "the same answer" (readingsWords in src/workloadPage.js): against each of the
   original model's answers, whether Jev read the two as serving the person equally and how sure it was; where it was
   unsure, the three votes that settled it (or that no second reading came back, and the answer was not counted); and where
   they differed only in wording or in what each includes, which one serves the person better, read twice, once each way
   round, and averaged, which decides whether the difference counts. */
function SameReadings({ r }) {
  const against = Array.isArray(r.against) ? r.against : [];
  const two = against.length > 1;
  const line = (a, i) => {
    const which = two ? (i === 0 ? "the original model's first answer" : "its second answer") : "the original model's answer";
    const out = [];
    if (a.votes) {
      const said = (v) => (v === 0 ? 'the same' : v === 1 ? 'different' : 'no answer');
      const all = a.votes.reads || [];
      const reads = all.filter((v) => v !== null && v !== undefined);
      const split = reads.length === 2 && reads[0] !== reads[1];
      const asked = `Jev was unsure whether they serve the person equally (${pctOf(a.p)} sure they do), so the second judge was asked to read them twice, once each way round`;
      if (!reads.length) out.push(`${asked}, and didn't answer either time, so this answer isn't counted.`);
      else {
        out.push(`${asked}: ${all.map(said).join(', then ')}.`
          + (split ? ` They split, so Jev's own lean decided: ${said(a.votes.lean)}.` : '')
          + (reads.length === 1 ? ' Only one reading came back, so it decided this time, and the pair is read again at the next test.' : ''));
      }
    } else if (a.p !== null && a.p !== undefined) {
      out.push(Number(a.p) >= 0.5 ? `Jev read them as serving the person equally, ${pctOf(a.p)} sure.` : `Jev read them as different, ${pctOf(1 - a.p)} sure.`);
    }
    if (a.named && NAMED_WORDS[a.named]) out.push(`The main difference it named: ${NAMED_WORDS[a.named]}.`);
    if (a.figures) out.push('A figure in it differs from this answer.');
    if (a.three) {
      const line2 = r.forgive !== null && r.forgive !== undefined ? pctOf(r.forgive) : null;
      out.push(`Asked which serves the person better, once each way round, it gave the original model's answer ${(a.three.pRef || []).map(pctOf).join(' and ')}`
        + `${a.three.ref !== null ? ` (${pctAvg(a.three.ref)} on average)` : ''} and this one ${(a.three.pCand || []).map(pctOf).join(' and ')}. `
        + (a.three.verdict === 'kept' ? `${line2 ? `That average is ${line2} or more, so the` : 'The'} difference counts.`
          : `${line2 ? `That average is under ${line2}, so the` : 'The'} difference was forgiven${a.three.verdict === 'better' ? ', and this answer counts as the better one' : ''}.`));
    }
    return { which, out };
  };
  // a figure that differs from every one of the original model's answers, or only from some (figuresAgainst)
  const byRef = against.filter((a) => a.figures !== null && a.figures !== undefined);
  const figuresAll = r.figures && (!byRef.length || byRef.every((a) => a.figures));
  return (
    <div className="wp-ansblock wp-readings">
      <p className="wp-sub">What the judge said</p>
      <p className="wp-ansnote">{JUDGES}</p>
      {against.length > 0 && (
        <ul className="wp-readlist">
          {against.map((a, i) => {
            const { which, out } = line(a, i);
            return <li key={i}><b>Against {which}:</b> {out.join(' ')}</li>;
          })}
        </ul>
      )}
      {r.figures && (
        <p className="wp-ansnote is-decide">
          {figuresAll
            ? `A figure in it differs from the original model's ${two ? 'answers' : 'answer'}, so it counts as different whatever a reading says.`
            : "A figure in it differs from one of the original model's answers, so against that one it counts as different whatever a reading says."}
        </p>
      )}
      {(r.refuses || r.cut) && <p className="wp-ansnote is-decide">{r.refuses ? 'It refuses what was asked' : 'It stops before it is finished'}, so it counts as different.</p>}
    </div>
  );
}

/* What the judge found of one answer held to "keeps what matters" (readingsWords in src/workloadPage.js): each fact both of
   the original model's answers give that matters, whether this answer kept it, and how that was read; the supporting detail
   they also share, which no answer had to keep; whether it gets something wrong against the request or is in another
   language than the original model's; and where it was never read (a rule of the instructions it breaks, which code checks
   first, or the original model's own answer word for word), that nothing else was checked. A fact or rule whose words the
   retention setting removed is named as such. */
function KeepsReadings({ r, facts }) {
  const list = Array.isArray(r.facts) ? r.facts : [];
  const detail = Array.isArray(facts?.detail) ? facts.detail.filter((d) => d.say) : [];
  const read = r.read !== false;
  const sayOf = (f) => (f.say === null || f.say === undefined ? 'a fact (its words are no longer kept, as your retention setting says)' : f.say);
  const figuresOf = (f) => (Array.isArray(f.missing) && f.missing.length ? f.missing.join(', ') : null);
  const how = (f) => {
    if (f.by === 'same text') return 'the same text';
    if (f.by === 'not read') return '';
    const fig = figuresOf(f);
    // decided in code, before any judge reads: a figure of the fact the answer never gives
    if (f.by === 'figures') return fig ? `it doesn't give ${fig}` : "it doesn't give one of its figures";
    if (f.by === 'jev+llm') {
      return f.p === null || f.p === undefined ? 'Jev was unsure, so the second judge read it'
        : `Jev was unsure, giving it a ${pctOf(f.p)} chance of being stated, so the second judge read it`;
    }
    if (f.by === 'llm') return 'read by the second judge';
    const chance = chanceOf(f.p, 'being stated');
    if (f.lean) return `${chance}, and the second judge didn't answer, so Jev's lean stood`;
    return chance;
  };
  const wrong = r.wrong || {};
  const isWrong = !!r.isWrong;
  const wrongRead = r.wrongRead !== undefined ? !!r.wrongRead : (wrong.p !== null && wrong.p !== undefined) || (wrong.llm !== null && wrong.llm !== undefined);
  const wrongWords = wrong.llm !== null && wrong.llm !== undefined
    ? (wrong.p !== null && wrong.p !== undefined
      ? `Jev was unsure, giving it a ${pctOf(wrong.p)} chance of getting something wrong, so the second judge read it: ${isWrong ? 'it does' : 'it does not'}.`
      : `Read by the second judge: ${isWrong ? 'it does' : 'it does not'}.`)
    : wrong.p !== null && wrong.p !== undefined
      ? `${chanceOf(wrong.p, 'getting something wrong')}${r.wrongLean ? ", and the second judge didn't answer, so Jev's lean stood" : ''}.` : '';
  const languageWords = r.languageLlm !== null && r.languageLlm !== undefined
    ? ` Jev was unsure which language it is in, so the second judge read it: ${r.languageLlm ? "the original model's" : 'another'}.`
    : r.language !== null && r.language !== undefined ? ` ${chanceOf(r.language, "being in the original model's language")}${r.languageLean ? ", and the second judge didn't answer, so Jev's lean stood" : ''}.` : '';
  return (
    <div className="wp-ansblock wp-readings">
      <p className="wp-sub">What it had to keep</p>
      {read && <p className="wp-ansnote">{JUDGES}</p>}
      {r.same && <p className="wp-ansnote">It is the original model's answer word for word, so it keeps everything that answer keeps. Nothing else was checked.</p>}
      {!read && !r.same && (
        <p className="wp-ansnote is-decide">
          {r.broke ? `It breaks a rule in the request's instructions ("${r.broke}").`
            : r.brokeHidden ? "It breaks a rule in the request's instructions (its words are no longer kept, as your retention setting says)."
              : "It breaks a rule in the request's instructions."}
          {' '}That is checked before anything is read, so its facts and what it says against the request weren't checked.
        </p>
      )}
      {list.length ? (
        <ul className="wp-readlist wp-factlist">
          {list.map((f, i) => {
            const label = f.kept === null || f.kept === undefined ? 'Not checked' : f.kept ? 'Kept' : 'Missed';
            const words = how(f);
            return (
              <li key={i} className={f.kept === null || f.kept === undefined ? '' : f.kept ? 'is-kept' : 'is-missed'}>
                <b>{label}:</b> {sayOf(f)}{words ? <span className="wp-factby"> ({words})</span> : null}
              </li>
            );
          })}
        </ul>
      ) : read ? <p className="wp-ansnote">The original model's two answers share no fact that matters on this request, so only the checks below apply.</p> : null}
      {detail.length > 0 && (
        <p className="wp-ansnote">Also in both of the original model's answers, as supporting detail no answer has to keep: {detail.map((d) => String(d.say).replace(/[.\s]+$/, '')).join('; ')}.</p>
      )}
      {read && wrongRead && (
        <p className={`wp-ansnote${isWrong ? ' is-decide' : ''}`}>
          {isWrong ? "It gets something wrong compared with the request, or says something the request doesn't. " : 'It gets nothing wrong compared with the request. '}{wrongWords}
        </p>
      )}
      {read && (r.otherLanguage || languageWords) && (
        <p className={`wp-ansnote${r.otherLanguage ? ' is-decide' : ''}`}>
          {r.otherLanguage ? "It isn't written in the original model's language." : "It is written in the original model's language."}{languageWords}
        </p>
      )}
      {read && (r.broke || r.brokeHidden) && (
        <p className="wp-ansnote is-decide">
          {r.broke ? `It doesn't do what the request's instructions ask ("${r.broke}"), where the original model's answer does.`
            : "It doesn't do what the request's instructions ask (its words are no longer kept, as your retention setting says), where the original model's answer does."}
        </p>
      )}
      {r.unsettled && (
        <p className="wp-ansnote">
          This verdict rests on Jev's lean, because the second judge didn't answer. It counts in this test, is read again at the next one,
          and the background checks never count it against a model that is serving.
        </p>
      )}
    </div>
  );
}

function QualityReadings({ r }) {
  const each = Array.isArray(r.each) ? r.each : [];
  const both = (side) => each.length === 2 && each.every((e) => e.side === side);
  // what differs, said as a sentence: its answer, the tool it called, or a field of it by name
  const what = r.field === 'the answer' ? 'Its answer' : r.field === 'the tool called' ? 'The tool it called' : `Its "${r.field}"`;
  const why = r.field ? `${what} differs from what the original model gave both times, so it counts as worse whatever a reading says.`
    : r.figures ? 'A figure in it differs from the one the original model gave both times, so it counts as worse whatever a reading says.'
    : r.broke ? `It breaks a rule in the request's instructions ("${r.broke}"), so it counts as worse whatever the readings say.`
      : r.brokeHidden ? "It breaks a rule in the request's instructions (its words are no longer kept, as your retention setting says), so it counts as worse whatever the readings say."
        : each.length !== 2 ? null
          : both('original') ? "Both readings found the original model's answer better, so it counts as clearly worse."
            : both('answer') ? "Both readings found this model's answer better, so it counts as at least as good, and better."
              : "It counts as worse only when both readings find the original model's answer better, so it counts as at least as good.";
  return (
    <div className="wp-ansblock wp-readings">
      <p className="wp-sub">What the judge said</p>
      {each.length > 0 && (
        <ul className="wp-readlist">
          {each.map((e, i) => (
            <li key={i}>
              <b>{i === 0 ? 'First reading' : 'Second reading, the answers swapped round'}:</b>{' '}
              {e.leaned
                ? `about equally good. It leaned to ${e.leaned === 'answer' ? "this model's answer" : "the original model's"}${sureWords(e.sure)}, too little to count.`
                : `${SIDE_WORDS[e.side] || SIDE_WORDS.equal}${sureWords(e.sure)}.`}
            </li>
          ))}
        </ul>
      )}
      {why && <p className={`wp-ansnote${r.field || r.figures || r.broke || r.brokeHidden || both('original') ? ' is-decide' : ''}`}>{why}</p>}
    </div>
  );
}
