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
const {loadHubConfig} = require('./hub-config.cjs');

const main = 'https://hub.example.com';
const relayHost = 'https://old-hub.example.com';
const second = 'https://providers.example.net';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const random = () => crypto.randomBytes(48).toString('base64url');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => server.close(resolve));

function writeHub(directory, portal, alternateUrls = [relayHost, second]) {
  fs.writeFileSync(path.join(directory, 'hub.json'), JSON.stringify({hubUrl: main, alternateUrls,
    portal: {workspaceDomain: 'example.org', googleRedirectUri: relayHost + '/oauth/callback', ...portal}}));
}

test('hub.json additional sites need an alternate URL and get their own Google redirect', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-sites-config-'));
  try {
    writeHub(directory, {additionalSites: [{url: second}]});
    assert.deepEqual(loadHubConfig(directory).portal.sites.map(site => ({...site})), [
      {origin: main, googleRedirectUri: relayHost + '/oauth/callback'},
      {origin: second, googleRedirectUri: second + '/oauth/callback'},
    ]);
    writeHub(directory, {}); // Existing configurations keep one site.
    assert.equal(loadHubConfig(directory).portal.sites.length, 1);
    for (const [portal, alternates] of [
      [{additionalSites: [{url: 'https://unlisted.example.net'}]}, undefined],
      [{additionalSites: [{url: second}, {url: second}]}, undefined],
      [{additionalSites: [{url: second, googleRedirectUri: 'https://evil.example/oauth/callback'}]}, undefined],
      [{additionalSites: [{url: second}]}, [relayHost]],
      [{additionalSites: {url: second}}, undefined],
    ]) {
      writeHub(directory, portal, alternates);
      assert.throws(() => loadHubConfig(directory), /hub\.json/);
    }
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});

test('both sites serve the same website, and each sign-in stays on its own address', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-sites-'));
  fs.mkdirSync(path.join(directory, 'team-keys'));
  const internal = random();
  fs.writeFileSync(path.join(directory, 'gateway-users.json'), JSON.stringify({users: [
    {name: 'jordan', email: 'jordan@example.org', keyHash: digest(internal), enabled: true}]}));
  fs.writeFileSync(path.join(directory, 'team-keys', 'jordan.key'), internal);
  writeHub(directory, {additionalSites: [{url: second}]});
  const hub = loadHubConfig(directory);
  const sites = hub.portal.sites.map(site => ({origin: site.origin, callbackOrigin: new URL(site.googleRedirectUri).origin,
    callbackPath: new URL(site.googleRedirectUri).pathname}));
  const issued = [], exchanged = [];
  let nonce;
  const oauth = {
    authorizationUrl(values) { nonce = values.nonce; issued.push(values.redirectUri); return 'https://accounts.google.com/test?state=' + values.state; },
    async exchange(values) { exchanged.push(values.redirectUri); return {email: 'jordan@example.org', sub: 'test-jordan', email_verified: true, hd: 'example.org', nonce}; },
  };
  const portal = createPortal({directory, origin: main, sites, workspaceDomain: 'example.org', oauth});
  const backend = http.createServer((req, res) => { res.writeHead(req.headers.authorization === 'Bearer ' + internal ? 200 : 401); res.end(); });
  await listen(portal); await listen(backend);
  const probe = http.createServer(); await listen(probe); const gatewayPort = probe.address().port; await close(probe);
  const gateway = spawn(process.execPath, [path.join(__dirname, '..', 'team-gateway.cjs')], {
    stdio: 'ignore', env: {...process.env, HUB_GATEWAY_DIR: directory, HUB_GATEWAY_PORT: String(gatewayPort),
      HUB_BACKEND_PORT: String(backend.address().port), HUB_PORTAL_PORT: String(portal.address().port)},
  });
  const request = (method, requestPath, site, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port: gatewayPort, method, path: requestPath,
      headers: {host: new URL(site).host, ...headers}}, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk);
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, text}));
    });
    req.on('error', reject); req.end();
  });
  const signIn = async site => {
    const start = await request('GET', '/sign-in', site);
    return {state: new URL(start.headers.location).searchParams.get('state'), binding: start.headers['set-cookie'][0].split(';')[0]};
  };
  try {
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      try { ready = (await request('GET', '/', main)).status === 200; } catch {}
      if (!ready) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready);
    const home = await request('GET', '/', second);
    assert.equal(home.status, 200);
    assert.match(home.text, /Sign in with Google/);
    assert.equal((await request('GET', '/', 'https://unknown.example.net')).status, 400);

    // The second site signs in on its own address, without the relay host.
    let flow = await signIn(second);
    assert.equal(issued.at(-1), second + '/oauth/callback');
    // A state issued for one site cannot be completed on another site's callback.
    assert.equal((await request('GET', `/oauth/callback?state=${flow.state}&code=valid`, relayHost, {cookie: flow.binding})).status, 401);
    flow = await signIn(second);
    const done = await request('GET', `/oauth/callback?state=${flow.state}&code=valid`, second, {cookie: flow.binding});
    assert.equal(done.status, 303);
    assert.equal(done.headers.location, '/');
    assert.equal(exchanged.at(-1), second + '/oauth/callback', 'the token exchange uses the redirect the browser used');
    const cookie = done.headers['set-cookie'].map(c => c.split(';')[0]).find(c => c.startsWith('__Host-ddhub_session='));
    const page = await request('GET', '/', second, {cookie});
    assert.match(page.text, /Signed in as/);
    assert.match(page.text, /curl -fsS https:\/\/providers\.example\.net\/setup-provider-hub\.sh/);
    const csrf = /name="hub-csrf" content="([^"]+)"/.exec(page.text)[1];
    // CSRF checks require the Origin of the site the browser is on.
    assert.equal((await request('POST', '/portal/setup-code', second, {cookie, origin: main, 'x-hub-csrf': csrf})).status, 403);
    assert.equal((await request('POST', '/portal/setup-code', second, {cookie, origin: second, 'x-hub-csrf': csrf})).status, 200);

    // The main site still relays through its original Google redirect host.
    flow = await signIn(main);
    assert.equal(issued.at(-1), relayHost + '/oauth/callback');
    const relay = new URL((await request('GET', `/oauth/callback?state=${flow.state}&code=valid`, relayHost)).headers.location);
    assert.equal(relay.origin, main);
    assert.equal((await request('GET', relay.pathname + relay.search, second, {cookie: flow.binding})).status, 401,
      'a relay for the main site cannot complete on the second site');
    flow = await signIn(main);
    const relayed = new URL((await request('GET', `/oauth/callback?state=${flow.state}&code=valid`, relayHost)).headers.location);
    assert.equal((await request('GET', relayed.pathname + relayed.search, main, {cookie: flow.binding})).status, 303);
    assert.equal(exchanged.at(-1), relayHost + '/oauth/callback');
  } finally {
    gateway.kill('SIGTERM');
    await new Promise(resolve => gateway.once('exit', resolve));
    await close(portal); await close(backend);
    fs.rmSync(directory, {recursive: true, force: true});
  }
});
