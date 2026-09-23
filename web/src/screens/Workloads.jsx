import React from 'react';
import PeriodChip from '../PeriodChip.jsx';
import { num } from '../api.js';
import { savedTile, spendTile } from '../savings.js';
import WorkloadTable from '../WorkloadTable.jsx';

const Tile = ({ k, v, s }) => (
  <div className="tile"><div className="k">{k}</div><div className="v">{v}</div><div className="s">{s}</div></div>
);

export default function Workloads({ data, onOpen, onPeriod, busy }) {
  return (
    <>
      <div className="phead"><h1>Workloads</h1>
        <PeriodChip days={data.days} periods={data.periods} onPick={onPeriod} busy={busy} /></div>
      <div className="tiles">
        <Tile k="Workloads" v={num(data.workloads)} s="found automatically" />
        <Tile k="Optimized" v={num(data.optimized)}
          s={data.waiting ? `${data.waiting} more switched, waiting for routed calls`
            : data.ready ? `${data.ready} more ready to switch` : 'nothing else ready yet'} />
        {/* what you are actually ahead by, which can be below zero while measuring is paid for */}
        <Tile k={`Saved · last ${data.days} days`} {...savedTile(data)} />
        <Tile k={`Spend · last ${data.days} days`} {...spendTile(data)} />
      </div>
      <WorkloadTable rows={data.rows} onOpen={onOpen} priced={data.priced} />
    </>
  );
}
