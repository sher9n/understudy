/* How two answers to the same call are compared, and what counts as the same.
   Every function here is pure, so the numbers on a certificate can be checked by hand. */

/** What the model actually produced, pulled out the same way for every model. */
export function extract(response, shapeKind) {
  const choice = response?.choices?.[0];
  if (!choice) return { ok: false, reason: 'no choice' };
  const msg = choice.message || {};
  if (choice.finish_reason === 'length') return { ok: false, reason: 'truncated' };
  if (shapeKind === 'tool_call') {
    const calls = msg.tool_calls || [];
    if (!calls.length) return { ok: false, reason: 'no tool call' };
    const parsed = [];
    for (const c of calls) {
      let args;
      try { args = JSON.parse(c.function?.arguments ?? '{}'); }
      catch { return { ok: false, reason: 'unparseable arguments' }; }
      parsed.push({ name: c.function?.name, args });
    }
    return { ok: true, value: parsed };
  }
  const text = typeof msg.content === 'string' ? msg.content : '';
  if (shapeKind === 'json' || shapeKind === 'enum') {
    const trimmed = text.trim().replace(/^```(?:json)?|```$/g, '').trim();
    if (!trimmed) return { ok: false, reason: 'empty' };
    try { return { ok: true, value: JSON.parse(trimmed) }; }
    catch { return { ok: false, reason: 'unparseable json' }; }
  }
  if (!text.trim()) return { ok: false, reason: 'empty' };
  return { ok: true, value: text };
}

/** Stable, order-insensitive for object keys, so formatting is never mistaken for a change. */
export function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

const leaves = (v, path = '', out = new Map()) => {
  if (v === null || typeof v !== 'object') { out.set(path || '$', v); return out; }
  if (Array.isArray(v)) { v.forEach((x, i) => leaves(x, `${path}[${i}]`, out)); return out; }
  for (const k of Object.keys(v)) leaves(v[k], path ? `${path}.${k}` : k, out);
  return out;
};

/* The same leaves, each with the keys and positions that lead to it (`segs`), so a field is found again by those and never
   by reading its place back: a field named "Doc. type" or "Price [EUR]" has a place that reads as two fields, or as a list. */
const leafEntries = (v, path = '', segs = [], out = new Map()) => {
  if (v === null || typeof v !== 'object') { out.set(path || '$', { segs, value: v }); return out; }
  if (Array.isArray(v)) { v.forEach((x, i) => leafEntries(x, `${path}[${i}]`, [...segs, i], out)); return out; }
  for (const k of Object.keys(v)) leafEntries(v[k], path ? `${path}.${k}` : k, [...segs, k], out);
  return out;
};
// a value found by its keys and positions (leafEntries), never by its place read back
export function valueAtSegs(value, segs) {
  let o = value;
  for (const k of segs) {
    if (o === null || typeof o !== 'object') return undefined;
    o = o[k];
  }
  return o;
}
// a place written the way leaves writes it, for a person or a judge to read
const placeOf = (segs) => segs.reduce((p, k) => (typeof k === 'number' ? `${p}[${k}]` : p ? `${p}.${k}` : k), '') || '$';

/* Structured answers, field by field, by what kind of field each one is.

   A field that DECIDES something (a label, an amount, a date, an id, a yes or no, which tool was
   called) has to match: an answer that gets one of those wrong is a wrong answer, whatever else it
   gets right. The old rule counted the share of fields that differed, so a reversed decision in an
   eight field answer counted as an eighth of a mistake, and a model that flipped the decision on
   nine calls in a hundred cleared a 3% bar and was switched to.

   A field that is WRITTEN (a "reason", a "summary", a sentence) is never the same string twice, even
   from the customer's own model, and counting its wording as a difference made the model look
   inconsistent with itself: that noise then loosened the bar for the fields that decide. Written
   fields are read for meaning by the judge instead, and only when every deciding field matches. */
const PROSE_CHARS = 40;
const PROSE_WORDS = 6;
export const isProse = (v) => typeof v === 'string' && v.trim().length >= PROSE_CHARS
  && v.trim().split(/\s+/).length >= PROSE_WORDS;

/** A number written as text, read the way people write it: 1,234.56, 1.234,56, 1234,5. */
export function asNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  let t = v.trim().replace(/^[$€£¥₹]\s*|\s*[$€£¥₹%]$/g, '');
  if (!/^-?\d[\d.,\s]*$/.test(t)) return null;
  t = t.replace(/\s/g, '');
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, '');
  else if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d+,\d+$/.test(t)) t = t.replace(',', '.');
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** The same value, written two ways: spacing, a number with separators, the case of a one-word label. */
export function sameValue(x, y) {
  if (x === y) return true;
  if (x === undefined || y === undefined || x === null || y === null) return false;
  const nx = asNumber(x);
  const ny = asNumber(y);
  if (nx !== null && ny !== null) return Math.abs(nx - ny) <= 1e-9 * Math.max(1, Math.abs(nx), Math.abs(ny));
  if (typeof x === 'boolean' || typeof y === 'boolean') return String(x).toLowerCase() === String(y).toLowerCase();
  if (typeof x === 'string' && typeof y === 'string') {
    const a = x.trim().replace(/\s+/g, ' ');
    const b = y.trim().replace(/\s+/g, ' ');
    if (a === b) return true;
    return /^[A-Za-z][A-Za-z _-]{0,40}$/.test(a) && a.toLowerCase() === b.toLowerCase();
  }
  return canonical(x) === canonical(y);
}

/** Two structured answers compared: whether any deciding field differs, and the written fields that do. */
export function structuredCompare(av, bv, shapeKind) {
  let x = av;
  let y = bv;
  if (shapeKind === 'tool_call') {
    const names = (calls) => (Array.isArray(calls) ? calls.map((c) => c?.name ?? '').join('|') : '');
    if (names(x) !== names(y)) return { decision: 1, fields: 1, differ: 1, prose: [] };
    x = (x || []).map((c) => c?.args);
    y = (y || []).map((c) => c?.args);
  }
  const la = leaves(x);
  const lb = leaves(y);
  const keys = new Set([...la.keys(), ...lb.keys()]);
  const prose = [];
  let differ = 0;
  let decided = 0;
  for (const k of keys) {
    const p = la.has(k) ? la.get(k) : undefined;
    const q = lb.has(k) ? lb.get(k) : undefined;
    if (isProse(p) && isProse(q)) {
      if (p.trim() !== q.trim()) prose.push({ path: k, a: p, b: q });
      continue;
    }
    decided += 1;
    if (!sameValue(p, q)) differ += 1;
  }
  return { decision: differ > 0 ? 1 : 0, fields: decided, differ, prose };
}

/** Which fields two structured answers differ in, by the rules structuredCompare counts with: the deciding fields
    whose values differ, and the written ones worded differently, which a judge reads for meaning rather than counts.
    What a person opening one request of a test is shown beside the two answers. */
export function differingFields(av, bv, shapeKind) {
  let x = av;
  let y = bv;
  if (shapeKind === 'tool_call') {
    const names = (calls) => (Array.isArray(calls) ? calls.map((c) => c?.name ?? '').join(', ') : '');
    if (names(x) !== names(y)) return { decide: ['the tool called'], written: [] };
    x = (x || []).map((c) => c?.args);
    y = (y || []).map((c) => c?.args);
  }
  if (shapeKind === 'enum' && (x === null || typeof x !== 'object') && (y === null || typeof y !== 'object')) {
    return { decide: sameValue(x, y) ? [] : ['the answer'], written: [] };
  }
  const la = leaves(x);
  const lb = leaves(y);
  const decide = [];
  const written = [];
  for (const k of new Set([...la.keys(), ...lb.keys()])) {
    const p = la.has(k) ? la.get(k) : undefined;
    const q = lb.has(k) ? lb.get(k) : undefined;
    if (isProse(p) && isProse(q)) { if (p.trim() !== q.trim()) written.push(k); continue; }
    if (!sameValue(p, q)) decide.push(k);
  }
  return { decide, written };
}

/** The written fields of a structured answer, as one text a judge can read. */
export function proseText(pairs, side) {
  return pairs.map((p) => `${p.path}: ${p[side]}`).join('\n');
}

/* Numbers, checked in code, because Jev's own guide says it is not reliable with them. When two
   answers state the same number of figures and the figures differ, the answers differ, whatever
   anybody's reading of the prose says: "The total is $1,234.50" against "$1,243.50". When the
   counts differ, the answers are simply written differently ("4 March" against "2026-03-04",
   "thirty days" against "30 days") and the reading decides. Thousands separators and decimal
   commas are read the way people write them. */
export function numbersOf(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(/\d+(?:[.,]\d+)*/g)) {
    let t = m[0];
    if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, '');
    else if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
    else if (/^\d+,\d{1,2}$/.test(t)) t = t.replace(',', '.');
    if (/^\d+(\.\d+)?$/.test(t)) t = String(Number(t));
    out.push(t);
  }
  return out.sort();
}

/* The same value written two ways reads as one figure (factFigures, figuresOf). numbersOf reads digits as they stand, so
   "10:00" gives 10 and 0 and "10am" gives 10, "1 234,56" gives 1 and 234.56, and "$2.5 million" gives 2.5. Here:
     - digit groups a space splits are one figure, as French, Nordic, Polish and SI writing group thousands ("1 234,56" is
       1234.56, "10 000" is 10000), with a plain, no-break, narrow no-break or thin space before exactly three digits;
     - a time is its hour on the 24-hour clock and its minutes, the minutes left out on the hour: "10:00", "10am" and
       "10 a.m." are 10, "2:30 pm" and "14:30" are 14 and 30, "14h30" is 14 and 30;
     - an amount with a scale word is its value: "$2.5 million" and "2,5 Mio." are 2500000, "$5k" is 5000, "€1.2bn" is
       1200000000, "3 lakh" is 300000 (in a fact, "m" and "b" alone only after a currency sign or as a capital, "3.2M",
       since "5m" is as often 5 minutes; an answer is read generously, "5m" giving both).
   A figure a fact gives can be given another way too (`or`, factNeeds): an hour on the other clock ("2pm" is 14, or 2 as
   "2 o'clock" and "from 10 to 2" give it) and a number grouped by spaces by all its parts ("912 345 678" is 912345678, or
   912, 345 and 678 as "912-345-678" gives them). */
const GAP_CHARS = /[    ]/g;
const SPACED = /(?<![\d.,])(\d{1,3})((?:[    ]\d{3})+)(?![\d])/g;
const MERIDIEM = '([ap])\\.?\\s?m\\.?(?![a-z])';
const CLOCK = new RegExp(`(?<![\\d.,:])(\\d{1,2})(?::(\\d{2})(?::\\d{2})?|h(\\d{2}))(?:\\s*${MERIDIEM})?(?![\\d:])`, 'gi');
const CLOCK_DOT = new RegExp(`(?<![\\d.,:])(\\d{1,2})\\.(\\d{2})\\s*${MERIDIEM}`, 'gi');
const HOUR = new RegExp(`(?<![\\d.,:])(\\d{1,2})\\s*${MERIDIEM}`, 'gi');
const SCALE_UNITS = { thousand: 1e3, thousands: 1e3, k: 1e3, million: 1e6, millions: 1e6, mn: 1e6, mio: 1e6, m: 1e6,
  billion: 1e9, billions: 1e9, bn: 1e9, b: 1e9, trillion: 1e12, trillions: 1e12, tn: 1e12, lakh: 1e5, lakhs: 1e5, crore: 1e7,
  crores: 1e7 };
// (any run of spaces between the number and its scale word: "$2.5  million" is still 2500000)
const SCALED = /(?<![\d.,])([$€£¥₹]\s*)?(\d+(?:[.,]\d+)*)\s*(thousands?|millions?|mn|mio|billions?|bn|trillions?|tn|lakhs?|crores?|k|m|b)\.?(?![a-z])/gi;
// one written figure as a number, read the way numbersOf reads it ("2,5" is 2.5, "1,500" is 1500)
const valueOf = (t) => Number(numbersOf(t)[0]);
// a product without the noise of binary fractions: 1.2 × 1e9 is 1200000000, not 1199999999.9999998
const exact = (x) => Number(x.toPrecision(12));
/* Digits of other scripts as the digits 0 to 9 ("٤٢" and "४२" are 42, a full-width "４２" too): the first of each script's ten,
   for the scripts whose digits run in order from it. */
const ZEROS = [0x660, 0x6F0, 0x7C0, 0x966, 0x9E6, 0xA66, 0xAE6, 0xB66, 0xBE6, 0xC66, 0xCE6, 0xD66, 0xDE6, 0xE50, 0xED0, 0xF20, 0x1040,
  0x1090, 0x17E0, 0x1810, 0x1946, 0x19D0, 0xFF10];
const asciiDigits = (s) => s.replace(/\p{Nd}/gu, (d) => {
  const cp = d.codePointAt(0);
  const z = cp <= 0x39 ? 0x30 : ZEROS.find((x) => cp >= x && cp <= x + 9);
  return z === undefined ? d : String(cp - z);
});
// a span written in digits: "2 weeks" is 14 days, "3 hours" 180 minutes (and in words, figuresOf)
const SPAN = /(\d+(?:[.,]\d+)?)[\s-]*(weeks?|fortnights?|hours?|hrs?)\b/gi;
const SPAN_OF = { week: 7, fortnight: 14, hour: 60, hr: 60 };

/* The text with each of those written as plain digits (`text`, what a fact must be given), the other ways the same values are
   written (`also`, what an answer may give instead: "15:00" is also 3, "2.5 million" also 2.5, "2 weeks" 14), and the other
   ways a fact's figure counts as given (`or`: [figure, [values all of which together give it]]). `generous` reads the way an
   answer is read: "5m" as 5 million too. */
const asFigure = (x) => String(Number(x));
function figureForms(input, { generous = false } = {}) {
  const also = [];
  const or = [];
  let t = asciiDigits(String(input ?? '')).replace(SPACED, (m, head, rest) => {
    const parts = numbersOf(m.replace(GAP_CHARS, ' '));
    const joined = head + rest.replace(GAP_CHARS, '');
    also.push(...parts);
    or.push([numbersOf(joined)[0], parts]);
    return joined;
  });
  for (const m of t.matchAll(SPAN)) {
    const n = valueOf(m[1]);
    const each = SPAN_OF[m[2].toLowerCase().replace(/s$/, '')];
    if (Number.isFinite(n) && each) also.push(exact(n * each));
  }
  const clock = (h, min, mer) => {
    const hour = Number(h);
    const minutes = min === undefined ? 0 : Number(min);
    if (hour > 24 || minutes > 59) return null;
    const half = String(mer || '').toLowerCase();
    const h24 = half === 'p' ? (hour % 12) + 12 : half === 'a' ? hour % 12 : hour;
    also.push(hour, h24, h24 % 12 || 12, minutes);
    // "3:00" with no am or pm may be the afternoon
    if (!half && hour >= 1 && hour <= 11) also.push(hour + 12);
    // the hour on the other clock gives it too, and the hour as written: "2pm" is given by "2 o'clock" and "from 10 to 2"
    for (const other of new Set([h24 % 12 || 12, hour])) if (other !== h24) or.push([asFigure(h24), [asFigure(other)]]);
    return ` ${h24}${minutes ? ` ${minutes}` : ''} `;
  };
  t = t.replace(CLOCK, (m, h, min, frMin, mer) => clock(h, min ?? frMin, mer) ?? m);
  t = t.replace(CLOCK_DOT, (m, h, min, mer) => clock(h, min, mer) ?? m);
  t = t.replace(HOUR, (m, h, mer) => clock(h, undefined, mer) ?? m);
  t = t.replace(SCALED, (m, sign, num, unit) => {
    const u = unit.toLowerCase();
    // "m" and "b" alone are a scale after a currency sign, or as a capital ("3.2M"), or in an answer read generously
    if ((u === 'm' || u === 'b') && !sign && !generous && unit !== unit.toUpperCase()) return m;
    const n = valueOf(num);
    if (!Number.isFinite(n)) return m;
    also.push(n);
    return `${sign || ''}${exact(n * SCALE_UNITS[u])}`;
  });
  return { text: t, also: also.filter((x) => Number.isFinite(Number(x))).map((x) => String(Number(x))), or };
}

/** The figures a fact must be given, each once: its digits (numbersOf), with spaced thousands, times and scaled amounts read
    as one value each (figureForms), and for each the other ways it counts as given (`or`: { figure: [[values]] }). A figure it
    spells out is left to the judge that reads it. */
export function factNeeds(text) {
  const forms = figureForms(text);
  const figures = [...new Set(numbersOf(forms.text))];
  const or = {};
  for (const [figure, values] of forms.or) {
    if (!figures.includes(figure) || !values.length) continue;
    const key = values.join(' ');
    or[figure] = or[figure] || [];
    if (!or[figure].some((v) => v.join(' ') === key)) or[figure].push(values);
  }
  return { figures, or };
}
export const factFigures = (text) => factNeeds(text).figures;

/** The figures of a fact (`figures`, and the other ways each counts as given, `or`, from factNeeds) not found among `found`
    (a Set from figuresOf). */
export function figuresMissing(fact, found) {
  const or = fact?.or && typeof fact.or === 'object' ? fact.or : {};
  return (fact?.figures || []).filter((x) => !found.has(x) && !(or[x] || []).some((vs) => vs.length && vs.every((v) => found.has(v))));
}

/* The figures a text gives however they are written: the digits numbersOf reads, the same values written as factFigures
   reads them and in the other ways they are written ("15:00" also gives 3), and a number written out: in English ("eight",
   "twenty-five", "two hundred and fifty", "three million", "a dozen", "once", "twice", "half", "a week" as 7 days, "half an
   hour" as 30 minutes), and, in a text that is not English, in French, German, Spanish, Italian, Portuguese or Dutch ("huit",
   "dix-sept", "einundzwanzig", "treinta y dos", "ventidue", "vinte e dois", "eenentwintig"); an ordinal ("third",
   "twenty-first") and an English month by its name ("2 September" gives 2 and 9). Read generously on purpose: it is used to
   see whether an answer gives every figure of a fact it has to keep (keepsCheck in src/eval/keeps.js), where a figure not
   found here is not kept, decided in code, and one found is read by Jev with the rest of the fact. The other languages' words
   are read only in a text that is not English, since in English they are words of their own ("due" is 2 in Italian): found
   there, a figure the answer never gives would let the fact through to Jev, who reads figures badly. Answers a Set of figures
   written as numbersOf writes them. */
const UNIT_WORDS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TEN_WORDS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const ORDINAL_WORDS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18,
  nineteenth: 19, twentieth: 20, thirtieth: 30 };
const MONTH_WORDS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10,
  november: 11, december: 12, jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const SCALE_WORDS = { thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12, lakh: 1e5, crore: 1e7 };
const TIMES_WORDS = { once: 1, twice: 2, thrice: 3 };
// the number words of French, German, Spanish, Italian, Portuguese and Dutch, read in a text that is not English
const FOREIGN_UNITS = {
  // French
  zéro: 0, un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, sept: 7, huit: 8, neuf: 9, dix: 10, onze: 11, douze: 12,
  treize: 13, quatorze: 14, quinze: 15, seize: 16,
  // German
  null: 0, ein: 1, eins: 1, eine: 1, zwei: 2, drei: 3, vier: 4, fünf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10, elf: 11,
  zwölf: 12, dreizehn: 13, vierzehn: 14, fünfzehn: 15, sechzehn: 16, siebzehn: 17, achtzehn: 18, neunzehn: 19,
  // Spanish
  cero: 0, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, doce: 12, trece: 13,
  catorce: 14, dieciséis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veintiuno: 21, veintiún: 21, veintidós: 22,
  veintitrés: 23, veinticuatro: 24, veinticinco: 25, veintiséis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29,
  // Italian
  due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6, sette: 7, otto: 8, nove: 9, dieci: 10, undici: 11, dodici: 12, tredici: 13,
  quattordici: 14, quindici: 15, sedici: 16, diciassette: 17, diciotto: 18, diciannove: 19, ventuno: 21, trentuno: 31,
  // Portuguese
  um: 1, uma: 1, dois: 2, duas: 2, três: 3, sete: 7, oito: 8, dez: 10, doze: 12, treze: 13, dezesseis: 16, dezasseis: 16,
  dezessete: 17, dezassete: 17, dezoito: 18, dezenove: 19, dezanove: 19,
  // Dutch
  nul: 0, een: 1, één: 1, twee: 2, drie: 3, vijf: 5, zes: 6, zeven: 7, negen: 9, tien: 10, twaalf: 12, dertien: 13, veertien: 14,
  vijftien: 15, zestien: 16, zeventien: 17, achttien: 18, negentien: 19,
};
const FOREIGN_TENS = {
  vingt: 20, vingts: 20, trente: 30, quarante: 40, cinquante: 50, soixante: 60, septante: 70, octante: 80, huitante: 80, nonante: 90,
  zwanzig: 20, dreißig: 30, dreissig: 30, vierzig: 40, fünfzig: 50, sechzig: 60, siebzig: 70, achtzig: 80, neunzig: 90,
  veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90,
  venti: 20, vent: 20, trenta: 30, quaranta: 40, cinquanta: 50, sessanta: 60, settanta: 70, ottanta: 80, novanta: 90,
  vinte: 20, trinta: 30, quarenta: 40, sessenta: 60, oitenta: 80,
  twintig: 20, dertig: 30, veertig: 40, vijftig: 50, zestig: 60, zeventig: 70, tachtig: 80, negentig: 90,
};
const FOREIGN_HUNDREDS = { cent: 100, cents: 100, hundert: 100, cien: 100, ciento: 100, cento: 100, cem: 100, honderd: 100 };
const FOREIGN_SCALES = { mille: 1e3, tausend: 1e3, mil: 1e3, mila: 1e3, duizend: 1e3, million: 1e6, millions: 1e6, millionen: 1e6,
  millón: 1e6, millones: 1e6, milione: 1e6, milioni: 1e6, milhão: 1e6, milhões: 1e6, miljoen: 1e6, milliard: 1e9, milliards: 1e9,
  milliarde: 1e9, milliarden: 1e9, miljard: 1e9 };
// "and" between the parts of a number, in each language ("vingt et un", "treinta y dos", "vinte e dois")
const JOINERS = new Set(['and', 'et', 'und', 'y', 'e', 'en']);
// the parts a compound written as one word is made of ("einundzwanzig", "dreihundert", "eenentwintig", "ventidue")
const PIECES = [...new Set([...Object.keys(FOREIGN_UNITS), ...Object.keys(FOREIGN_TENS), ...Object.keys(FOREIGN_HUNDREDS),
  ...Object.keys(FOREIGN_SCALES), 'und', 'en'])].sort((a, b) => b.length - a.length);
function piecesOf(word) {
  const out = [];
  let rest = word;
  while (rest) {
    const p = PIECES.find((x) => rest.startsWith(x));
    if (!p) return null;
    out.push(p);
    rest = rest.slice(p.length);
  }
  return out.length > 1 ? out : null;
}
/* Whether a text is written in English rather than in one of the other languages read here: more of the words that English
   cannot do without than of theirs, or with as few of either, no letter English does not use. */
const ENGLISH_WORDS = new Set(['the', 'and', 'of', 'to', 'is', 'a', 'in', 'that', 'it', 'for', 'you', 'with', 'on', 'are', 'this',
  'be', 'as', 'your', 'we', 'can', 'will', 'have', 'or', 'not', 'our', 'an', 'at', 'by', 'from', 'was', 'i', 'he', 'she', 'they']);
// (never one English uses too: "a", "is", "per", "no", "as")
const OTHER_WORDS = new Set([
  'le', 'la', 'les', 'des', 'du', 'de', 'et', 'est', 'une', 'un', 'pour', 'avec', 'sur', 'dans', 'qui', 'que', 'à', 'au', 'aux',
  'ne', 'pas', 'sont', 'il', 'elle', 'nous', 'vous',
  'der', 'die', 'das', 'und', 'ist', 'nicht', 'mit', 'für', 'auf', 'den', 'dem', 'des', 'ein', 'eine', 'zu', 'im', 'von', 'es',
  'sie', 'wir', 'sind', 'wird', 'wurde',
  'el', 'los', 'las', 'y', 'en', 'con', 'por', 'para', 'del', 'al', 'lo', 'se', 'más', 'como', 'son', 'una', 'muy',
  'di', 'che', 'è', 'della', 'dei', 'gli', 'alla', 'nel', 'nella', 'sono', 'si', 'ci', 'ma', 'più', 'non',
  'o', 'os', 'do', 'da', 'dos', 'das', 'em', 'no', 'na', 'não', 'com', 'um', 'uma', 'e', 'é', 'são',
  'het', 'een', 'van', 'op', 'niet', 'voor', 'met', 'zijn', 'dat', 'te', 'er', 'naar', 'ook', 'wordt', 'werd',
].filter((w) => !['a', 'is', 'per', 'no', 'as'].includes(w)));
function inEnglish(words) {
  const en = words.filter((w) => ENGLISH_WORDS.has(w)).length;
  const other = words.filter((w) => OTHER_WORDS.has(w)).length;
  if (en !== other) return en > other;
  return !words.some((w) => /[^a-z]/.test(w));
}
const wordOf = (table, w) => (w !== undefined && Object.hasOwn(table, w) ? table[w] : null);
// a whole number of these is a figure too: "a week" is 7 days, "two hours" 120 minutes
const UNIT_SPANS = { week: 7, weeks: 7, fortnight: 14, fortnights: 14, hour: 60, hours: 60 };

export function figuresOf(text) {
  const out = new Set(numbersOf(text));
  const forms = figureForms(text, { generous: true });
  for (const x of numbersOf(forms.text)) out.add(x);
  for (const x of forms.also) out.add(x);
  const raw = (String(text ?? '').toLowerCase().match(/\p{L}+/gu) || []);
  const foreign = !inEnglish(raw);
  const words = foreign ? raw.flatMap((w) => piecesOf(w) || [w]) : raw;
  const unitOf = (w) => wordOf(UNIT_WORDS, w) ?? (foreign ? wordOf(FOREIGN_UNITS, w) : null);
  const tensOf = (w) => wordOf(TEN_WORDS, w) ?? (foreign ? wordOf(FOREIGN_TENS, w) : null);
  const hundredOf = (w) => (w === 'hundred' ? 100 : foreign ? wordOf(FOREIGN_HUNDREDS, w) : null);
  const scaleOf = (w) => wordOf(SCALE_WORDS, w) ?? (foreign ? wordOf(FOREIGN_SCALES, w) : null);
  const numberWord = (w) => w !== undefined && (unitOf(w) !== null || tensOf(w) !== null || wordOf(ORDINAL_WORDS, w) !== null
    || hundredOf(w) !== null || w === 'dozen' || scaleOf(w) !== null);
  /* A number written out, word by word: "two hundred and fifty" is 250, "two thousand five hundred" 2500, "one hundred and
     first" 101, "quatre-vingt-dix" 90. Each word's own value is kept as well, so a reading that joins two numbers it should not
     still finds both. */
  let total = 0;
  let current = 0;
  let open = false;
  let last = null;
  // the number just written out, or 1 for "a" or "an" before a unit ("a week"), so a unit after it is read as its span
  let before = null;
  const close = () => {
    const v = open ? exact(total + current) : null;
    if (open) out.add(String(v));
    total = 0; current = 0; open = false; last = null;
    return v;
  };
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    const month = wordOf(MONTH_WORDS, w);
    if (month !== null) out.add(String(month));
    const times = wordOf(TIMES_WORDS, w);
    if (times !== null) out.add(String(times));
    if (w === 'half') { out.add('0.5'); out.add('50'); }
    const unit = unitOf(w);
    const tens = tensOf(w);
    const ordinal = wordOf(ORDINAL_WORDS, w);
    const hundred = hundredOf(w);
    const scale = scaleOf(w);
    if (unit !== null || tens !== null || ordinal !== null) {
      const v = unit ?? tens ?? ordinal;
      out.add(String(v));
      /* "twenty five", "twenty-first", "two hundred fifty", "dix-sept" (10 and 7), "soixante-dix" (60 and 10) and
         "quatre-vingts" (4 times 20) join; "one two", "five twenty" and "twenty thirty" are separate */
      let joins = false;
      if (!open || last === 'hundred' || last === 'scale' || last === 'and') joins = true;
      else if (last === 'tens') joins = (tens === null && v > 0 && v < 10) || (foreign && unit !== null && v >= 10 && v < 20 && (current % 100 === 60 || current % 100 === 80));
      else if (last === 'unit' && foreign && current % 100 === 10 && unit !== null && v >= 7 && v <= 9) joins = true;
      if (last === 'unit' && foreign && current % 100 === 4 && (w === 'vingt' || w === 'vingts')) {
        current = current - 4 + 80;
        last = 'tens';
        continue;
      }
      if (!joins) before = close();
      current += v;
      open = true;
      last = tens !== null ? 'tens' : 'unit';
      // an ordinal ends the number: "twenty-first", "one hundred and first"
      if (ordinal !== null) before = close();
      continue;
    }
    if (hundred !== null) {
      out.add('100');
      current = (current || 1) * 100;
      open = true; last = 'hundred';
      continue;
    }
    if (scale !== null) {
      out.add(String(scale));
      total += (current || 1) * scale;
      current = 0;
      open = true; last = 'scale';
      continue;
    }
    if (w === 'dozen') {
      out.add('12');
      current = (current || 1) * 12;
      open = true; last = 'scale';
      continue;
    }
    if (JOINERS.has(w) && open && numberWord(words[i + 1])) { last = 'and'; continue; }
    // "a hundred", "a million", "a dozen"
    if ((w === 'a' || w === 'an') && (hundredOf(words[i + 1]) !== null || words[i + 1] === 'dozen' || scaleOf(words[i + 1]) !== null)) {
      close();
      current = 1; open = true; last = 'unit';
      continue;
    }
    const closed = close();
    if (closed !== null) before = closed;
    // a span: "a week" is 7, "two weeks" 14, "half an hour" 30, "a quarter of an hour" 15, "an hour" 60 (minutes)
    const span = wordOf(UNIT_SPANS, w);
    if (span !== null) {
      // (an article one word further back too: "a free week-long trial")
      const article = (w2) => ['a', 'an', 'one', 'per', 'each', 'every'].includes(w2);
      const q = words[i - 1] === 'half' || words[i - 2] === 'half' ? 0.5 : words[i - 1] === 'quarter' || words[i - 3] === 'quarter' ? 0.25
        : before !== null ? before : article(words[i - 1]) || article(words[i - 2]) ? 1 : null;
      if (q !== null) out.add(String(exact(q * span)));
    }
    before = (w === 'a' || w === 'an') ? 1 : null;
  }
  close();
  return out;
}

/* Two answers carry different figures when they state the same count of them with different values,
   or, when the counts differ, when an amount (a figure with a decimal part or a thousands separator)
   in one is missing from the other: "Total 1,234.50" against "Total 1,243.50 (incl. 12% VAT)" is a
   different answer. Plain small figures with different counts are left to the reading, because "4
   March 2026" against "2026-03-04" carries the month as a figure on one side only. Figures on one
   side alone say nothing, since the other may write them in words. */
const AMOUNT = /^\d{1,3}([.,]\d{3})+([.,]\d+)?$|^\d+[.,]\d+$/;
export function numbersDiffer(a, b) {
  const x = numbersOf(a);
  const y = numbersOf(b);
  if (!x.length || !y.length) return false;
  if (x.length === y.length) return x.join(',') !== y.join(',');
  const amounts = (text) => [...String(text ?? '').matchAll(/\d+(?:[.,]\d+)*/g)].map((m) => m[0]).filter((t) => AMOUNT.test(t));
  const ax = numbersOf(amounts(a).join(' '));
  const ay = numbersOf(amounts(b).join(' '));
  if (!ax.length && !ay.length) return false;
  const count = (xs) => { const m = new Map(); for (const v of xs) m.set(v, (m.get(v) || 0) + 1); return m; };
  const cx = count(ax);
  const cy = count(ay);
  for (const [v, n] of cx) if ((cy.get(v) || 0) !== n) return true;
  for (const [v, n] of cy) if ((cx.get(v) || 0) !== n) return true;
  return false;
}

/* A structured answer held to "at least as good" (its customer's model disagreed with itself too often for "the same
   answer" to be a bar) is still held to the fields that model gives the same way both times: an amount, a date, an id, a
   label, a yes or no, which tool was called. One that changes any of them is worse whatever a judge reads of it, since a
   judge can see that two answers differ, not which one is right: the rule a written answer's figures are held to
   (qualityAgainst in src/eval/run.js), for a structured answer's fields. Such an answer used to reach the judge as its
   JSON, and a model that changed an invoice's total could be read as at least as good (26 Sep 2026). A field the
   customer's model itself gave two ways is left to the judge, as before. Fields are compared as "the same answer"
   compares them (sameValue): numbers by value, one-word labels whatever their case. A written field (isProse) is held
   to its figures only, where both of the customer's answers state the same ones (numbersDiffer).

   Answers the first held field `answer` changed, as { path, want, got }, or null when it changed none. With only one
   answer from the customer's model (`refB` missing), nothing is known to be held, and it answers null. `figuresOnly`
   holds numbers alone, for a reading that has one answer to hold it to and reads it strictly (a background answer,
   agreementOf in src/learn/explore.js), as a written answer's figures are read there: every field of a varied workload
   read that strictly would count almost every answer short.

   `only`, the paths the customer's model gives the same way on nearly every call (stablePaths), holds those alone. Two of
   its answers to one call can agree on a field it picks afresh each time purely by chance, a third of the time for a
   choice of three, and a candidate held to that was failed for picking differently, as the customer's model itself does
   (caught in test on 26 Sep 2026 before it shipped). A measurement always passes it; without it (a reading with no
   measurement's paths to go on), every field the two answers share is held. */
export function heldFieldChanged(answer, refA, refB, shapeKind, { figuresOnly = false, only = null } = {}) {
  if (refA === undefined || refA === null || refB === undefined || refB === null) return null;
  const holds = (path) => !only || only.has(path);
  let x = answer;
  let a = refA;
  let b = refB;
  if (shapeKind === 'tool_call') {
    const names = (calls) => (Array.isArray(calls) ? calls.map((c) => c?.name ?? '').join(', ') : '');
    // the customer's model called other tools each time: none of the arguments is held, since none lines up
    if (names(a) !== names(b)) return null;
    if (names(x) !== names(a)) {
      return holds(TOOL_PATH) ? { path: TOOL_PATH, want: names(a), got: names(x) } : null;
    }
    x = (Array.isArray(x) ? x : []).map((c) => c?.args);
    a = a.map((c) => c?.args);
    b = b.map((c) => c?.args);
  }
  const named = (path) => (path === '$' ? 'the answer' : path);
  const lx = leaves(x);
  const la = leaves(a);
  const lb = leaves(b);
  for (const [path, va] of la) {
    if (!lb.has(path) || !holds(path)) continue;
    const vb = lb.get(path);
    const vx = lx.has(path) ? lx.get(path) : undefined;
    if (isProse(va) && isProse(vb)) {
      if (typeof vx === 'string' && numbersOf(va).length && !numbersDiffer(va, vb) && numbersDiffer(vx, va)) {
        return { path: named(path), want: numbersOf(va).join(', '), got: numbersOf(vx).join(', ') };
      }
      continue;
    }
    if (figuresOnly && (asNumber(va) === null || asNumber(vb) === null)) continue;
    if (!sameValue(va, vb)) continue;
    if (!sameValue(vx, va)) return { path: named(path), want: va, got: vx ?? null };
  }
  return null;
}

// what heldFieldChanged and stablePaths call which tool a tool-calling answer called
export const TOOL_PATH = 'the tool called';

/* Choices. A field of a structured answer that picks one of a known set: a label or a category, a level on a scale, a yes
   or a no, which tool to call. Two answers can pick differently and both be right, as the customer's own model shows when
   it gives a different priority to the same ticket on its second answer, so a choice that differs is never a mistake on
   its own: a judge reads the request and both answers and says whether one is clearly worse (judgeStructured in
   src/eval/judge.js). A figure, a date, a code or a name is not a choice: one the customer's model states the same way
   both times stays held exactly (heldFieldChanged). Held exactly, a choice made a test nothing could pass: on 5 Oct 2026 a
   ticket-priority workload's own model gave another priority on 3 of 120 tickets, its bar came out at 3.1%, and that
   model's own second answers, tested as if they were a cheaper model's, could not clear it (upper reading 6.1%).

   Which fields are choices is read, never guessed from their names: what the requests declare (a list of allowed values,
   a true or false field, a whole number on a short scale, the tools to choose from and their arguments' allowed values),
   and, where nothing is declared, a yes or no field, or a short field whose values the workload's own instruction lists
   ("classify it as low, medium, high or urgent"). A short field whose values the instruction does not list is read as a
   fact: a currency or a country copied from the request is not a choice the model makes. */

// a field's place in an answer, at whatever position of a list: items[3].category is items[].category
export const normPath = (path) => String(path).replace(/\[\d+\]/g, '[]');
// a whole number on a scale this short is a level to pick (1 to 5, 0 to 10), not a quantity
const SCALE_MAX = 10;
// how deep a schema is read, and how much of it: deep enough for a model three definitions down, never without end
const SCHEMA_DEPTH = 40;
const SCHEMA_NODES = 4000;

/* A schema's own definitions, which a field points to rather than repeats ("$ref": "#/$defs/Priority"), as schemas made from
   code usually do: read where they point, within the same schema. Null for one that points anywhere else. */
function pointedTo(s, root) {
  const ref = s?.$ref;
  if (!root || typeof root !== 'object' || typeof ref !== 'string') return null;
  // the whole schema, as a tree of nodes points back to its top ("$ref": "#")
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) return null;
  let at = root;
  for (const part of ref.slice(2).split('/')) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!at || typeof at !== 'object' || !(key in at)) return null;
    at = at[key];
  }
  return at && typeof at === 'object' ? at : null;
}

/* A schema's parts, nearest the top first: the schema itself, then what it points to, combines (allOf, anyOf, oneOf, unless
   that is a set of consts, which is one choice: `isList`), its fields and its list's items, each with its place in an answer
   (`path`). A definition is followed where it is pointed to, and into itself again on the same path only REPEATS_MAX times:
   a node that holds a list of nodes declares its choices on its children and grandchildren too (children[].kind), never
   without end. Read no deeper than SCHEMA_DEPTH. `see` reads each part and answers true to stop. Breadth first, and no more
   than SCHEMA_NODES parts: a schema of many definitions that all point to each other has more paths than anything could
   read (fourteen give billions), and depth first, the budget ran out deep inside the first of them, so a choice declared
   beside it at the top went unread. */
const REPEATS_MAX = 3;
function eachSchemaPart(schema, prefix, see, { isList = () => false } = {}) {
  if (!schema || typeof schema !== 'object') return;
  const queue = [{ s: schema, path: prefix, refs: [], depth: 0 }];
  let budget = SCHEMA_NODES;
  for (let k = 0; k < queue.length && budget > 0; k += 1) {
    const { s, path, refs, depth } = queue[k];
    queue[k] = null;
    if (!s || typeof s !== 'object' || depth > SCHEMA_DEPTH) continue;
    budget -= 1;
    if (see(s, path)) return;
    // what is left to read is never more than the budget could read
    const next = (x, p, r = refs) => { if (queue.length - k <= budget) queue.push({ s: x, path: p, refs: r, depth: depth + 1 }); };
    if (typeof s.$ref === 'string' && refs.filter((r) => r === s.$ref).length < REPEATS_MAX) {
      const there = pointedTo(s, schema);
      if (there) next(there, path, [...refs, s.$ref]);
    }
    if (Array.isArray(s.allOf)) for (const x of s.allOf) next(x, path);
    for (const key of ['anyOf', 'oneOf']) {
      if (Array.isArray(s[key]) && s[key].length && !isList(s[key])) for (const x of s[key]) next(x, path);
    }
    if (s.properties && typeof s.properties === 'object') {
      for (const [name, v] of Object.entries(s.properties)) next(v, path ? `${path}.${name}` : name);
    }
    if (s.items && typeof s.items === 'object' && !Array.isArray(s.items)) next(s.items, `${path}[]`);
  }
}

// a set of consts, each one allowed value, with or without a null beside them (as TypeBox and Zod write an optional one): one
// choice, read as its list of values
const isNullPart = (x) => !!x && typeof x === 'object' && (x.type === 'null' || x.const === null) && !('enum' in x);
const isConstList = (xs) => xs.some((x) => x && typeof x === 'object' && 'const' in x && x.const !== null)
  && xs.every((x) => isNullPart(x) || (x && typeof x === 'object' && 'const' in x));

/* Every choice a schema declares, by place, with the values it allows where it lists them: an enum or a set of consts in the
   order given, and a whole number on a short scale as every value on it. */
function walkSchema(schema, prefix) {
  const out = new Map();
  eachSchemaPart(schema, prefix, (s, path) => {
    const at = normPath(path || '$');
    const types = Array.isArray(s.type) ? s.type : [s.type];
    const lo = Number(s.minimum);
    const hi = Number(s.maximum);
    if (Array.isArray(s.enum) && s.enum.length) {
      if (!out.get(at)) out.set(at, s.enum.filter((x) => x !== null));
    } else if (types.includes('boolean')) {
      if (!out.has(at)) out.set(at, null);
    } else if (types.includes('integer') && Number.isFinite(lo) && Number.isFinite(hi) && hi >= lo && hi - lo <= SCALE_MAX) {
      if (!out.get(at)) out.set(at, Array.from({ length: hi - lo + 1 }, (_, k) => lo + k));
    }
    for (const key of ['anyOf', 'oneOf']) {
      if (Array.isArray(s[key]) && s[key].length && isConstList(s[key]) && !out.get(at)) {
        out.set(at, s[key].filter((x) => !isNullPart(x)).map((x) => x.const));
      }
    }
    return false;
  }, { isList: isConstList });
  return out;
}

// the schemas a request gives its answer: its response_format's, or each tool's parameters (read as a list of calls' arguments)
function schemasOf(body, shapeKind) {
  if (!body || typeof body !== 'object' || shapeKind === 'free_text') return [];
  if (shapeKind === 'tool_call') {
    return (Array.isArray(body.tools) ? body.tools : []).map((t) => t?.function?.parameters ?? t?.parameters).filter(Boolean)
      .map((params) => [params, '[]']);
  }
  const rf = body.response_format;
  const schema = rf?.json_schema?.schema ?? rf?.schema;
  return schema ? [[schema, '']] : [];
}

/* Which tool to call is a choice only where there is one to make: two tools or more, and a request that does not name the one
   it wants (tool_choice). A single tool, or one the request forces, is called every time, by every model. */
const toolIsChosen = (body) => {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const choice = body?.tool_choice;
  const forced = choice && typeof choice === 'object' && (choice.function?.name || choice.name);
  return tools.length >= 2 && !forced;
};

/** The choices one request declares for its answer, by their places (normPath): which tool to call, where there is a choice
    of them, and its arguments' allowed values for a tool call, the schema's allowed values otherwise, and the whole answer of
    a workload of one label. */
export function declaredChoices(body, shapeKind) {
  const out = new Set();
  if (!body || typeof body !== 'object' || shapeKind === 'free_text') return out;
  if (shapeKind === 'tool_call' && toolIsChosen(body)) out.add(TOOL_PATH);
  for (const [schema, prefix] of schemasOf(body, shapeKind)) for (const p of walkSchema(schema, prefix).keys()) out.add(p);
  // a workload of one label: the label, or the answer itself where a model gave the label bare
  if (shapeKind === 'enum') out.add('$');
  return out;
}

/** The values a request allows for each choice it lists them for (an enum, a set of consts, every whole number on a short
    scale), by place (normPath), in the order given. */
export function declaredOptions(body, shapeKind) {
  const out = new Map();
  for (const [schema, prefix] of schemasOf(body, shapeKind)) {
    for (const [p, list] of walkSchema(schema, prefix)) if (Array.isArray(list) && list.length && !out.has(p)) out.set(p, list);
  }
  return out;
}

/** Whether a request's answer has written fields: text with no list of allowed values (a reason, a summary, a note), which
    two answers word differently, and which a judge then reads (judgeStructured). What the quote counts the readings of. */
export function hasWrittenFields(body, shapeKind) {
  let found = false;
  const written = (s) => {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    found = types.includes('string') && !Array.isArray(s.enum) && !('const' in s) && !s.format;
    return found;
  };
  for (const [schema, prefix] of schemasOf(body, shapeKind)) {
    eachSchemaPart(schema, prefix, written);
    if (found) return true;
  }
  return false;
}

/* Where the allowed values of a choice are a scale, each value's place on it, so the far end of it can be planted as clearly
   worse (plantedStructured in src/eval/run.js): numbers, numbers written as text or with a letter before them (P1, sev2), and
   the words that name levels (low, medium, high, urgent). Null for any other list, such as departments, where no value is
   further from another than any other is, and so none is clearly worse than another. */
const LEVEL_WORDS = { lowest: 0, none: 0, 'very low': 1, low: 2, minor: 2, normal: 3, medium: 3, moderate: 3, high: 4, major: 4,
  'very high': 5, urgent: 6, critical: 6, severe: 6, emergency: 7, highest: 7, blocker: 7 };
export function scaleOf(list) {
  if (!Array.isArray(list) || list.length < 3) return null;
  const numeric = list.map((x) => (typeof x === 'number' ? x
    : typeof x === 'string' && /^\s*(?:p|sev|s|level|tier)?\s*-?\d+(?:\.\d+)?\s*$/i.test(x) ? Number(x.replace(/[^\d.-]/g, '')) : NaN));
  if (numeric.every(Number.isFinite)) return numeric;
  const words = list.map((x) => (typeof x === 'string' ? LEVEL_WORDS[x.trim().toLowerCase().replace(/[_-]+/g, ' ')] : undefined));
  return words.every((x) => x !== undefined) ? words : null;
}

/** The leaves of a structured answer, by place, as heldFieldChanged and stablePaths read them (a tool call's arguments as a
    list of them, one for each call made). */
export function answerLeaves(value, shapeKind) {
  const v = shapeKind === 'tool_call' ? (Array.isArray(value) ? value : []).map((c) => c?.args) : value;
  return leaves(v);
}

/** The leaves of a structured answer as answerLeaves names them, each with the keys and positions that lead to it (`segs`,
    for valueAtSegs and a copy with one field changed), never read back from its place. */
export function answerLeafEntries(value, shapeKind) {
  const v = shapeKind === 'tool_call' ? (Array.isArray(value) ? value : []).map((c) => c?.args) : value;
  return leafEntries(v);
}

/* Where a structured answer is too long for a judge to read whole (Jev reads 2,500 characters of each, the language model
   4,000), the parts of the two answers that differ, each under its place: a field that differs on its own, or the line of a
   list it sits on, whole, where that line is short (ITEM_CHARS) and so says what the field is about (a category beside its
   product code). The fields that decide something come first and the written ones after, so a judge reads every deciding
   difference before any wording: `decide` and `written`, each a pair of the answer's part and the reference's. A difference
   on the thirtieth line of an invoice, or a priority after a 4,500-character description in the same call, was otherwise
   past what either judge read, both read the same text, and the answer was forgiven. Null where both are short enough to
   read whole. */
export const FOCUS_CHARS = 1800;
const ITEM_CHARS = 600;
export function focusParts(a, b, shapeKind) {
  const text = (v) => JSON.stringify(v, null, 2) ?? '';
  if (text(a).length <= FOCUS_CHARS && text(b).length <= FOCUS_CHARS) return null;
  let x = a;
  let y = b;
  if (shapeKind === 'tool_call') {
    const names = (calls) => (Array.isArray(calls) ? calls.map((c) => c?.name ?? '') : []);
    if (names(a).join('|') !== names(b).join('|')) {
      return { decide: [{ 'the tools called': names(a) }, { 'the tools called': names(b) }], written: [{}, {}] };
    }
    x = (Array.isArray(a) ? a : []).map((c) => c?.args);
    y = (Array.isArray(b) ? b : []).map((c) => c?.args);
  }
  const ex = leafEntries(x);
  const ey = leafEntries(y);
  const decide = new Map();
  const written = new Map();
  const size = (v) => (JSON.stringify(v) ?? '').length;
  for (const p of new Set([...ex.keys(), ...ey.keys()])) {
    const both = ex.has(p) && ey.has(p);
    const vx = ex.get(p)?.value;
    const vy = ey.get(p)?.value;
    const wordy = both && isProse(vx) && isProse(vy);
    if (both && (wordy ? vx.trim() === vy.trim() : sameValue(vx, vy))) continue;
    const segs = (ex.get(p) || ey.get(p)).segs;
    let at = segs;
    // the line of a list it sits on, whole, where that line is short enough to read beside it
    let last = -1;
    segs.forEach((s, i) => { if (typeof s === 'number') last = i; });
    if (last >= 0 && last < segs.length - 1 && !wordy) {
      const item = segs.slice(0, last + 1);
      if (Math.max(size(valueAtSegs(x, item)), size(valueAtSegs(y, item))) <= ITEM_CHARS) at = item;
    }
    const place = placeOf(at);
    if (wordy) { if (!decide.has(place)) written.set(place, at); } else { written.delete(place); decide.set(place, at); }
  }
  const pick = (v, places) => Object.fromEntries([...places].map(([place, at]) => [place, valueAtSegs(v, at) ?? null]));
  return { decide: [pick(x, decide), pick(y, decide)], written: [pick(x, written), pick(y, written)] };
}

/** focusParts as one part of each answer for a judge to read, the deciding differences first; null where both are short. */
export function focusOf(a, b, shapeKind) {
  const parts = focusParts(a, b, shapeKind);
  if (!parts) return null;
  return [{ ...parts.decide[0], ...parts.written[0] }, { ...parts.decide[1], ...parts.written[1] }];
}

/** What a request's own instruction says, as one text: its system and developer messages. */
export function instructionOf(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  return msgs.filter((m) => m?.role === 'system' || m?.role === 'developer')
    .map((m) => (typeof m.content === 'string' ? m.content
      : Array.isArray(m.content) ? m.content.map((x) => (typeof x?.text === 'string' ? x.text : '')).join(' ') : ''))
    .join('\n');
}

// what a field's values may be to be read as a choice where nothing declares one: a few, short, repeated words
const CHOICE_VALUES_MAX = 12;
const CHOICE_CHARS = 40;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The choices the answers themselves show where nothing declares them (see above): every yes or no field, and every short
    field with a few repeated values, each with a letter in it, that the instruction lists. A figure written as text is never
    one, however a numbered instruction happens to read ("1. Read the order. 2. ..."). `values` are answers as extract reads
    them. */
export function observedChoices(values, instruction, shapeKind) {
  const out = new Set();
  if (shapeKind === 'free_text') return out;
  const by = new Map();
  for (const v0 of values || []) {
    if (v0 === undefined || v0 === null) continue;
    const v = shapeKind === 'tool_call' ? (Array.isArray(v0) ? v0 : []).map((c) => c?.args) : v0;
    for (const [path, x] of leaves(v)) {
      const k = normPath(path);
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(x);
    }
  }
  const text = String(instruction || '').toLowerCase();
  // read once for each value, never for each of its thousands of places in a workload's line items
  const seen = new Map();
  const listed = (s) => {
    const t = String(s).trim().toLowerCase();
    if (!seen.has(t)) seen.set(t, !!t && new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRe(t)}($|[^\\p{L}\\p{N}_])`, 'u').test(text));
    return seen.get(t);
  };
  for (const [k, xs] of by) {
    if (xs.length < 4) continue;
    if (xs.every((x) => typeof x === 'boolean')) { out.add(k); continue; }
    if (!xs.every((x) => typeof x === 'string' && x.trim() && x.trim().length <= CHOICE_CHARS && !isProse(x) && /\p{L}/u.test(x))) continue;
    const distinct = new Set(xs.map((x) => x.trim().toLowerCase()));
    if (distinct.size < 2 || distinct.size > CHOICE_VALUES_MAX || distinct.size * 3 > xs.length) continue;
    if (xs.filter(listed).length >= 0.8 * xs.length) out.add(k);
  }
  return out;
}

/** Every choice a workload's answers make, by place (normPath, TOOL_PATH): what its requests declare (`bodies`) and what its
    customer's model's answers show (`values`, read against the first request's instruction). Empty for written answers. */
export function choicePathsOf({ bodies = [], values = [], shapeKind } = {}) {
  const out = new Set();
  if (!shapeKind || shapeKind === 'free_text') return out;
  // what the requests declare is the same for nearly all of a workload's requests: a few different ones read, not every one
  const read = new Set();
  /* and every version of its instruction among them, a few at most: read from the first sampled request alone, a workload
     with two versions of its prompt read a field as a choice on one test and as a fact on the next, as the sample fell */
  const instructions = new Set();
  for (const b of bodies) {
    const key = JSON.stringify([b?.response_format ?? null, b?.tool_choice ?? null,
      (Array.isArray(b?.tools) ? b.tools : []).map((t) => [t?.function?.name ?? t?.name, t?.function?.parameters ?? t?.parameters ?? null])]);
    if (!read.has(key) && read.size < 5) {
      read.add(key);
      for (const p of declaredChoices(b, shapeKind)) out.add(p);
    }
    if (instructions.size < 5) { const t = instructionOf(b); if (t) instructions.add(t); }
  }
  for (const p of observedChoices(values, [...instructions].join('\n'), shapeKind)) out.add(p);
  return out;
}

/** Whether a field, by the place leaves or heldFieldChanged gives it, is one of `choices` (choicePathsOf). */
export const isChoicePath = (path, choices) => !!choices?.size && (choices.has(path) || choices.has(normPath(path)));

/* The fields of a structured answer its customer's model gives the same way on both of its answers to a call, on nearly
   every call: what heldFieldChanged holds a candidate to. Nearly every call is read as a range, not a share: the exact
   lower bound on how often the two agree (exactLower) must be at least `share`, so ten agreeing calls of ten are not yet
   enough (a field that agrees 82% of the time shows ten of ten about one time in seven), and thirty of thirty are. A
   field that agrees only as often as chance allows, a category the model picks afresh every time, is that model's own
   variation, and is left to the judge. A field one answer has and the other does not counts as a disagreement: an optional
   field, there on half the answers, is not held, nor is the fourth line of a list that is sometimes three lines long. A
   written field counts by its figures, where both answers state any. `pairs` are the customer's model's two answers to
   each call, as a measurement's bar reads them. Answers a Set of paths, named as heldFieldChanged reads them before naming
   them for a page ('$' for an answer that is a single value). A choice (`except`, from choicePathsOf) is never held, however
   steadily the customer's model makes it: a judge reads a choice that differs. */
export function stablePaths(pairs, shapeKind, { least = 10, share = 0.9, except = null } = {}) {
  const tally = new Map();
  const count = (path, agreed) => {
    if (isChoicePath(path, except)) return;
    const t = tally.get(path) || [0, 0];
    t[0] += agreed ? 1 : 0;
    t[1] += 1;
    tally.set(path, t);
  };
  for (const [a0, b0] of pairs) {
    if (a0 === undefined || a0 === null || b0 === undefined || b0 === null) continue;
    let a = a0;
    let b = b0;
    if (shapeKind === 'tool_call') {
      const names = (calls) => (Array.isArray(calls) ? calls.map((c) => c?.name ?? '').join(', ') : '');
      count(TOOL_PATH, names(a) === names(b));
      if (names(a) !== names(b)) continue;
      a = (Array.isArray(a) ? a : []).map((c) => c?.args);
      b = (Array.isArray(b) ? b : []).map((c) => c?.args);
    }
    const la = leaves(a);
    const lb = leaves(b);
    for (const path of new Set([...la.keys(), ...lb.keys()])) {
      // there in one answer and not the other: they disagree on it
      if (!la.has(path) || !lb.has(path)) { count(path, false); continue; }
      const va = la.get(path);
      const vb = lb.get(path);
      if (isProse(va) && isProse(vb)) {
        if (numbersOf(va).length && numbersOf(vb).length) count(path, !numbersDiffer(va, vb));
        continue;
      }
      count(path, sameValue(va, vb));
    }
  }
  return new Set([...tally].filter(([, [agreed, n]]) => n >= least && exactLower(agreed, n) >= share).map(([path]) => path));
}

/** 0 means identical, 1 means a different answer. Null means a judge has to decide: free text, or a
 *  structured answer whose deciding fields all match and whose written fields differ in wording. */
export function disagreement(a, b, shapeKind) {
  if (!a.ok || !b.ok) return 1;                       // a failure is total disagreement, never skipped
  if (shapeKind === 'free_text') {
    return a.value.trim() === b.value.trim() ? 0 : null;
  }
  if (shapeKind === 'enum') return sameValue(a.value, b.value) || canonical(a.value) === canonical(b.value) ? 0
    : structuredCompare(a.value, b.value, 'json').decision;
  const c = structuredCompare(a.value, b.value, shapeKind);
  if (c.decision) return 1;
  return c.prose.length ? null : 0;
}

/** The four gates a candidate has to pass, computed on the server, never in a screen. */
export function gates(pairs, shapeKind) {
  const total = pairs.length;
  if (!total) return { structure: 0, accuracy: 0, coverage: 0, complete: 0 };
  const parsed = pairs.filter((p) => p.cand.ok).length;
  const exact = pairs.filter((p) => p.score === 0).length;
  const answered = pairs.filter((p) => p.cand.ok && p.ref.ok).length;
  let complete = total;
  if (shapeKind !== 'free_text') {
    complete = pairs.filter((p) => {
      if (!p.cand.ok || !p.ref.ok) return false;
      const want = leaves(p.ref.value).size;
      const got = leaves(p.cand.value).size;
      return want === 0 || got >= want;
    }).length;
  }
  return {
    structure: parsed / total,
    accuracy: exact / total,
    coverage: answered / total,
    complete: complete / total,
  };
}

/** The bar: how much the customer's own model disagrees with itself, with a floor under it. */
export function floorFrom(noisePct, { multiple, minPct }) {
  return Math.max(noisePct * multiple, minPct);
}

/** A bar is only meaningful while the reference agrees with itself most of the time. */
export const barIsMeaningful = (noisePct, maxPct) => noisePct <= maxPct;

/* The bar under "at least as good": no more often clearly worse than the customer's own model is against its own
   other answer, plus a margin in points. A multiple of that rate had to be cut off somewhere, since a customer's
   model clearly worse than itself on half its calls made a bar no answer could miss, and the cut-off was where a
   written workload "could not be measured" at all. Plus a margin, a varied workload's bar is simply wide, and
   showing a setup keeps it takes more calls, which the verdict counts (verdictWith) rather than giving up.

   Never past half, plus the margin. Two answers from one model can each be the clearly better one only half the
   time, so a model is clearly worse than its own other answer on half its calls at most. More than that says the
   answers it was held against (the ones it gave the customer, recorded) are better than what it gives now, and a
   bar read from it would pass a setup clearly worse on every call: a model replayed today clearly worse on all of
   them made a bar of 105%. Capped, a setup is held to answers like the recorded ones, most of the time. */
export function marginFloor(noisePct, { marginPct, minPct }) {
  return Math.min(Math.max(noisePct + marginPct, minPct), 50 + marginPct);
}

/* A verdict is a claim about a rate seen on a sample, so it carries how sure the sample can make
 * anybody: nineteen times in twenty the true rate is under the upper bound (Wilson's, one-sided).
 * The bound is worked out from the mean score, which for scores between 0 and 1 is conservative,
 * because nothing varies more than a yes-or-no with the same mean.
 *
 * cleared: even the upper bound is inside the bar.
 * missed: even the lower bound is past the review band, however few the calls. A sample too small to show a model
 *   passes can still show it fails: said as "nothing can be said", it kept a model serving that its own re-check had
 *   read as clearly worse (a short-poem workload on 26 Sep 2026: worse on 4 of 11 calls, at least 16% against a 5%
 *   bar), since only "missed" switches what serves back.
 * review: the sample straddles the bar, so a person should look.
 * insufficient: a perfect run on this many calls could not clear the bar, and what it did shows nothing past the
 *   review band either; nothing can be said.
 */
const Z95 = 1.6449;
export function wilson(mean, n, z = Z95) {
  if (!(n > 0)) return { lo: 0, hi: 1 };
  const p = Math.max(0, Math.min(1, mean));
  const centre = p + (z * z) / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  const d = 1 + (z * z) / n;
  return { lo: Math.max(0, (centre - half) / d), hi: Math.min(1, (centre + half) / d) };
}

/** The fewest calls on which a perfect run clears a bar (in percent). */
export function callsToClear(floorPct, z = Z95) {
  return Math.ceil((z * z) / (floorPct / 100) - z * z);
}

// how likely a normal reading is to fall past z: the one-sided chance a bound at z leaves out (0.05 at Z95, 0.025 at 1.96)
function outsideOf(z) {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erfc = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x);
  return z >= 0 ? erfc / 2 : 1 - erfc / 2;
}
const logFactorials = [0];
const logFactorial = (n) => {
  for (let i = logFactorials.length; i <= n; i += 1) logFactorials[i] = logFactorials[i - 1] + Math.log(i);
  return logFactorials[n];
};
// the chance of k or more in n at rate p
function atLeast(k, n, p) {
  if (k <= 0) return 1;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let sum = 0;
  for (let i = k; i <= n; i += 1) {
    sum += Math.exp(logFactorial(n) - logFactorial(i) - logFactorial(n - i) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  }
  return Math.min(1, sum);
}
/** The exact lower bound on a rate seen k times in n (Clopper and Pearson's, one-sided), as sure as a bound at `z`: the rate
    below which k or more in n would happen less often than that. Wilson's bound runs high on a few differences in a few
    calls (2 in 11 read over 5%, where the exact bound is about 3%), and a small sample's "clearly worse" rests on it
    (verdictWith), as does which fields a structured answer is held to (stablePaths). */
export function exactLower(k, n, z = Z95) {
  if (!(n > 0) || !(k > 0)) return 0;
  const outside = outsideOf(z);
  let lo = 0;
  let hi = Math.min(1, k / n);
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (atLeast(k, n, mid) < outside) lo = mid; else hi = mid;
  }
  return lo;
}
// the fewest scored calls a small sample's "clearly worse" is ever read on (verdictWith)
export const MISSED_MIN_CALLS = 10;

/**
 * The verdict for one candidate from its per-call scores (each 0 to 1, 1 meaning a different answer).
 *
 * A score is two things: whether the call differed at all, and by how much when it did. The first
 * is a count, which Wilson bounds properly; the second is bounded between 0 and 1 and gets its own
 * small margin. Bounding the mean as if every score were a yes or no read a candidate that only
 * ever differs slightly (one JSON field wrong on a few calls) as far more uncertain than it is.
 */
export function verdictWith(scores, floorPct, { reviewBand = 1.25, z = Z95 } = {}) {
  /* `z` is how sure the bound is: 1.6449 is one-sided 95%, the default; a cautious workload's second
     look is held to 1.96, one-sided 97.5%, the convention for showing a new treatment is not worse. */
  const zz = Number.isFinite(Number(z)) && Number(z) > 0 ? Number(z) : Z95;
  const n = scores.length;
  const gap = n ? (scores.reduce((a, b) => a + b, 0) / n) * 100 : 100;
  const differed = scores.filter((x) => x > 0);
  const k = differed.length;
  const share = wilson(n ? k / n : 0, n, zz);
  let sevLo = 1;
  let sevHi = 1;
  if (k) {
    const mean = differed.reduce((a, b) => a + b, 0) / k;
    const sd = Math.sqrt(differed.reduce((a, b) => a + (b - mean) ** 2, 0) / k);
    const margin = (zz * Math.max(sd, 0.1)) / Math.sqrt(k);
    sevLo = Math.max(0, mean - margin);
    sevHi = Math.min(1, mean + margin);
  }
  const lo = share.lo * sevLo;
  const hi = share.hi * sevHi;
  const loPct = lo * 100;
  const hiPct = hi * 100;
  if (n === 0 || wilson(0, n, zz).hi * 100 > floorPct) {
    /* Too few to show it passes, which is not too few to show it fails (see the comment above): clearly worse, on at least
       MISSED_MIN_CALLS scored calls, when even the exact lower bound on how often it differed, times how much, is past the
       review band. Read on Wilson's bound instead, a few differences in a few calls could fail a model that would pass. */
    const exactPct = exactLower(k, n, zz) * sevLo * 100;
    if (n >= MISSED_MIN_CALLS && exactPct > floorPct * reviewBand) return { verdict: 'missed', gap, lo: exactPct, hi: hiPct };
    return { verdict: 'insufficient', gap, lo: loPct, hi: hiPct, need: callsToClear(floorPct, zz) };
  }
  if (hiPct <= floorPct) return { verdict: 'cleared', gap, lo: loPct, hi: hiPct };
  if (loPct > floorPct * reviewBand) return { verdict: 'missed', gap, lo: loPct, hi: hiPct };
  return { verdict: 'review', gap, lo: loPct, hi: hiPct };
}

/* The bar is never one the customer's own model would fail. Its second answers, held to its first by the same yardstick,
   are the answers of a model exactly as good as itself, and a test it could not pass is no fair test of anybody: a bar of
   1.25 times how often it disagrees with itself leaves less than one extra difference in 120 requests when that is 2.5%,
   and a sample has to show, nineteen times in twenty, that a model is under it. So the bar is raised, where it has to be,
   to the top of the range the customer's model's own scores read at (the self-test), and that self-test is kept with the
   test for its page. Only where a sample of this size could show anything passes at all (a perfect run would clear the
   bar as it was): on fewer requests, a raise to the self-test's range would let a perfect run on a handful clear a bar
   it could never show it keeps, and "too few to be sure" is the answer there. `ownScores` are the customer's model's own
   per-request scores, read as the bar reads them; `z` the strictness the verdict is held to. Answers { bar, self (the
   self-test's verdict against the bar answered), raised, rawPct }. */
export function fairBar(rawPct, ownScores, { z = Z95, cap = 55 } = {}) {
  const scores = Array.isArray(ownScores) ? ownScores.filter((x) => Number.isFinite(Number(x))).map(Number) : [];
  if (!scores.length) return { bar: rawPct, self: null, raised: false, rawPct };
  const first = verdictWith(scores, rawPct, { z });
  if (wilson(0, scores.length, z).hi * 100 > rawPct) return { bar: rawPct, self: first, raised: false, rawPct };
  const bar = Math.max(rawPct, Math.min(first.hi, Math.max(cap, rawPct)));
  const raised = bar > rawPct + 1e-9;
  return { bar, self: raised ? verdictWith(scores, bar, { z }) : first, raised, rawPct };
}

/** Kept for the pages that still read a verdict from a gap alone; every measurement uses verdictWith. */
export function verdictFor(gapPct, floorPct, runs, { minRuns, reviewBand }) {
  if (runs < minRuns) return 'insufficient';
  if (gapPct <= floorPct) return 'cleared';
  if (gapPct <= floorPct * reviewBand) return 'review';
  return 'missed';
}

/** Seeded and stratified by answer length, because length is what breaks a model.
 *
 * `preferred` is the calls whose answers are already paid for. Within each length band they are
 * taken first, so a measurement repeated on unchanged traffic reuses what the last one bought,
 * while the spread across short and long answers stays exactly as it was. */
export function sampleCalls(calls, size, seed = 1, preferred = null, { fresh = null } = {}) {
  const withLen = calls.map((c) => ({ ...c, len: (c.response_json || '').length }));
  withLen.sort((a, b) => a.len - b.len);
  const quartiles = [[], [], [], []];
  withLen.forEach((c, i) => quartiles[Math.min(3, Math.floor((i * 4) / Math.max(1, withLen.length)))].push(c));
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  /* How many from each band. The share left over after an even split goes to the longest answers
     first, because length is what breaks a model; it used to be the longest band that was cut short
     (a pool of twenty sampled three, three, three and one). A band too small for its share passes
     the rest on to the others. */
  const want = [0, 0, 0, 0];
  let left = Math.min(size, withLen.length);
  for (let round = 0; left > 0 && round < 8; round += 1) {
    const open = [3, 2, 1, 0].filter((q) => quartiles[q].length > want[q]);
    if (!open.length) break;
    const each = Math.floor(left / open.length);
    const extra = left - each * open.length;
    open.forEach((q, k) => {
      const give = Math.min(quartiles[q].length - want[q], each + (k < extra ? 1 : 0));
      want[q] += give;
      left -= give;
    });
  }
  const out = [];
  quartiles.forEach((q, qi) => {
    const pool = [...q];
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    /* A re-check wants calls no earlier measurement used, so a lucky sample is not simply measured
       again; a first measurement prefers calls whose answers are already paid for. */
    const rank = (c) => (fresh && fresh.size ? (fresh.has(c.id) ? 0 : 2) : 0)
      + (preferred && preferred.size && preferred.has(c.id) ? 0 : 1);
    const ordered = [...pool].sort((a, b) => rank(a) - rank(b));
    out.push(...ordered.slice(0, want[qi]).map((c) => ({ ...c, quartile: qi })));
  });
  return out.slice(0, size);
}
