import React, { useEffect, useState } from 'react';
import PeriodChip from '../PeriodChip.jsx';
import { num, ago, feedDot, timeIST } from '../api.js';
import { usd } from '../money.js';
import { savedTile } from '../savings.js';
import { usePoll } from '../poll.js';
import { SpendChart, WaitingChart } from '../Charts.jsx';
import WorkloadTable from '../WorkloadTable.jsx';

const Tile = ({ k, v, s }) => (
  <div className="tile"><div className="k">{k}</div><div className="v">{v}</div><div className="s">{s}</div></div>
);

/* Said while the dashboard cannot read itself: that it is trying again, how old the figures on
   the screen are, and a way to try now rather than wait. */
function Reconnecting({ trouble, since, retry }) {
  const [, tick] = useState(0);
  // the countdown to the next try is worth keeping honest, once a second
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.round((trouble.next - Date.now()) / 1000));
  return (
    <div className="reconn" role="status">
      <span className="reconndot" aria-hidden="true" />
      <span>
        <b>Reconnecting.</b> The figures below are from {timeIST(since)} IST
        {secs > 0 ? `, and the next try is in ${secs} ${secs === 1 ? 'second' : 'seconds'}.` : '.'}
      </span>
      <button type="button" className="reconnbtn" onClick={retry}>Try now</button>
    </div>
  );
}

export default function Dashboard({ data, onOpen, onPeriod, busy, onTick }) {
  /* "Live" has to mean it. A developer who has just wired us up sits on this screen and
     sends a call from another window, and the whole point is that it shows up without them
     reloading. A read that fails keeps the figures that were already here and says so, and
     tries again, more slowly each time (see poll.js). */
  const { trouble, retry } = usePoll(onTick, { enabled: !!onTick });
  // when the figures on the screen were read
  const [since, setSince] = useState(() => Date.now());
  useEffect(() => { setSince(Date.now()); }, [data]);

  /* Either line is worth a chart, not just the one we charged for. A customer who sends us
     copies rather than routing pays us nothing, so "what you paid" is flat zero for ever,
     and checking only that told them to come back tomorrow while sitting on a month of real
     numbers about what their own models cost. */
  const hasDay = data.priced && data.series.some((d) => d.paid > 0 || d.would > 0);
  const runRate = data.days ? (data.spend / data.days) * 30 : 0;
  // how calls turned out, the way every workload page counts it
  const oc = data.outcomes;
  const judged = oc ? oc.calls - oc.recent : 0;

  return (
    <>
      <div className="phead"><h1>Dashboard</h1>
        <PeriodChip days={data.days} periods={data.periods} onPick={onPeriod} busy={busy} /></div>
      {trouble && <Reconnecting trouble={trouble} since={since} retry={retry} />}

      <div className="tiles five">
        <Tile k={`Spend · last ${data.days} days`} v={data.priced ? usd(data.spend) : 'Not priced'}
          s={!data.priced ? 'prices sync once a provider key is set'
            : data.spend > 0 ? `on track for ${usd(runRate)} a month` : 'nothing charged yet'} />
        {/* what you are actually ahead by, which can be below zero while measuring is paid for */}
        <Tile k={`Saved · last ${data.days} days`} {...savedTile(data)} />
        <Tile k="Workloads" v={num(data.workloads)}
          s={data.workloads
            ? `${data.optimized} optimized${data.waiting ? `, ${data.waiting} waiting for routing` : ''}, ${data.ready} ready, ${data.measuring} measuring`
            : 'found automatically from your calls'} />
        <Tile k="Worked" v={oc && oc.rate !== null ? `${(oc.rate * 100).toFixed(1)}%` : 'Not yet'}
          s={!oc || !judged ? 'how calls turned out, once they arrive'
            : oc.problem ? `${num(oc.problem)} of ${num(judged)} calls had a problem` : `of ${num(judged)} calls, no problem seen`} />
        <Tile k="Calls" v={num(data.calls)} s="since you connected" />
      </div>

      <div className="split2">
        <section className="panel2">
          <div className="p2head">
            <h2>Daily spend</h2>
            {hasDay && (
              <div className="lgd">
                <span><i className="ln" />What you paid</span>
                <span><i className="ln dash" />On your own models</span>
              </div>
            )}
          </div>
          <div className="p2body">
            {hasDay
              ? <SpendChart series={data.series} />
              : <WaitingChart message={data.priced
                  ? 'Your first full day of spend appears here tomorrow.'
                  : 'Spend appears here once a provider key is set and model prices sync.'} />}
          </div>
        </section>

        <section className="panel2">
          <div className="feedhead"><h3 id="feed-title">Live activity</h3></div>
          {/* The feed scrolls inside its panel, so it can be reached with the keyboard to be scrolled. */}
          <div className="feed" tabIndex={0} role="region" aria-labelledby="feed-title">
            {data.activity.length === 0 && (
              <div className="fr"><span className="fd mut" />
                <div className="ft">Nothing yet. Every call you send us appears here, as it arrives.</div>
                <div className="fw" /></div>
            )}
            {data.activity.map((a, i) => (
              <div className="fr" key={`${a.created_at}-${i}`}>
                {/* Anything from the last hour beats, so a glance at the feed shows how much
                    of it just happened rather than only marking the top line. A dot that
                    beats for ever would say "live" whether or not anything was going on,
                    which is the one thing it must not do, so the pulse stops when the entry
                    stops being recent and the stillness is information too. */}
                <span className={`fd ${feedDot[a.kind] || 'mut'}`
                  + (Date.now() - a.created_at < RECENT_MS ? ' beat' : '')} />
                {/* Not clipped. These lines say what happened, and cutting one mid-word
                    ("currently on open…") withholds the only part somebody was reading it
                    for. The row wraps; the panel scrolls. */}
                <div className="ft">{a.title}</div>
                <div className="fw">{ago(a.created_at)}</div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <WorkloadTable rows={data.rows} onOpen={onOpen} priced={data.priced} />
    </>
  );
}

/* How long an entry counts as just-happened, and keeps its pulse. */
const RECENT_MS = 60 * 60 * 1000;

