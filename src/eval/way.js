import config from '../config.js';
import { db } from '../db/index.js';

/* How the language model in EVAL_JUDGE_MODEL is asked, whatever it is asked for: a judge's one word, a
   checklist, a translation. A model that thinks before it answers spends its room on the thinking: held to six
   tokens, gpt-5.4-mini often came back with nothing at all, and every verdict that did not come back was dropped
   from the bar it was meant to set. So a model that can think is told not to, whatever its catalogue entry says
   it does by default, because the entries do not agree with themselves: gpt-5.4-mini's says thinking is off by
   default and that its default effort is medium. One that must think is given room to, and the answer itself
   always has room to arrive. Read from the catalogue at most every ten minutes. */
let judgeWay = { at: 0, model: null, way: null };
export async function judgeOptions() {
  if (judgeWay.model === config.EVAL_JUDGE_MODEL && Date.now() - judgeWay.at < 10 * 60000) return judgeWay.way;
  let way = { max_tokens: 16 };
  try {
    const row = await db.prepare('SELECT reasoning_json FROM models_catalog WHERE model_id = ?').get(config.EVAL_JUDGE_MODEL);
    const r = row?.reasoning_json ? JSON.parse(row.reasoning_json) : null;
    if (r && r.mandatory === true) way = { max_tokens: 600 };
    else if (r) {
      const efforts = Array.isArray(r.supported_efforts) ? r.supported_efforts : [];
      way = { max_tokens: 16, reasoning: efforts.includes('none') ? { effort: 'none' } : { enabled: false } };
    }
  } catch { /* the catalogue could not be read: the plain way */ }
  judgeWay = { at: Date.now(), model: config.EVAL_JUDGE_MODEL, way };
  return way;
}

/** The same, for an answer of up to `tokens` tokens rather than one word: a model that must think keeps its room to. */
export async function plainWay(tokens) {
  const way = await judgeOptions();
  return { ...way, max_tokens: (way.max_tokens > 16 ? way.max_tokens : 0) + tokens };
}

/** Forget what was read, so a changed catalogue entry or judge model is read at once. */
export const forgetJudgeOptions = () => { judgeWay = { at: 0, model: null, way: null }; };
