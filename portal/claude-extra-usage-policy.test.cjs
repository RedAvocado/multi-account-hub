'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createClaudeExtraUsagePolicy} = require('./claude-extra-usage-policy.cjs');

const UUID = '11111111-2222-3333-4444-555555555555';
const PROFILE = 'https://api.anthropic.com/api/oauth/profile';
const file = (id, disabled = false) => ({id: `${id}@private.example.json`, type: 'claude', auth_index: id, disabled});
const reply = body => ({status_code: 200, body: JSON.stringify(body)});
function fixture(t, handler) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-billing-policy-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  let clock = 1000000, files = [file('first')], unavailable = false;
  const calls = [];
  const service = createClaudeExtraUsagePolicy({directory, now: () => clock, management: async (endpoint, input) => {
    if (endpoint === 'auth-files') {
      if (unavailable) throw new Error('synthetic private account detail');
      return {files};
    }
    assert.equal(endpoint, 'api-call');
    assert.equal(input.header.Authorization, 'Bearer $TOKEN$');
    calls.push(input);
    if (input.method === 'PUT') {
      assert.equal(input.url, `https://api.anthropic.com/api/oauth/organizations/${UUID}/overage_spend_limit`);
      assert.deepEqual(JSON.parse(input.data), {is_enabled: false}, 'the only allowed mutation disables extra usage');
      assert.equal(input.header['x-organization-uuid'], UUID);
    } else { assert.equal(input.method, 'GET'); assert.equal(input.url, PROFILE); }
    return handler(input);
  }});
  return {service, calls, directory, advance: ms => {clock += ms;}, setFiles: value => {files = value;},
    setUnavailable: value => {unavailable = value;},
    read: () => JSON.parse(fs.readFileSync(path.join(directory, 'claude-extra-usage-policy.json'), 'utf8'))};
}

test('all Claude accounts are checked, enabled extra usage is disabled and independently verified, and state is private', async t => {
  let enabled = true;
  const f = fixture(t, input => {
    if (input.method === 'PUT') { enabled = false; return reply({is_enabled: false}); }
    return reply({organization: {uuid: UUID, has_extra_usage_enabled: input.auth_index === 'first' ? enabled : false}});
  });
  f.setFiles([file('first'), file('disabled', true), {id: 'codex.json', type: 'codex', auth_index: 'codex'}]);
  const pending = f.service.refresh();
  assert.equal(f.service.refresh(), pending, 'overlapping scans share one run');
  const result = await pending;
  assert.deepEqual(Object.values(result.accounts).map(a => a.state), ['off', 'off']);
  assert.equal(f.calls.length, 4);
  assert.equal(f.calls.filter(c => c.method === 'PUT').length, 1);
  assert.ok(Object.values(result.accounts)[0].disabledAt);
  const target = path.join(f.directory, 'claude-extra-usage-policy.json');
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(target, 'utf8').includes('private.example'));
  assert.ok(Object.keys(result.accounts).every(key => /^[a-f0-9]{64}$/.test(key)));
});

test('new accounts are checked on discovery, existing accounts are rechecked for drift after five minutes, and removed records are pruned', async t => {
  let enabled = false;
  const f = fixture(t, input => {
    if (input.method === 'PUT') {enabled = false; return reply({is_enabled: false});}
    return reply({organization: {uuid: UUID, has_extra_usage_enabled: enabled}});
  });
  await f.service.refresh();
  f.advance(60000);f.setFiles([file('first'), file('new')]);
  await f.service.refresh();
  assert.equal(f.calls.length, 2, 'existing off accounts do not add minute-by-minute provider calls');
  assert.equal(Object.keys(f.read().accounts).length, 2);
  f.advance(4 * 60000);enabled = true;
  await f.service.refresh();
  assert.equal(f.calls.filter(c => c.method === 'PUT').length, 1);
  assert.ok(Object.values(f.read().accounts).every(a => a.state === 'off'));
  f.setFiles([]);await f.service.refresh();
  assert.equal(Object.keys(f.read().accounts).length, 0);
});

test('provider retry hints are honored and failures remain unverified without modifying billing', async t => {
  const f = fixture(t, () => ({status_code: 429, header: {'Retry-After': ['600']}, body: '{}'}));
  const first = await f.service.refresh(), record = Object.values(first.accounts)[0];
  assert.equal(record.state, 'unverified');assert.equal(record.checkedAt, null);
  assert.equal(record.error, 'http_429');
  assert.equal(record.nextCheckAt - record.lastAttemptAt, 600000);
  f.advance(5 * 60000);await f.service.refresh();assert.equal(f.calls.length, 1);
  f.advance(5 * 60000);await f.service.refresh();assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(c => c.method === 'GET'));
});

test('unknown settings, unsafe organization IDs, denied updates and unconfirmed writes never report success', async t => {
  for (const scenario of ['unknown', 'invalidOrg', 'denied', 'unconfirmed', 'notChanged']) {
    const f = fixture(t, input => {
      if (input.method === 'PUT') {
        if (scenario === 'denied') return {status_code: 403, body: '{}'};
        return reply(scenario === 'unconfirmed' ? {} : {is_enabled: false});
      }
      if (scenario === 'unknown') return reply({organization: {uuid: UUID}});
      return reply({organization: {uuid: scenario === 'invalidOrg' ? '../unrelated' : UUID, has_extra_usage_enabled: true}});
    });
    const result = await f.service.refresh(), record = Object.values(result.accounts)[0];
    assert.equal(record.state, 'unverified', scenario);
    assert.equal(record.checkedAt, null, scenario);
    if (scenario === 'unknown' || scenario === 'invalidOrg') assert.ok(f.calls.every(c => c.method === 'GET'));
  }
});

test('already off accounts need no billing permissions and account-list failures cannot fabricate a fresh verification', async t => {
  const f = fixture(t, () => reply({organization: {has_extra_usage_enabled: false}}));
  await f.service.refresh();
  const previous = f.read();assert.equal(Object.values(previous.accounts)[0].state, 'off');
  f.advance(600000);f.setUnavailable(true);
  await assert.rejects(f.service.refresh());
  assert.deepEqual(f.read(), previous);
  assert.ok(f.calls.every(c => c.method === 'GET'));
});

test('Team extra usage requires admin controls and cannot be reported as disabled by this API', async t => {
  const f = fixture(t, () => reply({organization: {uuid: UUID, organization_type: 'claude_team', has_extra_usage_enabled: true}}));
  const record = Object.values((await f.service.refresh()).accounts)[0];
  assert.equal(record.state, 'unverified');
  assert.equal(record.error, 'team_admin_required');
  assert.equal(record.nextCheckAt - record.lastAttemptAt, 5 * 60000);
  assert.ok(f.calls.every(c => c.method === 'GET'));
});
