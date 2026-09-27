import { createContext, useContext } from 'react';

/* Where a link to a screen leads. The site as it was before the pages built from the 27 Sep 2026 homepage artboard is
   kept at /legacy, to compare the two, and while somebody reads it its links to the homepage and the two guides lead to
   the old versions, so reading the old site never drops them into the new one half way. Everywhere else a link leads
   where it says. */
export const LinkMap = createContext(null);

/** The old homepage and guides, by the screen each stands in for. */
export const LEGACY_LINKS = { home: 'legacyhome', how: 'legacyhow', routing: 'legacyrouting' };

/** The screen a link to `to` leads to on the page being read. */
export function useLinkTo() {
  const map = useContext(LinkMap);
  return (to) => (map && map[to]) || to;
}
