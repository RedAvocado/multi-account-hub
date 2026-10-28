'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {spawn} = require('node:child_process');
const {loadHubConfig, renderClientScript} = require('../portal/hub-config.cjs');

function withConfig(value) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-config-'));
  fs.writeFileSync(path.join(directory, 'hub.json'), JSON.stringify(value));
  return directory;
}

test('hub.json supports a website hub and a Tailscale-only hub', () => {
  const website = loadHubConfig(withConfig({hubUrl: 'https://hub.example.com', alternateUrls: ['https://old.example.com'],
    portal: {workspaceDomain: 'example.org', googleRedirectUri: 'https://old.example.com/oauth/callback'}}));
  assert.deepEqual(website.hosts, ['hub.example.com', 'old.example.com']);
  assert.equal(website.portal.workspaceDomain, 'example.org');
  assert.equal(website.portal.googleRedirectUri, 'https://old.example.com/oauth/callback');
  assert.equal(website.launchdLabelPrefix, 'com.dittodub.multi-account-hub.');

  const tailnet = loadHubConfig(withConfig({hubUrl: 'https://hub.tail1234.ts.net:8443'}));
  assert.equal(tailnet.portal, null);
  assert.deepEqual(tailnet.hosts, ['hub.tail1234.ts.net:8443']);
  assert.equal(loadHubConfig(withConfig({hubUrl: 'https://hub.example.com', portal: {workspaceDomain: 'example.org'}})).portal.googleRedirectUri,
    'https://hub.example.com/');

  for (const bad of [{}, {hubUrl: 'http://hub.example.com'}, {hubUrl: 'https://hub.example.com/path'}, {hubUrl: 'https://hub.example.com"'},
    {hubUrl: 'https://hub.example.com', portal: {}}, {hubUrl: 'https://hub.example.com', portal: {workspaceDomain: 'example.org', googleRedirectUri: 'https://elsewhere.example.com/'}},
    {hubUrl: 'https://hub.example.com', launchdLabelPrefix: 'bad prefix'}]) {
    assert.throws(() => loadHubConfig(withConfig(bad)), JSON.stringify(bad));
  }
  assert.throws(() => loadHubConfig(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-config-missing-'))), /hub\.json is missing/);
  assert.equal(renderClientScript("const HUB = ['__HUB_ORIGIN__', /* __HUB_ALTERNATE_ORIGINS__ */];", website),
    'const HUB = [\'https://hub.example.com\', "https://old.example.com"];');
});

test('a hub without a website serves the API and setup scripts but no portal routes', async () => {
  const directory = withConfig({hubUrl: 'https://hub.tail1234.ts.net'});
  fs.writeFileSync(path.join(directory, 'gateway-users.json'), JSON.stringify({users: []}));
  fs.mkdirSync(path.join(directory, 'onboarding'));
  fs.writeFileSync(path.join(directory, 'onboarding', 'setup-provider-hub.sh'), 'HUB=__HUB_ORIGIN__\n');
  const portal = http.createServer((req, res) => { res.writeHead(200); res.end('portal must not be reached'); });
  await new Promise(resolve => portal.listen(0, '127.0.0.1', resolve));
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const gateway = spawn(process.execPath, [path.join(__dirname, '..', 'team-gateway.cjs')], {stdio: 'ignore',
    env: {...process.env, HUB_GATEWAY_DIR: directory, HUB_GATEWAY_PORT: String(port), HUB_BACKEND_PORT: '9', HUB_PORTAL_PORT: String(portal.address().port)}});
  const get = (target, host = 'hub.tail1234.ts.net') => new Promise((resolve, reject) => {
    http.get({host: '127.0.0.1', port, path: target, headers: {host}}, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk); res.on('end', () => resolve({status: res.statusCode, text}));
    }).on('error', reject);
  });
  try {
    let script;
    for (let i = 0; i < 50 && !script; i++) {
      try { script = await get('/setup-provider-hub.sh'); } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert.deepEqual(script, {status: 200, text: 'HUB=https://hub.tail1234.ts.net\n'});
    for (const target of ['/', '/sign-in', '/portal.css', '/dittodub-white.svg']) assert.equal((await get(target)).status, 404, target);
    assert.equal((await get('/v1/models')).status, 401);
  } finally {
    gateway.kill();
    portal.close();
  }
});
