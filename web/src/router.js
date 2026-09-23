/* Every screen has an address. The server serves index.html for anything outside /api and
   /v1, so these are real URLs: they can be typed, bookmarked, shared and reloaded, and the
   back button walks them. */

export const ROUTES = [
  { screen: 'home', path: '/', title: 'Understudy, cheaper models proven on your own calls' },
  { screen: 'signin', path: '/signin', title: 'Sign in' },
  { screen: 'signincode', path: '/signin/code', title: 'Sign in with a code' },
  { screen: 'signinlink', path: '/signin/link', title: 'Sign in with your link' },
  { screen: 'signup', path: '/signup', title: 'Create an account' },
  { screen: 'connect', path: '/connect', title: 'Connect' },
  { screen: 'dash', path: '/dashboard', title: 'Dashboard' },
  { screen: 'work', path: '/workloads', title: 'Workloads' },
  { screen: 'models', path: '/models', title: 'Models' },
  { screen: 'settings', path: '/settings', title: 'Settings' },
  // the pages anybody can read, signed in or not
  { screen: 'traffic', path: '/traffic', title: 'What happens to your traffic' },
  { screen: 'pricing', path: '/pricing', title: 'Pricing' },
  { screen: 'terms', path: '/terms', title: 'Terms of service' },
  { screen: 'privacy', path: '/privacy', title: 'Privacy' },
  { screen: 'dpa', path: '/dpa', title: 'Data processing terms' },
  { screen: 'subprocessors', path: '/subprocessors', title: 'Subprocessors' },
  { screen: 'security', path: '/security', title: 'Security' },
  { screen: 'contact', path: '/contact', title: 'Contact us' },
  { screen: 'status', path: '/status', title: 'Status' },
];

/* The pages that read the same to everybody. They need no account and never send anybody to
   sign in: a person checking what we keep, what it costs or whether the service is up should
   be able to do that before they have an account, and after they have left one. */
export const PUBLIC = new Set(['traffic', 'pricing', 'terms', 'privacy', 'dpa', 'subprocessors',
  'security', 'contact', 'status']);

/** What a URL means. A workload's own page carries its id. An address that means nothing is
    said to be nothing, rather than quietly shown as the home page: a mistyped link that lands
    on the marketing page reads as though the thing it pointed at had been taken away. */
export function parse(pathname = window.location.pathname) {
  const clean = pathname.replace(/\/+$/, '') || '/';
  const workload = clean.match(/^\/workloads\/([A-Za-z0-9_-]+)$/);
  if (workload) return { screen: 'work', openId: workload[1] };
  const hit = ROUTES.find((r) => r.path === clean);
  return hit ? { screen: hit.screen, openId: null } : { screen: 'notfound', openId: null };
}

/** The address for a place in the app, optionally with a place on that page. */
export function href(screen, openId = null, hash = '') {
  const tail = hash ? `#${hash}` : '';
  if (openId) return `/workloads/${openId}${tail}`;
  return `${ROUTES.find((r) => r.screen === screen)?.path ?? '/'}${tail}`;
}

export function go(screen, openId = null, { replace = false, hash = '', search = '' } = {}) {
  const to = `${href(screen, openId)}${search}${hash ? `#${hash}` : ''}`;
  if (to === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
  window.history[replace ? 'replaceState' : 'pushState']({ screen, openId }, '', to);
}

export function onPop(fn) {
  window.addEventListener('popstate', fn);
  return () => window.removeEventListener('popstate', fn);
}

/* Where to go after signing in, when the sign-in screen was reached from a page that needed
   it. Only an address on this site, written as a path: anything else (another host, a
   protocol-relative "//host", a backslash, a control character) is ignored, so a crafted link
   can never use the sign-in screen to send somebody somewhere else. */
export function safeNext(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null;
  if (/\p{Cc}/u.test(raw)) return null;
  let url;
  try { url = new URL(raw, window.location.origin); } catch { return null; }
  if (url.origin !== window.location.origin) return null;
  const where = parse(url.pathname);
  if (where.screen === 'signin' || where.screen === 'signup' || where.screen === 'signincode'
    || where.screen === 'notfound' || where.screen === 'home') return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The address somebody is on now, to come back to after signing in. */
export const here = () => `${window.location.pathname}${window.location.search}`;

/** The sign-in address that comes back to `path` afterwards. */
export const signInHref = (path) => `/signin?next=${encodeURIComponent(path)}`;

/* What the browser tab says. One name per screen, so a row of tabs, the history list and a
   bookmark each say which screen they are, rather than every one of them reading "Understudy".
   A workload's page is named after the workload once its name is known. */
export function titleFor(screen, name = null) {
  if (screen === 'notfound') return 'Page not found, Understudy';
  if (screen === 'workload') return `${name || 'Workload'}, Understudy`;
  const r = ROUTES.find((x) => x.screen === screen);
  if (!r) return 'Understudy';
  return screen === 'home' ? r.title : `${r.title}, Understudy`;
}
