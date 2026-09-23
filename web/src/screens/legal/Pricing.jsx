import React from 'react';
import { usd } from '../../money.js';
import { Doc, Sec, To } from './Public.jsx';

/* The figures, written the way every amount in the app is written. */
const PLAN = usd(49);
const PLAN_MEASURING = usd(10);
const TOPUP_LOW = usd(5);
const TOPUP_HIGH = usd(500);

/* What Understudy costs, all of it on one page.
 *
 * The product exists to lower somebody's model bill, so its own price has to be as easy to
 * check as the savings it claims: what a routed call costs, what measuring costs, what is free,
 * how money gets onto the balance, and when anything is charged without somebody pressing a
 * button, which is only ever when they have switched that on themselves. */

export default function Pricing({ go }) {
  return (
    <Doc eyebrow="Pricing" title="What Understudy costs"
      lead="Model calls cost what the provider charges, plus a 1% fee. That is the whole of it for routed calls, and sending us copies is free.">

      <Sec id="calls" title="Calls">
        <div className="pricegrid">
          <div className="pricecard">
            <div className="pricek">Calls we route</div>
            <div className="pricefig">Provider price + 1%</div>
            <p>What the model provider charges for the call, plus a 1% fee. If the provider charges {usd(1)} for a
              set of calls, you pay {usd(1.01)}.</p>
          </div>
          <div className="pricecard pricefree">
            <div className="pricek">Copies you send us</div>
            <div className="pricefig">Free</div>
            <p>Keep calling your own provider, and send us a copy of each call afterwards. Sending copies costs
              nothing.</p>
          </div>
        </div>
      </Sec>

      <Sec id="measuring" title="Measuring and learning">
        <div className="pricegrid">
          <div className="pricecard">
            <div className="pricek">Measurements, background answers, experiments</div>
            <div className="pricefig">Cost + 1%</div>
            <p>
              Replaying a sample of your calls on other models to measure them, runners-up answering some calls in
              the background, and live experiments are all charged at what they cost, plus 1%, from your balance.
            </p>
          </div>
          <div className="pricecard">
            <div className="pricek">Monthly plan</div>
            <div className="pricefig">{PLAN} a month</div>
            <p>Includes {PLAN_MEASURING} of measurement each month.</p>
          </div>
        </div>
        <p>
          A workload&rsquo;s page shows an estimate of what measuring it will cost before anything runs, and
          Settings can hold measuring back until you ask for it. Experiments have a daily limit, set on each
          workload.
        </p>
      </Sec>

      <Sec id="balance" title="Your balance">
        <ul>
          <li><b>Prepaid.</b> Charges come out of a balance you add credit to in Settings.</li>
          <li><b>Top-ups from {TOPUP_LOW} to {TOPUP_HIGH}</b> at a time.</li>
          <li>
            <b>Automatic top-up is optional.</b> It is off until you have saved a card and switched it on, and you
            can switch it off again in Settings at any time.
          </li>
        </ul>
      </Sec>

      <Sec id="more" title="More">
        <p>
          What happens to the calls themselves, and what we keep, is on{' '}
          <To to="traffic" go={go}>what happens to your traffic</To>. The <To to="terms" go={go}>terms of
          service</To> say how fees are charged. Questions about pricing can go through the{' '}
          <To to="contact" go={go} search="?topic=sales">contact page</To>.
        </p>
      </Sec>
    </Doc>
  );
}
