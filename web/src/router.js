/* Every screen has an address. The server serves index.html for anything outside /api and
   /v1, so these are real URLs: they can be typed, bookmarked, shared and reloaded, and the
   back button walks them. */

export const ROUTES = [
  { screen: 'home', path: '/' },
  { screen: 'signin', path: '/signin' },
  { screen: 'signup', path: '/signup' },
  { screen: 'connect', path: '/connect' },
  { screen: 'dash', path: '/dashboard' },
  { screen: 'work', path: '/workloads' },
  { screen: 'models', path: '/models' },
  { screen: 'settings', path: '/settings' },
];

/** What a URL means. A workload's own page carries its id. */
export function parse(pathname = window.location.pathname) {
  const clean = pathname.replace(/\/+$/, '') || '/';
  const workload = clean.match(/^\/workloads\/([A-Za-z0-9_-]+)$/);
  if (workload) return { screen: 'work', openId: workload[1] };
  const hit = ROUTES.find((r) => r.path === clean);
  return hit ? { screen: hit.screen, openId: null } : { screen: 'home', openId: null, unknown: clean };
}

/** The address for a place in the app. */
export function href(screen, openId = null) {
  if (openId) return `/workloads/${openId}`;
  return ROUTES.find((r) => r.screen === screen)?.path ?? '/';
}

export function go(screen, openId = null, { replace = false } = {}) {
  const to = href(screen, openId);
  if (to === window.location.pathname) return;
  window.history[replace ? 'replaceState' : 'pushState']({ screen, openId }, '', to);
}

export function onPop(fn) {
  window.addEventListener('popstate', fn);
  return () => window.removeEventListener('popstate', fn);
}
