/* One way to write money, used everywhere a dollar amount is shown.
 *
 * From a dollar up, two decimals, the way money is written: $2.30, $1,204.50. Below a dollar,
 * up to four significant figures, because a model call costs a fraction of a cent and two
 * decimals would print a real charge of $0.00207809 as "$0.00": that is $0.002078. Never more
 * than six decimals, where a figure stops meaning anything to anybody. Never fewer than two, so
 * a dime reads $0.10 and not $0.1. The minus sign goes before the dollar: -$2.30, never $-2.30.
 * Nothing is written as zero unless it is zero: an amount too small for six decimals says it is
 * under a millionth of a dollar.
 *
 * `down: true` is for money somebody holds, a balance: it is never shown as more than it is, so
 * $9.99792191 reads $9.99 and not $10.00, and a debt of $2.294 reads -$2.30. Everything else is
 * rounded to the nearest. */

const MOST = 6;
// a hair of tolerance, so 0.29 is not floored to 0.28 by 0.29 * 100 = 28.999999999999996
const EPS = 1e-7;

function round(a, dp, how) {
  const f = 10 ** dp;
  if (how === 'floor') return Math.floor(a * f + EPS) / f;
  if (how === 'ceil') return Math.ceil(a * f - EPS) / f;
  // 1.005 * 100 is 100.49999999999999 in floating point, which rounded to $1.00; a relative hair
  // of tolerance lets an amount that is exactly halfway round up, as it is written
  return Math.round(a * f * (1 + 1e-12)) / f;
}

/** Decimals for an amount under a dollar: enough for four significant figures, two to six. */
const placesFor = (a) => Math.min(MOST, Math.max(2, 3 - Math.floor(Math.log10(a))));

export function usd(value, { down = false } = {}) {
  const v = Number(value);
  if (!Number.isFinite(v) || v === 0) return '$0.00';
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  // rounding down a balance means toward less money: a smaller credit, a larger debt
  const how = !down ? 'near' : v > 0 ? 'floor' : 'ceil';
  let dp = a >= 1 ? 2 : placesFor(a);
  let r = round(a, dp, how);
  // 0.99999 rounds up to a whole dollar, and a whole dollar is written with two decimals
  if (r >= 1 && dp > 2) { dp = 2; r = round(a, 2, how); }
  if (r === 0) return `${sign}<$0.000001`;
  let s = r.toFixed(dp);
  // below a dollar the places are figures, and a trailing zero is not one
  if (dp > 2) s = s.replace(/0+$/, '');
  const [whole, frac = ''] = s.split('.');
  return `${sign}$${Number(whole).toLocaleString('en-US')}.${frac.padEnd(2, '0')}`;
}

/** Money somebody holds: a balance is never shown as more than it is. */
export const usdHeld = (value) => usd(value, { down: true });
