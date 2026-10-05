import React from 'react';
import { href } from './router.js';
import { plainClick } from './nav.jsx';
import { usd } from './money.js';

/* A thin red bar across the top of every screen while the balance is too low to keep going (balanceAlert in
   src/billing.js): empty, so the requests sent through Understudy are turned away and tests are paused, or short of what a
   test waiting for credit needs. It says which, in a sentence, with a way to add credit, which opens the amount to add in
   Settings; the tests that were waiting start as soon as the credit lands. It goes when the balance covers them, and is not
   put away by hand, since what it says stays true until then. */
export default function LowBalanceBar({ alert, go }) {
  if (!alert?.low) return null;
  const add = (
    <a href={href('settings', null, 'add-credit')} onClick={plainClick(() => go('settings', null, { hash: 'add-credit' }))}>Add credit</a>
  );
  let what;
  if (alert.empty) {
    what = alert.routes
      ? <><b>Your balance is empty.</b> Requests you send through Understudy are being turned away, and tests are paused. {add} to continue.</>
      : <><b>Your balance is empty,</b> so tests are paused. {add} to continue running tests.</>;
  } else {
    const which = alert.waiting === 1
      ? `a test needs about ${usd(alert.needUsd)}, and ${usd(alert.freeUsd)} is free`
      : `tests on ${alert.waiting} workloads are paused, and ${usd(alert.freeUsd)} is free`;
    // on a phone without the figures, so it stays a thin bar: the workload says them where they matter
    what = <><b>Your balance is too low to keep testing</b><span className="lowbarwhy">: {which}</span>. {add} to continue running tests.</>;
  }
  return (
    <div className="lowbar" role="status">
      <span className="lowbardot" aria-hidden="true" />
      <p>{what}</p>
    </div>
  );
}
