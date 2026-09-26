import React, { useEffect, useState } from 'react';
import { api, usd, usdHeld, dateIST, ago } from '../api.js';
import { more } from '../moreApi.js';
import '../settings.css';

/* Everything a workspace chooses, on one short page (variation 1 of the Settings artboard, 26 Sep 2026): six topics in
   the order people need them, each setting a name and one plain sentence beside its control, and the four changed least
   under More options. Every change is saved on its own and read back from the server, so what the page shows is what is
   in force. */

const Sw = ({ on, onClick, busy, label }) => (
  <button type="button" className={`sw${on ? ' swon' : ''}`} disabled={busy} onClick={onClick}
    role="switch" aria-checked={!!on} aria-label={label}><i /></button>
);

/* A row of choices, one of them chosen; the chosen one says what it does in the row's sentence. */
const Choices = ({ label, options, chosen, busy, onChoose }) => (
  <span className="st-seg" role="group" aria-label={label}>
    {options.map((o) => (
      <button type="button" key={o.value} className={o.value === chosen ? 'on' : ''} aria-pressed={o.value === chosen}
        disabled={busy} onClick={() => { if (o.value !== chosen) onChoose(o.value); }}>{o.label}</button>
    ))}
  </span>
);

/* A choice of several named options, as a list to pick from. */
const Pick = ({ id, label, value, options, busy, onPick }) => (
  <select id={id} className="st-select" aria-label={label} value={String(value)} disabled={busy}
    onChange={(e) => onPick(e.target.value)}>
    {options.map((o) => <option key={o.value} value={String(o.value)}>{o.label}</option>)}
  </select>
);

/* One setting: its name and one sentence on the left, its control on the right (under the words on a phone). */
const Row = ({ label, id, say, children, className = '' }) => (
  <div className={`st-row ${className}`}>
    <div className="st-lbl"><b id={id}>{label}</b>{say && <span>{say}</span>}</div>
    {children && <div className="st-ctl">{children}</div>}
  </div>
);

const Card = ({ id, title, intro, children, foot }) => (
  <section className="st-card" id={id} aria-labelledby={`${id}-h`}>
    <div className="st-cardhead"><h2 id={`${id}-h`}>{title}</h2>{intro && <p>{intro}</p>}</div>
    {children}
    {foot && <div className="st-foot">{foot}</div>}
  </section>
);

const AMOUNTS = [10, 25, 50, 100];
const TOPUPS = [10, 25, 50, 100, 250];
// a few round numbers up to the ceiling, rather than every integer to twenty
const modelChoices = (max) => [3, 5, 10, 15, 20].filter((n) => n <= max);
const MODES = [
  { value: 'auto', label: 'Switch automatically', note: 'Understudy moves your requests to it step by step, checks it every day, and switches back if quality slips.' },
  { value: 'ask', label: 'Ask me first', note: 'Understudy tells you what passed and waits for your yes.' },
  { value: 'off', label: 'Never switch', note: 'Understudy only tests and reports. Nothing changes.' },
];
/* Which of the models that pass a workload's test it switches to (src/eval/confidence.js), for every workload that has
   not chosen for itself. */
const ROUTING = [
  { value: 'cautious', label: 'Cautious', note: 'Switch only when Understudy is very sure the answers stay as good. You save a little less.' },
  { value: 'balanced', label: 'Balanced', note: 'Pick the biggest saving Understudy is sure of. When two save about the same, pick the faster one.' },
  { value: 'savings', label: 'Most savings', note: 'Pick the cheapest model that passes, as long as it is fast enough.' },
];
const money = (v) => (v === null || v === undefined || v === '' ? '' : String(v));
/* An amount as typed: empty for none, or dollars with at most two places. Anything else is refused
   here, because "25..5" used to be sent as nothing, which the server stores as "no limit", while the
   page said the limit was saved. */
const MONEY = /^\d{1,7}(\.\d{1,2})?$/;
const typedOk = (v) => v === '' || MONEY.test(v);
const typedNum = (v) => (v === '' ? null : Number(v));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

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
  // the chip on a workload's page links to #optimize: brought into view once the page is drawn
  useEffect(() => {
    if (window.location.hash === '#optimize') document.getElementById('optimize')?.scrollIntoView({ block: 'start' });
  }, []);

  return (
    <div className="settingspage st">
      <header className="st-head"><h1>Settings</h1><p>These apply to your whole workspace.</p></header>
      {/* Said where it can be seen: at the foot of the window, whichever section was saved. At the top
          of a long page a confirmation or a refusal landed out of sight of the button pressed. */}
      {(err || ok) && (
        <div className={`settoast ${err ? 'bad' : 'good'}`} role={err ? 'alert' : 'status'}>
          <span>{err || ok}</span>
          <button type="button" className="settoastx" aria-label="Close" onClick={() => { setErr(null); setOk(null); }}>×</button>
        </div>
      )}
      <Switching data={data} busy={busy} run={run} />
      <Billing data={data} busy={busy} run={run} setErr={setErr} />
      <Privacy data={data} busy={busy} run={run} />
      <Keys data={data} busy={busy} run={run} />
      <Account data={data} busy={busy} run={run} />
      <Emails data={data} busy={busy} run={run} />
    </div>
  );
}

/* What happens when a cheaper model passes a test, how careful to be, and how often to test again: one choice each for
   the whole workspace, which every workload follows (each workload's page shows the first as a chip that links here).
   The four settings changed least wait under More options. */
function Switching({ data, busy, run }) {
  const [applyRouting, setApplyRouting] = useState(false);
  const [open, setOpen] = useState(false);
  const [budget, setBudget] = useState(money(data.optimizeBudget));
  const mode = MODES.find((m) => m.value === data.defaultOptimizeMode) || MODES[0];
  const routing = ROUTING.find((r) => r.value === data.defaultRoutingMode) || ROUTING[1];
  const own = Number(data.routingOwn) || 0;
  const budgetOk = typedOk(budget);
  const budgetNum = typedNum(budget);
  const retest = data.measureEveryDays;
  return (
    <Card id="optimize" title="Switching"
      intro="Understudy tests cheaper models on your real requests. These choices decide what happens when one of them does as well as your current model."
      foot={(
        <button type="button" className="st-more" aria-expanded={open} aria-controls="st-more" onClick={() => setOpen((v) => !v)}>
          {open ? 'Fewer options' : 'More options: models per test, testing budget, sharing'}
          <svg viewBox="0 0 16 16" aria-hidden="true" className={open ? 'up' : ''}><path d="M4.5 6.2 8 9.7l3.5-3.5" /></svg>
        </button>
      )}>
      <Row label="When a cheaper model passes a test" id="st-mode" say={mode.note}>
        <Choices label="When a cheaper model passes a test" options={MODES} chosen={mode.value} busy={busy}
          onChoose={(v) => run(() => more.setDefaultMode(v, true), `Every workload now follows: ${MODES.find((m) => m.value === v).label}.`)()} />
      </Row>
      <Row label="How careful to be" id="st-routing"
        say={(
          <>
            {routing.note}
            {own > 0 && (
              <label className="st-check">
                <input type="checkbox" checked={applyRouting} onChange={(e) => setApplyRouting(e.target.checked)} />
                {`Also make the ${plural(own, 'workload that chose its own', 'workloads that chose their own')} follow it, the next time you choose`}
              </label>
            )}
          </>
        )}>
        <Choices label="How careful to be" options={ROUTING} chosen={routing.value} busy={busy}
          onChoose={(v) => run(() => api.setDefaultRouting(v, applyRouting), `Workloads now pick: ${ROUTING.find((r) => r.value === v).label}.`)()} />
      </Row>
      <Row label="How often to re-test" id="st-retest"
        say={retest
          ? 'At most this often, and only when a test is likely to pay for itself. A new or cheaper model can bring one forward.'
          : 'Nothing is tested until you press Test now on a workload. A model you switched to is still checked on your live requests.'}>
        <Pick id="st-retest-pick" label="How often to re-test" value={retest} busy={busy}
          options={(data.measureChoices || []).map((c) => ({ value: c.days, label: c.label }))}
          onPick={(v) => run(() => api.setMeasureEvery(Number(v)), 'How often to re-test is saved.')()} />
      </Row>
      {open && (
        <div className="st-sub" id="st-more">
          <Row label="Models per test" id="st-models" say="Each test tries this many models. More models give a fuller picture, and cost more.">
            <Choices label="Models per test" options={modelChoices(data.evalModelsMax).map((n) => ({ value: n, label: String(n) }))}
              chosen={data.evalModels} busy={busy} onChoose={(n) => run(() => api.setModelsTested(n), `Each test now tries ${n} models.`)()} />
          </Row>
          <Row label="Testing budget" id="st-budget"
            say={budgetOk
              ? `The most Understudy may spend on tests and checks in any 30 days. Leave it empty for no limit. ${usd(data.optimizeSpent || 0)} spent in the last 30 days.${data.optimizeReserve > 0 ? ` The last ${Math.round(data.optimizeReserve * 100)}% of it is kept for tests.` : ''}`
              : 'Write an amount in dollars, like 20 or 7.50, or leave it empty for no limit.'}>
            <input className="inp st-amount" inputMode="decimal" placeholder="No limit" aria-labelledby="st-budget" aria-invalid={!budgetOk}
              value={budget} onChange={(e) => setBudget(e.target.value.replace(/[^\d.]/g, ''))} />
            <button type="button" className="minig" disabled={busy || !budgetOk || budgetNum === (data.optimizeBudget ?? null)}
              onClick={run(() => more.setOptimizeBudget(budgetNum), 'Your testing budget is saved.')}>Save</button>
          </Row>
          <Row label="Share results" id="st-share"
            say="Help everyone pick better models by sharing which models passed which kinds of work. Your requests, answers and names are never shared.">
            <Sw label="Share results" on={data.shareStats} busy={busy} onClick={run(() => more.setShareStats(!data.shareStats))} />
          </Row>
          {data.cacheHintsAvailable && (
            <Row label="Mark repeated instructions" id="st-cache"
              say="Some providers charge less for text they have seen before. Understudy can mark a long instruction you send again and again. Your words stay the same.">
              <Sw label="Mark repeated instructions" on={data.cacheHints} busy={busy} onClick={run(() => more.setCacheHints(!data.cacheHints))} />
            </Row>
          )}
        </div>
      )}
    </Card>
  );
}

/* The balance and adding to it, topping it up by itself, the most requests may cost, the card, and every movement. */
function Billing({ data, busy, run, setErr }) {
  const [picking, setPicking] = useState(false);
  const [paying, setPaying] = useState(null);
  const [withTopUp, setWithTopUp] = useState(false);
  const [history, setHistory] = useState(false);
  const l = data.limits || {};
  const [daily, setDaily] = useState(money(l.dailyUsd));
  const [monthly, setMonthly] = useState(money(l.monthlyUsd));
  /* The first page comes with Settings, so a payment that just landed shows the moment Settings is read
     again; older pages are added below it and let go whenever the first page changes. */
  const [older, setOlder] = useState([]);
  const [ended, setEnded] = useState(false);
  // let go of older pages only when the newest movement changes, not on every reading of Settings
  const newest = data.ledger?.[0]?.id ?? null;
  useEffect(() => { setOlder([]); setEnded(false); }, [newest]);
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
      setOlder((x) => [...x, ...rows]);
    } catch (e) { setErr(e.message); }
  };
  const pay = data.payments;
  // only a card saved at a checkout that said so is ever charged automatically
  const topUpCard = !!data.card?.forTopUps;
  const limitsOk = typedOk(daily) && typedOk(monthly);
  const limitsChanged = limitsOk && (typedNum(daily) !== (l.dailyUsd ?? null) || typedNum(monthly) !== (l.monthlyUsd ?? null));
  // the amount in force is always one of the choices, whatever it is
  const topUps = [...new Set([...TOPUPS, Number(data.topUpAmount)].filter((a) => Number.isFinite(a)))]
    .sort((a, b) => a - b).filter((a) => a >= (data.topUpMin ?? 0) && a <= (data.topUpMax ?? 1e9));
  const topUpSay = `${topUpCard
    ? `Adds ${usd(data.topUpAmount)} to your balance when it falls below ${usd(data.topUpThreshold)}.`
    : data.card
      ? 'The card on file was not saved for top ups. Add credit again and tick the box there to save it for them.'
      : 'Needs a card saved for top ups. Add credit and tick the box to top up automatically, which saves the card.'}${
    data.cardNote === 'unreachable' ? ' Paused because the card processor could not be reached. Switch it back on to try again.'
      : data.cardNote ? ` Turned off because the card was declined (${data.cardNote}).` : ''}`;
  return (
    <Card id="st-billing" title="Billing"
      intro={pay === 'off' ? 'No payment provider is set up here, so your balance cannot be topped up.'
        : pay === 'test' ? 'Payments here are in test mode, so cards are not charged.'
          : pay === 'test_refused' ? 'Payments are switched off here. This deployment only has a test payment key, which adds nothing to a balance.'
            : null}>
      <Row label="Balance" id="st-balance"
        say={`Your requests and tests are paid from this balance.${data.held > 0 ? ` ${usd(data.held)} is set aside for requests in progress, so ${usd(data.free)} is free to spend.` : ''}`}>
        <span className="st-money m">{usdHeld(data.balance)}</span>
        <button type="button" className="mini" disabled={!data.canBill || busy || paying} aria-expanded={picking} onClick={() => setPicking((v) => !v)}>
          {data.balance > 0 ? 'Add credit' : 'Add credit to start'}
        </button>
      </Row>
      {picking && (
        <Row label="How much to add" id="st-amount"
          say={(
            <label className="st-check">
              <input type="checkbox" checked={withTopUp} onChange={(e) => setWithTopUp(e.target.checked)} />
              Also top up automatically with this card when the balance runs low. You can turn it off at any time.
            </label>
          )}>
          {AMOUNTS.map((a) => (
            <button type="button" key={a} className="minig" disabled={!!paying} onClick={() => buy(a)}>{paying === a ? 'Opening…' : `$${a}`}</button>
          ))}
        </Row>
      )}
      <Row label="Automatic top up" id="st-topup" say={topUpSay}>
        <Pick id="st-topup-pick" label="Top up amount" value={data.topUpAmount} busy={busy || !topUpCard}
          options={topUps.map((a) => ({ value: a, label: `$${a}` }))}
          onPick={(v) => run(() => api.setTopUp({ enabled: data.autoTopUp, amountUsd: Number(v) }), 'Your top up amount is saved.')()} />
        {/* switching it on needs a card saved for top ups; switching it off never needs anything */}
        <Sw label="Automatic top up" on={data.autoTopUp} busy={busy || (!data.autoTopUp && (!data.canBill || !topUpCard))}
          onClick={run(() => api.setTopUp(data.autoTopUp ? { enabled: false } : { enabled: true, amountUsd: data.topUpAmount }))} />
      </Row>
      <Row label="Spending limits" id="st-limits"
        say={limitsOk
          ? `When you reach a limit, requests stop until the next day or month, India time. ${usd(l.spentToday || 0)} spent today and ${usd(l.spentMonth || 0)} this month.`
          : 'Write an amount in dollars, like 25 or 12.50, or leave it empty for no limit.'}>
        <span className="st-inputs">
          <label>A day
            <input className="inp st-amount" inputMode="decimal" placeholder="No limit" aria-label="Spending limit for a day" aria-invalid={!typedOk(daily)}
              value={daily} onChange={(e) => setDaily(e.target.value.replace(/[^\d.]/g, ''))} />
          </label>
          <label>A month
            <input className="inp st-amount" inputMode="decimal" placeholder="No limit" aria-label="Spending limit for a month" aria-invalid={!typedOk(monthly)}
              value={monthly} onChange={(e) => setMonthly(e.target.value.replace(/[^\d.]/g, ''))} />
          </label>
        </span>
        <button type="button" className="minig" disabled={busy || !limitsChanged}
          onClick={run(() => more.setLimits(typedNum(daily), typedNum(monthly)), 'Your limits are saved.')}>Save</button>
      </Row>
      <Row label="Card" id="st-card"
        say={data.card ? `${data.card.brand} ending ${data.card.last4}.${topUpCard ? ' It is saved for top ups.' : ''}` : 'No card is saved yet.'}>
        {ledger.length > 0 && (
          <button type="button" className="minig" aria-expanded={history} aria-controls="st-history" onClick={() => setHistory((v) => !v)}>
            {history ? 'Hide payment history' : 'Payment history'}
          </button>
        )}
      </Row>
      {history && (
        <div className="st-history" id="st-history" aria-label="Payment history">
          {ledger.map((x) => (
            <div key={x.id || `${x.created_at}-${x.amount_usd}`} className="st-move">
              <span className={`m ${x.amount_usd >= 0 ? 'in' : 'out'}`}>{x.amount_usd >= 0 ? '+' : ''}{usd(x.amount_usd)}</span>
              <span className="what">{x.note || x.kind}</span>
              <span className="when">{ago(x.created_at)}</span>
            </div>
          ))}
          {!ended && ledger.length >= 10 && <button type="button" className="st-more" onClick={moreLedger}>Show older payments</button>}
        </div>
      )}
      {data.plan && (
        <Row label="Testing allowance" id="st-allowance"
          say={`${usd(data.plan.allowanceLeft)} of ${usd(data.plan.allowanceTotal)} left this period. Tests use it before your balance.`} />
      )}
    </Card>
  );
}

function Privacy({ data, busy, run }) {
  return (
    <Card id="st-privacy" title="Privacy">
      <Row label="Zero data retention" id="st-zdr"
        say={`${data.zdrOnly
          ? 'Send requests only to model providers that delete them right away.'
          : 'Requests may also go to providers that keep them for a while, usually to check for abuse, but never to ones that train on them. More models can be used.'}${
          data.zdrForced ? ' This deployment requires it for every workspace.' : ''}`}>
        <Sw label="Zero data retention" on={data.zdrOnly} busy={busy || data.zdrForced} onClick={run(() => more.setZdr(!data.zdrOnly))} />
      </Row>
      <Row label="Keep request text for" id="st-keep"
        say={data.retentionDays
          ? 'After that, the text of requests and answers is deleted. What they cost and your test results are kept.'
          : 'Nothing is deleted on a schedule.'}>
        <Pick id="st-keep-pick" label="Keep request text for" value={data.retentionDays} busy={busy}
          options={data.retentionChoices.map((c) => ({ value: c.days, label: c.label }))}
          onPick={(v) => run(() => api.retention(Number(v)), 'How long request text is kept is saved.')()} />
      </Row>
    </Card>
  );
}

function Keys({ data, busy, run }) {
  const [fresh, setFresh] = useState(null);
  const [shown, setShown] = useState({});
  const [names, setNames] = useState({});
  const [newName, setNewName] = useState('production');
  const [sure, setSure] = useState(null);
  const [copied, setCopied] = useState(null);
  const copy = (id, text) => {
    navigator.clipboard?.writeText(text).then(() => { setCopied(id); setTimeout(() => setCopied(null), 2500); }).catch(() => {});
  };
  return (
    <Card id="st-keys" title="API keys"
      intro={`Name each key after where you use it, so you know which one to revoke.${data.canRevealKeys ? ''
        : ' This deployment cannot show a key again after it is made, so copy a new key when it appears.'}`}
      foot={(
        <>
          <input className="inp st-keyname" aria-label="Name for a new key" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <button type="button" className="mini" disabled={busy || !newName.trim()}
            onClick={run(async () => { const r = await api.newKey(newName.trim()); setFresh(r.key); })}>Create a key</button>
        </>
      )}>
      {fresh && (
        <div className="okbox keyshow st-fresh" role="status">
          <span>Your new key{data.canRevealKeys ? '' : '. Copy it now, because it cannot be shown again'}:</span>
          <code className="m">{fresh}</code>
          <button type="button" className="minig" onClick={() => copy('fresh', fresh)}>{copied === 'fresh' ? 'Copied' : 'Copy'}</button>
        </div>
      )}
      {data.keys.length === 0 && <Row label="No keys yet" say="Create one below to send requests through Understudy." />}
      {data.keys.map((k) => (
        <div className="st-row st-key" key={k.id}>
          <div className="st-lbl">
            <span className="st-keyline">
              <input className="inp st-keyedit" aria-label={`Name of the key ${k.prefix}`} value={names[k.id] ?? k.name}
                onChange={(e) => setNames((m) => ({ ...m, [k.id]: e.target.value }))}
                onBlur={() => { const v = (names[k.id] ?? k.name).trim(); if (v && v !== k.name) run(() => api.renameKey(k.id, v))(); }} />
              <span className="m st-prefix">{`${k.prefix}…`}</span>
            </span>
            <span>{`Made ${dateIST(k.created_at)} IST, last used ${k.last_used_at ? ago(k.last_used_at) : 'never'}`}</span>
          </div>
          <div className="st-ctl">
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
                onClick={run(async () => { await api.revokeKey(k.id); setSure(null); }, 'The key is revoked. Requests with it are refused from now on.')}>Yes, revoke</button>
            ) : (
              <button type="button" className="minig" disabled={busy} aria-label={`Revoke the key ${k.name}`} onClick={() => setSure(k.id)}>Revoke</button>
            )}
          </div>
          {shown[k.id] && (
            <div className="keyshow st-keyshow">
              <code className="m">{shown[k.id]}</code>
              <button type="button" className="minig" onClick={() => copy(k.id, shown[k.id])}>{copied === k.id ? 'Copied' : 'Copy'}</button>
            </div>
          )}
        </div>
      ))}
    </Card>
  );
}

function Account({ data, busy, run }) {
  const [name, setName] = useState(data.name);
  const [email, setEmail] = useState(data.email);
  const [pending, setPending] = useState(null);
  const [code, setCode] = useState('');
  const [pwOpen, setPwOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [emailPw, setEmailPw] = useState('');
  const min = data.passwordMin || 8;
  const moving = email.trim().toLowerCase() !== data.email;
  return (
    <Card id="st-account" title="Account">
      <Row label="Name" id="st-name">
        <input className="inp" aria-labelledby="st-name" value={name} onChange={(e) => setName(e.target.value)} />
        <button type="button" className="minig" disabled={busy || name === data.name} onClick={run(() => api.profile({ name }), 'Your name is saved.')}>Save</button>
      </Row>
      <Row label="Email" id="st-email"
        say={data.needsPassword ? 'Choose a password first, below, then change your email.'
          : 'Changing it asks for your password and sends a code to the new address. Every other browser is signed out once you confirm it.'}>
        <input className="inp" type="email" aria-labelledby="st-email" value={email} onChange={(e) => setEmail(e.target.value)} />
        {moving && !data.needsPassword && (
          <input className="inp" type="password" autoComplete="current-password" placeholder="Your current password"
            aria-label="Your current password, to change your email" value={emailPw} onChange={(e) => setEmailPw(e.target.value)} />
        )}
        <button type="button" className="minig" disabled={busy || !moving || data.needsPassword || !emailPw}
          onClick={run(async () => { const r = await api.profile({ email, password: emailPw }); setPending(r.pendingEmail || null); setEmailPw(''); },
            'A code is on its way to the new address.')}>Change</button>
      </Row>
      {pending && (
        <Row label={`Code sent to ${pending}`} id="st-code" say="Type the six digits from the email to finish changing your address.">
          <input className="inp st-code" inputMode="numeric" autoComplete="one-time-code" aria-labelledby="st-code" value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
          <button type="button" className="mini" disabled={busy || code.length < 6}
            onClick={run(async () => { await api.verifyEmailChange(pending, code); setPending(null); setCode(''); }, 'Your email address is changed.')}>
            Confirm
          </button>
        </Row>
      )}
      <Row label="Password" id="st-pw"
        say={data.needsPassword ? 'You signed in with an emailed code, so choose a password for next time.' : 'Every other browser is signed out when it changes.'}>
        {!pwOpen ? (
          <button type="button" className="minig" aria-expanded={false} onClick={() => setPwOpen(true)}>
            {data.needsPassword ? 'Set a password' : 'Change password'}
          </button>
        ) : (
          <>
            {!data.needsPassword && (
              <input className="inp" type="password" autoComplete="current-password" placeholder="Current password" aria-label="Current password"
                value={current} onChange={(e) => setCurrent(e.target.value)} />
            )}
            <input className="inp" type="password" autoComplete="new-password" placeholder={`New password, at least ${min} characters`} aria-label="New password"
              value={next} onChange={(e) => setNext(e.target.value)} />
            <button type="button" className="mini" disabled={busy || next.length < min || (!data.needsPassword && !current)}
              onClick={run(async () => { await api.changePassword(current, next); setCurrent(''); setNext(''); setPwOpen(false); },
                'Your password is changed. Every other browser is signed out.')}>
              Save
            </button>
            <button type="button" className="minig" onClick={() => { setPwOpen(false); setCurrent(''); setNext(''); }}>Cancel</button>
          </>
        )}
      </Row>
      <Row label="Signed in elsewhere" id="st-others" say="Signs out every other browser, for example after using a shared computer.">
        <button type="button" className="minig" disabled={busy} onClick={run(() => api.signOutOthers(), 'Every other browser is signed out.')}>Sign out everywhere else</button>
      </Row>
    </Card>
  );
}

function Emails({ data, busy, run }) {
  const kinds = data.notifyKinds || {};
  const prefs = data.notify || {};
  return (
    <Card id="st-emails" title="Emails" intro={`Sent to ${data.email}, at most ten a day.`}>
      {Object.entries(kinds).map(([k, words]) => (
        <Row key={k} label={words} id={`st-email-${k}`}>
          <Sw label={words} on={prefs[k] !== false} busy={busy} onClick={run(() => more.setNotify({ [k]: prefs[k] === false }))} />
        </Row>
      ))}
    </Card>
  );
}
