'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const random = () => crypto.randomBytes(32).toString('base64url');

function listen(server) { return new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); }
function request(port, key, pathName = '/v1/responses') {
  return new Promise((resolve, reject) => {
    const req = http.request({host:'127.0.0.1', port, method:'POST', path:pathName, headers:{authorization:`Bearer ${key}`}}, res => {
      res.once('data', () => resolve({req,res,status:res.statusCode}));
      res.once('end', () => resolve({req,res,status:res.statusCode}));
      res.once('error', reject);
    });
    req.once('error', reject);
    req.end('synthetic private content');
  });
}

test('four devices each sustain 125 simultaneous model streams and revoked devices are blocked', {timeout:30000}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'hub-load-'));
  for (const part of ['devices','team-keys']) fs.mkdirSync(path.join(directory,part));
  const users = [], keys = [];
  for (let index=0;index<4;index++) {
    const name=`user${index}`, email=`${name}@example.org`, internal=random(), key=random();
    users.push({name,email,enabled:true,keyHash:digest(internal)}); keys.push(key);
    fs.writeFileSync(path.join(directory,'team-keys',`${name}.key`),internal);
    fs.writeFileSync(path.join(directory,'devices',`${digest(key)}.json`),JSON.stringify({name,email,enabled:true}));
  }
  fs.writeFileSync(path.join(directory,'gateway-users.json'),JSON.stringify({users}));
  fs.writeFileSync(path.join(directory, 'hub.json'), JSON.stringify({hubUrl: 'https://hub.example.com', portal: {workspaceDomain: 'example.org'}}));
  const upstream=http.createServer((req,res) => {res.writeHead(200,{'content-type':'text/event-stream'});res.write('ready\n');});
  await listen(upstream);
  const socket=http.createServer(); await listen(socket); const port=socket.address().port; await new Promise(resolve=>socket.close(resolve));
  const gateway=spawn(process.execPath,[path.join(__dirname,'../team-gateway.cjs')],{env:{...process.env,HUB_GATEWAY_DIR:directory,HUB_GATEWAY_PORT:String(port),HUB_BACKEND_PORT:String(upstream.address().port)},stdio:['ignore','pipe','pipe']});
  let output='';gateway.stdout.on('data',c=>output+=c);gateway.stderr.on('data',c=>output+=c);
  const streams=[];
  try {
    for (let tries=0;tries<100;tries++) {
      if (gateway.exitCode!==null) throw new Error('Gateway exited unexpectedly');
      try {const r=await request(port,keys[0],'/v1/models');r.res.resume();break;}
      catch(error) {if(tries===99)throw error;await new Promise(resolve=>setTimeout(resolve,50));}
    }
    const results=await Promise.all(keys.flatMap(key=>Array.from({length:125},()=>request(port,key))));
    streams.push(...results);
    assert.equal(results.length,500);
    assert.equal(results.filter(result=>result.status===200).length,500);
    fs.unlinkSync(path.join(directory,'devices',`${digest(keys[0])}.json`));
    const revoked=await request(port,keys[0]);revoked.res.resume();assert.equal(revoked.status,401);
    assert.equal(output.includes('synthetic private content'),false);
  } finally {
    for(const stream of streams){stream.req.destroy();stream.res.destroy();}
    gateway.kill('SIGTERM');
    await new Promise(resolve=>{if(gateway.exitCode!==null)return resolve();gateway.once('exit',resolve);});
    upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));
    fs.rmSync(directory,{recursive:true,force:true});
  }
});
