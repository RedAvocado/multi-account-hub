'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {EventEmitter}=require('node:events');
const {createMonitor,enqueueDeviceEvent,discordDelivery}=require('./monitor-service.cjs');

function fixture() {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hub-monitor-test-'));
  const authDir=path.join(directory,'auth');fs.mkdirSync(authDir);fs.mkdirSync(path.join(directory,'devices'));
  return {directory,authDir,cleanup:()=>fs.rmSync(directory,{recursive:true,force:true})};
}
const loadEvents=directory=>fs.readdirSync(path.join(directory,'notification-outbox')).filter(x=>x.endsWith('.json'))
  .map(x=>JSON.parse(fs.readFileSync(path.join(directory,'notification-outbox',x),'utf8')));

test('new devices are queued once, survive restart, and honor Discord retry timing',async()=>{
  const {directory,authDir,cleanup}=fixture();let clock=1800000000000, calls=0;
  const existing='a'.repeat(64), fresh='b'.repeat(64);
  const device={name:'jordan',email:'jordan@example.com',enabled:true,deviceName:'Example\nLaptop',platform:'macOS'};
  fs.writeFileSync(path.join(directory,'devices',existing+'.json'),JSON.stringify(device));
  const delivered=[];
  const deliver=async content=>{delivered.push(content);calls++;return calls===1?{status:429,retryAfter:4}:{status:200};};
  const options={directory,authDir,now:()=>clock,deliver,management:async()=>({status:200,value:{files:[]}}),pause:async()=>{}};
  try {
    let monitor=createMonitor(options);monitor.scanDevices();assert.equal(monitor.status().queued,0);
    fs.mkdirSync(path.join(directory,'device-last-seen'));
    fs.writeFileSync(path.join(directory,'devices',fresh+'.json'),JSON.stringify(device));
    fs.writeFileSync(path.join(directory,'device-last-seen',fresh+'.json'),JSON.stringify({ip:'203.0.113.42'}));
    monitor.scanDevices();monitor.scanDevices();assert.equal(monitor.status().queued,1);
    const queued=loadEvents(directory);assert.match(queued[0].content,/Example Laptop/);assert.match(queued[0].content,/203\.0\.113\.42/);
    assert.ok(!queued[0].content.includes(fresh));
    const eventFile=fs.readdirSync(path.join(directory,'notification-outbox'))[0];
    assert.equal(fs.statSync(path.join(directory,'notification-outbox',eventFile)).mode&0o077,0);
    await monitor.flush();assert.equal(calls,1);assert.equal(monitor.status().queued,1);
    clock+=3000;monitor=createMonitor(options);await monitor.flush();assert.equal(calls,1);
    clock+=1100;await monitor.flush();assert.equal(calls,2);assert.equal(monitor.status().queued,0);
    monitor.scanDevices();assert.equal(monitor.status().queued,0);
    // Portal enrollment can persist its event even if the device is revoked before a scan.
    const shortLived='c'.repeat(64);enqueueDeviceEvent({directory,id:shortLived,device,ip:'not-an-ip'});
    await monitor.flush();assert.equal(calls,3);assert.match(delivered[2],/IP: Unavailable/);
    assert.equal(fs.statSync(path.join(directory,'monitor-state.json')).mode&0o077,0);
  } finally {cleanup();}
});

test('provider checks retry, refresh once on repeated 401, hide private accounts, and ignore network outages',async()=>{
  const {directory,authDir,cleanup}=fixture();let clock=1800000000000;
  const files=[
    {id:'personal.json',type:'codex',email:'personal@example.com',auth_index:'one',status_message:''},
    {id:'shared.json',type:'claude',email:'team@example.com',auth_index:'two',status_message:''},
    {id:'healthy.json',type:'codex',email:'healthy@example.com',auth_index:'three',status_message:''},
    {id:'outage.json',type:'claude',email:'outage@example.com',auth_index:'four',status_message:''},
  ];
  for(const f of files)fs.writeFileSync(path.join(authDir,f.id),JSON.stringify({type:f.type,email:f.email,account_id:'account_123',disabled:false,access_token:'synthetic',refresh_token:'synthetic'}));
  fs.writeFileSync(path.join(directory,'account-ownership.json'),JSON.stringify({version:1,accounts:{
    'personal.json':{owner:'riley',visibility:'personal'},'shared.json':{owner:'riley',visibility:'team'},
    'healthy.json':{owner:'jordan',visibility:'team'},'outage.json':{owner:'riley',visibility:'personal'},
  }}));
  const counts={}, forced=[];let recovery=false, captured=[];
  const management=async (endpoint,body)=>{
    if(endpoint==='auth-files')return {status:200,value:{files}};
    if(endpoint==='auth-files/refresh'){forced.push(body.name);return {status:500,value:{}};}
    assert.equal(endpoint,'api-call');assert.equal(body.header.Authorization,'Bearer $TOKEN$');
    counts[body.auth_index]=(counts[body.auth_index]||0)+1;captured.push(body.url);
    const status=body.auth_index==='one'?(recovery?200:401):body.auth_index==='two'?403:body.auth_index==='three'?200:503;
    return {status:200,value:{status_code:status}};
  };
  const sent=[];const monitor=createMonitor({directory,authDir,now:()=>clock,management,deliver:async s=>{sent.push(s);return {status:200};},pause:async()=>{}});
  try {
    await monitor.checkHealth({force:true});
    assert.deepEqual(forced,['personal.json']);assert.equal(counts.one,6);assert.equal(counts.two,3);assert.equal(counts.three,1);assert.equal(counts.four,3);
    assert.equal(monitor.status().incidents,2);assert.equal(monitor.status().queued,2);
    const events=loadEvents(directory).map(x=>x.content).join('\n');
    assert.match(events,/Personal Codex account/);assert.ok(!events.includes('personal@example.com'));
    assert.match(events,/Claude: team@example.com/);assert.ok(!events.includes('outage@example.com'));
    assert.ok(captured.includes('https://chatgpt.com/backend-api/wham/usage'));
    await monitor.flush();assert.equal(sent.length,2);
    clock+=60*1000;await monitor.checkHealth();assert.equal(sent.length,2);assert.deepEqual(forced,['personal.json']);
    clock+=15*60*1000;await monitor.checkHealth();assert.equal(monitor.status().queued,0);assert.deepEqual(forced,['personal.json']);
    recovery=true;
    const updated=new Date(Date.now()+2000);fs.utimesSync(path.join(authDir,'personal.json'),updated,updated);
    clock+=61*1000;await monitor.checkHealth();assert.equal(monitor.status().incidents,1);
    recovery=false;clock+=15*60*1000;await monitor.checkHealth();assert.equal(monitor.status().incidents,2);assert.equal(monitor.status().queued,1);
  } finally {cleanup();}
});

test('successful automatic refresh suppresses an authentication alarm',async()=>{
  const {directory,authDir,cleanup}=fixture();let probes=0,refreshes=0;
  const file={id:'codex.json',type:'codex',email:'work@example.com',auth_index:'index'};
  fs.writeFileSync(path.join(authDir,file.id),JSON.stringify({type:'codex',account_id:'acct_1',access_token:'synthetic',refresh_token:'synthetic'}));
  const management=async endpoint=>endpoint==='auth-files'?{status:200,value:{files:[file]}}:endpoint==='auth-files/refresh'?
    (refreshes++,{status:200,value:{ok:true}}):(probes++,{status:200,value:{status_code:refreshes?200:401}});
  try {
    const monitor=createMonitor({directory,authDir,management,now:()=>1800000000000,pause:async()=>{},deliver:async()=>({status:200})});
    await monitor.checkHealth({force:true});assert.equal(refreshes,1);assert.equal(probes,4);assert.equal(monitor.status().incidents,0);assert.equal(monitor.status().queued,0);
  } finally {cleanup();}
});

test('Discord delivery disables mentions and uses the private configured webhook',async()=>{
  const {directory,cleanup}=fixture();
  const webhook=path.join(directory,'discord-webhook-url');
  fs.writeFileSync(webhook,'https://discord.com/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz\n',{mode:0o600});
  let options,payload;
  const request=(requestOptions,callback)=>{
    options=requestOptions;const req=new EventEmitter();req.end=body=>{payload=JSON.parse(body.toString());
      const res=new EventEmitter();res.statusCode=200;res.headers={};callback(res);process.nextTick(()=>res.emit('end'));};
    return req;
  };
  try {
    const result=await discordDelivery(directory,request)('New device @everyone');
    assert.equal(result.status,200);assert.equal(options.hostname,'discord.com');assert.ok(options.path.endsWith('?wait=true'));
    assert.deepEqual(payload.allowed_mentions,{parse:[]});assert.equal(payload.content,'New device @everyone');
    fs.chmodSync(webhook,0o644);
    await assert.rejects(discordDelivery(directory,request)('test'),/configuration unavailable/);
  } finally {cleanup();}
});

test('persistent proxy authentication errors are reported even when a basic account check succeeds',async()=>{
  const {directory,authDir,cleanup}=fixture();let clock=1800000000000;
  const file={id:'codex.json',type:'codex',email:'work@example.com',auth_index:'index',unavailable:true,status_message:'401 unauthorized'};
  fs.writeFileSync(path.join(authDir,file.id),JSON.stringify({type:'codex',account_id:'acct_1',access_token:'synthetic',refresh_token:'synthetic'}));
  const management=async endpoint=>endpoint==='auth-files'?{status:200,value:{files:[file]}}:{status:200,value:{status_code:200}};
  try {
    const monitor=createMonitor({directory,authDir,management,now:()=>clock,pause:async()=>{},deliver:async()=>({status:200})});
    await monitor.checkHealth({force:true});assert.equal(monitor.status().queued,0);
    clock+=60001;await monitor.checkHealth();assert.equal(monitor.status().queued,1);
    assert.match(loadEvents(directory)[0].content,/basic account check succeeded/);
  } finally {cleanup();}
});
