import React, { useEffect, useState } from 'react';
import { api, usd, usdHeld, dateIST, ago } from '../api.js';
import { more } from '../moreApi.js';

/* Everything a workspace chooses, in one place, each with what it does in plain words. Every change is
   saved on its own and read back from the server, so what the page shows is what is in force. */

const Sw = ({ on, onClick, busy, label }) => (
  <button type="button" className={`sw${on ? ' swon' : ''}`} disabled={busy} onClick={onClick}
    role="switch" aria-checked={!!on} aria-label={label}><i /></button>
);

const AMOUNTS = [10, 25, 50, 100];
const TOPUPS = [10, 25, 50, 100, 250];
// a few round numbers up to the ceiling, rather than every integer to twenty
const modelChoices = (max) => [3, 5, 10, 15, 20].filter((n) => n <= max);
const MODES = [
  { mode: 'ask', label: 'Ask me first', note: 'A model that clears is shown to you, and nothing is switched until you approve it.' },
  { mode: 'auto', label: 'Switch on its own', note: 'A model that clears twice is switched to by itself, on a small share of calls first, growing while its calls hold up.' },
  { mode: 'off', label: 'Never switch', note: 'Workloads are measured and nothing is ever switched.' },
];
const money = (v) => (v === null || v === undefined || v === '' ? '' : String(v));
/* An amount as typed: empty for none, or dollars with at most two places. Anything else is refused
   here, because "25..5" used to be sent as nothing, which the server stores as "no limit", while the
   page said the limit was saved. */
const MONEY = /^\d{1,7}(\.\d{1,2})?$/;
const typedOk = (v) => v === '' || MONEY.test(v);
const typedNum = (v) => (v === '' ? null : Number(v));

export default function Settings({ data, reload }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [ok, setOk] = useState(null);
  const run = (fn, said = null) => async () => {
    setBusy(true); setErr(null); setOk(null);
    try { await fn(); await reload(); if (said) setOk(said); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  // a confirmation goes on its own after a while; a failure stays until it is read and closed
  useEffect(() => {
    if (!ok) return undefined;
    const t = setTimeout(() => setOk(null), 6000);
    return () => clearTimeout(t);
  }, [ok]);

  return (
    <div className="settingspage">
      <div className="phead"><h1>Settings</h1></div>
      {/* Said where it can be seen: at the foot of the window, whichever section was saved. At the top
          of a long page a confirmation or a refusal landed out of sight of the button pressed. */}
      {(err || ok) && (
        <div className={`settoast ${err ? 'bad' : 'good'}`} role={err ? 'alert' : 'status'}>
          <span>{err || ok}</span>
          <button type="button" className="settoastx" aria-label="Close" onClick={() => { setErr(null); setOk(null); }}>×</button>
        </div>
      )}
      <Account data={data} busy={busy} run={run} />
      <Keys data={data} busy={busy} run={run} />
      <Money data={data} busy={busy} run={run} setErr={setErr} />
      <Limits data={data} busy={busy} run={run} />
      <Optimizing data={data} busy={busy} run={run} />
      <Privacy data={data} busy={busy} run={run} />
      <Emails data={data} busy={busy} run={run} />
    </div>
  );
}

function Account({ data, busy, run }) {
  const [name, setName] = useState(data.name);
  const [email, setEmail] = useState(data.email);
  const [pending, setPending] = useState(null);
  const [code, setCode] = useState('');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [emailPw, setEmailPw] = useState('');
  const min = data.passwordMin || 8;
  const moving = email.trim().toLowerCase() !== data.email;
  return (
    <section className="opt" aria-labelledby="s-account">
      <div className="opthead"><h2 id="s-account">Account</h2></div>
      <div className="kvrow">
        <span className="kvk" id="s-name">Name</span>
        <span className="kvv"><input className="inp" aria-labelledby="s-name" value={name} onChange={(e) => setName(e.target.value)} /></span>
        <span className="kva">
          <button type="button" className="minig" disabled={busy || name === data.name} onClick={run(() => api.profile({ name }), 'Your name is saved.')}>Save</button>
        </span>
      </div>
      <div className="kvrow">
        <span className="kvk" id="s-email">Email</span>
        <span className="kvv">
          <input className="inp" type="email" aria-labelledby="s-email" value={email} onChange={(e) => setEmail(e.target.value)} />
          {moving && !data.needsPassword && (
            <input className="inp" type="password" autoComplete="current-password" placeholder="Your current password"
              aria-label="Your current password, to change your email" value={emailPw} onChange={(e) => setEmailPw(e.target.value)} />
          )}
          <span className="segnote">
            {data.needsPassword
              ? 'Choose a password first, under Password below, then change your email.'
              : 'Changing it needs your current password. A new address is only used once you type the code we send to it, and every other session is then signed out.'}
          </span>
        </span>
        <span className="kva">
          <button type="button" className="minig" disabled={busy || !moving || data.needsPassword || !emailPw}
            onClick={run(async () => { const r = await api.profile({ email, password: emailPw }); setPending(r.pendingEmail || null); setEmailPw(''); },
              'A code is on its way to the new address.')}>Change</button>
        </span>
      </div>
      {pending && (
        <div className="kvrow">
          <span className="kvk" id="s-code">Code sent to {pending}</span>
          <span className="kvv">
            <input className="inp" inputMode="numeric" autoComplete="one-time-code" aria-labelledby="s-code" value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
          </span>
          <span className="kva">
            <button type="button" className="mini" disabled={busy || code.length < 6}
              onClick={run(async () => { await api.verifyEmailChange(pending, code); setPending(null); setCode(''); }, 'Your email address is changed.')}>
              Confirm
            </button>
          </span>
        </div>
      )}
      <div className="kvrow">
        <span className="kvk" id="s-pw">Password</span>
        <span className="kvv">
          {!data.needsPassword && (
            <input className="inp" type="password" autoComplete="current-password" placeholder="Current password" aria-label="Current password"
              value={current} onChange={(e) => setCurrent(e.target.value)} />
          )}
          <input className="inp" type="password" autoComplete="new-password" placeholder={`New password, at least ${min} characters`} aria-label="New password"
            value={next} onChange={(e) => setNext(e.target.value)} />
          <span className="segnote">
            {data.needsPassword ? 'You signed in with an emailed code, so choose a password for next time. '
              : ''}Every other session is signed out when it changes.
          </span>
        </span>
        <span className="kva">
          <button type="button" className="minig" disabled={busy || next.length < min || (!data.needsPassword && !current)}
            onClick={run(async () => { await api.changePassword(current, next); setCurrent(''); setNext(''); }, 'Your password is changed. Other sessions are signed out.')}>
            {data.needsPassword ? 'Set' : 'Change'}
          </button>
        </span>
      </div>
      <div className="kvrow">
        <span className="kvk">Other sessions</span>
        <span className="kvv">Sign out every browser but this one, for example after using a shared computer.</span>
        <span className="kva">
          <button type="button" className="minig" disabled={busy} onClick={run(() => api.signOutOthers(), 'Every other session is signed out.')}>Sign out others</button>
        </span>
      </div>
    </section>
  );
}

function Keys({ data, busy, run }) {
  const [fresh, setFresh] = useState(null);
  const [shown, setShown] = useState({});
  const [names, setNames] = useState({});
  const [newName, setNewName] = useState('production');
  const [sure, setSure] = useState(null);
  const [copied, setCopied] = useState(null);
  const cols = { gridTemplateColumns: 'minmax(0, 1fr) 150px 120px 120px 190px' };
  const copy = (id, text) => {
    navigator.clipboard?.writeText(text).then(() => { setCopied(id); setTimeout(() => setCopied(null), 2500); }).catch(() => {});
  };
  return (
    <section className="opt" aria-labelledby="s-keys">
      <div className="opthead">
        <h2 id="s-keys">API keys</h2>
        <span className="s">
          {data.canRevealKeys
            ? 'Each key can be named, shown again, and revoked on its own. A revoked key stops working at once.'
            : 'Each key can be named and revoked on its own. This deployment cannot show a key again after it is made, so copy a new one when it appears. A revoked key stops working at once.'}
        </span>
      </div>
      <div className="gthead" style={cols} aria-hidden="true">
        <span>Name</span><span>Key</span><span>Created</span><span>Last used</span><span />
      </div>
      {data.keys.map((k) => (
        <div className="gtrow" key={k.id} style={cols}>
          <div className="on">
            <input className="inp" aria-label={`Name of the key ${k.prefix}`} value={names[k.id] ?? k.name}
              onChange={(e) => setNames((m) => ({ ...m, [k.id]: e.target.value }))}
              onBlur={() => { const v = (names[k.id] ?? k.name).trim(); if (v && v !== k.name) run(() => api.renameKey(k.id, v))(); }} />
          </div>
          <div className="mdl"><span className="vh">Key </span>{`${k.prefix}…`}</div>
          <div className="shp"><span className="vh">Created </span>{dateIST(k.created_at)} IST</div>
          <div className="shp"><span className="vh">Last used </span>{k.last_used_at ? ago(k.last_used_at) : 'never'}</div>
          <div style={{ textAlign: 'right', display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            {data.canRevealKeys && (
              <button type="button" className="minig" disabled={busy} aria-expanded={!!shown[k.id]}
                aria-label={`${shown[k.id] ? 'Hide' : 'Show'} the key ${k.name}`}
                onClick={run(async () => {
                  if (shown[k.id]) { setShown((m) => ({ ...m, [k.id]: null })); return; }
                  const r = await api.revealKeyById(k.id);
                  setShown((m) => ({ ...m, [k.id]: r.key }));
                })}>{shown[k.id] ? 'Hide' : 'Show'}</button>
            )}
            {sure === k.id ? (
              <button type="button" className="mini danger" disabled={busy} aria-label={`Yes, revoke the key ${k.name}`}
                onClick={run(async () => { await api.revokeKey(k.id); setSure(null); }, 'The key is revoked. Calls with it are refused from now on.')}>Yes, revoke</button>
            ) : (
              <button type="button" className="minig" disabled={busy} aria-label={`Revoke the key ${k.name}`} onClick={() => setSure(k.id)}>Revoke</button>
            )}
          </div>
          {shown[k.id] && (
            <div className="keyshow" style={{ gridColumn: '1 / -1' }}>
              <code className="m">{shown[k.id]}</code>
              <button type="button" className="minig" onClick={() => copy(k.id, shown[k.id])}>{copied === k.id ? 'Copied' : 'Copy'}</button>
            </div>
          )}
        </div>
      ))}
      <div className="barnote" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <input className="inp" style={{ maxWidth: 220 }} aria-label="Name for a new key" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <button type="button" className="mini" disabled={busy || !newName.trim()}
          onClick={run(async () => { const r = await api.newKey(newName.trim()); setFresh(r.key); })}>Create a key</button>
        <span>Name it after where it is used, so you know which to revoke.</span>
      </div>
      {fresh && (
        <div className="okbox keyshow" role="status">
          <span>Your new key{data.canRevealKeys ? '' : '. Copy it now: it cannot be shown again'}:</span>
          <code className="m">{fresh}</code>
          <button type="button" className="minig" onClick={() => copy('fresh', fresh)}>{copied === 'fresh' ? 'Copied' : 'Copy'}</button>
        </div>
      )}
    </section>
  );
}

function Money({ data, busy, run, setErr }) {
  const [picking, setPicking] = useState(false);
  const [paying, setPaying] = useState(null);
  const [withTopUp, setWithTopUp] = useState(false);
  /* The first page comes with Settings, so a payment that just landed shows the moment Settings is read
     again; older pages are added below it and let go whenever the first page changes. */
  const [older, setOlder] = useState([]);
  const [ended, setEnded] = useState(false);
  useEffect(() => { setOlder([]); setEnded(false); }, [data.ledger]);
  const ledger = [...(data.ledger || []), ...older];
  const buy = async (amountUsd) => {
    setPaying(amountUsd); setErr(null);
    try {
      const { url } = await api.checkout(amountUsd, withTopUp);
      window.location.assign(url);
    } catch (e) { setErr(e.message); setPaying(null); }
  };
  const moreLedger = async () => {
    const last = ledger[ledger.length - 1];
    if (!last) return;
    try {
      const r = await api.ledgerMore(last.created_at, last.id);
      const rows = r.rows || r.ledger || [];
      if (!rows.length || r.more === false) setEnded(true);
      setOlder((l) => [...l, ...rows]);
    } catch (e) { setErr(e.message); }
  };
  const pay = data.payments;
  // only a card saved at a checkout that said so is ever charged automatically
  const topUpCard = !!data.card?.forTopUps;
  return (
    <section className="opt" aria-labelledby="s-money">
      <div className="opthead">
        <h2 id="s-money">Money</h2>
        {pay === 'off' && <span className="s">No payment provider is set up here, so balances are read only.</span>}
        {pay === 'test' && <span className="s">Payments here are in test mode: cards are not charged.</span>}
        {pay === 'test_refused' && <span className="s">Payments are switched off here: this deployment has only a test payment key, and it adds nothing to a balance.</span>}
      </div>
      <div className="kvrow">
        <span className="kvk">Balance</span>
        <span className="kvv kvm">
          {usdHeld(data.balance)}
          {data.held > 0 && <span className="segnote"> {usd(data.held)} is set aside for calls in flight right now; {usd(data.free)} is free to spend.</span>}
        </span>
        <span className="kva">
          <button type="button" className="mini" disabled={!data.canBill || busy || paying} onClick={() => setPicking((v) => !v)} aria-expanded={picking}>
            {data.balance > 0 ? 'Add credit' : 'Add credit to start'}
          </button>
        </span>
      </div>
      {picking && (
        <div className="kvrow amountrow">
          <span className="kvk">How much</span>
          <span className="kvv">
            <span className="amounts">
              {AMOUNTS.map((a) => (
                <button type="button" key={a} className="minig" disabled={!!paying} onClick={() => buy(a)}>{paying === a ? 'Opening…' : `$${a}`}</button>
              ))}
            </span>
            <label className="segnote" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" checked={withTopUp} onChange={(e) => setWithTopUp(e.target.checked)} />
              Also top up automatically with this card when the balance runs low (you can turn it off at any time)
            </label>
          </span>
          <span className="kva" />
        </div>
      )}
      <div className="kvrow">
        <span className="kvk">Automatic top up</span>
        <span className="kvv">
          <span className="seg" role="group" aria-label="Top up amount">
            {/* the amount in force is always one of the choices, whatever it is */}
            {[...new Set([...TOPUPS, Number(data.topUpAmount)].filter((a) => Number.isFinite(a)))]
              .sort((a, b) => a - b)
              .filter((a) => a >= (data.topUpMin ?? 0) && a <= (data.topUpMax ?? 1e9)).map((a) => (
                <button type="button" key={a} disabled={busy || !topUpCard} className={a === data.topUpAmount ? 'segb on' : 'segb'}
                  aria-pressed={a === data.topUpAmount} onClick={run(() => api.setTopUp({ enabled: data.autoTopUp, amountUsd: a }))}>${a}</button>
              ))}
          </span>
          <span className="segnote">
            {topUpCard
              ? `Charges ${usd(data.topUpAmount)} to your card when the balance falls below ${usd(data.topUpThreshold)}, at most ${data.topUpMaxPerDay} times a day.`
              : data.card
                ? 'The card on file was not saved for top ups. Add credit again and tick the box there, which saves it for them and shows you what that means.'
                : 'Needs a card saved for top ups: add credit and tick the box to top up automatically, which saves the card for them.'}
            {data.cardNote ? ` Turned off after the card was declined (${data.cardNote}).` : ''}
          </span>
        </span>
        <span className="kva">
          <Sw label="Automatic top up" on={data.autoTopUp} busy={busy || !data.canBill || !topUpCard}
            onClick={run(() => api.setTopUp({ enabled: !data.autoTopUp, amountUsd: data.topUpAmount }))} />
        </span>
      </div>
      <div className="kvrow">
        <span className="kvk">Card</span>
        <span className="kvv kvm">{data.card ? `${data.card.brand} ···· ${data.card.last4}` : 'none saved'}</span>
      </div>
      {data.plan && (
        <div className="kvrow">
          <span className="kvk">Measuring allowance</span>
          <span className="kvv">{usd(data.plan.allowanceLeft)} of {usd(data.plan.allowanceTotal)} left this period. Measuring uses it before your balance.</span>
        </div>
      )}
      {ledger.length > 0 && (
        <div className="barnote" aria-label="Recent movements">
          {ledger.map((l) => (
            <div key={l.id || `${l.created_at}-${l.amount_usd}`}>{l.amount_usd >= 0 ? '+' : ''}{usd(l.amount_usd)} · {l.note || l.kind} · {ago(l.created_at)}</div>
          ))}
          {!ended && ledger.length >= 10 && <button type="button" className="lnk linkbtn" onClick={moreLedger}>Show older movements</button>}
        </div>
      )}
    </section>
  );
}

function Limits({ data, busy, run }) {
  const l = data.limits || {};
  const [daily, setDaily] = useState(money(l.dailyUsd));
  const [monthly, setMonthly] = useState(money(l.monthlyUsd));
  const num = typedNum;
  const valid = typedOk(daily) && typedOk(monthly);
  const changed = valid && (num(daily) !== (l.dailyUsd ?? null) || num(monthly) !== (l.monthlyUsd ?? null));
  return (
    <section className="opt" aria-labelledby="s-limits">
      <div className="opthead">
        <h2 id="s-limits">Spending limits</h2>
        <span className="s">Calls through Understudy are refused once a limit is reached, with a message saying when they resume. Days and months are told in IST.</span>
      </div>
      <div className="kvrow">
        <span className="kvk" id="s-daily">A day</span>
        <span className="kvv">
          <input className="inp" inputMode="decimal" placeholder="No limit" aria-labelledby="s-daily" aria-invalid={!typedOk(daily)}
            value={daily} onChange={(e) => setDaily(e.target.value.replace(/[^\d.]/g, ''))} />
          <span className="segnote">
            {typedOk(daily) ? `${usd(l.spentToday || 0)} spent on calls today.` : 'Write an amount in dollars, like 25 or 12.50, or leave it empty for no limit.'}
          </span>
        </span>
      </div>
      <div className="kvrow">
        <span className="kvk" id="s-monthly">A month</span>
        <span className="kvv">
          <input className="inp" inputMode="decimal" placeholder="No limit" aria-labelledby="s-monthly" aria-invalid={!typedOk(monthly)}
            value={monthly} onChange={(e) => setMonthly(e.target.value.replace(/[^\d.]/g, ''))} />
          <span className="segnote">
            {typedOk(monthly) ? `${usd(l.spentMonth || 0)} spent on calls this month.` : 'Write an amount in dollars, like 250 or 99.50, or leave it empty for no limit.'}
          </span>
        </span>
        <span className="kva">
          <button type="button" className="minig" disabled={busy || !changed} onClick={run(() => more.setLimits(num(daily), num(monthly)), 'Your limits are saved.')}>Save</button>
        </span>
      </div>
    </section>
  );
}

function Optimizing({ data, busy, run }) {
  const [apply, setApply] = useState(false);
  const [budget, setBudget] = useState(money(data.optimizeBudget));
  const mode = MODES.find((m) => m.mode === data.defaultOptimizeMode) || MODES[0];
  const budgetOk = typedOk(budget);
  const budgetNum = typedNum(budget);
  return (
    <section className="opt" aria-labelledby="s-opt">
      <div className="opthead"><h2 id="s-opt">Optimizing</h2></div>
      <div className="kvrow">
        <span className="kvk">New workloads</span>
        <span className="kvv">
          <span className="seg" role="group" aria-label="How new workloads are switched">
            {MODES.map((m) => (
              <button type="button" key={m.mode} disabled={busy} className={m.mode === mode.mode ? 'segb on' : 'segb'} aria-pressed={m.mode === mode.mode}
                onClick={run(() => more.setDefaultMode(m.mode, apply))}>{m.label}</button>
            ))}
          </span>
          <span className="segnote">{mode.note}</span>
          <label className="segnote" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={apply} onChange={(e) => setApply(e.target.checked)} />
            Apply it to the workloads you have now too, the next time you choose
          </label>
        </span>
      </div>
      <div className="kvrow">
        <span className="kvk">Measure by itself</span>
        <span className="kvv">
          <span className="seg" role="group" aria-label="How often to measure">
            {(data.measureChoices || []).map((c) => (
              <button type="button" key={c.days} disabled={busy} className={c.days === data.measureEveryDays ? 'segb on' : 'segb'}
                aria-pressed={c.days === data.measureEveryDays} onClick={run(() => api.setMeasureEvery(c.days))}>{c.label}</button>
            ))}
          </span>
          <span className="segnote">
            {data.measureEveryDays
              ? 'At most this often, and only when what a measurement can be expected to find would pay for it within two months. '
                + 'Re-checks that keep finding nothing new space themselves out; a new or cheaper model brings the next one forward. '
                + 'A switch is also watched on your live calls every hour.'
              : 'Nothing is measured until you press Measure now on a workload. A switch is still watched on your live calls every hour.'}
          </span>
        </span>
      </div>
      <div className="kvrow">
        <span className="kvk">Models tried each time</span>
        <span className="kvv">
          <span className="seg" role="group" aria-label="Models tried each time">
            {modelChoices(data.evalModelsMax).map((n) => (
              <button type="button" key={n} disabled={busy} className={n === data.evalModels ? 'segb on' : 'segb'} aria-pressed={n === data.evalModels}
                onClick={run(() => api.setModelsTested(n))}>{n}</button>
            ))}
          </span>
          <span className="segnote">More is a fuller picture and costs more, since each answers every sampled call. {data.evalModelsMax} is the most we run.</span>
        </span>
      </div>
      <div className="kvrow">
        <span className="kvk" id="s-budget">Optimizing budget</span>
        <span className="kvv">
          <input className="inp" inputMode="decimal" placeholder="No budget" aria-labelledby="s-budget" aria-invalid={!budgetOk}
            value={budget} onChange={(e) => setBudget(e.target.value.replace(/[^\d.]/g, ''))} />
          <span className="segnote">
            {budgetOk
              ? <>The most measuring, background answers, answers read in the background and live experiments may spend over thirty days, together.{' '}{usd(data.optimizeSpent || 0)} spent in the last thirty days.</>
              : 'Write an amount in dollars, like 20 or 7.50, or leave it empty for no budget.'}
          </span>
        </span>
        <span className="kva">
          <button type="button" className="minig" disabled={busy || !budgetOk || budgetNum === (data.optimizeBudget ?? null)}
            onClick={run(() => more.setOptimizeBudget(budgetNum), 'Your optimizing budget is saved.')}>Save</button>
        </span>
      </div>
      <div className="kvrow">
        <span className="kvk">Share results</span>
        <span className="kvv">
          Let which models cleared which kinds of workload help other workspaces choose what to try. Never a call, an answer, a name or a figure: only verdicts, counted.
        </span>
        <span className="kva"><Sw label="Share results" on={data.shareStats} busy={busy} onClick={run(() => more.setShareStats(!data.shareStats))} /></span>
      </div>
      {data.cacheHintsAvailable && (
        <div className="kvrow">
          <span className="kvk">Mark for caching</span>
          <span className="kvv">
            On models that only cache what is marked, mark a long instruction you send again and again, so it is read back at a tenth of the price.
            Only on workloads busy enough for it to pay; the words sent are exactly yours.
          </span>
          <span className="kva"><Sw label="Mark for caching" on={data.cacheHints} busy={busy} onClick={run(() => more.setCacheHints(!data.cacheHints))} /></span>
        </div>
      )}
    </section>
  );
}

function Privacy({ data, busy, run }) {
  return (
    <section className="opt" aria-labelledby="s-privacy">
      <div className="opthead"><h2 id="s-privacy">Privacy and data</h2></div>
      <div className="kvrow">
        <span className="kvk">Zero data retention</span>
        <span className="kvv">
          {data.zdrOnly
            ? 'Every call goes only to providers that keep nothing of what they are sent.'
            : 'Calls may go to providers that keep what they are sent for a while (usually to check for abuse), never to ones that train on it. More models can be used.'}
          {data.zdrForced ? ' This deployment requires it for every workspace.' : ''}
        </span>
        <span className="kva">
          <Sw label="Zero data retention" on={data.zdrOnly} busy={busy || data.zdrForced} onClick={run(() => more.setZdr(!data.zdrOnly))} />
        </span>
      </div>
      <div className="kvrow">
        <span className="kvk">Keep call content for</span>
        <span className="kvv">
          <span className="seg" role="group" aria-label="Keep call content for">
            {data.retentionChoices.map((c) => (
              <button type="button" key={c.days} disabled={busy} className={c.days === data.retentionDays ? 'segb on' : 'segb'}
                aria-pressed={c.days === data.retentionDays} onClick={run(() => api.retention(c.days))}>{c.label}</button>
            ))}
          </span>
          <span className="segnote">
            {data.retentionDays
              ? 'After this, every copy of what a call said and what was answered is cleared. What calls cost and every measurement are kept.'
              : 'Nothing is cleared on a schedule.'}
          </span>
        </span>
      </div>
    </section>
  );
}

function Emails({ data, busy, run }) {
  const kinds = data.notifyKinds || {};
  const prefs = data.notify || {};
  return (
    <section className="opt" aria-labelledby="s-emails">
      <div className="opthead">
        <h2 id="s-emails">Emails</h2>
        <span className="s">Sent to {data.email}, each event once, at most ten a day.</span>
      </div>
      {Object.entries(kinds).map(([k, words]) => (
        <div className="kvrow" key={k}>
          <span className="kvk">{words}</span>
          <span className="kva"><Sw label={words} on={prefs[k] !== false} busy={busy} onClick={run(() => more.setNotify({ [k]: prefs[k] === false }))} /></span>
        </div>
      ))}
    </section>
  );
}
