'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {spawn} = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const {createUsage, parseCodex, parseClaude, claudePlan} = require('./usage-service.cjs');

test('Claude plan names use confirmed multipliers and seat tiers without guessing unknown tiers', () => {
  const max = {account: {has_claude_max: true}, organization: {rate_limit_tier: 'default_claude_max_20x'}};
  assert.equal(claudePlan(max), 'Max 20×');
  assert.equal(claudePlan({...max, organization: {rate_limit_tier: 'default_claude_max_5x'}}), 'Max 5×');
  for (const tier of [undefined, 'unknown', 'constructor', '__proto__']) {
    assert.equal(claudePlan({...max, organization: {rate_limit_tier: tier}}), 'Max');
  }
  assert.equal(claudePlan({organization: {organization_type: 'claude_team', seat_tier: 'team_standard'}}), 'Team — Standard');
  assert.equal(claudePlan({account: {has_claude_max: true}, organization: {organization_type: 'claude_team', seat_tier: 'team_premium'}}), 'Team — Premium');
  assert.equal(claudePlan({organization: {organization_type: 'claude_team', seat_tier: 'unknown'}}), 'Team');
  assert.equal(claudePlan({organization: {organization_type: 'claude_enterprise'}}), 'Enterprise');
  assert.equal(claudePlan({account: {has_claude_pro: true}}), 'Pro');
  assert.equal(claudePlan({}), null);
  assert.equal(claudePlan(null), null);
});

test('operator reset invalidation refreshes quota and credit details without affecting other accounts', async t => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-operator-invalidation-'));
  t.after(() => fs.rmSync(authDir, {recursive: true, force: true}));
  const accounts = ['a', 'b'].map(id => ({id: id + '.json', provider: 'codex', email: id + '@example.com'}));
  for (const a of accounts) fs.writeFileSync(path.join(authDir, a.id), JSON.stringify({type: 'codex', email: a.email, account_id: a.id[0]}));
  const reads = [], now = Date.parse('2026-10-29T18:00:00Z'); let used = 100;
  const service = createUsage({authDir, details: false, routingCredits: true, now: () => now,
    admin: {snapshot: async () => ({accounts, users: [{enabled: true, editable: true, accounts: accounts.map(a => a.id)}]})},
    management: async (endpoint, input) => {
      if (endpoint === 'auth-files') return {files: accounts.map(a => ({id: a.id, type: 'codex', auth_index: a.id[0]}))};
      reads.push(input.auth_index);
      return {status_code: 200, body: JSON.stringify(input.url.endsWith('/usage') ? {
        rate_limit: {primary_window: {used_percent: used, limit_window_seconds: 604800}}, rate_limit_reset_credits: {available_count: used ? 1 : 0},
      } : {available_count: used ? 1 : 0, credits: used ? [{id: 'credit', status: 'available', reset_type: 'codex_rate_limits', expires_at: '2026-10-30T18:00:00Z'}] : []})};
    }});
  await service.getForRouting(); assert.equal(reads.length, 4);
  used = 0; service.invalidateAccount('a.json');
  const snapshot = await service.getForRouting();
  assert.equal(snapshot.accounts['a.json'].windows[0].remaining, 100);
  assert.equal(snapshot.accounts['a.json'].resetCredits.availableCount, 0);
  assert.equal(snapshot.accounts['b.json'].windows[0].remaining, 0);
  assert.deepEqual(reads.slice(4), ['a', 'a']);
});

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
  const almostEmpty={five_hour:{utilization:99.96}};
  assert.equal(parseClaude(almostEmpty).windows[0].remaining,0,'the usage panel rounds for display');
  assert.ok(parseClaude(almostEmpty,{precise:true}).windows[0].remaining>0,'routing must retain nonzero quota precision');
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
  const historyReads=[];
  const burnRates={basis:'1w',tenMinutes:{percent:1,observedSeconds:1800,windowSeconds:1800}};
  const usage = createUsage({admin, authDir, management, now:()=>clock,history:{get(id,provider){historyReads.push([id,provider]);return burnRates;}}});
  const jordan = {name:'jordan', email:'jordan@example.org'};
  try {
    const first = await usage.getForUser(jordan);
    assert.equal(first.accounts.length, 1);
    assert.equal(first.accounts[0].windows[0].remaining, 60);
    assert.deepEqual(first.accounts[0].burnRates,burnRates);
    assert.deepEqual(historyReads,[['work.json','codex']],'only currently authorized account history is read');
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
    const readsBeforeRevocation=historyReads.length;
    release.resolve(); release = null;
    assert.equal((await pending).accounts.length, 0);
    assert.equal(historyReads.length,readsBeforeRevocation,'permission recheck must happen before reading history');
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

test('shared quota state coordinates processes and backs off provider rate limits', async t => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-shared-usage-'));
  t.after(() => fs.rmSync(authDir, {recursive: true, force: true}));
  const account = {id: 'claude.json', provider: 'claude', email: 'claude@example.com', disabled: false};
  const admin = {snapshot: async () => ({accounts: [account], users: [{enabled: true, editable: true, accounts: [account.id]}]})};
  let clock = Date.parse('2026-10-29T18:00:00Z'), mode = 'ok', calls = 0;
  const management = async (endpoint, input) => {
    if (endpoint === 'auth-files') return {files: [{id: account.id, type: 'claude', auth_index: 'claude'}]};
    calls++;
    if (mode === '429') return {status_code: 429, header: {'Retry-After': ['0']}, body: '{}'};
    return {status_code: 200, body: JSON.stringify({five_hour: {utilization: 25, resets_at: '2026-10-29T23:00:00Z'}})};
  };
  const options = {admin, authDir, management, details: false, now: () => clock};
  const first = createUsage(options), second = createUsage(options), third = createUsage(options);
  assert.equal((await first.getForRouting()).accounts[account.id].windows[0].remaining, 75);
  assert.equal(calls, 1);
  clock += 30000; mode = '429';
  assert.equal((await second.getForRouting()).accounts[account.id].windows[0].remaining, 75,
    'a successful shared observation is reused during the 60-second poll interval');
  assert.equal(calls, 1);
  clock += 30001;
  const [outage, concurrent] = await Promise.all([first.getForRouting(), second.getForRouting()]);
  assert.equal(calls, 2, 'a provider failure is shared instead of creating a cross-process stampede');
  assert.equal(outage.accounts[account.id].windows[0].remaining, 75);
  assert.equal(concurrent.accounts[account.id].windows[0].remaining, 75);
  assert.equal((await third.getForRouting()).accounts[account.id].windows[0].remaining, 75,
    'a third instance honors the persisted cooldown instead of retrying at 30 seconds');
  assert.equal(calls, 2);
  clock += 60001; mode = 'ok';
  const recovered = (await third.getForRouting()).accounts[account.id];
  assert.equal(recovered.windows[0].remaining, 75);
  assert.equal(calls, 3, 'the next retry recovers after the bounded cooldown');
  clock += 60001; mode = '429';
  const nextFailure = (await first.getForRouting()).accounts[account.id];
  assert.equal(nextFailure.checkedAt, recovered.checkedAt,
    'a process with an older local cache retains the newer confirmed shared reading after a failed refresh');
  assert.equal((await second.getForRouting()).accounts[account.id].checkedAt, recovered.checkedAt,
    'all processes use the newest confirmed observation during the shared cooldown');
});

test('shared Claude quota keeps profile details local and writes private state', async t => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-claude-details-'));
  t.after(() => fs.rmSync(authDir, {recursive: true, force: true}));
  const account = {id: 'claude.json', provider: 'claude', email: 'claude@example.com'};
  const admin = {snapshot: async () => ({accounts: [account], users: [{name: 'member', email: 'member@example.com', enabled: true, editable: true, accounts: [account.id]}]})};
  let calls = [], failQuota = false;
  const management = async (endpoint, input) => {
    if (endpoint === 'auth-files') return {files: [{id: account.id, type: 'claude', auth_index: 'claude'}]};
    calls.push(input.url);
    if (input.url.endsWith('/profile')) return {status_code: 200, body: JSON.stringify({account: {has_claude_max: true}, organization: {rate_limit_tier: 'default_claude_max_20x'}})};
    if (failQuota) return {status_code: 429, body: '{}'};
    return {status_code: 200, body: JSON.stringify({five_hour: {utilization: 25, resets_at: '2026-10-29T23:00:00Z'}})};
  };
  let now = Date.parse('2026-10-29T18:00:00Z');
  const detailed = createUsage({admin, authDir, management, now: () => now});
  const routing = createUsage({admin, authDir, management, details: false, now: () => now});
  const rich = await detailed.getForUser({name: 'member', email: 'member@example.com'});
  assert.equal(rich.accounts[0].plan, 'Max 20×');
  assert.deepEqual(calls, ['https://api.anthropic.com/api/oauth/usage', 'https://api.anthropic.com/api/oauth/profile']);
  const snapshot = await routing.getForRouting();
  assert.equal(snapshot.accounts[account.id].windows[0].remaining, 75);
  assert.deepEqual(calls, ['https://api.anthropic.com/api/oauth/usage', 'https://api.anthropic.com/api/oauth/profile'],
    'routing reuses only the quota read and does not inherit website profile enrichment');
  const cacheDirectory = path.join(authDir, '.claude-usage-cache');
  const cache = fs.readdirSync(cacheDirectory).find(name => name.endsWith('.json'));
  assert.ok(cache);
  assert.equal(fs.statSync(cacheDirectory).mode & 0o077, 0, 'shared telemetry directory is private');
  assert.equal(fs.statSync(path.join(cacheDirectory, cache)).mode & 0o077, 0, 'shared quota observations are private');
  assert.equal(JSON.parse(fs.readFileSync(path.join(cacheDirectory, cache), 'utf8')).record.value.plan, null);
  now += 31000;
  assert.equal((await detailed.getForUser({name: 'member', email: 'member@example.com'})).accounts[0].plan, 'Max 20×');
  assert.equal(calls.length, 2, 'client refreshes must not repeat optional profile reads');
  now += 30000;
  assert.equal((await detailed.getForUser({name: 'member', email: 'member@example.com'})).accounts[0].plan, 'Max 20×');
  assert.equal(calls.filter(url => url.endsWith('/usage')).length, 2, 'quota refreshes still run once a minute');
  assert.equal(calls.filter(url => url.endsWith('/profile')).length, 1, 'plan metadata is cached independently for fifteen minutes');
  now += 60000; failQuota = true;
  const stale = await detailed.getForUser({name: 'member', email: 'member@example.com'});
  assert.equal(stale.accounts[0].stale, true);
  assert.equal(stale.accounts[0].plan, 'Max 20×', 'shared quota failures must not erase locally confirmed plan details');
});

test('separate Node processes serialize a Claude quota read through the file lock', async t => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-claude-processes-'));
  const counter = path.join(authDir, 'provider-count');
  t.after(() => fs.rmSync(authDir, {recursive: true, force: true}));
  const script = `
    const fs = require('node:fs');
    const {createUsage} = require(${JSON.stringify(path.join(process.cwd(), 'portal/usage-service.cjs'))});
    const account = {id: 'claude.json', provider: 'claude', email: 'claude@example.com'};
    const admin = {snapshot: async () => ({accounts: [account], users: [{enabled: true, editable: true, accounts: [account.id]}]})};
    const management = async (endpoint, input) => {
      if (endpoint === 'auth-files') return {files: [{id: account.id, type: 'claude', auth_index: 'claude'}]};
      fs.appendFileSync(process.env.COUNTER, '1\\n');
      await new Promise(resolve => setTimeout(resolve, 100));
      return {status_code: 200, body: JSON.stringify({five_hour: {utilization: 10}})};
    };
    createUsage({admin, authDir: process.env.AUTH_DIR, management, details: false,
      now: () => 1793296800000}).getForRouting().then(result => {
        if (!result.accounts['claude.json']) process.exitCode = 2;
      }).catch(() => { process.exitCode = 3; });
  `;
  const run = () => new Promise(resolve => {
    const child = spawn(process.execPath, ['-e', script], {cwd: process.cwd(), env: {...process.env, AUTH_DIR: authDir, COUNTER: counter}});
    let error = '';
    child.stderr.on('data', chunk => { error += chunk.toString(); });
    child.on('close', (code, signal) => resolve({code, signal, error}));
  });
  const results = await Promise.all([run(), run()]);
  assert.deepEqual(results.map(result => result.code), [0, 0], results.map(result => result.error).join('\n'));
  assert.equal(fs.readFileSync(counter, 'utf8').trim().split('\n').length, 1);
});

test('Retry-After HTTP dates are honored within the bounded cooldown', async t => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-claude-retry-date-'));
  t.after(() => fs.rmSync(authDir, {recursive: true, force: true}));
  const account = {id: 'claude.json', provider: 'claude', email: 'claude@example.com'};
  const admin = {snapshot: async () => ({accounts: [account], users: [{enabled: true, editable: true, accounts: [account.id]}]})};
  let clock = Date.parse('2026-10-29T18:00:00Z'), calls = 0, mode = '429';
  const management = async (endpoint, input) => {
    if (endpoint === 'auth-files') return {files: [{id: account.id, type: 'claude', auth_index: 'claude'}]};
    calls++;
    if (mode === '429') return {status_code: 429, header: {'retry-after': new Date(clock + 120000).toUTCString()}, body: '{}'};
    return {status_code: 200, body: JSON.stringify({five_hour: {utilization: 10}})};
  };
  const usage = createUsage({admin, authDir, management, details: false, now: () => clock});
  assert.deepEqual((await usage.getForRouting()).accounts, {});
  assert.equal(calls, 1);
  clock += 90000;
  assert.deepEqual((await usage.getForRouting()).accounts, {});
  assert.equal(calls, 1, 'the HTTP date keeps the provider read paused');
  clock += 30001; mode = 'ok';
  assert.equal((await usage.getForRouting()).accounts[account.id].windows[0].remaining, 90);
  assert.equal(calls, 2);
});

test('routing snapshots contain only quota windows for permitted active accounts and preserve observation age on failure', async () => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-routing-usage-'));
  const accounts = [
    {id:'work.json',provider:'codex',email:'work@example.com'},
    {id:'private.json',provider:'codex',email:'private@example.com',personal:true,owner:'other'},
    {id:'disabled.json',provider:'claude',email:'disabled@example.com',disabled:true},
    {id:'unassigned.json',provider:'claude',email:'unassigned@example.com'},
  ];
  const users = [{name:'member',enabled:true,editable:true,accounts:accounts.slice(0,3).map(a=>a.id)}];
  for (const account of accounts) fs.writeFileSync(path.join(authDir,account.id),JSON.stringify({
    type:account.provider,email:account.email,account_id:'synthetic-id',access_token:'secret-must-not-leak',
  }));
  let clock=1800000000000, fail=false, calls=0;
  const usage=createUsage({authDir,details:false,admin:{async snapshot(){return {accounts,users};}},now:()=>clock,
    management:async(endpoint,input)=>{
      if(endpoint==='auth-files')return {files:accounts.map(a=>({id:a.id,type:a.provider,auth_index:a.id.split('.')[0]}))};
      calls++;
      assert.ok(input.url.endsWith('/wham/usage'),'routing must not query reset credits or subscription details');
      if(fail)throw Error('provider unavailable');
      return {status_code:200,body:JSON.stringify({rate_limit:{primary_window:{limit_window_seconds:18000,
        used_percent:100,reset_at:clock/1000+300}}})};
    }});
  try {
    const first=await usage.getForRouting();
    assert.deepEqual(Object.keys(first.accounts),['work.json']);
    assert.deepEqual(first.accounts['work.json'],{provider:'codex',checkedAt:new Date(clock).toISOString(),
      windows:[{label:'5h',remaining:0,resetsAt:new Date(clock+300000).toISOString(),scope:'general',durationSeconds:18000}]});
    const encoded=JSON.stringify(first);
    for(const value of ['secret-must-not-leak','synthetic-id','work@example.com','private.json'])assert.ok(!encoded.includes(value));
    clock+=61000;fail=true;
    const old=await usage.getForRouting();
    assert.equal(old.accounts['work.json'].checkedAt,first.accounts['work.json'].checkedAt,
      'a failed refresh must not make old quota look fresh');
    users[0].accounts=[];
    assert.deepEqual((await usage.getForRouting()).accounts,{});
    assert.equal(calls,2);
  } finally {fs.rmSync(authDir,{recursive:true,force:true});}
});

test('routing credit expirations have an independent cache and preserve successful age through outages', async () => {
  const authDir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-routing-credits-'));
  const account={id:'work.json',provider:'codex',email:'work@example.com'};
  fs.writeFileSync(path.join(authDir,account.id),JSON.stringify({type:'codex',email:account.email,account_id:'private-account-id'}));
  const users=[{name:'member',enabled:true,editable:true,accounts:[account.id]}];
  const started=Date.parse('2026-10-29T18:00:00Z');
  let clock=started, creditCalls=0, usageCalls=0, failCredits=false, availableCount=2;
  const expiry=new Date(started+86400000).toISOString();
  const usage=createUsage({authDir,details:false,routingCredits:true,now:()=>clock,
    admin:{async snapshot(){return {accounts:[account],users};}},
    management:async(endpoint,input)=>{
      if(endpoint==='auth-files')return {files:[{id:account.id,type:'codex',auth_index:'work'}]};
      assert.equal(input.method,'GET','routing must only read reset credits');
      if(input.url.endsWith('/wham/usage')) {
        usageCalls++;
        return {status_code:200,body:JSON.stringify({rate_limit:{primary_window:{limit_window_seconds:18000,used_percent:20}},
          rate_limit_reset_credits:{available_count:availableCount}})};
      }
      assert.ok(input.url.endsWith('/wham/rate-limit-reset-credits'),'routing must not fetch profiles or subscriptions');
      creditCalls++;
      if(failCredits)throw Error('credit outage');
      return {status_code:200,body:JSON.stringify({available_count:2,credits:[
        {id:'private-credit-a',reset_type:'codex_rate_limits',status:'available',expires_at:expiry},
        {id:'private-credit-a',reset_type:'codex_rate_limits',status:'available',expires_at:expiry},
        {id:'private-credit-b',reset_type:'codex_rate_limits',status:'available',expires_at:expiry},
        {id:'expired',reset_type:'codex_rate_limits',status:'available',expires_at:new Date(started-1).toISOString()},
        {id:'used',reset_type:'codex_rate_limits',status:'used',expires_at:expiry},
        {id:'wrong-type',reset_type:'another_product',status:'available',expires_at:expiry},
      ]})};
    }});
  try {
    const snapshots=await Promise.all(Array.from({length:8},()=>usage.getForRouting()));
    const first=snapshots[0].accounts[account.id];
    assert.deepEqual(first.resetCredits,{checkedAt:new Date(started).toISOString(),availableCount:2,expirations:[expiry,expiry]});
    assert.equal(creditCalls,1);assert.equal(usageCalls,1);
    for(const secret of ['private-credit','private-account-id','work@example.com'])assert.ok(!JSON.stringify(snapshots).includes(secret));
    clock+=60000;
    const cached=(await usage.getForRouting()).accounts[account.id];
    assert.equal(cached.resetCredits.availableCount,2);
    assert.equal(cached.resetCredits.checkedAt,first.resetCredits.checkedAt);
    assert.equal(creditCalls,1,'quota refreshes must reuse the independent five-minute credit cache');
    clock=started+300000;availableCount=2;failCredits=true;
    const outage=(await usage.getForRouting()).accounts[account.id];
    assert.equal(outage.checkedAt,new Date(clock).toISOString(),'credit outage must not make current quota stale');
    assert.deepEqual(outage.resetCredits,first.resetCredits,'credit failure must retain the original successful observation time');
    assert.equal(creditCalls,2);
    clock+=30000;
    await usage.getForRouting();assert.equal(creditCalls,2,'failed credit probes back off for one minute');
    clock+=30000;failCredits=false;
    const recovered=(await usage.getForRouting()).accounts[account.id];
    assert.equal(recovered.resetCredits.checkedAt,new Date(clock).toISOString());
    assert.equal(creditCalls,3);
    users[0].accounts=[];
    assert.deepEqual((await usage.getForRouting()).accounts,{});
  } finally {fs.rmSync(authDir,{recursive:true,force:true});}
});

test('partial redemption suppresses an uncertain expiration bonus until changed credit details refresh', async () => {
  const authDir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-routing-credit-redemption-'));
  const account={id:'work.json',provider:'codex',email:'work@example.com'};
  fs.writeFileSync(path.join(authDir,account.id),JSON.stringify({type:'codex',email:account.email,account_id:'synthetic-account'}));
  const started=Date.parse('2026-10-29T18:00:00Z');
  let clock=started, availableCount=2, creditCalls=0, fail=false, inconsistent=false;
  const soon=new Date(started+86400000).toISOString(),later=new Date(started+14*86400000).toISOString();
  const usage=createUsage({authDir,details:false,routingCredits:true,now:()=>clock,
    admin:{async snapshot(){return {accounts:[account],users:[{name:'member',enabled:true,editable:true,accounts:[account.id]}]};}},
    management:async(endpoint,input)=>{
      if(endpoint==='auth-files')return {files:[{id:account.id,type:'codex',auth_index:'work'}]};
      if(input.url.endsWith('/wham/usage'))return {status_code:200,body:JSON.stringify({
        rate_limit:{primary_window:{limit_window_seconds:18000,used_percent:20}},rate_limit_reset_credits:{available_count:availableCount}})};
      creditCalls++;if(fail)throw Error('credit outage');
      return {status_code:200,body:JSON.stringify({available_count:availableCount,credits:[
        ...(availableCount===2||inconsistent?[{id:'soon',reset_type:'codex_rate_limits',status:'available',expires_at:soon}]:[]),
        {id:'later',reset_type:'codex_rate_limits',status:'available',expires_at:later},
      ]})};
    }});
  try {
    assert.deepEqual((await usage.getForRouting()).accounts[account.id].resetCredits.expirations,[soon,later]);
    clock+=60000;availableCount=1;fail=true;
    assert.equal((await usage.getForRouting()).accounts[account.id].resetCredits,undefined,
      'a count decrease cannot preserve the consumed earliest expiration');
    assert.equal(creditCalls,2,'a changed count must refresh before the five-minute cache expires');
    clock+=30000;availableCount=2;
    assert.equal((await usage.getForRouting()).accounts[account.id].resetCredits,undefined);
    assert.equal(creditCalls,2,'an intervening count increase must not restore invalidated expirations during backoff');
    clock+=30000;fail=false;availableCount=1;
    const refreshed=(await usage.getForRouting()).accounts[account.id].resetCredits;
    assert.deepEqual(refreshed,{checkedAt:new Date(clock).toISOString(),availableCount:1,expirations:[later]});
    assert.equal(creditCalls,3);
    clock+=60000;availableCount=2;
    assert.deepEqual((await usage.getForRouting()).accounts[account.id].resetCredits.expirations,[soon,later]);
    clock+=60000;availableCount=1;inconsistent=true;
    assert.equal((await usage.getForRouting()).accounts[account.id].resetCredits,undefined,
      'fresh details with count one and two available expirations must not guess that the soonest credit survived');
    clock+=30000;
    assert.equal((await usage.getForRouting()).accounts[account.id].resetCredits,undefined);
    assert.equal(creditCalls,5,'inconsistent provider details must back off without applying a bonus');
    clock+=30000;inconsistent=false;
    assert.deepEqual((await usage.getForRouting()).accounts[account.id].resetCredits.expirations,[later]);
  } finally {fs.rmSync(authDir,{recursive:true,force:true});}
});

test('slow credit reads cannot advance a pre-reset quota observation beyond its reset', async () => {
  const authDir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-routing-credit-delay-'));
  const account={id:'work.json',provider:'codex',email:'work@example.com'};
  fs.writeFileSync(path.join(authDir,account.id),JSON.stringify({type:'codex',email:account.email,account_id:'synthetic-account'}));
  const observed=Date.parse('2026-10-29T18:00:00Z');
  let clock=observed;
  const usage=createUsage({authDir,details:false,routingCredits:true,now:()=>clock,
    admin:{async snapshot(){return {accounts:[account],users:[{name:'member',enabled:true,editable:true,accounts:[account.id]}]};}},
    management:async(endpoint,input)=>{
      if(endpoint==='auth-files')return {files:[{id:account.id,type:'codex',auth_index:'work'}]};
      if(input.url.endsWith('/wham/usage'))return {status_code:200,body:JSON.stringify({
        rate_limit:{primary_window:{limit_window_seconds:18000,used_percent:100,reset_at:(observed+5000)/1000}}})};
      clock+=14000;throw Error('slow credit failure');
    }});
  try {
    const accountQuota=(await usage.getForRouting()).accounts[account.id];
    assert.equal(accountQuota.checkedAt,new Date(observed).toISOString());
    assert.equal(accountQuota.windows[0].resetsAt,new Date(observed+5000).toISOString());
    assert.ok(Date.parse(accountQuota.checkedAt)<Date.parse(accountQuota.windows[0].resetsAt));
    assert.ok(clock>Date.parse(accountQuota.windows[0].resetsAt));
    assert.equal(accountQuota.resetCredits,undefined);
  } finally {fs.rmSync(authDir,{recursive:true,force:true});}
});
