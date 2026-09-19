/* Making a thrown error a 500 instead of an outage.
 *
 * Express 4 does not know about promises. An `async` route handler that rejects does not
 * reach Express's error handling at all: it becomes an unhandled rejection, and Node ends
 * the process on those. So one bad query on one request takes the whole service down for
 * everybody, which is exactly what happened here: a SELECT naming a column that did not
 * exist killed the server, and the platform mailed about a crash.
 *
 * This wraps every handler registered on a router so a rejection is handed to Express
 * instead. It patches the router rather than asking each route to remember, because a rule
 * that has to be remembered at 60 call sites is a rule that will be missed at the 61st. */

import express from 'express';

const VERBS = ['use', 'all', 'get', 'post', 'put', 'patch', 'delete', 'options', 'head'];

const wrap = (fn) => {
  if (typeof fn !== 'function') return fn;
  // four arguments means Express's own error handler shape, which must be left alone
  if (fn.length >= 4) return fn;
  return function wrapped(req, res, next) {
    try {
      const out = fn.call(this, req, res, next);
      if (out && typeof out.then === 'function') out.catch(next);
      return out;
    } catch (err) {
      next(err);
      return undefined;
    }
  };
};

/** Patch a router or app in place so no handler on it can escape with a rejection. */
export function harden(target) {
  for (const verb of VERBS) {
    if (typeof target[verb] !== 'function') continue;
    const original = target[verb].bind(target);
    target[verb] = (...args) => original(...args.map(wrap));
  }
  return target;
}

/** A router that is hardened from the moment it exists. */
export const safeRouter = (...args) => harden(express.Router(...args));
