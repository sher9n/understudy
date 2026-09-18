import React, { useEffect, useRef, useState } from 'react';

/* The window every figure on the screen is read over.
 *
 * It looked like a control before it was one: a chip that said "Last 30 days" and did
 * nothing when pressed, which is worse than no chip at all, because it tells somebody the
 * period is theirs to choose and then ignores them. */

export default function PeriodChip({ days, periods = [7, 30, 90], onPick, busy }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  return (
    <span className="periodwrap" ref={wrap}>
      <button className="chip" disabled={busy} aria-haspopup="true" aria-expanded={open}
        onClick={() => setOpen((v) => !v)}>
        Last {days} days
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor"
          strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
          style={{ marginLeft: 6, verticalAlign: '-1px' }}><path d="M4 6.5 L8 10.5 L12 6.5" /></svg>
      </button>
      {open && (
        <span className="periodpop">
          {periods.map((p) => (
            <button key={p} className={p === days ? 'periodopt on' : 'periodopt'}
              onClick={() => { setOpen(false); if (p !== days) onPick(p); }}>
              Last {p} days
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
