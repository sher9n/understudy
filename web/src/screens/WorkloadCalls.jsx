import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, usd, num, timeIST } from '../api.js';

/* The calls a workload is made of: searchable, a page at a time, and each one readable in
   full without leaving the table.

   A workload is a claim that a group of requests are all the same job, and reading some of
   them is the only way to check it. Twenty-five at a time, because that is what fits on a
   screen and anything longer is a list nobody scrolls to the bottom of. The whole call opens
   in a card when the pointer rests on a row: resting is enough to read one, and pressing the
   row keeps it open for a long one, so reading never depends on holding a mouse still. */

const OPEN_AFTER_MS = 220;    // passing over a row on the way somewhere else opens nothing
const CLOSE_AFTER_MS = 160;   // long enough to move from the row into the card

const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (p?.type === 'text' || typeof p?.text === 'string'
      ? p.text : (p?.type ? `[${p.type.replace('_', ' ')}]` : ''))).join('\n');
  }
  return content == null ? '' : JSON.stringify(content, null, 2);
};

const pretty = (v) => {
  if (typeof v !== 'string') return JSON.stringify(v, null, 2);
  try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; }
};

export default function WorkloadCalls({ workloadId }) {
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  // the card
  const [peek, setPeek] = useState(null);          // { id, pos, pinned }
  const [full, setFull] = useState(null);          // the call being read, in full
  const cache = useRef(new Map());
  const openTimer = useRef(null);
  const closeTimer = useRef(null);
  const card = useRef(null);
  /* Which call the card is for right now. A fetch that comes back after the pointer has
     moved on to another row must not fill the new card with the old call. */
  const showing = useRef(null);
  /* Whether the pointer is on the card. Somebody whose pointer is on the card is reading it,
     so nothing that happens to the page underneath should take it away from them. */
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
    setPeek(null); setFull(null);
  }, []);

  /* Where the card goes: over the text columns of the table, below the row if it fits and
     above it if it does not, never running off the screen. */
  const placeFor = (el) => {
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.max(16, Math.min(r.left + 96, vw - 360));
    const width = Math.min(760, vw - left - 16);
    const below = vh - r.bottom;
    if (below >= 320 || below >= r.top) {
      return { left, width, top: r.bottom + 6, maxHeight: Math.max(220, vh - r.bottom - 22) };
    }
    return { left, width, bottom: vh - r.top + 6, maxHeight: Math.max(220, r.top - 22) };
  };

  const show = useCallback(async (id, el, pinned) => {
    clearTimeout(closeTimer.current);
    showing.current = id;
    setPeek({ id, pos: placeFor(el), pinned });
    if (cache.current.has(id)) { setFull(cache.current.get(id)); return; }
    setFull(null);
    try {
      const c = await api.workloadCall(workloadId, id);
      cache.current.set(id, c);
      if (showing.current === id) setFull(c);
    } catch (e) {
      if (showing.current === id) setFull({ id, error: e.message });
    }
  }, [workloadId]);

  const enterRow = (id) => (e) => {
    if (peek?.pinned) return;
    const el = e.currentTarget;
    clearTimeout(openTimer.current); clearTimeout(closeTimer.current);
    openTimer.current = setTimeout(() => show(id, el, false), OPEN_AFTER_MS);
  };
  const leaveRow = () => {
    clearTimeout(openTimer.current);
    if (peek?.pinned) return;
    closeTimer.current = setTimeout(close, CLOSE_AFTER_MS);
  };
  const pressRow = (id) => (e) => {
    clearTimeout(openTimer.current);
    if (peek?.pinned && peek.id === id) { close(); return; }
    show(id, e.currentTarget, true);
  };

  // Escape closes it; a click anywhere else closes a card that was pressed open
  useEffect(() => {
    if (!peek) return undefined;
    const key = (e) => { if (e.key === 'Escape') close(); };
    const away = (e) => {
      if (!peek.pinned) return;
      if (card.current?.contains(e.target) || e.target.closest?.('.clrow')) return;
      close();
    };
    /* Scrolling closes a preview, because the card was placed against a row that has now
       moved and the pointer is over a different one. It never closes a card somebody pressed
       open, and it NEVER reacts to scrolling inside the card itself: a listener that caught
       every scroll on the page closed the card the moment anyone scrolled a long request to
       read it, which is the one thing the card is for. */
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
            <div key={c.id} tabIndex={0} role="button"
              className={`clrow${peek?.id === c.id ? ' on' : ''}`}
              aria-label={`Read the call from ${timeIST(c.at)} in full`}
              onMouseEnter={enterRow(c.id)} onMouseLeave={leaveRow}
              onClick={pressRow(c.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pressRow(c.id)(e); }
              }}>
              <div className="cwhen">{timeIST(c.at)}</div>
              <div className="casked">
                <span className="clamp">
                  {c.asked || <span className="cgone">{c.purged ? 'cleared after the retention window' : 'nothing kept'}</span>}
                </span>
                {c.source === 'trace' && !allCopies && <span className="ctag">copy</span>}
              </div>
              <div className="canswer">
                <span className="clamp">
                  {c.status && c.status >= 400
                    ? <span className="ctag bad">did not get through</span>
                    : (c.answered || <span className="cgone">{c.purged ? 'cleared' : 'nothing kept'}</span>)}
                </span>
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
            {/* data.q, not q: the words describe the rows actually on screen. Using what is
                being typed said "420 matching" over the old results for the moment before
                the search came back. */}
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
        <div ref={card} className={`peek${peek.pinned ? ' pinned' : ''}`} style={peek.pos}
          role="dialog" aria-label="The full call"
          onMouseEnter={() => { overCard.current = true; clearTimeout(closeTimer.current); }}
          onMouseLeave={() => {
            overCard.current = false;
            if (!peek.pinned) closeTimer.current = setTimeout(close, CLOSE_AFTER_MS);
          }}>
          {!full ? <div className="peekwait">Opening the call…</div> : full.error ? (
            <div className="peekwait">{full.error}</div>
          ) : (
            <FullCall c={full} pinned={peek.pinned} onClose={close} />
          )}
        </div>
      )}
    </section>
  );
}

/* One call, whole. Every message in the order it was sent, with who sent it, then everything
   that came back. Long text is kept exactly as it was, line breaks and all, because the thing
   somebody is checking is usually a detail. */
function FullCall({ c, pinned, onClose }) {
  const req = c.request || {};
  const res = c.response || {};
  const msgs = Array.isArray(req.messages) ? req.messages : [];
  const tools = Array.isArray(req.tools) ? req.tools : [];
  const reply = res?.choices?.[0]?.message;
  const failed = c.status && c.status >= 400;

  return (
    <>
      <div className="peekhead">
        <div>
          <div className="peektitle">{timeIST(c.at)} IST · {c.model || 'no model named'}</div>
          <div className="peekmeta m">
            {num(c.promptTokens)} in · {num(c.completionTokens)} out
            {c.latencyMs != null ? ` · ${num(c.latencyMs)} ms` : ''}
            {c.cost ? ` · ${usd(c.cost)}` : ''}
            {c.source === 'trace' ? ' · a copy' : ''}
            {res?.streamed ? ' · streamed' : ''}
          </div>
        </div>
        <button className="peekx" onClick={onClose} aria-label="Close">{pinned ? 'Close' : 'Esc'}</button>
      </div>

      <div className="peekbody">
        {c.purged ? (
          <p className="peekgone">
            The words of this call were cleared after your retention window. What it cost, how
            long it took and which model answered are kept, so your charts do not change.
          </p>
        ) : (
          <>
            <div className="peeksec">Request</div>
            {msgs.length === 0 && <p className="peekgone">Nothing was kept of the request.</p>}
            {msgs.map((m, i) => (
              <div className="peekmsg" key={i}>
                <span className={`peekrole ${m.role}`}>{m.role}</span>
                <pre>{textOf(m.content) || (m.tool_calls ? pretty(m.tool_calls) : '')}</pre>
              </div>
            ))}
            {tools.length > 0 && (
              <div className="peekmsg">
                <span className="peekrole tool">tools offered</span>
                <pre>{tools.map((t) => t?.function?.name || t?.name).filter(Boolean).join(', ')}</pre>
              </div>
            )}
            {req.response_format && (
              <div className="peekmsg">
                <span className="peekrole tool">answer format</span>
                <pre>{pretty(req.response_format)}</pre>
              </div>
            )}

            <div className="peeksec">Response</div>
            {failed ? (
              <div className="peekmsg">
                <span className="peekrole bad">did not get through</span>
                <pre>{res?.error?.message || `The provider answered ${c.status}.`}</pre>
              </div>
            ) : !reply ? (
              <p className="peekgone">No answer was kept for this call.</p>
            ) : (
              <>
                <div className="peekmsg">
                  <span className="peekrole assistant">assistant</span>
                  <pre>{textOf(reply.content) || (reply.tool_calls ? '' : '(an empty answer)')}</pre>
                </div>
                {Array.isArray(reply.tool_calls) && reply.tool_calls.map((t, i) => (
                  <div className="peekmsg" key={`t${i}`}>
                    <span className="peekrole tool">called {t?.function?.name || 'a tool'}</span>
                    <pre>{pretty(t?.function?.arguments ?? '')}</pre>
                  </div>
                ))}
                {res?.choices?.[0]?.finish_reason && (
                  <div className="peekfoot m">Finished because: {res.choices[0].finish_reason}</div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}
