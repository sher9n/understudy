import test from 'node:test';
import assert from 'node:assert/strict';
import { ROUTES, PUBLIC, parse, href, modelHref, titleFor } from '../web/src/router.js';

/* The addresses the site answers. The server serves the app for every address the router knows
   and a 404 for any other (src/server.js asks the same parse), so these are the pages that can be
   linked to, bookmarked and shared. */

test('how it works has an address of its own, readable without an account', () => {
  assert.deepEqual(parse('/how-it-works'), { screen: 'how', openId: null });
  assert.deepEqual(parse('/how-it-works/'), { screen: 'how', openId: null }, 'a trailing slash is the same page');
  assert.equal(parse('/how-it-work').screen, 'notfound', 'a near miss is not the page');
  assert.equal(href('how'), '/how-it-works');
  assert.equal(href('how', null, 'testing'), '/how-it-works#testing', 'a step on it can be linked to');
  assert.ok(PUBLIC.has('how'), 'it needs no account, so it never sends anybody to sign in');
  assert.equal(titleFor('how'), 'How it works, Understudy');
});

test('how models are routed has an address of its own, readable without an account', () => {
  assert.deepEqual(parse('/how-models-are-routed'), { screen: 'routing', openId: null });
  assert.deepEqual(parse('/how-models-are-routed/'), { screen: 'routing', openId: null }, 'a trailing slash is the same page');
  assert.equal(href('routing'), '/how-models-are-routed');
  assert.equal(href('routing', null, 'second-look'), '/how-models-are-routed#second-look', 'a part of it can be linked to');
  assert.ok(PUBLIC.has('routing'), 'it needs no account, so it never sends anybody to sign in');
  assert.equal(titleFor('routing'), 'How models are routed, Understudy');
});

test('every address leads back to its own screen, and every public page has one', () => {
  for (const r of ROUTES) assert.equal(parse(r.path).screen, r.screen, r.path);
  for (const s of PUBLIC) assert.ok(ROUTES.some((r) => r.screen === s), `${s} has an address`);
  assert.equal(new Set(ROUTES.map((r) => r.path)).size, ROUTES.length, 'no two screens share an address');
});

test("a model's page in one of a workload's tests has an address of its own, however its name is written", () => {
  const key = 'meta-llama/llama-3.3-70b-instruct:free';
  const to = modelHref('wl_abc', 'run_def', key);
  assert.equal(to, '/workloads/wl_abc/tests/run_def/models/meta-llama%2Fllama-3.3-70b-instruct%3Afree');
  assert.deepEqual(parse(to), { screen: 'work', openId: 'wl_abc', test: 'run_def', model: key });
  assert.deepEqual(parse(`${to}/`), parse(to), 'a trailing slash is the same page');
  assert.deepEqual(parse('/workloads/wl_abc/tests/run_def/models/meta-llama/llama-3.3-70b-instruct:free'), parse(to),
    'the name typed with its slash as it is leads to the same page');
  assert.equal(parse('/workloads/wl_abc/tests/run_def/models/').screen, 'notfound', 'no model named is no page');
  assert.equal(parse('/workloads/wl_abc/tests/run_def/models//gpt').screen, 'notfound', 'an empty part of a name is no page');
  assert.equal(parse('/workloads/wl_abc/tests/run_def').screen, 'notfound', 'a test has no page apart from its workload');
  assert.equal(parse('/workloads/wl_abc/tests/run_def/models/%E0%A4%A').screen, 'notfound', 'a broken name is no page');
  assert.deepEqual(parse('/workloads/wl_abc'), { screen: 'work', openId: 'wl_abc' }, 'the workload page is as it was');
  assert.equal(titleFor('model', 'mistral-small, Invoice totals'), 'mistral-small, Invoice totals, Understudy');
});
