'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createDevices,clientIp}=require('./device-service.cjs');

test('device inventory tracks only the latest valid IP and revocation blocks the credential',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hub-devices-'));
  const devdir=path.join(directory,'devices');fs.mkdirSync(devdir);
  const id='a'.repeat(64),keyHash='b'.repeat(64);
  fs.writeFileSync(path.join(devdir,`${id}.json`),JSON.stringify({name:'jordan',email:'jordan@example.com',enabled:true,deviceName:'Laptop',platform:'Darwin',createdAt:'2026-01-01T00:00:00Z'}));
  fs.writeFileSync(path.join(directory,'gateway-users.json'),JSON.stringify({users:[{name:'riley',email:'riley@example.com',keyHash,enabled:true}]}));
  let clock=1760000000000;const service=createDevices({directory,now:()=>clock});
  try {
    assert.equal(clientIp({'x-forwarded-for':'198.51.100.5'}),'');
    assert.equal(clientIp({'cf-connecting-ip':'198.51.100.1'}),'198.51.100.1');
    assert.equal(clientIp({'cf-connecting-ip':'invalid'}),'');
    service.note(id,'198.51.100.1');
    clock+=1000;service.note(id,'198.51.100.2');
    service.note(keyHash,'2001:db8::1','legacy');
    const list=service.list();
    assert.equal(list.find(x=>x.id===id).lastIp,'198.51.100.2');
    assert.equal(list.find(x=>x.id===id).name,'Laptop');
    assert.equal(list.find(x=>x.kind==='legacy').lastIp,'2001:db8::1');
    assert.equal(fs.statSync(path.join(directory,'device-last-seen',`${id}.json`)).mode & 0o777,0o600);
    assert.throws(()=>service.revoke('../bad'));
    service.revoke(id);
    assert.equal(fs.existsSync(path.join(devdir,`${id}.json`)),false);
    assert.equal(service.list().some(x=>x.id===id),false);
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
});
