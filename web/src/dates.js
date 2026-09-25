/* Dates as India tells them, with the month in three letters: "25 Sep, 01:46". Written out here rather than left to
   the browser's British English, which says "Sept" in some browsers and "Sep" in others, so one page read two ways on
   two machines, and the workload page stopped matching its design. India keeps one offset all year, so adding it is
   exact. Every one answers '' for a moment that is not one. */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const inIndia = (ms) => new Date(Number(ms) + 5.5 * 3600000);
const two = (n) => String(n).padStart(2, '0');
const ok = (ms) => ms !== null && ms !== undefined && ms !== '' && Number.isFinite(Number(ms));
const dayMonth = (d) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
const clock = (d) => `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;

/** A day in IST: "25 Sep". */
export const dayIST = (ms) => (ok(ms) ? dayMonth(inIndia(ms)) : '');

/** A day in IST, with its year: "25 Sep 2026". */
export const dateIST = (ms) => (ok(ms) ? `${dayMonth(inIndia(ms))} ${inIndia(ms).getUTCFullYear()}` : '');

/** A day in IST in full: "Fri, 25 Sep 2026". */
export const weekdayIST = (ms) => {
  if (!ok(ms)) return '';
  const d = inIndia(ms);
  return `${WEEKDAYS[d.getUTCDay()]}, ${dayMonth(d)} ${d.getUTCFullYear()}`;
};

/* A moment, to the minute, in IST: "25 Sep, 01:46". The calls in a workload arrive minutes apart, so a date alone
   would print the same string down the whole table. */
export const timeIST = (ms) => (ok(ms) ? `${dayMonth(inIndia(ms))}, ${clock(inIndia(ms))}` : '');

/* A moment in full, with its year and its zone named, for a page that may be read long after: "23 Sep 2026, 14:05 IST". */
export const stampIST = (ms) => {
  if (!ok(ms)) return '';
  const d = inIndia(ms);
  return `${dayMonth(d)} ${d.getUTCFullYear()}, ${clock(d)} IST`;
};

/** A day counted in whole UTC days since 1970, the way a test counts its days, by its date: "24 Sep". */
export const dayOf = (day) => (ok(day) ? dayMonth(new Date(Number(day) * 86400000)) : '');
