'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createRoutingUsage} = require('./routing-usage-service.cjs');

test('routing feed refreshes once, replaces atomically, and keeps the last snapshot on failure', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-feed-'));
  let release, calls = 0, fail = false;
  const snapshot = {version:1,accounts:{'work.json':{provider:'codex',checkedAt:'2026-10-29T18:00:00Z',
    windows:[{label:'5h',remaining:80,resetsAt:null}]}}};
  const service = createRoutingUsage({directory,usage:{async getForRouting(){
    calls++;
    if(fail)throw Error('outage');
    await new Promise(resolve=>{release=resolve;});
    return snapshot;
  }}});
  try {
    const a=service.refresh(),b=service.refresh();
    assert.equal(a,b);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(calls,1);
    assert.deepEqual(fs.readdirSync(directory),[]);
    release();await a;
    const file=path.join(directory,'routing-usage.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),snapshot);
    assert.equal(fs.statSync(file).mode&0o777,0o600);
    fail=true;
    await assert.rejects(service.refresh(),/outage/);
    assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),snapshot);
    assert.deepEqual(fs.readdirSync(directory),['routing-usage.json']);
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
});
