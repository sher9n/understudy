import { usd } from './money.js';

/* The "Saved" tile, the same on the dashboard and on the workloads page.
 *
 * The figure is what the customer is actually ahead by over the window: what their routed calls
 * would have cost sent straight to their own provider on their own models, less what they paid us
 * for them (our fee included), less what measuring cost them (measurements and answers made in the
 * background, fee included). It can be below zero, typically in a new workspace that has paid the
 * fee and some measuring and has nothing switched yet, and then it is shown as it is, with where it
 * comes from, never hidden behind a dash.
 *
 * A server from before the net figure sends `saved` alone, as the saving on calls; that is still
 * read, with the words it always had. */
export function savedTile(data) {
  if (!data.priced) return { v: 'Not priced', s: 'waiting on prices' };
  const s = data.savings;
  if (!s) {
    return {
      v: usd(data.saved),
      s: data.saved > 0 ? 'against your own models'
        : data.optimized ? 'no calls on a switched model yet' : 'nothing optimized yet',
    };
  }
  const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  const net = data.saved !== null && data.saved !== undefined && Number.isFinite(Number(data.saved))
    ? Number(data.saved) : n(s.net);
  const onCalls = n(s.onCalls);
  const measuring = n(s.optimizing) > 0 ? usd(s.optimizing) : null;
  const switched = n(s.switchedCalls) > 0;

  // calls a cheaper strategy answered came to more than the customer's own models would have
  if (onCalls < 0 && switched) {
    return {
      v: usd(net),
      s: `calls cost ${usd(-onCalls)} more than your own models${measuring ? `, and ${measuring} went on measuring` : ''}`,
    };
  }
  // something saved on the calls themselves
  if (onCalls > 0 || switched) {
    return { v: usd(net), s: measuring ? `${usd(onCalls)} on calls, less ${measuring} spent measuring` : 'against your own models' };
  }
  /* Nothing answered more cheaply yet, so what the window cost is our fee on the routed calls and
     any measuring. A switch that is made but has not had a routed call yet is not "nothing". */
  const lead = data.optimized || data.waiting ? 'no calls on a switched model yet' : 'nothing switched yet';
  const parts = [onCalls < 0 && `${usd(-onCalls)} in fees`, measuring && `${measuring} on measuring`].filter(Boolean);
  return { v: usd(net), s: parts.length ? `${lead}; ${parts.join(' and ')}` : lead };
}

/* The "Spend" tile beside it counts what calls cost and nothing else; what measuring cost is in the
 * Saved tile's words. So it says "on calls": a workspace that had paid only for measuring read
 * "nothing charged yet" right beside a saving below zero for what measuring had cost it. */
export function spendTile(data) {
  if (!data.priced) return { v: 'Not priced', s: 'prices sync once a provider key is set' };
  const runRate = data.days ? (data.spend / data.days) * 30 : 0;
  return {
    v: usd(data.spend),
    s: data.spend > 0 ? `on calls, on track for ${usd(runRate)} a month` : 'no calls charged yet',
  };
}
