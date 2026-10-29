'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createUsageHistory} = require('./usage-history-service.cjs');

const MINUTE = 60000;
function fixture(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'usage-history-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  let clock=Date.parse('2026-10-29T00:00:00Z');
  const history=createUsageHistory({directory,now:()=>clock});
  function sample(remaining, {at=clock,reset=null,windows,provider='codex'}={}) {
    history.record({version:1,accounts:{'private-account@example.com.json':{provider,checkedAt:new Date(at).toISOString(),
      windows:windows||[{label:'1w',scope:'general',remaining,resetsAt:reset}]}}});
  }
  return {directory,history,sample,get:()=>history.get('private-account@example.com.json','codex'),
    advance:minutes=>{clock+=minutes*MINUTE;},time:()=>clock};
}

test('burn rates use actual trailing horizons, survive restarts and keep account identities private', t=>{
  const f=fixture(t);
  f.sample(100);assert.equal(f.get().tenMinutes.percent,null);
  for(let minute=1;minute<=60;minute++) {f.advance(1);f.sample(100-minute*(minute<=30?.1:.2));}
  const rates=f.get();
  assert.equal(rates.basis,'1w');
  assert.equal(rates.tenMinutes.percent,3);
  assert.equal(rates.hour.percent,12);
  assert.equal(rates.day.percent,288);
  assert.equal(rates.day.observedSeconds,3600);
  const file=path.join(f.directory,'usage-history.json'),raw=fs.readFileSync(file,'utf8');
  assert.equal(fs.statSync(file).mode&0o777,0o600);
  assert.ok(!raw.includes('private-account'));
  const restarted=createUsageHistory({directory:f.directory,now:f.time});
  assert.deepEqual(restarted.get('private-account@example.com.json','codex'),rates);
  assert.equal(restarted.get('another-account','codex'),null);
  assert.equal(restarted.get('private-account@example.com.json','claude'),null);
});

test('resets and long outages do not turn into usage or erase observed burn', t=>{
  const f=fixture(t);
  f.sample(50);
  for(let i=1;i<=10;i++){f.advance(1);f.sample(50-i);}
  f.advance(1);f.sample(100); // A redeemed reset.
  for(let i=1;i<=10;i++){f.advance(1);f.sample(100-i);}
  assert.equal(f.get().tenMinutes.percent,10);
  assert.equal(f.get().tenMinutes.observedSeconds,20*60);
  f.advance(10);f.sample(20); // Unobserved gap cannot be treated as 70% burn.
  for(let i=1;i<=5;i++){f.advance(1);f.sample(20-i);}
  assert.equal(f.get().tenMinutes.percent,10);
  f.advance(4);
  assert.equal(f.get().stale,true);
});

test('scheduled reset crossings and changed reset timestamps exclude ambiguous intervals', t=>{
  const f=fixture(t),reset=new Date(f.time()+5*MINUTE).toISOString();
  f.sample(90,{reset});
  for(let i=1;i<=4;i++){f.advance(1);f.sample(90-i,{reset});}
  f.advance(1);f.sample(80,{reset}); // Reset crossed even without a visible refill.
  f.advance(1);f.sample(79,{reset:new Date(f.time()+7*86400000).toISOString()});
  for(let i=1;i<=5;i++){f.advance(1);f.sample(79-i,{reset:new Date(f.time()+(7*86400000-i*MINUTE)).toISOString()});}
  const rates=f.get();
  assert.equal(rates.tenMinutes.percent,10);
  assert.equal(rates.tenMinutes.observedSeconds,9*60);
});

test('the longest general quota is the basis without mixing scoped windows', t=>{
  const f=fixture(t);
  f.sample(50,{windows:[{label:'5h',remaining:80},{label:'1w',remaining:50},{label:'Sonnet',remaining:0,scope:'sonnet'}]});
  assert.equal(f.get().basis,'1w');
  for(let i=1;i<=5;i++){f.advance(1);f.sample(50-i);}
  assert.equal(f.get().tenMinutes.percent,10);
  f.advance(1);f.sample(50,{windows:[{label:'1mo',remaining:50}]});
  assert.equal(f.get().basis,'1mo');
  assert.equal(f.get().tenMinutes.percent,null,'a different denominator requires new history');
});

test('stale duplicates and future timestamps cannot add history; malformed files retain aged valid data', t=>{
  const f=fixture(t),at=f.time();
  f.sample(80);f.sample(60); // Same provider observation is not another measurement.
  f.advance(1);f.sample(79);
  f.sample(10,{at:f.time()+60000});
  f.advance(5);f.sample(1,{at});
  const file=path.join(f.directory,'usage-history.json');
  const content=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.equal(Object.values(content.accounts)[0].points.length,2);
  const old=f.get();
  fs.writeFileSync(file,'malformed');f.advance(1);
  assert.equal(f.get().tenMinutes.percent,old.tenMinutes.percent);
  assert.equal(f.get().stale,true);
  f.history.record({version:1,accounts:{}});
  assert.ok(f.get(),'temporary feed omissions preserve history');
  f.advance(24*60+4);f.history.record({version:1,accounts:{}});
  assert.equal(f.get(),null,'old account history ages out');
});

test('a full day survives retention and moving boundaries use only the overlapping intervals', t=>{
  const f=fixture(t);
  f.sample(100);
  for(let i=1;i<=24*60+10;i++){f.advance(1);f.sample(100-i*.01);}
  const rates=f.get();
  assert.equal(rates.day.observedSeconds,24*60*60);
  assert.equal(rates.day.percent,14.4);
  assert.equal(rates.hour.percent,.6);
  assert.equal(rates.tenMinutes.percent,.1);
  f.advance(.5);
  const shifted=f.get();
  assert.equal(shifted.tenMinutes.observedSeconds,29.5*60);
  assert.equal(shifted.tenMinutes.percent,.1);
  const file=path.join(f.directory,'usage-history.json');
  assert.ok(Object.values(JSON.parse(fs.readFileSync(file,'utf8')).accounts)[0].points.length<=24*60+4);
});

test('empty malformed account histories cannot break usage reads', t=>{
  const f=fixture(t);f.sample(80);
  const file=path.join(f.directory,'usage-history.json'),value=JSON.parse(fs.readFileSync(file,'utf8'));
  Object.values(value.accounts)[0].points=[];
  fs.writeFileSync(file,JSON.stringify(value));f.advance(1);
  assert.equal(f.get(),null);
});
