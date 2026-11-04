'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createUsage, parseCodex, parseClaude, parseCreditGrants} = require('./usage-service.cjs');
const {createCreditUsageWatcher} = require('./credit-usage-watcher.cjs');

const usageBody = (credits, extra = {}) => ({plan_type: 'pro', rate_limit: {primary_window: {used_percent: 100, limit_window_seconds: 604800}},
  credits, spend_control: {reached: false}, ...extra});

test('Codex credits are usable only with a positive balance and no provider cap', () => {
  assert.deepEqual(parseCodex(usageBody({has_credits: true, unlimited: false, overage_limit_reached: false, balance: '22339.0086710000'})).credits,
    {balance: 22339.01, unlimited: false, usable: true, grants: []});
  assert.equal(parseCodex(usageBody({has_credits: false, unlimited: false, balance: '-3.27'})).credits.balance, 0);
  assert.equal(parseCodex(usageBody({has_credits: false, unlimited: false, balance: '-3.27'})).credits.usable, false);
  assert.equal(parseCodex(usageBody({has_credits: true, balance: '10', overage_limit_reached: true})).credits.usable, false);
  assert.equal(parseCodex(usageBody({has_credits: true, balance: '10'}, {spend_control: {reached: true}})).credits.usable, false);
  assert.equal(parseCodex(usageBody({has_credits: true, unlimited: true, balance: null})).credits.usable, true);
  assert.equal(parseCodex(usageBody(undefined)).credits, null);
  assert.equal(parseCodex(usageBody({has_credits: true, balance: 'not a number'})).credits, null);
});

test('credit grants keep only live balances with their expiry, soonest first', () => {
  const at = Date.parse('2026-11-04T00:00:00Z');
  const grants = parseCreditGrants({expiring_balance_details: [
    {amount_granted: '62500', amount_remaining: '50138.968338', expiry_date: '2027-01-01T00:00:00Z', grant_type: 'promotional_credit'},
    {amount_granted: '1000', amount_remaining: '250', expiry_date: '2026-12-01T00:00:00Z', grant_type: 'purchased'},
    {amount_granted: '1000', amount_remaining: '0', expiry_date: '2027-02-01T00:00:00Z'},
    {amount_granted: '1000', amount_remaining: '5', expiry_date: '2026-11-01T00:00:00Z'},
    {amount_remaining: '5', expiry_date: 'garbage'},
    {amount_remaining: '7', expiry_date: '2027-03-01T00:00:00Z', grant_type: '<script>'},
  ]}, at);
  assert.deepEqual(grants, [
    {remaining: 250, granted: 1000, expiresAt: '2026-12-01T00:00:00.000Z', type: 'purchased'},
    {remaining: 50138.97, granted: 62500, expiresAt: '2027-01-01T00:00:00.000Z', type: 'promotional_credit'},
    {remaining: 7, granted: null, expiresAt: '2027-03-01T00:00:00.000Z', type: null},
  ]);
  assert.deepEqual(parseCreditGrants(null, at), []);
});

test('Claude usage credits are reported but billed extra usage is never usable without a prepaid balance', () => {
  const off = parseClaude({seven_day: {utilization: 10}, spend: {used: {amount_minor: 0, currency: 'USD', exponent: 2}, enabled: false, balance: null}});
  assert.deepEqual(off.credits, {balance: null, currency: 'USD', extraUsage: false, unlimited: false, usable: false, grants: []});
  const prepaid = parseClaude({seven_day: {utilization: 10}, spend: {enabled: true, balance: {amount_minor: 2550, currency: 'USD', exponent: 2}}});
  assert.equal(prepaid.credits.balance, 25.5);
  assert.equal(prepaid.credits.usable, true);
  assert.equal(parseClaude({seven_day: {utilization: 10}, spend: {enabled: true, balance: null}}).credits.usable, false);
});

test('usage and routing snapshots carry credits and grant expiry, refreshing grants every five minutes', async t => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-credits-'));
  t.after(() => fs.rmSync(authDir, {recursive: true, force: true}));
  const account = {id: 'codex-a.json', provider: 'codex', email: 'a@example.com'};
  fs.writeFileSync(path.join(authDir, account.id), JSON.stringify({type: 'codex', email: account.email, account_id: 'acct-1'}));
  let clock = Date.parse('2026-11-04T18:00:00Z');
  const calls = [];
  const usage = createUsage({authDir, details: false, routingCredits: false, now: () => clock,
    admin: {snapshot: async () => ({accounts: [account], users: [{name: 'nate', email: 'n@example.com', enabled: true, editable: true, accounts: [account.id]}]})},
    management: async (endpoint, input) => {
      if (endpoint === 'auth-files') return {files: [{id: account.id, type: 'codex', auth_index: 'idx'}]};
      calls.push(input.url);
      if (input.url.endsWith('/remaining_balance')) {
        assert.equal(input.url, 'https://chatgpt.com/backend-api/accounts/acct-1/remaining_balance');
        return {status_code: 200, body: JSON.stringify({balance: '500', expiring_balance_details: [
          {amount_granted: '62500', amount_remaining: '500', expiry_date: '2027-01-01T00:00:00Z', grant_type: 'promotional_credit'}]})};
      }
      return {status_code: 200, body: JSON.stringify(usageBody({has_credits: true, balance: '500'}))};
    }});
  const routing = (await usage.getForRouting()).accounts[account.id];
  assert.deepEqual(routing.credits, {usable: true, balance: 500, unlimited: false, expiresAt: '2027-01-01T00:00:00.000Z'});
  const forUser = (await usage.getForUser({name: 'nate', email: 'n@example.com'})).accounts[0];
  assert.equal(forUser.credits.grants[0].expiresAt, '2027-01-01T00:00:00.000Z');
  assert.equal(calls.filter(url => url.endsWith('/remaining_balance')).length, 1);
  clock += 60 * 1000;
  await usage.getForRouting();
  assert.equal(calls.filter(url => url.endsWith('/remaining_balance')).length, 1, 'grants are cached between usage reads');
  clock += 5 * 60 * 1000;
  await usage.getForRouting();
  assert.equal(calls.filter(url => url.endsWith('/remaining_balance')).length, 2);
});

test('credit watcher alerts once per spending episode and explains whether the hub chose credits', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-credit-watch-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const events = [];
  let clock = Date.parse('2026-11-04T18:00:00Z');
  const make = () => createCreditUsageWatcher({directory, now: () => clock, enqueue: (id, text) => events.push({id, text}),
    accountLabel: file => `Codex: ${file.id}`});
  let watcher = make();
  const snapshot = (balance, otherRemaining) => ({version: 1, accounts: {
    'a.json': {provider: 'codex', checkedAt: new Date(clock).toISOString(), windows: [{label: '1w', remaining: 0, resetsAt: '2026-11-06T17:08:23.000Z'}],
      credits: {usable: true, balance, unlimited: false, expiresAt: '2027-01-01T00:00:00.000Z'}},
    'b.json': {provider: 'codex', checkedAt: new Date(clock).toISOString(), windows: [{label: '1w', remaining: otherRemaining}]},
  }});
  watcher.observe(snapshot(1000, 0));
  assert.equal(events.length, 0, 'the first observation is only a baseline');
  clock += 60000; watcher.observe(snapshot(990, 0));
  assert.equal(events.length, 1);
  assert.match(events[0].text, /Codex credits are being used/);
  assert.match(events[0].text, /Codex: a\.json/);
  assert.match(events[0].text, /Spent 10 credits since the last check; 990 left, expiring Jan 1, 2027/);
  assert.match(events[0].text, /Every Codex plan in the hub is used up/);
  assert.match(events[0].id, /^credits-[a-f0-9]{16}-\d+$/);
  clock += 60000; watcher.observe(snapshot(985, 0));
  watcher = make(); // State survives restarts.
  clock += 60000; watcher.observe(snapshot(980, 0));
  assert.equal(events.length, 1, 'continued spending in the same episode does not repeat the alert');
  clock += 61 * 60000; watcher.observe(snapshot(980, 0));
  clock += 60000; watcher.observe(snapshot(970, 50));
  assert.equal(events.length, 2, 'spending after an hour of quiet starts a new episode');
  assert.match(events[1].text, /likely direct use of the account outside the hub/);
  clock += 60000; watcher.observe(snapshot(5000, 50));
  clock += 20 * 60000; watcher.observe(snapshot(4000, 50));
  assert.equal(events.length, 2, 'top-ups and observations far apart are not counted as spending');
});
