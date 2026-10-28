'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createPortal} = require('./portal-service.cjs');
const {issueLoginLink, consumeLoginLink} = require('./login-link-service.cjs');
const origin = 'https://hub.example.com';

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-login-link-'));
  const member = {name: 'jordan', email: 'jordan@example.org', enabled: true, role: 'member', keyHash: 'a'.repeat(64)};
  const bindings = {};
  let now = 1800000000000, server, port;
  function save() {
    fs.writeFileSync(path.join(directory, 'gateway-users.json'), JSON.stringify({users: [member]}));
    fs.writeFileSync(path.join(directory, 'google-bindings.json'), JSON.stringify(bindings));
  }
  save();
  async function stop() {if (server) await new Promise(resolve => server.close(resolve));}
  async function restart() {
    await stop();
    server = createPortal({directory, origin, workspaceDomain: 'example.org', oauth: {}, now: () => now});
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  }
  await restart();
  t.after(async () => {await stop(); fs.rmSync(directory, {recursive: true, force: true});});
  function request(method, target, {cookie, body, headers = {}} = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({host: '127.0.0.1', port, method, path: target, agent: false,
        headers: {host: new URL(origin).host, origin, 'content-type': 'application/json', ...(cookie ? {cookie} : {}), ...headers}}, res => {
        let text = ''; res.on('data', chunk => text += chunk);
        res.on('end', () => resolve({status: res.statusCode, headers: res.headers, text}));
      });
      req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  return {directory, member, bindings, save, restart, request,
    advance: ms => now += ms,
    issue: () => issueLoginLink({directory, email: member.email, workspaceDomain: 'example.org', now}),
    consume: token => consumeLoginLink({directory, token, now}),
    redeem: (token, options = {}) => request('POST', '/portal/login-link', {body: {token}, ...options}),
  };
}

test('a local login link creates only its assigned member session, survives restart, and is consumed once', async t => {
  const f = await fixture(t), issued = f.issue();
  const folder = path.join(f.directory, 'portal-login-links');
  const record = path.join(folder, fs.readdirSync(folder)[0]);
  assert.equal(fs.statSync(folder).mode & 0o077, 0);
  assert.equal(fs.statSync(record).mode & 0o077, 0);
  assert.ok(!fs.readFileSync(record, 'utf8').includes(issued.token));
  const preview = await f.request('GET', '/login-link');
  assert.equal(preview.status, 200);
  assert.equal(preview.headers['cache-control'], 'no-store');
  assert.equal(preview.headers['referrer-policy'], 'no-referrer');
  assert.equal(fs.readdirSync(folder).length, 1, 'link previews must not consume the link');
  await f.restart();
  const attempts = await Promise.all([f.redeem(issued.token), f.redeem(issued.token)]);
  assert.deepEqual(attempts.map(x => x.status).sort(), [200, 401]);
  const success = attempts.find(x => x.status === 200);
  const header = success.headers['set-cookie'].find(value => value.startsWith('__Host-ddhub_session='));
  assert.match(header, /Secure; HttpOnly; SameSite=Lax; Max-Age=604800/);
  const cookie = header.split(';')[0];
  await f.restart();
  const page = await f.request('GET', '/', {cookie});
  assert.match(page.text, /Signed in as <strong>jordan@example.org/);
  assert.doesNotMatch(page.text, /id="admin"/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.directory, 'google-bindings.json'), 'utf8')), {}, 'a login link must not invent a Google identity');
  assert.equal((await f.redeem(issued.token)).status, 401);
  const csrf = /name="hub-csrf" content="([^"]+)"/.exec(page.text)[1];
  assert.equal((await f.request('POST', '/portal/setup-code', {cookie, headers: {'x-hub-csrf': csrf}})).status, 200);
  assert.equal((await f.request('POST', '/portal/logout', {cookie, headers: {'x-hub-csrf': csrf}})).status, 200);
  await f.restart();
  assert.doesNotMatch((await f.request('GET', '/', {cookie})).text, /Signed in as/);
});

test('login links reject cross-origin requests and altered identities without consuming a valid link', async t => {
  const f = await fixture(t), issued = f.issue();
  assert.equal((await f.redeem(issued.token, {headers: {origin: 'https://other.example'}})).status, 403);
  assert.equal((await f.redeem(issued.token, {body: {token: issued.token, email: 'riley@example.org'}})).status, 400);
  assert.equal((await f.request('GET', `/portal/login-link?token=${issued.token}`)).status, 404);
  assert.equal((await f.redeem('bad')).status, 401);
  assert.equal((await f.redeem(issued.token)).status, 200);
});

test('expiry, disabled access, key rotation, and changed Google bindings invalidate login links', async t => {
  const f = await fixture(t);
  let issued = f.issue(); f.advance(2 * 60 * 60 * 1000);
  assert.equal((await f.redeem(issued.token)).status, 401);
  issued = f.issue(); f.member.enabled = false; f.save();
  assert.equal((await f.redeem(issued.token)).status, 401);
  assert.throws(() => f.issue());
  f.member.enabled = true; f.save();
  issued = f.issue(); f.member.keyHash = 'b'.repeat(64); f.save();
  assert.equal((await f.redeem(issued.token)).status, 401);
  issued = f.issue(); f.bindings[f.member.email] = 'verified-google-subject'; f.save();
  assert.equal((await f.redeem(issued.token)).status, 401);
  issued = f.issue();
  const reply = await f.redeem(issued.token);
  assert.equal(reply.status, 200);
  const cookie = reply.headers['set-cookie'].find(x => x.startsWith('__Host-ddhub_session=')).split(';')[0];
  f.bindings[f.member.email] = 'changed-google-subject'; f.save();
  assert.doesNotMatch((await f.request('GET', '/', {cookie})).text, /Signed in as/);
});

test('unbound login-link sessions expire after seven days and are revoked by a new Google binding', async t => {
  const f = await fixture(t);
  async function login() {
    const reply = await f.redeem(f.issue().token);
    assert.equal(reply.status, 200);
    return reply.headers['set-cookie'].find(x => x.startsWith('__Host-ddhub_session=')).split(';')[0];
  }
  const first = await login();
  f.advance(7 * 24 * 60 * 60 * 1000 - 1); await f.restart();
  assert.match((await f.request('GET', '/', {cookie: first})).text, /Signed in as/);
  f.advance(1);
  assert.doesNotMatch((await f.request('GET', '/', {cookie: first})).text, /Signed in as/);
  const second = await login();
  f.bindings[f.member.email] = 'new-verified-google-subject'; f.save();
  assert.doesNotMatch((await f.request('GET', '/', {cookie: second})).text, /Signed in as/);
});

test('login-link records must remain private regular files', async t => {
  const f = await fixture(t), issued = f.issue();
  const folder = path.join(f.directory, 'portal-login-links'), file = path.join(folder, fs.readdirSync(folder)[0]);
  fs.chmodSync(file, 0o644);
  assert.throws(() => f.consume(issued.token));
  fs.chmodSync(file, 0o600);
  const moved = path.join(f.directory, 'elsewhere');
  fs.renameSync(file, moved); fs.symlinkSync(moved, file);
  assert.throws(() => f.consume(issued.token));
});
