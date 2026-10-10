import config from '../config.js';
import { db } from '../db/index.js';

/* How the language model in EVAL_JUDGE_MODEL is asked, whatever it is asked for: a judge's one word, a
   checklist, a translation. A model that thinks before it answers spends its room on the thinking: held to six
   tokens, gpt-5.4-mini often came back with nothing at all, and every verdict that did not come back was dropped
   from the bar it was meant to set. So a model that can think is told not to, whatever its catalogue entry says
   it does by default, because the entries do not agree with themselves: gpt-5.4-mini's says thinking is off by
   default and that its default effort is medium. One that must think is given room to, and the answer itself
   always has room to arrive. Read from the catalogue at most every ten minutes. */
/* Any other model asked for a judge's one word (the customer's own model breaking a tie between the two judges, see
   judgeChoices in src/eval/judge.js) is asked the same way, read from its own catalogue entry. */
const judgeWays = new Map();
export async function judgeOptions(model = config.EVAL_JUDGE_MODEL) {
  const hit = judgeWays.get(model);
  if (hit && Date.now() - hit.at < 10 * 60000) return hit.way;
  let way = { max_tokens: 16 };
  try {
    const row = await db.prepare('SELECT reasoning_json FROM models_catalog WHERE model_id = ?').get(model);
    const r = row?.reasoning_json ? JSON.parse(row.reasoning_json) : null;
    if (r && r.mandatory === true) way = { max_tokens: 600 };
    else if (r) {
      const efforts = Array.isArray(r.supported_efforts) ? r.supported_efforts : [];
      way = { max_tokens: 16, reasoning: efforts.includes('none') ? { effort: 'none' } : { enabled: false } };
    }
  } catch { /* the catalogue could not be read: the plain way */ }
  judgeWays.set(model, { at: Date.now(), way });
  if (judgeWays.size > 200) judgeWays.clear();
  return way;
}

/* How the customer's own model is asked for a judge's one word, breaking a tie between the judges (judgeChoices in
   src/eval/judge.js). It was never chosen to judge, so nothing is assumed of it: it always has room to answer (TIE_ROOM
   tokens), since told not to think, several came back with nothing at all (o3, o4-mini), and a model that answers in a word
   costs no more for the room; one that can think is asked at the lightest effort it offers. Found in the catalogue by its
   id, or where that carries a variant (":nitro", ":floor"), by the model it is a variant of: looked up as written, a
   thinking model got sixteen tokens and never answered. Read from the catalogue at most every ten minutes. */
export const TIE_ROOM = 1200;
const tieWays = new Map();
export async function tieOptions(model) {
  const hit = tieWays.get(model);
  if (hit && Date.now() - hit.at < 10 * 60000) return hit.way;
  let way = { max_tokens: TIE_ROOM };
  try {
    const id = String(model || '');
    const read = (m) => db.prepare('SELECT reasoning_json FROM models_catalog WHERE model_id = ?').get(m);
    const row = (await read(id)) ?? (id.includes(':') ? await read(id.slice(0, id.indexOf(':'))) : null);
    const r = row?.reasoning_json ? JSON.parse(row.reasoning_json) : null;
    if (r) {
      const efforts = Array.isArray(r.supported_efforts) ? r.supported_efforts : [];
      const light = ['minimal', 'low'].find((e) => efforts.includes(e));
      if (light) way = { ...way, reasoning: { effort: light } };
    }
  } catch { /* the catalogue could not be read: room to answer, as it is */ }
  tieWays.set(model, { at: Date.now(), way });
  if (tieWays.size > 200) tieWays.clear();
  return way;
}

/** The same, for an answer of up to `tokens` tokens rather than one word: a model that must think keeps its room to. */
export async function plainWay(tokens) {
  const way = await judgeOptions();
  return { ...way, max_tokens: (way.max_tokens > 16 ? way.max_tokens : 0) + tokens };
}

/** Forget what was read, so a changed catalogue entry or judge model is read at once. */
export const forgetJudgeOptions = () => { judgeWays.clear(); tieWays.clear(); };
