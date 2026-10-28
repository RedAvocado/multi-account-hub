'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const {createPortal} = require('./portal-service.cjs');
const {createMonitor,enqueueDeviceEvent} = require('./monitor-service.cjs');

const origin = 'https://hub.example.com';
const callbackOrigin = 'https://old-hub.example.com';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const random = () => crypto.randomBytes(48).toString('base64url');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => server.close(resolve));

test('Google setup creates a device key that routes as only its assigned user', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-full-flow-'));
  fs.mkdirSync(path.join(directory, 'team-keys'));
  fs.mkdirSync(path.join(directory, 'auth'));
  const notifications=[];
  const monitor=createMonitor({directory,authDir:path.join(directory,'auth'),deliver:async text=>{notifications.push(text);return {status:200};}});
  const internal = {jordan: random(), riley: random()};
  const users = Object.entries(internal).map(([name, key]) => ({name, email: `${name}@example.org`, keyHash: digest(key), enabled: true}));
  fs.writeFileSync(path.join(directory, 'gateway-users.json'), JSON.stringify({users}));
  fs.writeFileSync(path.join(directory, 'hub.json'), JSON.stringify({hubUrl: origin, alternateUrls: [callbackOrigin], portal: {workspaceDomain: 'example.org'}}));
  for (const [name, key] of Object.entries(internal)) fs.writeFileSync(path.join(directory, 'team-keys', `${name}.key`), key);
  let nonce;
  const oauth = {
    authorizationUrl(values) {
      nonce = values.nonce;
      return 'https://accounts.google.com/test?state=' + values.state;
    },
    async exchange() { return {email: 'jordan@example.org', sub: 'test-jordan', email_verified: true, hd: 'example.org', nonce}; },
  };
  const portal = createPortal({directory, origin, workspaceDomain: 'example.org', callbackOrigin, oauth,notifyDevice:event=>enqueueDeviceEvent({directory,hubUrl:origin+'/',...event})});
  const backend = http.createServer((req, res) => {
    if (req.headers.authorization === 'Bearer ' + internal.jordan) {res.writeHead(200); return res.end('jordan');}
    if (req.headers.authorization === 'Bearer ' + internal.riley) {res.writeHead(200); return res.end('riley');}
    res.writeHead(401); res.end();
  });
  await listen(portal); await listen(backend);
  const probe = http.createServer(); await listen(probe); const gatewayPort = probe.address().port; await close(probe);
  const gateway = spawn(process.execPath, [path.join(__dirname, '..', 'team-gateway.cjs')], {
    stdio: 'ignore', env: {...process.env, HUB_GATEWAY_DIR: directory, HUB_GATEWAY_PORT: String(gatewayPort),
      HUB_BACKEND_PORT: String(backend.address().port), HUB_PORTAL_PORT: String(portal.address().port)},
  });
  const request = (method, requestPath, headers = {}, body = '') => new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port: gatewayPort, method, path: requestPath, headers: {host: new URL(origin).host, ...headers}}, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk); res.on('end', () => resolve({status: res.statusCode, headers: res.headers, text}));
    });
    req.on('error', reject); req.end(body);
  });
  try {
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try { if ((await request('GET', '/')).status === 200) {ready = true; break;} } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready);
    let start = await request('GET', '/sign-in');
    let state = new URL(start.headers.location).searchParams.get('state');
    let binding = start.headers['set-cookie'][0].split(';')[0];
    let relayResponse = await request('GET', `/oauth/callback?state=${state}&code=valid`, {host: new URL(callbackOrigin).host});
    const stolenRelay = new URL(relayResponse.headers.location);
    assert.equal(stolenRelay.origin, origin);
    assert.equal((await request('GET', stolenRelay.pathname + stolenRelay.search)).status, 401);
    assert.equal((await request('GET', stolenRelay.pathname + stolenRelay.search, {cookie: binding})).status, 401);
    start = await request('GET', '/sign-in');
    state = new URL(start.headers.location).searchParams.get('state');
    binding = start.headers['set-cookie'][0].split(';')[0];
    relayResponse = await request('GET', `/oauth/callback?state=${state}&code=valid`, {host: new URL(callbackOrigin).host});
    const relay = new URL(relayResponse.headers.location);
    assert.equal(relay.origin, origin);
    const callback = await request('GET', relay.pathname + relay.search, {cookie: binding});
    assert.equal(callback.status, 303);
    const cookie = callback.headers['set-cookie'].map(c => c.split(';')[0]).find(c => c.startsWith('__Host-ddhub_session='));
    const page = await request('GET', '/', {cookie});
    const csrf = /name="hub-csrf" content="([^"]+)"/.exec(page.text)[1];
    const setup = await request('POST', '/portal/setup-code', {cookie, origin, 'x-hub-csrf': csrf});
    const code = JSON.parse(setup.text).code;
    const redeemed = await request('POST', '/portal/redeem', {'content-type': 'application/json','cf-connecting-ip':'203.0.113.42'},
      JSON.stringify({code,deviceName:'Example laptop',platform:'macOS'}));
    const deviceKey = JSON.parse(redeemed.text).key;
    assert.notEqual(deviceKey, internal.jordan);
    await monitor.flush();assert.equal(notifications.length,1);
    assert.match(notifications[0],/Example laptop/);assert.match(notifications[0],/203\.0\.113\.42/);
    assert.ok(!notifications[0].includes(deviceKey));
    const model = await request('GET', '/v1/models', {authorization: `Bearer ${deviceKey}`});
    assert.equal(model.status, 200); assert.equal(model.text, 'jordan');
    assert.equal((await request('GET', '/v0/management/auth-files', {authorization: `Bearer ${deviceKey}`})).status, 404);
    fs.unlinkSync(path.join(directory, 'devices', `${digest(deviceKey)}.json`));
    assert.equal((await request('GET', '/v1/models', {authorization: `Bearer ${deviceKey}`})).status, 401);
  } finally {
    gateway.kill('SIGTERM');
    await new Promise(resolve => gateway.once('exit', resolve));
    await close(portal); await close(backend);
    fs.rmSync(directory, {recursive: true, force: true});
  }
});
