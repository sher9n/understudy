import React from 'react';
import { Doc, Sec, To } from './Public.jsx';

/* What happens to a customer's traffic, told as the path one call takes, then what is kept and
 * for how long, who else touches it, what it costs, and how to turn each part of it off.
 *
 * Every statement here is one the service can stand behind today. Where a choice belongs to the
 * workspace, the page says so and says where the setting is, rather than describing a default
 * as though it were a promise. */

const PATH = [
  ['Your app', 'Sends the call', 'With your Understudy key, to the address on your Connect page. Your code is otherwise unchanged.'],
  ['Understudy', 'Records it and forwards it', 'Groups the call with others doing the same job, keeps a copy for your retention window, and sends it on.'],
  ['OpenRouter', 'Routes every model call', 'Every call denies data collection, and asks for providers that keep nothing unless your workspace has turned zero data retention off.'],
  ['The model provider', 'Answers, and keeps nothing', 'With zero data retention on, where every workspace starts, only providers that keep nothing are reached. The answer comes back the same way, to your app.'],
];

export default function Traffic({ go }) {
  return (
    <Doc eyebrow="Your data" title="What happens to your traffic"
      lead="This page follows one call from your app to a model and back, and says what is kept on the way, for how long, who else touches it, what it costs, and how to switch each part off.">

      <Sec id="path" title="The path of a call">
        <ol className="tpath" aria-label="The path of one call, from your app to the model provider">
          {PATH.map(([k, t, s], i) => (
            <li key={k} className={i === PATH.length - 1 ? 'tstep tzdr' : 'tstep'}>
              <div className="tstepk">{k}</div>
              <div className="tstept">{t}</div>
              <div className="tsteps">{s}</div>
            </li>
          ))}
        </ol>
        <p>
          If you send us <b>copies</b> instead, your own provider answers the call as it always has, and we
          only receive a copy of the request and the answer afterwards. Nothing about the call itself goes
          through us.
        </p>
        <p>
          <b>Zero data retention is a choice your workspace makes in Settings, and it starts on.</b> Turned
          off, calls can also reach providers that keep what they are sent for a while, usually to check for
          abuse, which lets you use models that no provider serves without keeping anything. Either way, a
          call never goes to a provider that trains on what it is sent.
        </p>
      </Sec>

      <Sec id="kept" title="What we keep, and for how long">
        <p>
          <b>The content of each call</b>, meaning the request and the answer, is kept for your
          workspace&rsquo;s retention window. Your workspace chooses it in Settings: 30, 60 or 90 days, or
          indefinitely. New workspaces start at 30 days.
        </p>
        <p>
          When the window passes, the content of calls, of measurement replays and of their cached answers is
          cleared. The numbers are kept so your charts still add up: which model answered, how many tokens,
          what it cost, how long it took, and whether it went through.
        </p>
        <div className="klist">
          <div className="klrow"><div className="klk">Your account</div>
            <div className="klv">Your email and name, and your password stored as a scrypt hash, never the password itself.</div></div>
          <div className="klrow"><div className="klk">Your API keys</div>
            <div className="klv">A SHA-256 hash of each key, plus an AES-256-GCM encrypted copy, so you can see your own key again.</div></div>
          <div className="klrow"><div className="klk">Measurements</div>
            <div className="klv">Each measurement and its results.</div></div>
          <div className="klrow"><div className="klk">Outcomes</div>
            <div className="klv">The outcomes you report to us about your calls.</div></div>
          <div className="klrow"><div className="klk">Activity and money</div>
            <div className="klv">The activity feed you see on your dashboard, and the ledger of money in and out of your balance.</div></div>
        </div>
      </Sec>

      <Sec id="use" title="What we do with it">
        <ul>
          <li>Group your calls into workloads, by the job each call does.</li>
          <li>Replay a sample of a workload&rsquo;s calls on other models to measure them. Those replays go
            through OpenRouter under your workspace&rsquo;s retention choice, and they are charged to you. A
            measurement nobody asked for only runs when what it can be expected to find would pay for itself
            within two months.</li>
          <li>Judge answers, to see whether two answers mean the same thing and how well a model suits a task.</li>
          <li>On a workload running live experiments, read a few of its answers each day in the background to
            see how often each way of serving gets them right. Those reads are charged like measuring.</li>
          <li>Learn from how your calls turned out.</li>
          <li>Where Settings allows it, mark a long instruction you send again and again, so the provider can
            reuse it for a few minutes at a lower price. Only a marker is added; the words sent are exactly
            yours.</li>
          <li>Show all of it back to you.</li>
        </ul>
        <p>
          <b>Share results is off unless you switch it on.</b> Switched on in Settings, which models cleared
          which kinds of workload is counted together with other workspaces that switched it on too, to help
          choose which models to try first. That is only verdicts, counted: never a call, an answer, a name or
          a figure.
        </p>
        <p><b>We do not sell your data, and we do not train models on it.</b></p>
      </Sec>

      <Sec id="who" title="Who else touches it">
        <div className="klist">
          <div className="klrow"><div className="klk">Railway</div>
            <div className="klv">Hosts the application and its Postgres database. Your data may be processed in the United States.</div></div>
          <div className="klrow"><div className="klk">OpenRouter</div>
            <div className="klv">Routes every model call. Every call denies data collection, and asks for providers that keep
              nothing unless your workspace turned that off.</div></div>
          <div className="klrow"><div className="klk">Model providers</div>
            <div className="klv">The providers OpenRouter reaches for a call: only ones that keep nothing while zero data
              retention is on, and never one that trains on what it is sent.</div></div>
          <div className="klrow"><div className="klk">TypeSafe</div>
            <div className="klv">Its judging model, Jev, reads requests and answers to judge whether two answers mean the same
              thing and how well a model suits a task. Jev is reached through OpenRouter, only on providers that keep nothing.</div></div>
          <div className="klrow"><div className="klk">Stripe</div>
            <div className="klv">Takes payments. We keep the Stripe customer id and your card&rsquo;s brand and last four
              digits, never card numbers.</div></div>
          <div className="klrow"><div className="klk">Resend</div>
            <div className="klv">Sends sign-in and notification email.</div></div>
        </div>
        <p>The full list, and how we tell you before it changes, is on the <To to="subprocessors" go={go}>subprocessors</To> page.</p>
      </Sec>

      <Sec id="cost" title="What it costs">
        <p>
          A call we route costs what the model provider charges, plus a 1% fee. Measurements, background answers,
          answers read in the background and live experiments are charged at cost plus 1% from your balance, and
          an optimizing budget in Settings can cap all of them together. Sending us copies is free. Everything is
          on the <To to="pricing" go={go}>pricing</To> page.
        </p>
      </Sec>

      <Sec id="off" title="How to turn things off">
        <ul>
          <li><b>Keep content for less time.</b> In Settings, choose how long call content is kept. 30 days is the
            shortest window.</li>
          <li><b>Measure only when you ask.</b> In Settings, set Measure to &ldquo;Only when I ask&rdquo;. Nothing is
            replayed on other models, and nothing is spent on measuring, until you press Measure now on a workload.</li>
          <li><b>No experiments on live calls.</b> On a workload&rsquo;s page, set its experiments to Off. Nothing is
            read in the background on a workload with no experiments.</li>
          <li><b>Nothing switched without you.</b> New workspaces start on &ldquo;Ask me first&rdquo;: a cheaper model
            is only recommended until you approve it. Settings sets it for new workloads and each workload&rsquo;s
            page for that one. A switch can be undone from the workload&rsquo;s page, and one that starts working
            less well than your own model is switched back by itself.</li>
          <li><b>Cap what is spent.</b> In Settings, set a daily or monthly limit on calls, and an optimizing budget
            for measuring and everything else done to find a cheaper model.</li>
          <li><b>Keep providers that keep nothing.</b> Zero data retention starts on. Leave it on in Settings.</li>
          <li><b>No cache markers.</b> In Settings, switch off Mark for caching.</li>
          <li><b>No shared results.</b> Share results stays off unless you switch it on in Settings.</li>
          <li><b>No emails.</b> In Settings, under Emails, switch off the ones you do not want.</li>
          <li><b>Stop a key.</b> Revoke it in Settings, and anything using it stops at once.</li>
          <li><b>Stop sending.</b> Point your client back at your own provider, or stop sending copies. Nothing
            reaches us after that.</li>
          <li><b>Delete your account and its data.</b> Ask through the <To to="contact" go={go} search="?topic=privacy">contact page</To>.</li>
        </ul>
      </Sec>
    </Doc>
  );
}
