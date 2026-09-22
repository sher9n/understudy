/* Picking a model call by call, from the workload's own measured calls. Pure.
 *
 * A measurement knows, for each call it replayed, whether a cheap model's answer matched the
 * customer's model. Calls a cheap model gets wrong often share something you can see before
 * sending them: a longer prompt, more figures to get right, another language, more turns. A small
 * model of those few features, learned from the measured calls, can send the easy calls to the
 * cheap model and the rest to the customer's own, with no extra call and no waiting on a check.
 *
 * It only earns a place when there is enough to learn from and it holds up on calls it did not
 * learn from: every call is predicted with the model learned from all the others (leave one out),
 * and it is judged on those predictions alone. */

import { textOf } from './threads.js';

export const FEATURES = ['prompt length', 'figures', 'other alphabets', 'turns', 'question length', 'tools'];

/** What can be seen of a call before it is sent. */
export function featuresOf(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const all = msgs.map((m) => textOf(m.content)).join('\n');
  const last = msgs.filter((m) => m.role === 'user').map((m) => textOf(m.content)).slice(-1)[0] || '';
  const figures = (last.match(/\d+(?:[.,]\d+)*/g) || []).length;
  const nonAscii = last.length ? [...last].filter((c) => c.charCodeAt(0) > 127).length / last.length : 0;
  return [
    Math.log1p(all.length),
    Math.log1p(figures),
    nonAscii,
    Math.log1p(msgs.length),
    Math.log1p(last.length),
    Array.isArray(body?.tools) && body.tools.length ? 1 : 0,
  ];
}

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

/** A small logistic model: standardised features, gently held back from over-reading few calls. */
export function train(samples, { l2 = 1, iters = 600, lr = 0.2 } = {}) {
  const d = samples[0]?.x.length ?? FEATURES.length;
  const means = Array(d).fill(0);
  const sds = Array(d).fill(0);
  for (const s of samples) s.x.forEach((v, j) => { means[j] += v / samples.length; });
  for (const s of samples) s.x.forEach((v, j) => { sds[j] += ((v - means[j]) ** 2) / samples.length; });
  for (let j = 0; j < d; j += 1) sds[j] = Math.sqrt(sds[j]) || 1;
  const z = samples.map((s) => ({ x: s.x.map((v, j) => (v - means[j]) / sds[j]), y: s.y }));
  let w = Array(d).fill(0);
  let b = 0;
  for (let it = 0; it < iters; it += 1) {
    const gw = Array(d).fill(0);
    let gb = 0;
    for (const s of z) {
      const e = sigmoid(b + s.x.reduce((a, v, j) => a + v * w[j], 0)) - s.y;
      s.x.forEach((v, j) => { gw[j] += e * v; });
      gb += e;
    }
    w = w.map((wj, j) => wj - lr * (gw[j] / z.length + (l2 * wj) / z.length));
    b -= lr * (gb / z.length);
  }
  return { weights: w, bias: b, means, sds };
}

/** The chance the cheap model's answer would match, for one call. */
export function predict(m, x) {
  return sigmoid(m.bias + x.reduce((a, v, j) => a + ((v - m.means[j]) / (m.sds[j] || 1)) * m.weights[j], 0));
}

/** Every call predicted by a model learned from all the other calls. */
export function leaveOneOut(samples, opts) {
  return samples.map((s, i) => predict(train(samples.filter((_, k) => k !== i), opts), s.x));
}
