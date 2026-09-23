import React from 'react';

/* A short notice at the top of a screen: what just happened, in a sentence, and a way to put it
   away. Used for what the app itself has to tell somebody, such as a payment that has just come
   back from Stripe or a session that has ended, never for an error inside one section. */
export default function Notice({ tone = '', children, onClose }) {
  return (
    <div className={`appnote${tone ? ` ${tone}` : ''}`} role="status">
      <div className="appnotebody">{children}</div>
      {onClose && (
        <button type="button" className="appnotex" onClick={onClose} aria-label="Dismiss this notice">×</button>
      )}
    </div>
  );
}
