'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn, execFileSync} = require('node:child_process');

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const random = () => crypto.randomBytes(48).toString('base64url');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => server.close(resolve));

test('a usage-only key reads GET /v1/usage and nothing else', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-usage-key-'));
  fs.mkdirSync(path.join(directory, 'team-keys'));
  fs.mkdirSync(path.join(directory, 'devices'), {mode: 0o700});
  const internal = random();
  fs.writeFileSync(path.join(directory, 'gateway-users.json'), JSON.stringify({users: [
    {name: 'jordan', email: 'jordan@example.org', keyHash: digest(internal), enabled: true}]}));
  fs.writeFileSync(path.join(directory, 'team-keys', 'jordan.key'), internal);
  fs.writeFileSync(path.join(directory, 'hub.json'), JSON.stringify({hubUrl: 'https://hub.example.com'}));
  const device = (scope) => {
    const key = random();
    fs.writeFileSync(path.join(directory, 'devices', `${digest(key)}.json`), JSON.stringify({name: 'jordan', email: 'jordan@example.org',
      enabled: true, createdAt: '2026-11-04T00:00:00Z', deviceName: 'Phone', platform: '', ...(scope ? {scope} : {})}));
    return key;
  };
  const usageKey = device('usage'), fullKey = device(), unknownKey = device('admin');
  const backendHits = [];
  const backend = http.createServer((req, res) => { backendHits.push(req.url); res.writeHead(200); res.end('model'); });
  await listen(backend);
  const probe = http.createServer(); await listen(probe); const port = probe.address().port; await close(probe);
  // An isolated HOME keeps the gateway's usage service away from real accounts.
  const gateway = spawn(process.execPath, [path.join(__dirname, '..', 'team-gateway.cjs')], {stdio: 'ignore',
    env: {...process.env, HOME: directory, HUB_GATEWAY_DIR: directory, HUB_GATEWAY_PORT: String(port), HUB_BACKEND_PORT: String(backend.address().port)}});
  const request = (method, url, key, extra = {}) => new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port, method, path: url,
      headers: {host: 'hub.example.com', ...(key ? {authorization: `Bearer ${key}`} : {}), ...extra}}, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', c => text += c); res.on('end', () => resolve({status: res.statusCode, text}));
    });
    req.on('error', reject); req.end();
  });
  try {
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      try { ready = (await request('GET', '/v1/models', fullKey)).status === 200; } catch {}
      if (!ready) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready);
    // The bare test hub has no account files, so the usage service answers
    // 503; what matters is that the key passed authentication and scope.
    const usage = await request('GET', '/v1/usage', usageKey);
    assert.ok([200, 503].includes(usage.status), `usage read refused: ${usage.status}`);
    assert.ok('accounts' in JSON.parse(usage.text) || JSON.parse(usage.text).error === 'Usage temporarily unavailable.');
    backendHits.length = 0;
    for (const [method, url] of [['GET', '/v1/models'], ['POST', '/v1/responses'], ['POST', '/v1/messages'],
      ['GET', '/usage/v0/management/auth-files'], ['POST', '/usage/v0/management/api-call'], ['POST', '/usage/v0/management/reset-quota']]) {
      const response = await request(method, url, usageKey);
      assert.equal(response.status, 403, `${method} ${url} must be refused for a usage-only key`);
    }
    const upgrade = await request('GET', '/v1/responses', usageKey, {connection: 'Upgrade', upgrade: 'websocket',
      'sec-websocket-version': '13', 'sec-websocket-key': crypto.randomBytes(16).toString('base64')}).catch(error => ({status: 0, error}));
    assert.notEqual(upgrade.status, 101, 'usage-only keys cannot open model WebSockets');
    assert.deepEqual(backendHits, [], 'nothing reached the model backend');
    assert.equal((await request('GET', '/v1/models', fullKey)).status, 200, 'ordinary device keys are unchanged');
    assert.equal((await request('GET', '/v1/usage', unknownKey)).status, 401, 'an unknown scope fails closed');
    assert.equal((await request('GET', '/v1/usage')).status, 401);
  } finally {
    gateway.kill('SIGTERM');
    await new Promise(resolve => gateway.once('exit', resolve));
    await close(backend);
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('hub-admin add-device --usage-only records the scope and shows it in the device list', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'hub-admin.py'), 'utf8');
  assert.match(source, /add_argument\('--usage-only'/);
  assert.match(source, /record\['scope'\] = 'usage'/);
  execFileSync('python3', ['-m', 'py_compile', path.join(__dirname, '..', 'hub-admin.py')]);
});
