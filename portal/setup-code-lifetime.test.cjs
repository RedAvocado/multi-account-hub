'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createPortal} = require('./portal-service.cjs');

test('setup codes last two hours, survive restart, and remain single-use and session-bound', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-setup-codes-'));
  const origin = 'https://hub.example.com';
  const internalKey = crypto.randomBytes(32).toString('base64url');
  const keyHash = crypto.createHash('sha256').update(internalKey).digest('hex');
  fs.mkdirSync(path.join(directory, 'team-keys'));
  fs.writeFileSync(path.join(directory, 'team-keys', 'riley.key'), internalKey);
  fs.writeFileSync(path.join(directory, 'gateway-users.json'), JSON.stringify({users:[
    {name:'riley',email:'riley@example.org',enabled:true,keyHash},
  ]}));
  let clock = 1800000000000, nonce, server, port;
  const oauth = {
    authorizationUrl(values) {nonce = values.nonce; return `https://accounts.google.com/test?state=${values.state}`;},
    async exchange() {return {email:'riley@example.org',sub:'verified-subject',email_verified:true,hd:'example.org',nonce};},
  };
  async function start() {
    server = createPortal({directory, origin, workspaceDomain: 'example.org', oauth, now:() => clock});
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  }
  async function stop() {if (server) {const running=server; server=null; await new Promise(resolve => running.close(resolve));}}
  async function restart() {await stop(); await start();}
  function request(method, target, {cookie, headers={}, body}={}) {
    return new Promise((resolve,reject) => {
      const req=http.request({host:'127.0.0.1',port,method,path:target,
        headers:{host:new URL(origin).host,...(cookie?{cookie}:{}),...headers}}, res => {
        let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);
        res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text}));
      });
      req.on('error',reject);if(body)req.write(body);req.end();
    });
  }
  try {
    await start();
    const begin=await request('GET','/sign-in');
    const state=new URL(begin.headers.location).searchParams.get('state');
    const binding=begin.headers['set-cookie'][0].split(';')[0];
    const finish=await request('GET',`/oauth/callback?state=${state}&code=synthetic`,{cookie:binding});
    const cookie=finish.headers['set-cookie'].find(value=>value.startsWith('__Host-ddhub_session=')).split(';')[0];
    const page=await request('GET','/',{cookie});
    assert.match(page.text,/expires in two hours/);
    const csrf=/name="hub-csrf" content="([^"]+)"/.exec(page.text)[1];
    const issue=async()=>{
      const response=await request('POST','/portal/setup-code',{cookie,headers:{origin,'x-hub-csrf':csrf}});
      assert.equal(response.status,200);
      const data=JSON.parse(response.text);assert.equal(data.expiresInSeconds,7200);return data.code;
    };
    const redeem=code=>request('POST','/portal/redeem',{
      headers:{'content-type':'application/json'},body:JSON.stringify({code}),
    });

    let code=await issue();
    const codeDir=path.join(directory,'portal-setup-codes');
    const files=fs.readdirSync(codeDir);
    assert.equal(files.length,1);assert.match(files[0],/^[a-f0-9]{64}\.json$/);
    assert.equal(fs.statSync(codeDir).mode&0o077,0);
    assert.equal(fs.statSync(path.join(codeDir,files[0])).mode&0o077,0);
    assert.ok(!fs.readFileSync(path.join(codeDir,files[0]),'utf8').includes(code));
    clock+=181000;
    await restart();
    assert.equal((await redeem(code)).status,200);
    await restart();
    assert.equal((await redeem(code)).status,401);

    code=await issue();
    clock+=2*60*60*1000-1;
    await restart();
    assert.equal((await redeem(code)).status,200);
    code=await issue();
    clock+=2*60*60*1000;
    await restart();
    assert.equal((await redeem(code)).status,401);

    const previous=await issue(), replacement=await issue();
    await restart();
    assert.equal((await redeem(previous)).status,401);
    assert.equal((await redeem(replacement)).status,200);
    code=await issue();
    const logout=await request('POST','/portal/logout',{cookie,headers:{origin,'x-hub-csrf':csrf}});
    assert.equal(logout.status,200);
    await restart();
    assert.equal((await redeem(code)).status,401);
  } finally {
    await stop();fs.rmSync(directory,{recursive:true,force:true});
  }
});
