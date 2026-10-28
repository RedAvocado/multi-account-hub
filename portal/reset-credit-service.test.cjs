'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {createUsage} = require('./usage-service.cjs');
const {createClientUsage, usageEndpoint} = require('./client-usage-service.cjs');
const {CREDIT_URL} = require('./reset-credit-service.cjs');

async function fixture(t) {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-reset-test-'));
  const accounts = ['shared', 'private'].map((name, index) => ({id: name + '.json', email: name + '@example.com',
    provider: 'codex', personal: index === 1, owner: 'owner', disabled: false}));
  for (const a of accounts) fs.writeFileSync(path.join(authDir, a.id), JSON.stringify({type: 'codex', email: a.email, account_id: a.id.split('.')[0]}));
  const identity = {name: 'member', email: 'member@example.com', isAdmin: false};
  const user = {...identity, role: 'member', enabled: true, editable: true, accounts: accounts.map(a => a.id)};
  const state = {clock: Date.parse('2026-10-28T12:00:00Z'), enabled: true, used: 100, allowed: false,
    posts: [], clears: [], ledger: new Map(), reads: 0, applied: 0};
  const credits = [{id: 'credit_1', status: 'available', reset_type: 'codex_rate_limits', expires_at: '2026-11-01T00:00:00Z', secret: 'must-not-leak'},
    {id: 'credit_2', status: 'available', reset_type: 'codex_rate_limits', expires_at: '2026-11-03T00:00:00Z'}];
  const management = async (endpoint, input) => {
    if (endpoint === 'auth-files') {
      state.beforeResolve?.();
      return {files: accounts.map(a => ({id: a.id, type: 'codex', auth_index: a.id.split('.')[0], disabled: a.disabled}))};
    }
    if (endpoint === 'reset-quota') { state.clears.push(input); return {status: 'ok'}; }
    assert.equal(input.header.Authorization, 'Bearer $TOKEN$');
    assert.equal(input.header['ChatGPT-Account-ID'], 'shared');
    const response = body => ({status_code: 200, body: JSON.stringify(body)});
    if (input.method === 'POST') {
      assert.equal(input.url, CREDIT_URL + '/consume');
      assert.equal(input.auth_index, 'shared');
      const body = JSON.parse(input.data); state.posts.push(body);
      if (state.blockConsume) await state.blockConsume;
      if (state.outcome) return response({code: state.outcome});
      if (state.ledger.has(body.redeem_request_id)) return response({code: 'already_redeemed'});
      const credit = credits.find(c => c.id === body.credit_id && c.status === 'available');
      if (!credit) return response({code: 'no_credit'});
      credit.status = 'used'; state.applied++; state.used = 0; state.allowed = true;
      state.ledger.set(body.redeem_request_id, true);
      if (state.loseResponse) throw new Error('simulated lost response after redemption');
      return response({code: 'reset', private_upstream_field: 'must-not-leak'});
    }
    if (input.url === CREDIT_URL) {
      state.reads++;
      const value = response({credits, available_count: credits.filter(c => c.status === 'available').length});
      if (state.blockRead) await state.blockRead;
      if (state.failRead) throw new Error('simulated provider error');
      return value;
    }
    if (input.url.endsWith('/wham/usage')) {
      const value = response({plan_type: 'pro', rate_limit: {
        allowed: state.allowed, limit_reached: !state.allowed,
        primary_window: {used_percent: state.used, limit_window_seconds: 604800, reset_at: 1793600000},
      }});
      state.usageStarted = true;
      if (state.blockUsage) await state.blockUsage;
      return value;
    }
    return response({});
  };
  const options = {admin: {snapshot: async () => ({accounts, users: [user]})}, authDir, management, now: () => state.clock};
  const usage = createUsage(options);
  const id = (await usage.listForUser(identity))[0].id;
  const handler = createClientUsage({usage});
  const server = http.createServer((req, res) => {
    if (!usageEndpoint(req)) { res.writeHead(404); res.end(); return; }
    void handler(req, res, identity, () => state.enabled);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(authDir, {recursive: true, force: true}); });
  const request = async (input, endpoint = 'api-call') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/usage/v0/management/${endpoint}`, {
      method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(input),
    });
    const value = await response.json();
    return {status: response.status, value: value.body ? JSON.parse(value.body) : value};
  };
  const read = () => request({auth_index: id, method: 'GET', url: CREDIT_URL});
  const selection = {credit_id: 'credit_1', redeem_request_id: '12345678-1234-5234-8234-123456789abc'};
  const consume = (change = {}) => request({auth_index: id, method: 'POST', url: CREDIT_URL + '/consume',
    header: {Authorization: 'malicious', 'ChatGPT-Account-ID': 'private'}, data: JSON.stringify({...selection, ...change})});
  const clear = () => request({auth_index: id}, 'reset-quota');
  return {state, user, accounts, usage, options, identity, id, request, read, selection, consume, clear};
}

test('a non-admin member can read and redeem an assigned account reset and clear its confirmed cooldown', async t => {
  const f = await fixture(t);
  assert.equal(f.identity.isAdmin, false);
  assert.equal(f.user.role, 'member');
  const first = await f.read();
  assert.equal(first.status, 200); assert.equal(first.value.credits.length, 2);
  assert.ok(!JSON.stringify(first).includes('must-not-leak'));
  await Promise.all([f.read(), f.read()]); assert.equal(f.state.reads, 1);
  assert.equal((await f.clear()).status, 409); assert.equal(f.state.clears.length, 0);
  assert.equal((await f.consume({credit_id: 'unrelated_credit'})).value.code, 'no_credit');
  assert.equal(f.state.applied, 0);
  f.state.posts.length = 0;
  assert.equal((await f.usage.getForUser(f.identity)).accounts[0].windows[0].remaining, 0);
  assert.deepEqual(await f.consume(), {status: 200, value: {code: 'reset'}});
  assert.equal(f.state.applied, 1);
  assert.equal((await f.usage.getForUser(f.identity)).accounts[0].windows[0].remaining, 100, 'usage cache invalidated immediately');
  assert.equal((await f.read()).value.credits.filter(c => c.status === 'available').length, 1);
  assert.equal((await f.clear()).status, 200); assert.equal(f.state.clears.length, 1);
  assert.equal((await f.clear()).status, 200); assert.equal(f.state.clears.length, 1, 'duplicate cooldown confirmation is a no-op');
  assert.equal((await f.consume({redeem_request_id: 'aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee'})).value.code, 'already_redeemed');
  assert.equal(f.state.posts[0].redeem_request_id, f.state.posts[1].redeem_request_id);
  assert.equal(f.state.applied, 1, 'changing the client UUID does not spend another reset');
  f.state.allowed = false;
  assert.equal((await f.clear()).status, 409); assert.equal(f.state.clears.length, 1, 'old success cannot clear a newly exhausted account');
  f.state.clock += 61000;
  assert.equal((await f.clear()).status, 409);
});

test('foreign, personal, revoked and malformed reset requests cannot mutate provider accounts', async t => {
  const f = await fixture(t);
  for (const data of [{}, {...f.selection, credit_id: '../bad'}, {...f.selection, extra: true}, {...f.selection, redeem_request_id: 'bad'}]) {
    assert.equal((await f.request({auth_index: f.id, method: 'POST', url: CREDIT_URL + '/consume', data: JSON.stringify(data)})).status, 400);
  }
  assert.equal((await f.request({auth_index: 'b'.repeat(64), method: 'POST', url: CREDIT_URL + '/consume', data: JSON.stringify(f.selection)})).status, 404);
  const owner = {...f.identity, name: 'owner'};
  f.user.name = 'owner';
  const privateId = (await f.usage.listForUser(owner)).find(a => a.email === 'private@example.com').id;
  f.user.name = 'member';
  f.user.role = 'admin'; f.identity.isAdmin = true;
  assert.equal((await f.request({auth_index: privateId, method: 'POST', url: CREDIT_URL + '/consume', data: JSON.stringify(f.selection)})).status, 404);
  f.state.enabled = false; assert.equal((await f.consume()).status, 401);
  f.state.enabled = true; f.state.beforeResolve = () => { f.state.enabled = false; };
  assert.equal((await f.consume()).status, 403);
  assert.equal(f.state.posts.length, 0); assert.equal(f.state.clears.length, 0);
  f.state.enabled = true;
  f.state.beforeResolve = () => { f.user.accounts = []; };
  assert.equal((await f.consume()).status, 403, 'account grants are rechecked after awaiting auth metadata');
  assert.equal(f.state.posts.length, 0);
});

test('unknown outcomes and no-op outcomes never authorize cooldown clearing; lost responses retry safely after restart', async t => {
  const f = await fixture(t);
  for (const outcome of ['nothing_to_reset', 'no_credit', 'surprise']) {
    f.state.outcome = outcome;
    assert.equal((await f.consume()).status, outcome === 'surprise' ? 503 : 200);
    assert.equal((await f.clear()).status, 409);
  }
  f.state.outcome = null; f.state.loseResponse = true;
  assert.equal((await f.consume()).status, 503); assert.equal(f.state.applied, 1);
  assert.equal((await f.clear()).status, 409);
  f.state.loseResponse = false;
  const restarted = createUsage(f.options);
  assert.deepEqual(await restarted.resetCredits.consume(f.identity, f.id, f.selection, () => true), {code: 'already_redeemed'});
  assert.equal(f.state.applied, 1);
  assert.deepEqual(await restarted.resetCredits.clearCooldown(f.identity, f.id, () => true), {status: 'ok'});
});

test('concurrent resets are bounded and a pre-reset credit read cannot refill the cache afterward', async t => {
  const f = await fixture(t);
  let releaseRead, releaseConsume;
  f.state.blockRead = new Promise(resolve => { releaseRead = resolve; });
  const reading = f.read();
  while (!f.state.reads) await new Promise(resolve => setImmediate(resolve));
  f.state.blockConsume = new Promise(resolve => { releaseConsume = resolve; });
  const consuming = f.consume();
  while (!f.state.posts.length) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.consume({credit_id: 'credit_2'})).status, 409);
  releaseConsume(); f.state.blockConsume = null;
  assert.equal((await consuming).status, 200);
  releaseRead(); f.state.blockRead = null;
  assert.equal((await reading).status, 503);
  assert.equal((await f.read()).value.credits.filter(c => c.status === 'available').length, 1);
  f.state.clock += 30000; f.state.failRead = true;
  assert.equal((await f.read()).status, 503);
  const count = f.state.reads;
  f.state.clock += 59000; assert.equal((await f.read()).status, 503); assert.equal(f.state.reads, count);
  f.state.clock += 1000; f.state.failRead = false; assert.equal((await f.read()).status, 200);
});

test('an in-flight usage snapshot cannot restore pre-reset quota to the cache', async t => {
  const f = await fixture(t);
  let release;
  f.state.blockUsage = new Promise(resolve => { release = resolve; });
  const reading = f.usage.getForUser(f.identity);
  while (!f.state.usageStarted) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.consume()).value.code, 'reset');
  release(); f.state.blockUsage = null;
  assert.equal((await reading).accounts[0].stale, true);
  assert.equal((await f.usage.getForUser(f.identity)).accounts[0].windows[0].remaining, 100);
});
