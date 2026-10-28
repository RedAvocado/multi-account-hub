'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {createClientUsage, usageEndpoint} = require('./client-usage-service.cjs');

test('client usage exposes only sanitized, authorized reads in the T3 protocol', async t => {
  const id = 'a'.repeat(64);
  const account = {id, provider: 'codex', email: 'allowed@example.com', plan: 'pro',
    windows: [{label: '1w', remaining: 60, resetsAt: '2026-11-01T00:00:00Z'}], stale: false};
  let calls = 0, enabled = true, allowed = true;
  const usage = {
    async listForUser() { return allowed ? [account] : []; },
    async getForUser(identity, options) {
      calls++;
      assert.equal(identity.name, 'tester');
      return {accounts: allowed && (!options?.id || options.id === id) ? [account] : []};
    },
  };
  const handler = createClientUsage({usage});
  const server = http.createServer((req, res) => {
    if (!usageEndpoint(req)) { res.writeHead(404); res.end(); return; }
    void handler(req, res, {name: 'tester', email: 'tester@example.com'}, () => enabled);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const root = `http://127.0.0.1:${server.address().port}`;
  const post = input => fetch(root + '/usage/v0/management/api-call', {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(input),
  });
  const read = {auth_index: id, method: 'GET', url: 'https://chatgpt.com/backend-api/wham/usage',
    header: {Authorization: 'Bearer malicious-supplied-token', 'ChatGPT-Account-ID': 'other-account'}};
  const list = await fetch(root + '/usage/v0/management/auth-files');
  assert.equal(list.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await list.json(), {files: [{id, auth_index: id, provider: 'codex', email: account.email, disabled: false}]});
  assert.equal(calls, 0, 'listing must not fetch every account');
  const result = await (await post(read)).json();
  assert.equal(result.status_code, 200);
  const body = JSON.parse(result.body);
  assert.equal(body.rate_limit.primary_window.used_percent, 40);
  assert.equal(body.rate_limit.primary_window.limit_window_seconds, 604800);
  assert.ok(!JSON.stringify(result).includes('malicious'));
  for (const change of [
    {url: 'http://127.0.0.1:8317/v0/management/config'},
    {url: read.url + '?other=1'}, {method: 'POST'}, {data: '{}'}, {body: {}}, {auth_index: '../private'},
    {url: 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits?other=1'},
    {url: 'https://example.com/'}, {extra: true},
  ]) assert.equal((await post({...read, ...change})).status, 403);
  assert.equal(calls, 1, 'rejected requests must not reach the usage service');
  assert.equal((await post({...read, auth_index: 'b'.repeat(64)})).status, 404);
  assert.equal((await post({...read, url: 'https://api.anthropic.com/api/oauth/usage'})).status, 404);
  account.stale = true;
  assert.equal((await post(read)).status, 503, 'T3 must not mistake stale usage for a current snapshot');
  const direct = await (await fetch(root + '/v1/usage')).json();
  assert.equal(direct.accounts[0].stale, true);
  account.stale = false; enabled = false;
  assert.equal((await post(read)).status, 401, 'recheck device revocation after fetching');
  enabled = true; allowed = false;
  assert.equal((await post(read)).status, 404);
  for (const path of ['/v0/management/auth-files', '/usage/v0/management/config', '/v1/usage?token=bad']) {
    assert.equal((await fetch(root + path)).status, 404);
  }
  allowed = true; account.provider = 'claude';
  account.windows = [{label: '5h', remaining: 90, resetsAt: null}, {label: 'Fable', remaining: 25, resetsAt: null}];
  const claude = JSON.parse((await (await post({...read, url: 'https://api.anthropic.com/api/oauth/usage'})).json()).body);
  assert.equal(claude.five_hour.utilization, 10);
  assert.equal(claude.limits[0].percent, 75);
});
