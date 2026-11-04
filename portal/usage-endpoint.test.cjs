'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {createClientUsage, usageEndpoint} = require('./client-usage-service.cjs');
const {createUsage} = require('./usage-service.cjs');
const {createUsageHistory} = require('./usage-history-service.cjs');

// GET /v1/usage is the API-key endpoint: every account the key's member may
// use, with remaining quota, burn rates, quota resets, banked resets and
// credits, each with their expirations.
test('/v1/usage reports usage, burn rates, resets and expirations for the key holder only', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-usage-endpoint-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const mine = {id: 'codex-mine.json', provider: 'codex', email: 'mine@example.com'};
  const other = {id: 'codex-other.json', provider: 'codex', email: 'other@example.com'};
  for (const account of [mine, other]) {
    fs.writeFileSync(path.join(directory, account.id), JSON.stringify({type: 'codex', email: account.email, account_id: account.id.slice(6, -5)}));
  }
  let clock = Date.parse('2026-11-04T18:00:00Z');
  const now = () => clock;
  let used = 40;
  const resetAt = Math.floor(Date.parse('2026-11-06T17:08:23Z') / 1000);
  const usage = createUsage({authDir: directory, now, history: createUsageHistory({directory, now}),
    admin: {snapshot: async () => ({accounts: [mine, other], users: [
      {name: 'nate', email: 'nate@example.com', enabled: true, editable: true, accounts: [mine.id]},
      {name: 'jo', email: 'jo@example.com', enabled: true, editable: true, accounts: [other.id]},
    ]})},
    management: async (endpoint, input) => {
      if (endpoint === 'auth-files') return {files: [mine, other].map(a => ({id: a.id, type: 'codex', auth_index: a.id.slice(6, -5)}))};
      const url = input.url;
      if (url.endsWith('/wham/usage')) return {status_code: 200, body: JSON.stringify({plan_type: 'pro',
        rate_limit: {primary_window: {used_percent: used, limit_window_seconds: 604800, reset_at: resetAt}},
        rate_limit_reset_credits: {available_count: 1}, credits: {has_credits: true, balance: '1234.5'}})};
      if (url.endsWith('/rate-limit-reset-credits')) return {status_code: 200, body: JSON.stringify({available_count: 1,
        credits: [{id: 'r1', status: 'available', expires_at: '2026-11-30T20:06:55Z'}]})};
      if (url.endsWith('/remaining_balance')) return {status_code: 200, body: JSON.stringify({expiring_balance_details: [
        {amount_granted: '62500', amount_remaining: '1234.5', expiry_date: '2027-01-01T00:00:00Z', grant_type: 'promotional_credit'}]})};
      if (url.includes('/subscriptions')) return {status_code: 200, body: JSON.stringify({will_renew: true, active_until: '2026-12-03T19:22:00Z'})};
      throw new Error('unexpected ' + url);
    }});
  // The monitor records quota every minute; the endpoint only reads it.
  const recorder = createUsageHistory({directory, now});
  for (let minute = 0; minute <= 30; minute++) {
    recorder.record({version: 1, accounts: {[mine.id]: {provider: 'codex', checkedAt: new Date(clock).toISOString(),
      windows: [{label: '1w', remaining: 100 - used, resetsAt: new Date(resetAt * 1000).toISOString(), scope: 'general'}]}}});
    if (minute < 30) { clock += 60000; used += 0.1; }
  }
  const handler = createClientUsage({usage, now});
  const server = http.createServer((req, res) => {
    if (!usageEndpoint(req)) { res.writeHead(404); res.end(); return; }
    void handler(req, res, {name: 'nate', email: 'nate@example.com'}, () => true);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/usage`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const {accounts} = await response.json();
  assert.deepEqual(accounts.map(a => a.email), ['mine@example.com'], 'only the key holder\'s accounts are exposed');
  const [account] = accounts;
  assert.deepEqual(account.windows, [{label: '1w', remaining: 57, resetsAt: '2026-11-06T17:08:23.000Z'}]);
  assert.equal(account.bankedResets, 1);
  assert.deepEqual(account.resetExpirations, ['2026-11-30T20:06:55.000Z']);
  assert.equal(account.renewsAt, '2026-12-03T19:22:00.000Z');
  assert.equal(account.credits.balance, 1234.5);
  assert.deepEqual(account.credits.grants, [{remaining: 1234.5, granted: 62500, expiresAt: '2027-01-01T00:00:00.000Z', type: 'promotional_credit'}]);
  assert.equal(account.burnRates.basis, '1w');
  assert.equal(account.burnRates.stale, false);
  assert.equal(account.burnRates.tenMinutes.percent, 1, '0.1 points a minute is 1 point per ten minutes');
  assert.equal(account.burnRates.hour.percent, 6);
  assert.equal(account.stale, false);
  assert.ok(!JSON.stringify(accounts).includes('auth_index') && !JSON.stringify(accounts).includes('.json'), 'no internal identifiers');
});
