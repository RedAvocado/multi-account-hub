'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {environmentPlan, readConnection, routingArgs, withRoutingArgs, providerName} = require('../scripts/configure-t3-usage.cjs');

const origin = 'https://hub.example.com', origins = [origin], key = 'h'.repeat(43);
const legacy = 'model_provider = "dittodub-provider-hub"\n\n[model_providers.dittodub-provider-hub]\n' +
  'name = "Hub"\nbase_url = "' + origin + '/v1"\nwire_api = "responses"\n' +
  'requires_openai_auth = false\nsupports_websockets = true\nexperimental_bearer_token = "' + key + '"\n';
const personal = 'model_provider = "personal"\nmodel = "personal-model"\ncli_auth_credentials_store = "keyring"\n' +
  '[model_providers.personal]\nbase_url = "https://personal.invalid/v1"\nname = "Personal"\nwire_api = "responses"\n' +
  '[mcp_servers.example]\ncommand = "example-mcp"\n[plugins."example@local"]\nenabled = true\n';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-environment-test-'));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const root = path.join(home, '.dittodub-provider-hub'), codex = path.join(root, 'codex');
  function write(relative, text, mode = 0o600) {
    const file = path.join(home, relative);
    fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
    fs.writeFileSync(file, text, {mode});
    return file;
  }
  const config = path.join(codex, 'config.toml');
  return {home, root, codex, config, write, plan: () => environmentPlan(home, origins),
    seed() {
      write('.codex/config.toml', personal);
      write('.codex/auth.json', '{"tokens":{"access_token":"PERSONAL"}}\n');
      write('.codex/AGENTS.md', 'Use the shared instructions.\n');
      write('.codex/plugins/cache/example/plugin.json', '{"name":"example"}');
      write('.codex/plugins/installed_plugins.json', '{"example":true}');
      write('.codex/skills/example/SKILL.md', 'Shared skill');
    },
    credentials() {
      write('.dittodub-provider-hub/codex/auth.json', JSON.stringify({OPENAI_API_KEY: key}));
      write('.dittodub-provider-hub/device-key', key + '\n');
    },
  };
}

test('fresh environment shares config/MCP/plugins/instructions, but keeps auth and runtime state private', t => {
  const f = fixture(t);
  assert.equal(f.plan().connection, null);
  assert.equal(fs.existsSync(f.root), false, 'preflight must not create files');
  f.seed(); f.credentials();
  const runtime = f.write('.dittodub-provider-hub/codex/sessions/keep', 'hub session');
  f.write('.codex/sessions/keep', 'personal session');
  f.write('.dittodub-provider-hub/codex/history.jsonl', 'hub history');
  const before = fs.readFileSync(path.join(f.home, '.codex/config.toml'));
  const auth = fs.readFileSync(path.join(f.home, '.codex/auth.json'));
  f.plan().apply(); f.plan().apply();
  for (const name of ['config.toml', 'skills', 'plugins', 'AGENTS.md']) {
    const target = path.join(f.codex, name);
    assert.ok(fs.lstatSync(target).isSymbolicLink());
    assert.equal(fs.realpathSync(target), fs.realpathSync(path.join(f.home, '.codex', name)));
  }
  assert.deepEqual(fs.readFileSync(f.config), before);
  assert.deepEqual(fs.readFileSync(path.join(f.home, '.codex/auth.json')), auth);
  assert.equal(fs.readFileSync(runtime, 'utf8'), 'hub session');
  assert.equal(fs.readFileSync(path.join(f.codex, 'history.jsonl'), 'utf8'), 'hub history');
  assert.ok(!fs.lstatSync(path.join(f.codex, 'auth.json')).isSymbolicLink());
  assert.equal(fs.statSync(path.join(f.codex, 'auth.json')).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(f.root, 'backups')), false);
  // Atomic config replacements and future plugin/skill/instruction edits remain visible.
  const replacement = f.write('.codex/new-config', personal + '[mcp_servers.future]\ncommand = "future"\n');
  fs.renameSync(replacement, path.join(f.home, '.codex/config.toml'));
  f.write('.codex/plugins/cache/future/plugin.json', 'future plugin');
  f.write('.codex/skills/future/SKILL.md', 'future skill');
  f.write('.codex/AGENTS.md', 'New instructions');
  assert.match(fs.readFileSync(f.config, 'utf8'), /mcp_servers.future/);
  assert.equal(fs.readFileSync(path.join(f.codex, 'plugins/cache/future/plugin.json'), 'utf8'), 'future plugin');
  assert.equal(fs.readFileSync(path.join(f.codex, 'skills/future/SKILL.md'), 'utf8'), 'future skill');
  assert.equal(fs.readFileSync(path.join(f.codex, 'AGENTS.md'), 'utf8'), 'New instructions');
});

test('minimal legacy config migrates with a private backup, once; missing PERSONAL files are created', t => {
  const f = fixture(t);
  f.write('.dittodub-provider-hub/codex/config.toml', legacy);
  f.write('.dittodub-provider-hub/codex/skills/.system/builtin/SKILL.md', 'old builtin');
  f.plan().apply();
  const backups = fs.readdirSync(path.join(f.root, 'backups')).sort();
  assert.equal(backups.length, 2);
  const configBackup = backups.map(dir => path.join(f.root, 'backups', dir, 'codex-config.toml')).find(file => fs.existsSync(file));
  assert.equal(fs.readFileSync(configBackup, 'utf8'), legacy);
  assert.equal(fs.statSync(configBackup).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(f.config, 'utf8'), '');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.codex, 'auth.json'))).OPENAI_API_KEY, key);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.codex, 'hub-connection.json'))).baseUrl, origin + '/v1');
  f.plan().apply();
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'backups')).sort(), backups);
});

test('already shared owner-style setup migrates from private auth/device key without reading PERSONAL auth', t => {
  const f = fixture(t); f.seed(); f.credentials();
  for (const name of ['config.toml', 'skills', 'plugins', 'AGENTS.md']) {
    fs.symlinkSync(path.join(f.home, '.codex', name), path.join(f.codex, name));
  }
  const before = fs.readFileSync(f.config), privateAuth = fs.readFileSync(path.join(f.codex, 'auth.json'));
  f.plan().apply(); f.plan().apply();
  assert.deepEqual(fs.readFileSync(f.config), before);
  assert.deepEqual(fs.readFileSync(path.join(f.codex, 'auth.json')), privateAuth);
  assert.equal(fs.existsSync(path.join(f.root, 'backups')), false);
});

for (const [name, setup, error] of [
  ['custom top-level config', f => f.write('.dittodub-provider-hub/codex/config.toml', 'model = "keep"\n' + legacy), /deliberate merge/],
  ['custom MCP config', f => f.write('.dittodub-provider-hub/codex/config.toml', legacy + '\n[mcp_servers.keep]\ncommand = "keep"\n'), /deliberate merge/],
  ['custom plugins', f => f.write('.dittodub-provider-hub/codex/plugins/keep.json', 'keep'), /custom files/],
  ['custom instructions', f => f.write('.dittodub-provider-hub/codex/AGENTS.md', 'Keep HUB instructions'), /custom files/],
  ['custom Claude skills', f => f.write('.dittodub-provider-hub/claude/skills/custom/SKILL.md', 'keep'), /custom files/],
  ['unexpected config link', f => fs.symlinkSync(f.write('other-config', personal), f.config), /links elsewhere/],
  ['broken config link', f => fs.symlinkSync(path.join(f.home, 'absent'), f.config), /links elsewhere/],
  ['circular config link', f => fs.symlinkSync(f.config, f.config), /links elsewhere/],
  ['source link into HUB', f => { fs.mkdirSync(path.join(f.home, '.codex')); fs.symlinkSync(f.config, path.join(f.home, '.codex/config.toml')); }, /PERSONAL/],
  ['linked auth', f => { fs.unlinkSync(path.join(f.codex, 'auth.json')); fs.symlinkSync(f.write('outside-auth', '{}'), path.join(f.codex, 'auth.json')); }, /private, owned regular/],
  ['hardlinked auth', f => fs.linkSync(path.join(f.codex, 'auth.json'), path.join(f.home, 'other-auth')), /private, owned regular/],
  ['linked Claude launcher', f => fs.symlinkSync(f.write('other-launcher', 'keep', 0o700), path.join(f.root, 'hub-claude')), /owned executable/],
  ['conflicting keys', f => f.write('.dittodub-provider-hub/device-key', 'd'.repeat(43)), /disagree/],
  ['foreign connection URL', f => f.write('.dittodub-provider-hub/codex/hub-connection.json', '{"version":1,"baseUrl":"https://other.invalid/v1"}'), /Unrecognized/],
]) test(name + ' is rejected before shared files or backups are created', t => {
  const f = fixture(t); f.credentials(); setup(f);
  assert.throws(f.plan, error);
  assert.equal(fs.existsSync(path.join(f.root, 'backups')), false);
  assert.equal(fs.existsSync(path.join(f.codex, 'skills')), false);
  assert.equal(fs.existsSync(path.join(f.home, '.codex/plugins')), false);
});

test('changes after preflight are detected before linking', t => {
  const f = fixture(t); f.credentials();
  const plan = f.plan();
  f.write('.dittodub-provider-hub/codex/AGENTS.md', 'keep concurrent edit');
  assert.throws(() => plan.apply(), /custom files/);
  assert.equal(fs.existsSync(f.config), false);
});

test('shared config is never a credential source and arbitrary symlinks remain rejected in the usage reader', t => {
  const f = fixture(t); f.seed();
  fs.mkdirSync(f.codex, {recursive: true});
  fs.symlinkSync(path.join(f.home, '.codex/config.toml'), f.config);
  assert.throws(() => readConnection(f.codex, {home: f.home, origins}), /private HUB credential/);
  fs.unlinkSync(f.config);
  fs.symlinkSync(f.write('other', legacy), f.config);
  assert.throws(() => readConnection(f.codex, {home: f.home, origins}), /Unexpected/);
});

test('launch overrides are non-secret, appended after user flags, and idempotent', () => {
  const original = '-c \'model_provider="personal"\' -c \'model_reasoning_effort="high"\'';
  const args = withRoutingArgs(original, origin + '/v1', '/fixture/codex');
  assert.ok(args.startsWith(original + ' '));
  assert.ok(args.endsWith(routingArgs(origin + '/v1', '/fixture/codex')));
  assert.equal(withRoutingArgs(args, origin + '/v1', '/fixture/codex'), args);
  assert.ok(!args.includes(key) && !args.includes('experimental_bearer_token'));
  for (const invalid of ['--', '-c "unclosed', "'unclosed"]) assert.throws(() => withRoutingArgs(invalid, origin + '/v1', '/fixture/codex'));
});

test('usage main uses private connection, installs overrides before links/refresh, preserves PERSONAL config, and supports reruns', async t => {
  const f = fixture(t); f.seed(); f.credentials();
  const binary = f.write('bin/codex', '#!/bin/sh\nexit 0\n', 0o700);
  const rendered = f.write('setup.cjs', fs.readFileSync(path.join(__dirname, '../scripts/configure-t3-usage.cjs'), 'utf8').replaceAll('__HUB_ORIGIN__', origin));
  const {main} = require(rendered);
  t.mock.method(os, 'homedir', () => f.home);
  const requests = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    assert.ok(url.startsWith(origin + '/v1/'));
    assert.equal(options.headers.authorization, 'Bearer ' + key);
    requests.push(url);
    return {ok: true, async json() {
      return url.endsWith('/usage') ? {accounts: [{}]} : {data: [{id: 'gpt-99', owned_by: 'openai'}, {id: 'claude-future', owned_by: 'anthropic'}]};
    }};
  });
  const settings = {providerInstances: {personal: {driver: 'codex', config: {binaryPath: binary, homePath: path.join(f.home, '.codex')}}}};
  const original = fs.readFileSync(path.join(f.home, '.codex/config.toml'));
  const calls = [];
  let first = true;
  const client = {close() { calls.push('close'); }, async request(tag, payload) {
    calls.push(tag);
    if (tag === 'server.getConfig') return {settings: structuredClone(settings), providers: []};
    if (tag === 'server.getSettings') return structuredClone(settings);
    if (tag === 'server.updateSettings') {
      const mutation = payload.providerInstanceMutation;
      if (mutation) {
        if (first) assert.equal(fs.existsSync(f.config), false, 'overrides must be saved before sharing');
        settings.providerInstances[mutation.instanceId] = structuredClone(mutation.instance);
      } else assert.equal(payload.patch.usageLimitSources['dittodub-provider-hub'].managementKey, key);
      return settings;
    }
    assert.equal(tag, 'server.refreshProviders');
    assert.ok(fs.lstatSync(f.config).isSymbolicLink());
    assert.ok(fs.statSync(path.join(f.root, 'hub-claude')).mode & 0o100);
    assert.ok(settings.providerInstances.hub_codex.config.launchArgs.endsWith(routingArgs(origin + '/v1', f.codex)));
    return {providers: Object.entries(settings.providerInstances).map(([instanceId, value]) => ({
      instanceId, installed: true, enabled: true, status: 'ready', models: (value.config.customModels || []).map(slug => ({slug})),
    }))};
  }};
  const dependencies = {
    localT3: () => ({origin: new URL('http://127.0.0.1:9999'), t3: '/mock/t3'}),
    connect: async () => client,
    execFileSync: (_file, args) => { calls.push(args[2]); return args[2] === 'issue' ? JSON.stringify({token: 'mock-session', sessionId: 'mock-id'}) : ''; },
  };
  await main(['--codex-home', f.codex], dependencies);
  first = false;
  const afterFirst = structuredClone(settings);
  await main(['--codex-home', f.codex], dependencies);
  assert.deepEqual(settings, afterFirst);
  assert.deepEqual(fs.readFileSync(path.join(f.home, '.codex/config.toml')), original);
  assert.equal(requests.length, 4);
  assert.equal(calls.filter(call => call === 'revoke').length, 2);
  assert.equal(calls.filter(call => call === 'close').length, 2);
});

test('reserved provider table collision is rejected before migration', t => {
  const f = fixture(t); f.seed(); f.credentials();
  fs.appendFileSync(path.join(f.home, '.codex/config.toml'), '\n[model_providers.' + providerName(f.codex) + ']\nenv_key = "OTHER"\n');
  assert.throws(f.plan, /reserved HUB provider/);
  assert.equal(fs.existsSync(f.config), false);
});

test('legacy alternate HUB endpoint survives migration independently of shared config', t => {
  const f = fixture(t);
  const alternate = 'https://old-hub.example.com';
  f.write('.dittodub-provider-hub/codex/config.toml', legacy.replace(origin, alternate));
  const plan = environmentPlan(f.home, [origin, alternate]);
  assert.equal(plan.connection.baseUrl, alternate + '/v1');
  plan.apply();
  assert.equal(readConnection(f.codex, {home: f.home, origins: [origin, alternate]}).baseUrl, alternate + '/v1');
  assert.equal(fs.readFileSync(f.config, 'utf8'), '');
});
