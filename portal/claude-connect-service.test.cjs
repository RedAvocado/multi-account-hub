'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createClaudeConnect, privatizeCredential} = require('./claude-connect-service.cjs');

function fixture() {
  let clock = 1000000, sequence = 0, exchange = 'wait';
  const calls = [];
  const accounts = [{id:'old.json',provider:'claude',email:'old@example.com',disabled:true}];
  const users = [{name:'riley',email:'riley@example.org',enabled:true,editable:true,accounts:['codex.json']},
    {name:'jordan',email:'jordan@example.org',enabled:true,editable:true,accounts:['codex.json']}];
  const admin = {
    async snapshot() { return {accounts:structuredClone(accounts),users:structuredClone(users),version:'a'.repeat(64)}; },
    async setPermissions(input) { assert.equal(input.user,'riley'); users[0].accounts = input.accounts; },
  };
  const management = async (method,endpoint,body) => {
    calls.push({method,endpoint,body});
    if (endpoint === 'anthropic-auth-url') {
      const state = (++sequence).toString(16).padStart(32,'0');
      return {status:'ok',state,url:`https://claude.ai/oauth/authorize?state=${state}&redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback&code_challenge_method=S256`};
    }
    if (endpoint === 'oauth-callback') return {status:'ok'};
    if (endpoint.startsWith('get-auth-status?')) return {status:exchange};
    if (endpoint.startsWith('oauth-session?')) return {status:'ok'};
    throw new Error('unexpected request');
  };
  const service = createClaudeConnect({admin,authDir:'/unused',management,now:()=>clock,secureCredential:()=>{}});
  const identity = {id:'session-a',name:'riley',email:'riley@example.org'};
  return {service,identity,calls,accounts,users,setExchange:s=>{exchange=s;},tick:ms=>{clock+=ms;}};
}

test('Claude login is session-bound, rejects forged callbacks, and grants only Riley a new account', async () => {
  const f = fixture(), s = f.service;
  const start = await s.start(f.identity);
  assert.equal(start.status,'waiting');
  const state = new URL(start.url).searchParams.get('state');
  assert.equal((await s.start(f.identity)).url,start.url);
  assert.equal((await s.status({...f.identity,id:'different-session'})).status,'idle');
  const wrongSession = {...f.identity,id:'different-session'};
  await assert.rejects(s.submit(wrongSession,{callback:`http://localhost:54545/callback?state=${state}&code=synthetic`}));
  for (const callback of [
    `https://attacker.test/callback?state=${state}&code=synthetic`,
    `http://localhost:54545/callback?state=wrong&code=synthetic`,
    `http://localhost:54545/callback?state=${state}&state=${state}&code=synthetic`,
    `http://localhost:54545/callback?state=${state}&code=synthetic#fragment`,
  ]) await assert.rejects(s.submit(f.identity,{callback}), error=>error.status===400);
  assert.equal(f.calls.filter(x=>x.endpoint==='oauth-callback').length,0);
  const done = await s.submit(f.identity,{callback:`http://localhost:54545/callback?state=${state}&code=synthetic-code`});
  assert.equal(done.status,'exchanging');
  await assert.rejects(s.submit(f.identity,{callback:'repeat'}), error=>error.status===409);
  assert.equal((await s.status(f.identity)).status,'exchanging');
  f.accounts.push({id:'new.json',provider:'claude',email:'new@example.com',disabled:false});
  f.setExchange('ok');
  assert.deepEqual(await s.status(f.identity),{status:'complete',account:'new@example.com',assigned:true});
  assert.deepEqual(f.users[0].accounts,['codex.json','new.json']);
  assert.deepEqual(f.users[1].accounts,['codex.json']);
  assert.ok(!JSON.stringify(await s.status(f.identity)).includes('synthetic-code'));
  assert.equal((await s.start(f.identity)).status,'waiting');
});

test('credential permissions are private and reject symlinks or traversal', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'claude-credential-mode-'));
  try {
    fs.writeFileSync(path.join(dir,'account.json'),'{}',{mode:0o644});
    privatizeCredential(dir,'account.json');
    assert.equal(fs.statSync(path.join(dir,'account.json')).mode & 0o777,0o600);
    fs.symlinkSync('account.json',path.join(dir,'symlink.json'));
    assert.throws(()=>privatizeCredential(dir,'symlink.json'));
    assert.throws(()=>privatizeCredential(dir,'../account.json'));
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('cancellation, expiry, and ambiguous new accounts do not grant access', async () => {
  const f=fixture(), s=f.service;
  await s.start(f.identity);
  await s.cancel(f.identity);
  assert.ok(f.calls.some(x=>x.method==='DELETE'&&x.endpoint.startsWith('oauth-session?')));
  assert.equal((await s.status(f.identity)).status,'idle');
  let start=await s.start(f.identity);
  f.tick(291000);
  assert.equal((await s.status(f.identity)).status,'idle');
  await assert.rejects(s.submit(f.identity,{callback:'expired'}), error=>error.status===409);
  start=await s.start(f.identity);
  const state=new URL(start.url).searchParams.get('state');
  await s.submit(f.identity,{callback:`http://localhost:54545/callback?state=${state}&code=synthetic`});
  f.accounts.push({id:'new-one.json',provider:'claude',email:'one@example.com',disabled:false},
    {id:'new-two.json',provider:'claude',email:'two@example.com',disabled:false});
  f.setExchange('ok');
  assert.deepEqual(await s.status(f.identity),{status:'complete',account:null,assigned:false});
  assert.deepEqual(f.users[0].accounts,['codex.json']);
});
