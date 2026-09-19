import React, { useEffect } from 'react';
import PeriodChip from '../PeriodChip.jsx';
import { usd, num, ago, feedDot } from '../api.js';
import { SpendChart, WaitingChart } from '../Charts.jsx';
import WorkloadTable from '../WorkloadTable.jsx';

const Tile = ({ k, v, s }) => (
  <div className="tile"><div className="k">{k}</div><div className="v">{v}</div><div className="s">{s}</div></div>
);

export default function Dashboard({ data, onOpen, onPeriod, busy, onTick }) {
  /* "Live" has to mean it. A developer who has just wired us up sits on this screen and
     sends a call from another window, and the whole point is that it shows up without them
     reloading. Polling stops while the tab is hidden, so a forgotten tab costs nothing. */
  useEffect(() => {
    if (!onTick) return undefined;
    const t = setInterval(() => { if (!document.hidden) onTick(); }, 5000);
    return () => clearInterval(t);
  }, [onTick]);

  const hasDay = data.priced && data.series.some((d) => d.paid > 0);
  const runRate = data.days ? (data.spend / data.days) * 30 : 0;

  return (
    <>
      <div className="phead"><h1>Dashboard</h1>
        <PeriodChip days={data.days} periods={data.periods} onPick={onPeriod} busy={busy} /></div>

      <div className="tiles">
        <Tile k={`Spend · last ${data.days} days`} v={data.priced ? usd(data.spend) : '—'}
          s={!data.priced ? 'prices sync once a provider key is set'
            : data.spend > 0 ? `on track for ${usd(runRate)} a month` : 'nothing charged yet'} />
        <Tile k={`Saved · last ${data.days} days`} v={data.priced && data.saved > 0 ? usd(data.saved) : '—'}
          s={!data.priced ? 'waiting on prices' : data.saved > 0 ? 'against your own models' : 'nothing optimized yet'} />
        <Tile k="Workloads" v={num(data.workloads)}
          s={data.workloads
            ? `${data.optimized} optimized, ${data.ready} ready, ${data.measuring} measuring`
            : 'found automatically from your calls'} />
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
          <div className="feedhead">
            <h3>Live activity</h3>
            <span className="livedot" title="updating" />
          </div>
          <div className="feed">
            {data.activity.length === 0 && (
              <div className="fr"><span className="fd mut" />
                <div className="ft">Nothing yet. Every call you send us appears here, as it arrives.</div>
                <div className="fw" /></div>
            )}
            {data.activity.map((a, i) => (
              <div className="fr" key={`${a.created_at}-${i}`}>
                <span className={`fd ${feedDot[a.kind] || 'mut'}`} />
                <div className="ft">{clip(a.title)}</div>
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

const clip = (s) => (s && s.length > 78 ? `${s.slice(0, 76).replace(/[ ,.]+$/, '')}…` : s);
