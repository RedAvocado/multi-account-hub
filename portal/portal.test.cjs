'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {createPortal} = require('./portal-service.cjs');

const origin = 'https://old-hub.example.com';
const random = () => crypto.randomBytes(48).toString('base64url');
const digest = s => crypto.createHash('sha256').update(s).digest('hex');

test('Google identity, browser session and one-time setup are bound to each authorized person', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-portal-test-'));
  fs.mkdirSync(path.join(directory, 'team-keys'));
  const keys = {riley: random(), jordan: random(), casey: random(), alex: random()};
  const userList = Object.keys(keys).map(name => ({name, email: `${name}@example.org`, keyHash: digest(keys[name]), enabled: true, ...(name === 'riley' ? {role: 'admin'} : {})}));
  for (const [name, key] of Object.entries(keys)) fs.writeFileSync(path.join(directory, 'team-keys', `${name}.key`), key);
  const save = () => fs.writeFileSync(path.join(directory, 'gateway-users.json'), JSON.stringify({users: userList}));
  save();
  let clock = 1000000;
  let nextIdentity;
  let adminChanges = 0;
  const admin = {async snapshot() { return {users: [], accounts: [], version: 'a'.repeat(64)}; },
    async setPermissions() { adminChanges++; return {ok: true}; }, async setEnabled() { adminChanges++; return {ok: true}; },
    async mine(current) {return {version:'a'.repeat(64),accounts:[{email:current.email}]};},async setVisibility() {return {ok:true};}};
  const oauth = {
    authorizationUrl({state, nonce, challenge}) {
      const u = new URL('https://accounts.google.com/test');
      u.searchParams.set('state', state); u.searchParams.set('nonce', nonce); u.searchParams.set('challenge', challenge);
      return u.href;
    },
    async exchange({code, verifier}) {
      assert.equal(code, 'valid-code'); assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
      return nextIdentity;
    },
  };
  const usage = {async getForUser(current) { return {accounts: [{email: current.email, windows: []}]}; }};
  let claudeStarts = 0;
  const claudeConnect = {async start() {claudeStarts++;return {status:'waiting',url:'https://claude.ai/oauth/authorize'};},
    async status(){return {status:'idle'};},async submit(){return {status:'exchanging'};},async cancel(){}};
  let providerStarts=0,deviceRevocations=0;
  const enrollments=[];
  const providerConnect={async start(current){providerStarts++;return {status:'waiting',provider:'codex',account:current.name};},
    async status(){return {status:'idle'};},async submit(){return {status:'exchanging'};},async cancel(){}};
  const devices={list(){return [{name:'synthetic device'}]},revoke(){deviceRevocations++;},note(){}};
  const server = createPortal({directory, origin, workspaceDomain: 'example.org', oauth, admin, usage, claudeConnect, providerConnect, devices,
    notifyDevice:event=>enrollments.push(event), now: () => clock});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  function request(method, requestPath, {cookie, headers = {}, body} = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({host: '127.0.0.1', port, method, path: requestPath,
        headers: {host: new URL(origin).host, ...(cookie ? {cookie} : {}), ...headers}}, res => {
        let text = ''; res.setEncoding('utf8'); res.on('data', c => text += c);
        res.on('end', () => resolve({status: res.statusCode, headers: res.headers, text}));
      });
      req.on('error', reject); if (body) req.write(body); req.end();
    });
  }
  const cookieHeader = reply => (reply.headers['set-cookie'] || []).map(c => c.split(';')[0]).find(c => c.startsWith('__Host-ddhub_session='));
  const start = async () => {
    const response = await request('GET', '/sign-in');
    assert.equal(response.status, 303);
    return {location: new URL(response.headers.location), cookie: response.headers['set-cookie'][0].split(';')[0]};
  };
  const finish = async (flow, email, extra = {}) => {
    nextIdentity = {email, sub: digest(email), email_verified: true, hd: 'example.org', nonce: flow.location.searchParams.get('nonce'), ...extra};
    return request('GET', `/oauth/callback?state=${flow.location.searchParams.get('state')}&code=valid-code`, {cookie: flow.cookie});
  };
  const signedIn = async email => {
    const flow = await start(), done = await finish(flow, email);
    assert.equal(done.status, 303);
    const cookie = cookieHeader(done);
    const response = await request('GET', '/', {cookie});
    const csrf = /name="hub-csrf" content="([^"]+)"/.exec(response.text)[1];
    return {cookie, csrf};
  };
  const setup = async (identity, headers = {}) => request('POST', '/portal/setup-code', {cookie: identity.cookie, headers: {origin, 'x-hub-csrf': identity.csrf, ...headers}});
  const redeem = async code => request('POST', '/portal/redeem', {headers: {'content-type': 'application/json'}, body: JSON.stringify({code})});
  try {
    assert.equal((await request('POST', '/portal/setup-code')).status, 403);
    assert.equal((await request('GET', '/', {headers: {host: 'evil.example'}})).status, 400);
    let flow = await start();
    assert.equal((await request('GET', `/oauth/callback?state=${flow.location.searchParams.get('state')}&code=valid-code`)).status, 401);
    flow = await start();
    assert.equal((await finish(flow, 'jordan@example.org', {nonce: 'wrong'})).status, 401);
    flow = await start();
    assert.equal((await finish(flow, 'jordan@example.org', {email_verified: false})).status, 403);
    flow = await start();
    assert.equal((await finish(flow, 'jordan@example.org', {hd: ''})).status, 403);
    flow = await start();
    assert.equal((await finish(flow, 'stranger@example.org')).status, 403);
    flow = await start();
    assert.equal((await finish(flow, 'casey@example.org', {hd: 'another-managed-domain.example'})).status, 303);
    const jordan = await signedIn('jordan@example.org');
    assert.equal((await request('GET', '/portal/usage')).status, 403);
    const usageResponse = await request('GET', '/portal/usage', {cookie: jordan.cookie});
    assert.equal(usageResponse.status, 200);
    assert.equal(usageResponse.headers['cache-control'], 'no-store');
    assert.equal(JSON.parse(usageResponse.text).accounts[0].email, 'jordan@example.org');
    assert.equal((await request('POST', '/portal/claude/start', {cookie: jordan.cookie, headers:{origin,'x-hub-csrf':jordan.csrf}})).status, 403);
    assert.equal(claudeStarts, 0);
    assert.equal((await request('GET','/portal/accounts/mine',{cookie:jordan.cookie})).status,200);
    assert.equal((await request('GET','/portal/admin/devices',{cookie:jordan.cookie})).status,403);
    const providerBody=JSON.stringify({provider:'codex',visibility:'personal'});
    assert.equal((await request('POST','/portal/providers/start',{cookie:jordan.cookie,headers:{origin:'https://evil.example','x-hub-csrf':jordan.csrf,'content-type':'application/json'},body:providerBody})).status,403);
    assert.equal(providerStarts,0);
    assert.equal((await request('POST','/portal/providers/start',{cookie:jordan.cookie,headers:{origin,'x-hub-csrf':jordan.csrf,'content-type':'application/json'},body:providerBody})).status,200);
    assert.equal(providerStarts,1);
    const deviceBody=JSON.stringify({id:'a'.repeat(64)});
    assert.equal((await request('POST','/portal/admin/devices/revoke',{cookie:jordan.cookie,headers:{origin,'x-hub-csrf':jordan.csrf,'content-type':'application/json'},body:deviceBody})).status,403);
    assert.equal(deviceRevocations,0);
    assert.equal((await request('GET', '/portal/admin', {cookie: jordan.cookie})).status, 403);
    userList.find(u => u.name === 'jordan').role = 'admin'; save();
    assert.equal((await request('GET', '/portal/admin', {cookie: jordan.cookie})).status, 200);
    assert.equal((await request('GET', '/portal/admin/devices', {cookie: jordan.cookie})).status, 200);
    assert.match((await request('GET', '/', {cookie: jordan.cookie})).text, /id="admin-devices"/);
    delete userList.find(u => u.name === 'jordan').role; save();
    assert.equal((await request('GET', '/portal/admin', {cookie: jordan.cookie})).status, 403);
    assert.equal((await setup(jordan, {origin: 'https://evil.example'})).status, 403);
    assert.equal((await setup(jordan, {'x-hub-csrf': 'wrong'})).status, 403);
    let result = await setup(jordan);
    assert.equal(result.status, 200);
    let code = JSON.parse(result.text).code;
    result = await redeem(code);
    assert.equal(result.status, 200);
    const jordanDeviceKey = JSON.parse(result.text).key;
    assert.match(jordanDeviceKey, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(jordanDeviceKey, keys.jordan);
    assert.notEqual(jordanDeviceKey, keys.riley);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'devices', `${digest(jordanDeviceKey)}.json`))).name, 'jordan');
    assert.equal(enrollments.length,1);
    assert.equal(enrollments[0].device.name,'jordan');
    assert.equal(enrollments[0].id,digest(jordanDeviceKey));
    assert.ok(!JSON.stringify(enrollments[0]).includes(jordanDeviceKey));
    assert.equal((await redeem(code)).status, 401);
    assert.equal(enrollments.length,1);
    result = await setup(jordan); code = JSON.parse(result.text).code;
    userList.find(u => u.name === 'jordan').enabled = false; save();
    assert.equal((await redeem(code)).status, 403);
    assert.equal((await setup(jordan)).status, 403);
    userList.find(u => u.name === 'jordan').enabled = true; save();
    result = await setup(jordan); code = JSON.parse(result.text).code;
    clock += 181000;
    assert.equal((await redeem(code)).status, 200);
    result = await setup(jordan); code = JSON.parse(result.text).code;
    clock += 2 * 60 * 60 * 1000;
    assert.equal((await redeem(code)).status, 401);
    result = await setup(jordan); code = JSON.parse(result.text).code;
    await request('POST', '/portal/logout', {cookie: jordan.cookie, headers: {origin, 'x-hub-csrf': jordan.csrf}});
    assert.equal((await redeem(code)).status, 401);
    flow = await start();
    assert.equal((await finish(flow, 'jordan@example.org', {sub: 'new-subject'})).status, 403);
    const riley = await signedIn('riley@example.org');
    assert.equal((await request('GET', '/portal/admin', {cookie: riley.cookie})).status, 200);
    assert.equal((await request('GET','/portal/admin/devices',{cookie:riley.cookie})).status,200);
    assert.equal((await request('POST','/portal/admin/devices/revoke',{cookie:riley.cookie,headers:{origin,'x-hub-csrf':riley.csrf,'content-type':'application/json'},body:JSON.stringify({id:'a'.repeat(64)})})).status,200);
    assert.equal(deviceRevocations,1);
    assert.equal((await request('GET', '/portal/claude/status', {cookie: riley.cookie})).status, 404);
    assert.equal((await request('POST', '/portal/claude/start', {cookie: jordan.cookie, headers:{origin,'x-hub-csrf':jordan.csrf}})).status, 403);
    assert.equal((await request('POST', '/portal/claude/start', {cookie: riley.cookie, headers:{origin:'https://evil.example','x-hub-csrf':riley.csrf}})).status, 403);
    assert.equal((await request('POST', '/portal/claude/start', {cookie: riley.cookie, headers:{origin,'x-hub-csrf':'wrong'}})).status, 403);
    assert.equal(claudeStarts, 0);
    assert.equal((await request('POST', '/portal/claude/start', {cookie: riley.cookie, headers:{origin,'x-hub-csrf':riley.csrf}})).status, 200);
    assert.equal(claudeStarts, 1);
    const adminBody = JSON.stringify({user: 'jordan', accounts: [], version: 'a'.repeat(64)});
    assert.equal((await request('POST', '/portal/admin', {cookie: riley.cookie, headers: {origin: 'https://evil.example', 'x-hub-csrf': riley.csrf, 'content-type': 'application/json'}, body: adminBody})).status, 403);
    assert.equal((await request('POST', '/portal/admin', {cookie: jordan.cookie, headers: {origin, 'x-hub-csrf': jordan.csrf, 'content-type': 'application/json'}, body: adminBody})).status, 403);
    assert.equal(adminChanges, 0);
    assert.equal((await request('POST', '/portal/admin', {cookie: riley.cookie, headers: {origin, 'x-hub-csrf': riley.csrf, 'content-type': 'application/json'}, body: adminBody})).status, 200);
    assert.equal(adminChanges, 1);
    result = await setup(riley); code = JSON.parse(result.text).code;
    result = await redeem(code);
    const nateDeviceKey = JSON.parse(result.text).key;
    assert.notEqual(nateDeviceKey, keys.riley);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'devices', `${digest(nateDeviceKey)}.json`))).name, 'riley');
    assert.equal(fs.statSync(path.join(directory, 'google-bindings.json')).mode & 0o077, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('a registered root callback uses the same browser binding and cannot be replayed', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-root-callback-'));
  fs.writeFileSync(path.join(directory, 'gateway-users.json'), JSON.stringify({users: [
    {name: 'riley', email: 'riley@example.org', enabled: true, keyHash: 'a'.repeat(64)},
  ]}));
  let nonce;
  const oauth = {authorizationUrl(values) { nonce = values.nonce; return `https://accounts.google.com/test?state=${values.state}`; },
    async exchange() { return {email: 'riley@example.org', sub: 'synthetic', email_verified: true, hd: 'example.org', nonce}; }};
  const server = createPortal({directory, origin, workspaceDomain: 'example.org', callbackPath: '/', oauth});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const request = (target, cookie) => new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port, path: target, headers: {host: new URL(origin).host, ...(cookie ? {cookie} : {})}}, res => {
      res.resume(); res.on('end', () => resolve({status: res.statusCode, headers: res.headers}));
    });
    req.on('error', reject); req.end();
  });
  try {
    assert.equal((await request('/')).status, 200);
    const start = await request('/sign-in');
    const state = new URL(start.headers.location).searchParams.get('state');
    const cookie = start.headers['set-cookie'][0].split(';')[0];
    const target = `/?state=${state}&code=synthetic`;
    assert.equal((await request(target)).status, 401);
    assert.equal((await request(target, cookie)).status, 303);
    assert.equal((await request(target, cookie)).status, 401);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, {recursive: true, force: true});
  }
});
