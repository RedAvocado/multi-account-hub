'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {createAdministration} = require('./admin-service.cjs');

test('personal ownership, sharing, duplicate claims, and reauthentication stay inside exact routing rules', async () => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hub-ownership-'));
  const authDir=path.join(directory,'auth'); fs.mkdirSync(authDir);
  const personal={type:'codex',email:'personal@example.com',account_id:'personal-account',access_token:'test',refresh_token:'test'};
  fs.writeFileSync(path.join(authDir,'riley.json'),JSON.stringify(personal),{mode:0o600});
  fs.writeFileSync(path.join(directory,'account-ownership.json'),JSON.stringify({version:1,accounts:{'riley.json':{owner:'riley',visibility:'personal'}}}));
  const gateway={users:['riley','jordan','alex'].map(name=>({name,email:`${name}@example.org`,enabled:true,role:name==='alex'?'member':'admin'}))};
  fs.writeFileSync(path.join(directory,'gateway-users.json'),JSON.stringify(gateway));
  let config={enabled:true,users:gateway.users.map(u=>({name:u.name,primary:u.name==='riley'?['id=riley.json']:[],access:[], 'api-keys':['synthetic']}))};
  const management=async (method,body)=>{if(method==='PATCH')config={...config,...structuredClone(body)};return structuredClone(config)};
  const admin=createAdministration({directory,authDir,management});
  const riley={name:'riley',email:'riley@example.org'}, jordan={name:'jordan',email:'jordan@example.org'};
  try {
    let s=await admin.snapshot();
    await assert.rejects(admin.setPermissions({user:'jordan',accounts:['riley.json'],version:s.version}),e=>e.status===403);
    await assert.rejects(admin.setVisibility(jordan,{id:'riley.json',visibility:'team',version:s.version}),e=>e.status===403);
    await assert.rejects(admin.claimAccount(jordan,personal,'personal'),e=>e.status===409);
    const work={type:'claude',email:'jordan@example.com',account_uuid:'jordan-user',organization_uuid:'jordan-org',access_token:'test',refresh_token:'test'};
    const created=await admin.claimAccount(jordan,work,'personal');
    assert.equal(created.assigned,true);
    assert.deepEqual(config.users.find(u=>u.name==='jordan').primary,[`id=${created.id}`]);
    assert.ok(!config.users.find(u=>u.name==='riley').primary.includes(`id=${created.id}`));
    assert.equal((await admin.mine(jordan)).accounts[0].email,'jordan@example.com');
    fs.writeFileSync(path.join(directory,'monitor-state.json'),JSON.stringify({version:1,accounts:{
      [crypto.createHash('sha256').update(created.id).digest('hex')]:{incident:true}}}));
    assert.equal((await admin.mine(jordan)).accounts[0].needsAttention,true);
    assert.deepEqual((await admin.mine(riley)).accounts.map(account=>account.id),['riley.json']);
    assert.equal((await admin.mine(riley)).accounts[0].needsAttention,false);
    s=await admin.snapshot();
    await assert.rejects(admin.setPermissions({user:'riley',accounts:['riley.json',created.id],version:s.version}),e=>e.status===403);
    await assert.rejects(admin.setVisibility(riley,{id:created.id,visibility:'team',version:s.version}),e=>e.status===403);
    await assert.rejects(admin.setPermissions({user:'jordan',accounts:[],version:s.version}),e=>e.status===403);
    // Legacy fallback rules must not be able to silently restore access when
    // an owner changes their account from shared to personal.
    config.users.find(u=>u.name==='alex').auths=[`id=${created.id}`];
    s=await admin.snapshot();
    assert.equal(s.users.find(u=>u.name==='alex').editable,false);
    await assert.rejects(admin.setVisibility(jordan,{id:created.id,visibility:'team',version:s.version}),e=>e.status===409);
    await assert.rejects(admin.setPermissions({user:'alex',accounts:[],version:s.version}),e=>e.status===409);
    delete config.users.find(u=>u.name==='alex').auths;
    s=await admin.snapshot();
    await admin.setVisibility(jordan,{id:created.id,visibility:'team',version:s.version});
    assert.ok(config.users.every(u=>u.primary.includes(`id=${created.id}`)));
    config.users.find(u=>u.name==='alex').auths=[`id=${created.id}`];
    s=await admin.snapshot();
    await assert.rejects(admin.setVisibility(jordan,{id:created.id,visibility:'personal',version:s.version}),e=>e.status===409);
    assert.equal((await admin.mine(jordan)).accounts[0].visibility,'team');
    delete config.users.find(u=>u.name==='alex').auths;
    s=await admin.snapshot();
    await admin.setVisibility(jordan,{id:created.id,visibility:'personal',version:s.version});
    assert.ok(config.users.filter(u=>u.name!=='jordan').every(u=>!u.primary.includes(`id=${created.id}`)));
    assert.ok(config.users.find(u=>u.name==='jordan').primary.includes(`id=${created.id}`));
    const reauth=await admin.claimAccount(jordan,{...work,access_token:'new-token'},'personal');
    assert.equal(reauth.id,created.id);
    assert.equal(JSON.parse(fs.readFileSync(path.join(authDir,created.id))).access_token,'new-token');
    assert.equal(fs.statSync(path.join(authDir,created.id)).mode & 0o777,0o600);
    assert.deepEqual((await admin.mine(riley)).accounts.map(a=>a.id),['riley.json']);
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
});

test('an established owner can choose sharing for the originally protected account', async () => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hub-owner-choice-'));
  const authDir=path.join(directory,'auth');fs.mkdirSync(authDir);
  fs.writeFileSync(path.join(authDir,'original.json'),JSON.stringify({type:'codex',email:'owner-private@example.net'}));
  fs.writeFileSync(path.join(directory,'account-ownership.json'),JSON.stringify({version:1,accounts:{'original.json':{owner:'riley',visibility:'personal'}}}));
  const users=['riley','jordan'].map(name=>({name,email:`${name}@example.org`,enabled:true,role:'admin'}));
  fs.writeFileSync(path.join(directory,'gateway-users.json'),JSON.stringify({users}));
  let config={enabled:true,users:users.map(u=>({name:u.name,primary:u.name==='riley'?['id=original.json']:[],access:[]}))};
  const management=async(method,body)=>{if(method==='PATCH')config={...config,...structuredClone(body)};return structuredClone(config);};
  const admin=createAdministration({directory,authDir,management});
  const riley=users[0],jordan=users[1];
  try {
    let s=await admin.snapshot();
    await assert.rejects(admin.setVisibility(jordan,{id:'original.json',visibility:'team',version:s.version}),e=>e.status===403);
    assert.equal(s.accounts[0].visibility,'personal');
    await admin.setVisibility(riley,{id:'original.json',visibility:'team',version:s.version});
    s=await admin.snapshot();
    assert.equal(s.accounts[0].visibility,'team');
    assert.ok(config.users.every(u=>u.primary.includes('id=original.json')));
    await admin.setVisibility(riley,{id:'original.json',visibility:'personal',version:s.version});
    s=await admin.snapshot();
    assert.equal(s.accounts[0].visibility,'personal');
    assert.ok(!config.users.find(u=>u.name==='jordan').primary.includes('id=original.json'));
    assert.ok(config.users.find(u=>u.name==='riley').primary.includes('id=original.json'));
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
});

test('a lost routing response cannot make a shared account appear personal', async () => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hub-sharing-outage-'));
  const authDir=path.join(directory,'auth');fs.mkdirSync(authDir);
  fs.writeFileSync(path.join(authDir,'personal.json'),JSON.stringify({type:'claude',email:'private@example.com'}));
  fs.writeFileSync(path.join(directory,'account-ownership.json'),JSON.stringify({version:1,accounts:{'personal.json':{owner:'jordan',visibility:'personal'}}}));
  const users=['riley','jordan'].map(name=>({name,email:`${name}@example.org`,enabled:true,role:'admin'}));
  fs.writeFileSync(path.join(directory,'gateway-users.json'),JSON.stringify({users}));
  let config={enabled:true,users:users.map(u=>({name:u.name,primary:u.name==='jordan'?['id=personal.json']:[],access:[]}))};
  let failure='before', getDown=false;
  const management=async(method,body)=>{
    if(method==='GET' && getDown) throw new Error('synthetic management outage');
    if(method==='PATCH') {
      if(failure!=='before') config={...config,...structuredClone(body)};
      if(failure==='uncertain') getDown=true;
      if(failure) throw new Error('synthetic lost response');
    }
    return structuredClone(config);
  };
  const admin=createAdministration({directory,authDir,management});
  const owner=users[1];
  try {
    let snapshot=await admin.snapshot();
    await assert.rejects(admin.setVisibility(owner,{id:'personal.json',visibility:'team',version:snapshot.version}),e=>e.status===503);
    assert.equal((await admin.mine(owner)).accounts[0].visibility,'personal');
    assert.ok(!config.users.find(u=>u.name==='riley').primary.includes('id=personal.json'));
    failure='after';snapshot=await admin.snapshot();
    assert.deepEqual(await admin.setVisibility(owner,{id:'personal.json',visibility:'team',version:snapshot.version}),{ok:true});
    assert.equal((await admin.mine(owner)).accounts[0].visibility,'team');
    assert.ok(config.users.every(u=>u.primary.includes('id=personal.json')));
    failure=null;snapshot=await admin.snapshot();
    await admin.setVisibility(owner,{id:'personal.json',visibility:'personal',version:snapshot.version});
    assert.ok(!config.users.find(u=>u.name==='riley').primary.includes('id=personal.json'));
    failure='uncertain';snapshot=await admin.snapshot();
    await assert.rejects(admin.setVisibility(owner,{id:'personal.json',visibility:'team',version:snapshot.version}),e=>e.status===503 && /could not be confirmed/.test(e.message));
    getDown=false;
    assert.equal((await admin.mine(owner)).accounts[0].visibility,'team');
    assert.ok(config.users.every(u=>u.primary.includes('id=personal.json')));
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
});
