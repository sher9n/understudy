import React from 'react';
import { To } from './legal/Public.jsx';

/* An address that leads nowhere.
 *
 * It says so, names the address, and offers the two ways out somebody actually wants: the place
 * they would most likely have been going (their dashboard, or the home page before they have an
 * account), and back to wherever they came from. It used to show the home page instead, which
 * made a mistyped link look like a page that had been taken down, and gave a signed-in person
 * the marketing page with a "Sign in" button on it. */

export default function NotFound({ me, go, inApp = false }) {
  const path = window.location.pathname;
  const signedIn = !!me?.signedIn;
  // a page opened in a new tab has nothing to go back to, so it is not offered
  const canGoBack = window.history.length > 1;
  const home = signedIn ? (me.onboarded ? 'dash' : 'connect') : 'home';
  const homeLabel = signedIn ? (me.onboarded ? 'Go to your dashboard' : 'Finish connecting') : 'Go to the home page';

  const body = (
    <>
      <div className="eyeb doceyeb">Page not found</div>
      <h1>There is nothing at this address</h1>
      <p className="doclead">
        Nothing lives at <code className="lostpath">{path}</code>. The link may have a typing mistake in it,
        or the page may have moved.
      </p>
      <div className="lostacts">
        <To to={home} go={go} className="btn">{homeLabel}</To>
        {canGoBack && (
          <button type="button" className="btn sec" onClick={() => window.history.back()}>Go back</button>
        )}
      </div>
      {!inApp && (
        <p className="lostmore">
          Or try <To to="pricing" go={go}>pricing</To>, <To to="status" go={go}>status</To>, or{' '}
          <To to="contact" go={go}>contact us</To> if a link here sent you to this page.
        </p>
      )}
    </>
  );

  return inApp
    ? <div className="lostpage lostapp">{body}</div>
    : <main className="docpage lostpage" id="main"><div className="dochead">{body}</div></main>;
}
