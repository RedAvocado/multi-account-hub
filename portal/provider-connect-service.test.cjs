'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
const {createProviderConnect}=require('./provider-connect-service.cjs');

test('provider logins are isolated per person and hand the verified staged credential to its owner',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hub-provider-flow-'));
  const children=[];const claims=[];
  const admin={async claimAccount(identity,record,visibility){claims.push({identity,record,visibility});return {email:record.email,assigned:true};}};
  const spawn=(helper,args)=>{
    const process=new EventEmitter();process.pid=1234;process.exitCode=null;process.killed=false;
    process.stdout=new PassThrough();process.stderr=new PassThrough();process.stdin=new PassThrough();
    process.kill=()=>{process.killed=true;};
    const stage=path.dirname(args[args.indexOf('-config')+1]);
    children.push({process,stage,args});
    setImmediate(()=>{
      if(args.includes('-claude-login')) process.stdout.write('https://claude.ai/oauth/authorize?state='+('a'.repeat(32))+'&redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback&code_challenge_method=S256\n');
      else process.stdout.write('Codex device code: ABCD-12345\n');
    });
    return process;
  };
  const connect=createProviderConnect({directory,admin,spawn,helper:'/synthetic/helper'});
  const riley={id:'riley-session',name:'riley',email:'riley@example.org'};
  const jordan={id:'jordan-session',name:'jordan',email:'jordan@example.org'};
  try {
    const [claude,codex]=await Promise.all([connect.start(riley,{provider:'claude',visibility:'personal'}),connect.start(jordan,{provider:'codex',visibility:'team'})]);
    assert.equal(claude.status,'waiting');assert.equal(codex.deviceCode,'ABCD-12345');
    assert.notEqual(children[0].stage,children[1].stage);
    assert.equal((await connect.status({...riley,id:'other-session'})).status,'idle');
    await assert.rejects(connect.submit(riley,{callback:'http://localhost:54545/callback?state=wrong&code=abc'}),e=>e.status===400);
    await connect.submit(riley,{callback:`http://localhost:54545/callback?state=${'a'.repeat(32)}&code=abc`});
    const c=children.find(x=>x.args.includes('-claude-login'));
    fs.writeFileSync(path.join(c.stage,'auth','one.json'),JSON.stringify({type:'claude',email:'riley@example.com',access_token:'test',refresh_token:'test'}));
    c.process.exitCode=0;c.process.emit('close',0);
    assert.equal((await connect.status(riley)).status,'complete');
    assert.equal(claims[0].identity.name,'riley');assert.equal(claims[0].visibility,'personal');
    const d=children.find(x=>x.args.includes('-codex-device-login'));
    fs.writeFileSync(path.join(d.stage,'auth','one.json'),JSON.stringify({type:'codex',email:'jordan@example.com',access_token:'test',refresh_token:'test'}));
    d.process.exitCode=0;d.process.emit('close',0);
    assert.equal((await connect.status(jordan)).status,'complete');
    assert.equal(claims[1].identity.name,'jordan');assert.equal(claims[1].visibility,'team');
    assert.equal(fs.existsSync(c.stage),false);assert.equal(fs.existsSync(d.stage),false);
  } finally {connect.close();fs.rmSync(directory,{recursive:true,force:true});}
});
