'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createPortal} = require('./portal-service.cjs');

test('seven-day sessions survive restarts while logout, expiry and identity changes revoke access', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-sessions-'));
  const origin = 'https://hub.example.com';
  const usersFile = path.join(directory, 'gateway-users.json');
  const user = {name: 'riley', email: 'riley@example.org', enabled: true, keyHash: 'a'.repeat(64)};
  const saveUsers = () => fs.writeFileSync(usersFile, JSON.stringify({users: [user]}));
  saveUsers();
  let clock = 1800000000000, nonce, server, port;
  const oauth = {
    authorizationUrl(values) {nonce = values.nonce; return `https://accounts.google.com/test?state=${values.state}`;},
    async exchange() {return {email:user.email, sub:'verified-subject', email_verified:true, hd:'example.org', nonce};},
  };
  async function startServer() {
    server = createPortal({directory, origin, workspaceDomain: 'example.org', oauth, now: () => clock});
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  }
  async function stopServer() {if (server) {const running = server; server = null; await new Promise(resolve => running.close(resolve));}}
  async function restart() {await stopServer(); await startServer();}
  function request(method, target, {cookie, headers = {}, body} = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({host:'127.0.0.1', port, method, path:target,
        headers:{host:new URL(origin).host, ...(cookie ? {cookie} : {}), ...headers}}, res => {
        let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk);
        res.on('end', () => resolve({status:res.statusCode, headers:res.headers, text}));
      });
      req.on('error', reject); if (body) req.write(body); req.end();
    });
  }
  async function login() {
    const start = await request('GET', '/sign-in');
    const state = new URL(start.headers.location).searchParams.get('state');
    const binding = start.headers['set-cookie'][0].split(';')[0];
    const reply = await request('GET', `/oauth/callback?state=${state}&code=synthetic`, {cookie:binding});
    assert.equal(reply.status, 303);
    const setCookie = reply.headers['set-cookie'].find(value => value.startsWith('__Host-ddhub_session='));
    assert.match(setCookie, /; Max-Age=604800(?:;|$)/);
    assert.match(setCookie, /; Secure; HttpOnly; SameSite=Lax;/);
    const cookie = setCookie.split(';')[0];
    const page = await request('GET', '/', {cookie});
    const csrf = /name="hub-csrf" content="([^"]+)"/.exec(page.text)[1];
    return {cookie, csrf};
  }
  const post = (target, login) => request('POST', target, {cookie:login.cookie, headers:{origin,'x-hub-csrf':login.csrf}});
  try {
    await startServer();
    const first = await login(), second = await login();
    const sessionDir = path.join(directory, 'portal-sessions');
    const records = fs.readdirSync(sessionDir);
    assert.equal(records.length, 2);
    assert.equal(fs.statSync(sessionDir).mode & 0o077, 0);
    for (const record of records) {
      assert.match(record, /^[a-f0-9]{64}\.json$/);
      const file = path.join(sessionDir, record);
      assert.equal(fs.statSync(file).mode & 0o077, 0);
      assert.ok(!fs.readFileSync(file, 'utf8').includes(first.cookie.split('=')[1]));
      assert.ok(!fs.readFileSync(file, 'utf8').includes(second.cookie.split('=')[1]));
    }
    await restart();
    assert.match((await request('GET', '/', {cookie:first.cookie})).text, /Signed in as/);
    user.enabled = false; saveUsers();
    assert.doesNotMatch((await request('GET', '/', {cookie:first.cookie})).text, /Signed in as/);
    user.enabled = true; saveUsers();
    assert.equal((await post('/portal/logout', first)).status, 200);
    await restart();
    assert.doesNotMatch((await request('GET', '/', {cookie:first.cookie})).text, /Signed in as/);
    assert.match((await request('GET', '/', {cookie:second.cookie})).text, /Signed in as/);
    const setup = await post('/portal/setup-code', second);
    assert.equal(setup.status, 200);
    fs.writeFileSync(path.join(directory, 'google-bindings.json'), JSON.stringify({[user.email]:'replacement-subject'}));
    assert.doesNotMatch((await request('GET', '/', {cookie:second.cookie})).text, /Signed in as/);
    const redeem = await request('POST', '/portal/redeem', {headers:{'content-type':'application/json'}, body:JSON.stringify({code:JSON.parse(setup.text).code})});
    assert.equal(redeem.status, 403);
    fs.writeFileSync(path.join(directory, 'google-bindings.json'), JSON.stringify({[user.email]:'verified-subject'}));
    clock += 7 * 24 * 60 * 60 * 1000 - 1;
    await restart();
    assert.match((await request('GET', '/', {cookie:second.cookie})).text, /Signed in as/);
    clock += 1;
    assert.doesNotMatch((await request('GET', '/', {cookie:second.cookie})).text, /Signed in as/);
    await restart();
    assert.doesNotMatch((await request('GET', '/', {cookie:second.cookie})).text, /Signed in as/);
    assert.equal(fs.readdirSync(sessionDir).length, 0);
  } finally {
    await stopServer();
    fs.rmSync(directory, {recursive:true, force:true});
  }
});
