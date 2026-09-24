import test from 'node:test';
import assert from 'node:assert/strict';
import { ROUTES, PUBLIC, parse, href, titleFor } from '../web/src/router.js';

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

test('every address leads back to its own screen, and every public page has one', () => {
  for (const r of ROUTES) assert.equal(parse(r.path).screen, r.screen, r.path);
  for (const s of PUBLIC) assert.ok(ROUTES.some((r) => r.screen === s), `${s} has an address`);
  assert.equal(new Set(ROUTES.map((r) => r.path)).size, ROUTES.length, 'no two screens share an address');
});
