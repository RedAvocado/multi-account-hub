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
