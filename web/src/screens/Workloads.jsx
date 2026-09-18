import React from 'react';
import PeriodChip from '../PeriodChip.jsx';
import { usd, num } from '../api.js';
import WorkloadTable from '../WorkloadTable.jsx';

const Tile = ({ k, v, s }) => (
  <div className="tile"><div className="k">{k}</div><div className="v">{v}</div><div className="s">{s}</div></div>
);

export default function Workloads({ data, onOpen, onPeriod, busy }) {
  const runRate = data.days ? (data.spend / data.days) * 30 : 0;
  return (
    <>
      <div className="phead"><h1>Workloads</h1>
        <PeriodChip days={data.days} periods={data.periods} onPick={onPeriod} busy={busy} /></div>
      <div className="tiles">
        <Tile k="Workloads" v={num(data.workloads)} s="found automatically" />
        <Tile k="Optimized" v={num(data.optimized)}
          s={data.ready ? `${data.ready} more ready to switch` : 'nothing else ready yet'} />
        <Tile k={`Saved · last ${data.days} days`} v={data.priced && data.saved > 0 ? usd(data.saved) : '—'}
          s={data.priced ? 'against your own models' : 'waiting on prices'} />
        <Tile k={`Spend · last ${data.days} days`} v={data.priced ? usd(data.spend) : '—'}
          s={!data.priced ? 'prices sync once a provider key is set'
            : data.spend > 0 ? `on track for ${usd(runRate)} a month` : 'nothing charged yet'} />
      </div>
      <WorkloadTable rows={data.rows} onOpen={onOpen} priced={data.priced} />
    </>
  );
}
