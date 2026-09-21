import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, usd, num, timeIST } from '../api.js';

/* The calls a workload is made of: searchable, a page at a time, and any cell that had to be
   cut short readable in place.

   A workload is a claim that a group of requests are all the same job, and reading some of
   them is the only way to check it. Twenty-five at a time, because that is what fits on a
   screen and anything longer is a list nobody scrolls to the bottom of.

   Resting on a cell opens THAT cell, not the whole call. A request and its answer together
   can run to tens of thousands of characters, and somebody resting on what was asked wants
   what was asked; a card carrying both is a wall of text they then have to search. Only a
   cell with more behind it can be opened, so a cell already showing everything stays still
   rather than offering to repeat itself. */

const OPEN_AFTER_MS = 200;    // passing over a cell on the way somewhere else opens nothing
const CLOSE_AFTER_MS = 160;   // long enough to move from the cell into the card

const FIELD_LABEL = { asked: 'What it asked', answered: 'What it answered' };

export default function WorkloadCalls({ workloadId }) {
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  // the card: which cell it is for, where it sits, and whether it was pressed open
  const [peek, setPeek] = useState(null);      // { key, id, field, pos, pinned }
  const [text, setText] = useState(null);
  const cache = useRef(new Map());
  const openTimer = useRef(null);
  const closeTimer = useRef(null);
  const card = useRef(null);
  /* Which cell the card is for right now, so a fetch that lands after the pointer has moved
     on cannot fill the new card with the old cell's words. */
  const showing = useRef(null);
  /* Somebody whose pointer is on the card is reading it, so nothing happening to the page
     underneath should take it away from them. */
  const overCard = useRef(false);

  // a search waits for the typing to stop, then starts from the first page
  useEffect(() => {
    const t = setTimeout(() => { setQ(typed.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [typed]);

  useEffect(() => {
    let live = true;
    setLoading(true); setErr('');
    api.workloadCalls(workloadId, { page, q })
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setErr(e.message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [workloadId, page, q]);

  const close = useCallback(() => {
    clearTimeout(openTimer.current); clearTimeout(closeTimer.current);
    showing.current = null;
    overCard.current = false;
    setPeek(null); setText(null);
  }, []);

  /* Where the card goes: lined up with the cell it belongs to, below it if there is room and
     above it if there is not, and never running off the screen. */
  const placeFor = (el) => {
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(620, Math.max(320, vw - 32));
    const left = Math.max(16, Math.min(r.left - 12, vw - width - 16));
    const below = vh - r.bottom;
    if (below >= 260 || below >= r.top) {
      return { left, width, top: r.bottom + 6, maxHeight: Math.max(180, vh - r.bottom - 22) };
    }
    return { left, width, bottom: vh - r.top + 6, maxHeight: Math.max(180, r.top - 22) };
  };

  const show = useCallback(async (id, field, el, pinned) => {
    const key = `${id}:${field}`;
    clearTimeout(closeTimer.current);
    showing.current = key;
    setPeek({ key, id, field, pos: placeFor(el), pinned });
    if (cache.current.has(key)) { setText(cache.current.get(key)); return; }
    setText(null);
    try {
      const t = await api.callText(workloadId, id, field);
      cache.current.set(key, t);
      if (showing.current === key) setText(t);
    } catch (e) {
      if (showing.current === key) setText({ error: e.message });
    }
  }, [workloadId]);

  const enterCell = (id, field) => (e) => {
    if (peek?.pinned) return;
    const el = e.currentTarget;
    clearTimeout(openTimer.current); clearTimeout(closeTimer.current);
    openTimer.current = setTimeout(() => show(id, field, el, false), OPEN_AFTER_MS);
  };
  const leaveCell = () => {
    clearTimeout(openTimer.current);
    if (peek?.pinned) return;
    closeTimer.current = setTimeout(close, CLOSE_AFTER_MS);
  };
  const pressCell = (id, field) => (e) => {
    clearTimeout(openTimer.current);
    if (peek?.pinned && peek.key === `${id}:${field}`) { close(); return; }
    show(id, field, e.currentTarget, true);
  };

  // Escape closes it; a click elsewhere closes one that was pressed open
  useEffect(() => {
    if (!peek) return undefined;
    const key = (e) => { if (e.key === 'Escape') close(); };
    const away = (e) => {
      if (!peek.pinned) return;
      if (card.current?.contains(e.target) || e.target.closest?.('.cellmore')) return;
      close();
    };
    /* Scrolling closes a preview, because the card was placed against a cell that has now
       moved. It never closes one that was pressed open, and never reacts to scrolling
       inside the card: reading a long field is the whole point of it. */
    const scrolled = (e) => {
      if (peek.pinned || overCard.current) return;
      if (e.target instanceof Node && card.current?.contains(e.target)) return;
      close();
    };
    window.addEventListener('keydown', key);
    window.addEventListener('mousedown', away);
    window.addEventListener('scroll', scrolled, { passive: true, capture: true });
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('mousedown', away);
      window.removeEventListener('scroll', scrolled, { capture: true });
    };
  }, [peek, close]);

  useEffect(() => () => { clearTimeout(openTimer.current); clearTimeout(closeTimer.current); }, []);

  const rows = data?.rows || [];
  const from = data && data.total ? (data.page - 1) * data.per + 1 : 0;
  const to = data ? Math.min(data.total, data.page * data.per) : 0;
  const allCopies = rows.length > 0 && rows.every((c) => c.source === 'trace');
  const anyCopies = rows.some((c) => c.source === 'trace');

  /* A cell with more behind it is something you can open, and says so by being a control.
     A cell showing all it has is just text. */
  const cell = (c, field, body) => {
    const more = field === 'asked' ? c.askedMore : c.answeredMore;
    if (!more) return <span className="clamp">{body}</span>;
    const k = `${c.id}:${field}`;
    return (
      <span className={`clamp cellmore${peek?.key === k ? ' on' : ''}`}
        tabIndex={0} role="button" aria-label={`Read all of ${FIELD_LABEL[field].toLowerCase()}`}
        onMouseEnter={enterCell(c.id, field)} onMouseLeave={leaveCell}
        onClick={pressCell(c.id, field)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pressCell(c.id, field)(e); }
        }}>{body}</span>
    );
  };

  return (
    <section className="opt">
      <div className="opthead callshead">
        <h2>The calls in this workload</h2>
        <div className="callsearch">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
          </svg>
          <input type="search" value={typed} onChange={(e) => setTyped(e.target.value)}
            placeholder="Search what was asked or answered" aria-label="Search the calls" />
          {typed && (
            <button className="callclear" onClick={() => setTyped('')} aria-label="Clear the search">×</button>
          )}
        </div>
      </div>

      {err && <div className="errbox" style={{ margin: 16 }}>{err}</div>}

      {data && !rows.length ? (
        <div className="optempty">
          {data.q ? `No calls match “${data.q}”.` : 'Calls appear here as they arrive.'}
        </div>
      ) : (
        <div className={loading && data ? 'callgrid dim' : 'callgrid'}>
          <div className="clhrow">
            <span>When</span>
            <span>What it asked</span>
            <span>What it answered</span>
            <span>Model</span>
            <span style={{ textAlign: 'right' }}>Tokens</span>
            <span style={{ textAlign: 'right' }}>Took</span>
            <span style={{ textAlign: 'right' }}>Cost</span>
          </div>
          {rows.map((c) => (
            <div key={c.id} className="clrow">
              <div className="cwhen">{timeIST(c.at)}</div>
              <div className="casked">
                {cell(c, 'asked', c.asked
                  || <span className="cgone">{c.purged ? 'cleared after the retention window' : 'nothing kept'}</span>)}
                {c.source === 'trace' && !allCopies && <span className="ctag">copy</span>}
              </div>
              <div className="canswer">
                {c.status && c.status >= 400
                  ? <span className="ctag bad">did not get through</span>
                  : cell(c, 'answered', c.answered
                    || <span className="cgone">{c.purged ? 'cleared' : 'nothing kept'}</span>)}
              </div>
              <div className="cmodel m">{c.model ? String(c.model).split('/').pop() : '—'}</div>
              <div className="num m">{num(c.promptTokens)} / {num(c.completionTokens)}</div>
              <div className="num m">{c.latencyMs == null ? '—' : `${num(c.latencyMs)} ms`}</div>
              <div className="num m">{c.cost ? usd(c.cost) : '—'}</div>
            </div>
          ))}
        </div>
      )}

      {data && data.total > 0 && (
        <div className="callfoot">
          <span className="s">
            {`${num(from)} to ${num(to)} of ${num(data.total)}${data.q ? ` matching “${data.q}”` : ''}. Times are IST. `}
            {allCopies
              ? 'These are copies, so the cost is what your own provider charged.'
              : anyCopies
                ? 'Cost is what you paid us, or what your provider charged on a copy.'
                : 'Cost is what you paid us.'}
          </span>
          <span className="pager">
            <button className="ghost" disabled={data.page <= 1 || loading}
              onClick={() => { close(); setPage((p) => Math.max(1, p - 1)); }}>Previous</button>
            <span className="pagepos m">{data.page} / {data.pages}</span>
            <button className="ghost" disabled={data.page >= data.pages || loading}
              onClick={() => { close(); setPage((p) => p + 1); }}>Next</button>
          </span>
        </div>
      )}

      {peek && (
        <div ref={card} className={`fieldpop${peek.pinned ? ' pinned' : ''}`} style={peek.pos}
          role="dialog" aria-label={FIELD_LABEL[peek.field]}
          onMouseEnter={() => { overCard.current = true; clearTimeout(closeTimer.current); }}
          onMouseLeave={() => {
            overCard.current = false;
            if (!peek.pinned) closeTimer.current = setTimeout(close, CLOSE_AFTER_MS);
          }}>
          <div className="fieldhead">
            <span className="fieldname">{FIELD_LABEL[peek.field]}</span>
            {text && !text.error && text.at && <span className="fieldwhen m">{timeIST(text.at)} IST</span>}
            <button className="peekx" onClick={close} aria-label="Close">
              {peek.pinned ? 'Close' : 'Esc'}
            </button>
          </div>
          {!text ? (
            <div className="fieldwait">Opening…</div>
          ) : text.error ? (
            <div className="fieldwait">{text.error}</div>
          ) : text.purged || !text.text ? (
            <div className="fieldwait">
              {text.purged
                ? 'These words were cleared after your retention window. What the call cost, how long it took and which model answered are kept.'
                : 'Nothing was kept for this one.'}
            </div>
          ) : (
            <>
              <pre className="fieldtext">{text.text}</pre>
              {text.truncated && (
                <div className="fieldcut">This is the first 20,000 characters of it.</div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
