'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {createClientUsage, usageEndpoint, providerBody} = require('./client-usage-service.cjs');
const {createUsage} = require('./usage-service.cjs');

test('Claude client usage includes its confirmed subscription label with a generic fallback', () => {
  for (const plan of ['Max 20×', 'Max 5×', 'Team — Standard', 'Team — Premium', 'Pro']) {
    assert.equal(providerBody({provider: 'claude', plan, windows: []}).plan_type, `Claude ${plan}`);
  }
  assert.equal(providerBody({provider: 'claude', plan: null, windows: []}).plan_type, undefined);
});

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
  account.stale = true; account.rateLimited = true; account.checkedAt = new Date().toISOString();
  account.windows = [{label: '5h', remaining: 25, resetsAt: new Date(Date.now() - 1000).toISOString()}];
  const claudeRead = {...read, url: 'https://api.anthropic.com/api/oauth/usage'};
  assert.equal((await post(claudeRead)).status, 503, 'a rate-limit fallback cannot cross a quota reset');
  account.windows[0].resetsAt = new Date(Date.now() + 3600000).toISOString();
  assert.equal((await post(claudeRead)).status, 200, 'a recent explicitly marked rate limit can use last-good quotas');
  account.rateLimited = false;
  assert.equal((await post(claudeRead)).status, 503, 'authentication and unrelated failures cannot use the rate-limit grace');
});

test('Claude client limits stay available between polls and brief rate limits without hiding observation age', async t => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-client-claude-'));
  t.after(() => fs.rmSync(authDir, {recursive: true, force: true}));
  const account = {id: 'claude.json', provider: 'claude', email: 'claude@example.com', disabled: false};
  const admin = {snapshot: async () => ({accounts: [account], users: [{name: 'tester', email: 'tester@example.com', enabled: true, editable: true, accounts: [account.id]}]})};
  let clock = Date.parse('2026-10-29T18:00:00Z'), mode = 'ok', calls = 0;
  const management = async (endpoint, input) => {
    if (endpoint === 'auth-files') return {files: [{id: account.id, type: 'claude', auth_index: 'claude'}]};
    calls++;
    if (mode === '429') return {status_code: 429, header: {'rEtRy-AfTeR': ['0']}, body: '{}'};
    return {status_code: 200, body: JSON.stringify({five_hour: {utilization: 20, resets_at: '2026-10-29T23:00:00Z'}})};
  };
  const usage = createUsage({admin, authDir, management, details: false, now: () => clock});
  const handler = createClientUsage({usage, now: () => clock});
  const server = http.createServer((req, res) => {
    if (!usageEndpoint(req)) { res.writeHead(404); return res.end(); }
    void handler(req, res, {name: 'tester', email: 'tester@example.com'}, () => true);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const root = `http://127.0.0.1:${server.address().port}`;
  const first = await (await fetch(root + '/v1/usage')).json();
  const id = first.accounts[0].id;
  const request = () => fetch(root + '/usage/v0/management/api-call', {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({auth_index: id, method: 'GET', url: 'https://api.anthropic.com/api/oauth/usage', header: {}}),
  });
  assert.equal(calls, 1);
  for (const elapsed of [30000, 15000, 14999]) {
    clock += elapsed;
    assert.equal((await request()).status, 200, 'the one-minute cache interval must not hide healthy client limits');
    assert.equal(calls, 1, 'client refreshes reuse the shared quota observation');
    const snapshot = await (await fetch(root + '/v1/usage')).json();
    assert.equal(snapshot.accounts[0].checkedAt, first.accounts[0].checkedAt, 'cache reads preserve observation time');
  }
  clock += 2; mode = '429';
  const rateLimited = await request();
  assert.equal(rateLimited.status, 200, 'brief rate limits retain the recent confirmed reading');
  const cached = await rateLimited.json();
  assert.equal(cached.stale, true);
  assert.equal(cached.checked_at, first.accounts[0].checkedAt, 'cached readings never acquire a new observation time');
  assert.equal(calls, 2);
  clock += 30000;
  assert.equal((await request()).status, 200, 'a subsequent client reuses the bounded fallback without retrying upstream');
  assert.equal(calls, 2);
  clock += 30001; mode = 'ok';
  const recovered = await request();
  assert.equal(recovered.status, 200);
  const fresh = await recovered.json();
  assert.equal(JSON.parse(fresh.body).five_hour.utilization, 20);
  assert.equal(fresh.stale, false);
  assert.notEqual(fresh.checked_at, cached.checked_at);
  assert.equal(calls, 3);
  const cacheDirectory = path.join(authDir, '.claude-usage-cache');
  const cache = fs.readdirSync(cacheDirectory).find(name => name.endsWith('.json'));
  assert.ok(cache);
  assert.equal(fs.statSync(path.join(cacheDirectory, cache)).mode & 0o077, 0);
  clock += 300001; mode = '429';
  assert.equal((await request()).status, 503, 'a rate limit cannot extend last-good readings beyond five minutes');
});

test('Claude quota reset crossings refresh before the normal poll interval and never reuse expired limits', async t => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-client-claude-reset-'));
  t.after(() => fs.rmSync(authDir, {recursive: true, force: true}));
  const start = Date.parse('2026-10-29T18:00:00Z');
  let clock = start, calls = 0, fail = false;
  const account = {id: 'claude.json', provider: 'claude', email: 'claude@example.com'};
  const identity = {name: 'tester', email: 'tester@example.com'};
  const admin = {snapshot: async () => ({accounts: [account], users: [{...identity, enabled: true, editable: true, accounts: [account.id]}]})};
  const usage = createUsage({admin, authDir, details: false, now: () => clock, management: async (endpoint) => {
    if (endpoint === 'auth-files') return {files: [{id: account.id, type: 'claude', auth_index: 'claude'}]};
    calls++;
    if (fail) return {status_code: 429, body: '{}'};
    return {status_code: 200, body: JSON.stringify({five_hour: {
      utilization: clock < start + 10000 ? 100 : 5,
      resets_at: new Date(clock < start + 10000 ? start + 10000 : clock + 18000000).toISOString(),
    }})};
  }});
  const first = await usage.getForUser(identity);
  assert.equal(first.accounts[0].windows[0].remaining, 0);
  clock += 10000;
  const reset = await usage.getForUser(identity);
  assert.equal(calls, 2, 'an observed reset overrides the local 30-second cache and shared one-minute poll interval');
  assert.equal(reset.accounts[0].windows[0].remaining, 95);
  assert.equal(reset.accounts[0].stale, false);
  fail = true;
  clock += 18000000;
  const stale = await usage.getForUser(identity);
  assert.equal(stale.accounts[0].stale, true, 'failed post-reset reads cannot present pre-reset limits as current');
  assert.equal(stale.accounts[0].checkedAt, reset.accounts[0].checkedAt);
});
