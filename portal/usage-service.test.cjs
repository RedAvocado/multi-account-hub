'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createUsage, parseCodex, parseClaude} = require('./usage-service.cjs');

test('usage parsers report remaining rather than used and do not invent missing quotas', () => {
  const codex = parseCodex({plan_type: 'pro', rate_limit: {
    primary_window: {limit_window_seconds: 604800, used_percent: 75, reset_at: 1793600591},
    secondary_window: {limit_window_seconds: 18000, used_percent: 12},
  }, rate_limit_reset_credits: {available_count: 2}});
  assert.deepEqual(codex.windows.map(x => [x.label, x.remaining]), [['1w', 25], ['5h', 88]]);
  assert.equal(codex.bankedResets, 2);
  assert.equal(parseCodex({rate_limit: {primary_window: {limit_window_seconds: 604800}}}).windows.length, 0);
  assert.equal(parseCodex({rate_limit: {primary_window: {limit_window_seconds: 604800, used_percent: 101}}}).windows.length, 0);
  const claude = parseClaude({five_hour: {utilization: 8, resets_at: '2026-10-27T18:00:00Z'},
    seven_day: {utilization: 35}, limits: [{kind: 'weekly_scoped', is_active: true,
      scope: {model: {display_name: 'Fable 5'}}, percent: 20}]});
  assert.deepEqual(claude.windows.map(x => [x.label, x.remaining]), [['5h', 92], ['1w', 65], ['Fable', 80]]);
  assert.equal(parseClaude({iguana_necktie: {utilization: 20, limit_dollars: 100}}).windows.length, 0);
});

test('usage respects exact account grants, hides personal information, caches results, and rechecks revocations', async () => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-usage-test-'));
  const accounts = [
    {id: 'work.json', email: 'work@example.com', provider: 'codex', personal: false, disabled: false},
    {id: 'personal.json', email: 'owner-private@example.net', provider: 'codex', personal: true, owner: 'riley', disabled: false},
    {id: 'disabled.json', email: 'bad@example.com', provider: 'claude', personal: false, disabled: true},
  ];
  for (const a of accounts.slice(0, 2)) fs.writeFileSync(path.join(authDir, a.id), JSON.stringify({type: a.provider, email: a.email, account_id: 'synthetic-account'}));
  const users = [
    {name: 'riley', email: 'riley@example.org', enabled: true, editable: true, accounts: ['work.json','personal.json']},
    // Defense in depth: even an accidental grant cannot expose the personal account.
    {name: 'jordan', email: 'jordan@example.org', enabled: true, editable: true, accounts: ['work.json','personal.json','disabled.json']},
  ];
  let clock = 1000000, calls = 0, fail = false, release;
  const admin = {async snapshot() { return {users, accounts}; }};
  const management = async (endpoint, input) => {
    if (endpoint === 'auth-files') return {files: accounts.map(a => ({id:a.id,type:a.provider,disabled:a.disabled,auth_index:a.id.split('.')[0]}))};
    calls++;
    assert.equal(input.header.Authorization, 'Bearer $TOKEN$');
    assert.ok(input.url.startsWith('https://chatgpt.com/backend-api/'));
    if (release) await new Promise(resolve => { release.resolve = resolve; });
    if (fail) throw new Error('synthetic outage');
    if (input.url.endsWith('/wham/usage')) return {status_code: 200, body: JSON.stringify({plan_type:'pro', rate_limit:{primary_window:{limit_window_seconds:604800,used_percent:40,reset_at:1793600591}}, rate_limit_reset_credits:{available_count:2}})};
    if (input.url.includes('reset-credits')) return {status_code:200,body:JSON.stringify({available_count:2,credits:[{status:'available',expires_at:'2026-11-06T12:00:00Z'},{status:'used',expires_at:'2026-11-01T12:00:00Z'}]})};
    return {status_code:200,body:JSON.stringify({will_renew:true,entitlement:{renews_at:'2026-11-07T12:00:00Z'}})};
  };
  const usage = createUsage({admin, authDir, management, now:()=>clock});
  const jordan = {name:'jordan', email:'jordan@example.org'};
  try {
    const first = await usage.getForUser(jordan);
    assert.equal(first.accounts.length, 1);
    assert.equal(first.accounts[0].windows[0].remaining, 60);
    assert.equal(first.accounts[0].resetExpirations.length, 1);
    assert.equal(first.accounts[0].renewsAt, '2026-11-07T12:00:00.000Z');
    assert.ok(!JSON.stringify(first).includes('owner-private'));
    assert.ok(!JSON.stringify(first).includes('synthetic-account'));
    assert.equal(calls, 3);
    const id = first.accounts[0].id;
    assert.match(id, /^[a-f0-9]{64}$/);
    assert.equal((await usage.listForUser(jordan)).length, 1);
    assert.equal((await usage.getForUser(jordan, {id: 'f'.repeat(64)})).accounts.length, 0);
    await usage.getForUser(jordan); assert.equal(calls, 3);
    clock += 29999;
    await usage.getForUser(jordan); assert.equal(calls, 3);
    clock += 1;
    await Promise.all(Array.from({length: 12}, () => usage.getForUser(jordan, {id})));
    assert.equal(calls, 6, 'concurrent readers share one refresh exactly at 30 seconds');
    clock += 301000; fail = true;
    const stale = await usage.getForUser(jordan);
    assert.equal(stale.accounts[0].stale, true);
    assert.equal(stale.accounts[0].windows[0].remaining, 60);
    clock += 61000; fail = false; release = {};
    const pending = usage.getForUser(jordan);
    while (!release.resolve) await new Promise(resolve => setImmediate(resolve));
    users[1].accounts = [];
    release.resolve(); release = null;
    assert.equal((await pending).accounts.length, 0);
    const riley = await usage.getForUser({name:'riley',email:'riley@example.org'});
    assert.equal(riley.accounts.length, 2);
    assert.ok(riley.accounts.some(a => a.email === 'owner-private@example.net'));
    const privateJordan = {id:'jordan-personal.json', email:'private-jordan@example.com', provider:'codex', personal:true, owner:'jordan', disabled:false};
    accounts.push(privateJordan);
    fs.writeFileSync(path.join(authDir,privateJordan.id),JSON.stringify({type:'codex',email:privateJordan.email,account_id:'synthetic-account'}));
    users[0].accounts.push(privateJordan.id);
    users[1].accounts = [privateJordan.id];
    assert.ok(!(await usage.getForUser({name:'riley',email:'riley@example.org'})).accounts.some(a=>a.email===privateJordan.email));
    assert.ok((await usage.getForUser(jordan)).accounts.some(a=>a.email===privateJordan.email));
    users[1].enabled = false;
    await assert.rejects(usage.getForUser(jordan));
  } finally { fs.rmSync(authDir, {recursive:true,force:true}); }
});
