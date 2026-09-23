import React, { memo, useCallback, useDeferredValue, useMemo, useState } from 'react';
import { api, num } from '../api.js';
import { usd } from '../money.js';
import '../models.css';

/* The models a measurement may try, and which of them this workspace allows.
 *
 * Three hundred and more of them, so the list can be searched and narrowed: by what a model is
 * called, by who makes it, by whether any provider that keeps nothing serves it, and by whether
 * it is switched on here. Switching one on or off takes effect on the screen at once and is
 * saved behind it; it used to wait for the whole list to be read again after every press.
 *
 * "Where it runs" used to say "candidate" for nearly every row, which told nobody anything.
 * What decides whether a model can be used at all is whether any provider that keeps nothing
 * serves it, because every call asks for one: a model with none is refused on every call. So
 * that is what the column says, in numbers, whenever the server reports it. */

const Tile = ({ k, v, s }) => (
  <div className="tile"><div className="k">{k}</div><div className="v">{v}</div><div className="s">{s}</div></div>
);

/* A model's maker, as its catalogue name writes it ("Mistral: Mistral Nemo" is Mistral's), and
   the part of the name after it. The id's first half is the stable key. */
const makerKey = (m) => String(m.id).split('/')[0];
const makerName = (m) => (m.name && m.name.includes(': ') ? m.name.split(': ')[0] : makerKey(m));
const shortName = (m) => (m.name && m.name.includes(': ') ? m.name.slice(m.name.indexOf(': ') + 2) : (m.name || m.id));

/** How many providers that keep nothing serve a model, or null when the server does not say. */
const keepersOf = (m) => (typeof m.zdr === 'number' ? m.zdr : null);

/* A model no provider serves without keeping data is refused on every call, because every call
   asks for one that keeps nothing; the row says that rather than a bare zero. */
const keepWords = (n, zdrOnly) => (n === null ? null
  : n === 0 ? (zdrOnly ? 'None, so every call to it is refused' : 'None')
    : `${num(n)} ${n === 1 ? 'provider keeps' : 'providers keep'} nothing`);

/* A switch that says what it does. It is a real switch to a screen reader, named after the model
   it switches, rather than twenty buttons all called "Turn off". */
function Switch({ on, busy, onChange, label, describedBy, disabled = false }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label}
      aria-describedby={describedBy} className={`sw${on ? ' swon' : ''}`}
      disabled={disabled || busy} aria-busy={busy || undefined} onClick={onChange}><i /></button>
  );
}

const Row = memo(({ m, on, busy, onToggle, showKeepers, zdrOnly }) => {
  const keepers = keepersOf(m);
  return (
    <div className="catlrow" role="row">
      <div className="catlname" role="cell">
        <span className="catltitle">{shortName(m)}</span>
        <span className="catlid m">{m.id}</span>
      </div>
      <div className="catlprice num" role="cell">
        <span className="catlk">Per 1M tokens</span>
        {usd(m.priceIn)} in, {usd(m.priceOut)} out
      </div>
      <div className="catlopen" role="cell">
        <span className="catlk">Open weights</span>{m.openWeights ? 'Yes' : 'No'}
      </div>
      {showKeepers && (
        <div className={`catlkeep${keepers === 0 ? ' none' : ''}`} role="cell">
          <span className="catlk">Keeps nothing</span>{keepWords(keepers, zdrOnly) ?? 'Not reported'}
        </div>
      )}
      <div className="catlserve" role="cell">
        <span className="catlk">Serving</span>
        {m.where.length ? m.where.join(', ') : <span className="catlmut">No workload</span>}
      </div>
      <div className="catluse" role="cell">
        <Switch on={on} busy={busy} label={`Use ${m.name || m.id}`}
          onChange={() => onToggle(m.id, !on)} />
      </div>
    </div>
  );
});

export default function Models({ data }) {
  const [query, setQuery] = useState('');
  const [maker, setMaker] = useState('');
  const [keeps, setKeeps] = useState(false);
  const [which, setWhich] = useState('all');   // all | on | off
  // switched here but not read back yet, and the switches still being saved
  const [over, setOver] = useState({});
  const [saving, setSaving] = useState({});
  const [err, setErr] = useState('');
  const q = useDeferredValue(query.trim().toLowerCase());

  const models = data.models;
  const isOn = useCallback((m) => (over[m.id] ?? m.enabled), [over]);
  // whether this server says how many providers that keep nothing serve each model
  const reported = useMemo(() => models.some((m) => keepersOf(m) !== null), [models]);

  const makers = useMemo(() => {
    const seen = new Map();
    for (const m of models) {
      const k = makerKey(m);
      const had = seen.get(k);
      seen.set(k, { key: k, name: had?.name || makerName(m), n: (had?.n || 0) + 1 });
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [models]);

  const shown = useMemo(() => models.filter((m) => {
    if (maker && makerKey(m) !== maker) return false;
    if (keeps && reported && !(keepersOf(m) > 0)) return false;
    if (which === 'on' && !isOn(m)) return false;
    if (which === 'off' && isOn(m)) return false;
    if (q && !`${m.name} ${m.id}`.toLowerCase().includes(q)) return false;
    return true;
  }), [models, maker, keeps, reported, which, q, isOn]);

  /* A switch changes on the screen the moment it is pressed, and goes back, with the reason, if
     the server does not take it. */
  const toggle = useCallback(async (id, next) => {
    setErr('');
    setOver((o) => ({ ...o, [id]: next }));
    setSaving((s) => ({ ...s, [id]: true }));
    try {
      await api.setModel(id, next);
    } catch (e) {
      setOver((o) => ({ ...o, [id]: !next }));
      setErr(`${id} was not ${next ? 'switched on' : 'switched off'}: ${e.message}`);
    } finally {
      setSaving((s) => { const t = { ...s }; delete t[id]; return t; });
    }
  }, []);

  const enabled = models.filter(isOn);
  const serving = models.filter((m) => m.where.length);
  const cheapest = enabled.length ? Math.min(...enabled.map((m) => m.priceIn)) : 0;
  const reachable = reported ? models.filter((m) => keepersOf(m) > 0).length : null;
  const filtered = !!(q || maker || keeps || which !== 'all');
  const clear = () => { setQuery(''); setMaker(''); setKeeps(false); setWhich('all'); };

  return (
    <>
      <div className="phead"><h1>Models</h1><span className="chip chipflat">{num(models.length)} available</span></div>
      <div className="tiles">
        <Tile k="Enabled" v={num(enabled.length)} s={`of ${num(models.length)} available`} />
        <Tile k="Serving your traffic" v={num(serving.length)}
          s={serving.length ? serving.map((m) => shortName(m)).slice(0, 2).join(' and ') : 'nothing routed yet'} />
        {reported
          ? <Tile k="Keep nothing" v={num(reachable)} s="have a provider that keeps nothing" />
          : <Tile k="Open weights" v={num(enabled.filter((m) => m.openWeights).length)} s="enabled" />}
        <Tile k="Cheapest enabled" v={enabled.length ? usd(cheapest) : 'none'} s="per 1M input tokens" />
      </div>

      <section className="opt">
        <div className="opthead">
          <h2>Candidate models</h2>
          <span className="s">We only try what you enable here, and every one is measured on your own calls before anything switches.</span>
        </div>
        {models.length === 0 ? (
          <div className="optempty">
            The model list syncs from the provider once routing is configured. Nothing can be tried until then.
          </div>
        ) : (
          <>
            <div className="catlbar" role="search" aria-label="Find models">
              <label className="catlsearch">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
                <span className="vh">Search models</span>
                <input type="search" value={query} onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by name or maker" autoComplete="off" spellCheck="false" />
              </label>
              <label className="catlpick">
                <span className="vh">Maker</span>
                <select value={maker} onChange={(e) => setMaker(e.target.value)}>
                  <option value="">Every maker</option>
                  {makers.map((mk) => <option key={mk.key} value={mk.key}>{mk.name} ({num(mk.n)})</option>)}
                </select>
              </label>
              <div className="seg catlseg" role="group" aria-label="Which models">
                {[['all', 'All'], ['on', 'Enabled'], ['off', 'Not enabled']].map(([k, label]) => (
                  <button key={k} type="button" aria-pressed={which === k}
                    className={which === k ? 'segb on' : 'segb'} onClick={() => setWhich(k)}>{label}</button>
                ))}
              </div>
              <label className={`catlcheck${reported ? '' : ' off'}`}>
                <input type="checkbox" checked={keeps && reported} disabled={!reported}
                  onChange={(e) => setKeeps(e.target.checked)} aria-describedby={reported ? undefined : 'catl-unreported'} />
                Only models a provider that keeps nothing serves
              </label>
            </div>
            <div className="catlcount" aria-live="polite">
              {filtered
                ? <>Showing {num(shown.length)} of {num(models.length)} models. <button type="button" className="plainb catlclear" onClick={clear}>Clear the filters</button></>
                : <>{num(models.length)} models, {num(enabled.length)} enabled.</>}
              {!reported && (
                <span id="catl-unreported" className="catlnote">
                  {' '}This server does not report which providers keep nothing yet, so that filter is off.
                </span>
              )}
            </div>
            {err && <div className="errbox" role="alert" style={{ margin: '0 20px 12px' }}>{err}</div>}

            <div className="catltable" role="table" aria-label="Candidate models">
              <div className={`catlhead${reported ? '' : ' nokeep'}`} role="row">
                <span role="columnheader">Model</span>
                <span role="columnheader">Price per 1M tokens</span>
                <span role="columnheader">Open weights</span>
                {reported && <span role="columnheader">Keeps nothing</span>}
                <span role="columnheader">Serving</span>
                <span role="columnheader" className="catlusehead">Use</span>
              </div>
              <div className={reported ? 'catlrows' : 'catlrows nokeep'} role="rowgroup">
                {shown.map((m) => (
                  <Row key={m.id} m={m} on={isOn(m)} busy={!!saving[m.id]} onToggle={toggle} showKeepers={reported}
                    zdrOnly={!!data.zdrOnly} />
                ))}
              </div>
              {shown.length === 0 && (
                <div className="optempty">
                  No model matches. <button type="button" className="plainb catlclear" onClick={clear}>Clear the filters</button>
                </div>
              )}
            </div>
          </>
        )}
      </section>

      <section className="opt">
        <div className="opthead"><h2>Provider rules</h2></div>
        <div className="kvrow">
          <span className="kvk" id="rule-zdr">Zero data retention only</span>
          <span className="kvv">
            {data.zdrOnly
              ? 'Every call asks for providers that keep nothing: zero data retention, and data collection denied.'
              : 'This deployment does not ask providers to keep nothing.'}
            <span className="kvs catlwhy" id="rule-zdr-why">
              {data.zdrOnly
                ? 'Always on: it is set for the whole service, not for each workspace, so it cannot be switched off here.'
                : 'Set for the whole service, not for each workspace, so it cannot be changed here.'}
            </span>
          </span>
          <span className="kva">
            <Switch on={!!data.zdrOnly} disabled label="Zero data retention only" describedBy="rule-zdr-why" />
          </span>
        </div>
        <div className="kvrow">
          <span className="kvk">Skip aliases and routers</span>
          <span className="kvv">
            An alias or a router can change the model under you, so a result measured on one would not hold.
            <span className="kvs catlwhy" id="rule-alias-why">
              Always on: aliases and routers are left out when the model list is read, so there is nothing here to switch.
            </span>
          </span>
          <span className="kva">
            <Switch on disabled label="Skip aliases and routers" describedBy="rule-alias-why" />
          </span>
        </div>
      </section>
    </>
  );
}
