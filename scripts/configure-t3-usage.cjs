#!/usr/bin/env node
'use strict';

// Upgrade an existing hub connection using T3's supported local session/settings
// APIs. Secrets stay in memory and T3's secret store, never in command arguments.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {execFileSync} = require('node:child_process');
// The hub fills in its own addresses when it serves this script.
const HUB_ORIGINS = ['__HUB_ORIGIN__', /* __HUB_ALTERNATE_ORIGINS__ */];
const ORIGIN = HUB_ORIGINS[0];
class SetupError extends Error {}

function option(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new SetupError(`Missing ${name} value.`);
  return path.resolve(args[i + 1]);
}
function readPrivate(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 1024 * 1024) {
    throw new SetupError(`Expected a private, owned regular file: ${file}`);
  }
  return fs.readFileSync(file, 'utf8');
}
function parseConfig(text, origins = HUB_ORIGINS) {
  const name = /^model_provider\s*=\s*"([a-zA-Z0-9_-]+)"\s*$/m.exec(text)?.[1];
  if (!name) throw new SetupError('Could not find the selected hub provider.');
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = new RegExp(`^\\[model_providers\\.${escaped}\\]\\s*\n([^]*?)(?=^\\[|(?![^]))`, 'm').exec(text);
  if (!block) throw new SetupError('Could not read the hub provider configuration.');
  const base = /^base_url\s*=\s*"([^"]+)"\s*$/m.exec(block[1])?.[1];
  const key = /^experimental_bearer_token\s*=\s*"([A-Za-z0-9_-]{40,128})"\s*$/m.exec(block[1])?.[1];
  if (!key || !['http://127.0.0.1:8317/v1', ...origins.map(origin => origin + '/v1')].includes(base)) throw new SetupError('This is not a recognized hub connection.');
  const updated = /^requires_openai_auth\s*=.*$/m.test(block[1])
    ? block[1].replace(/^requires_openai_auth\s*=.*$/m, 'requires_openai_auth = true')
    : block[1] + '\nrequires_openai_auth = true\n';
  return {key, text: text.replace(block[0], block[0].replace(block[1], updated))};
}

function codingModels(document) {
  if (!Array.isArray(document?.data) || document.data.length > 2000) throw new SetupError('Invalid hub model catalog.');
  const models = {codex: new Set(), claudeAgent: new Set()};
  for (const model of document.data) {
    const id = model?.id;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(id)) {
      throw new SetupError('Invalid model ID in the hub catalog.');
    }
    if (model.owned_by === 'anthropic' && id.startsWith('claude-')) models.claudeAgent.add(id);
    // The same endpoint also advertises image/audio models and internal Codex
    // helpers. Those are not conversational coding models for the T3 picker.
    if (model.owned_by === 'openai' && /^(gpt-\d|o\d(?:-|$))/.test(id) &&
        !/(image|audio|realtime|transcrib|tts|embedding|moderation|search)/i.test(id)) models.codex.add(id);
  }
  if (!models.codex.size && !models.claudeAgent.size) throw new SetupError('The hub advertised no coding models. Check account access and rerun setup.');
  return Object.fromEntries(Object.entries(models).map(([driver, ids]) => [driver, [...ids].sort()]));
}

function normalizedHome(value, home) {
  if (typeof value !== 'string' || !value) return null;
  return path.resolve(value === '~' ? home : value.startsWith('~/') ? path.join(home, value.slice(2)) : value);
}

function providerPlan(settings, {home, codexHome, codexBinary, claudeHome, claudeBinary, models, catalog = []}) {
  const instances = settings.providerInstances;
  if (!instances || typeof instances !== 'object' || Array.isArray(instances)) throw new SetupError('T3 did not return provider settings.');
  const targets = [{id: 'hub_codex', driver: 'codex', name: 'HUB Codex', directory: codexHome, binary: codexBinary}];
  if (claudeHome && claudeBinary) targets.push({id: 'hub_claude', driver: 'claudeAgent', name: 'HUB Claude', directory: claudeHome, binary: claudeBinary});
  const plan = [];
  for (const target of targets) {
    const matches = Object.entries(instances).filter(([, instance]) => instance.driver === target.driver &&
      normalizedHome(instance.config?.homePath, home) === path.resolve(target.directory));
    if (!matches.length) {
      if (instances[target.id]) throw new SetupError(`${target.id} already refers to another provider. Resolve that name conflict in T3 before rerunning setup.`);
      if (!target.binary) throw new SetupError(`Install ${target.driver === 'codex' ? 'Codex' : 'Claude'} in T3 Code before rerunning setup.`);
      matches.push([target.id, {driver: target.driver, displayName: target.name, enabled: true,
        config: {...(target.driver === 'codex' ? {setupMode: 'existing'} : {}), binaryPath: target.binary, homePath: target.directory}}]);
    }
    for (const [id, instance] of matches) {
      const current = instance.config?.customModels ?? [];
      if (!Array.isArray(current)) throw new SetupError(`Unexpected custom model settings for ${id}; they were preserved.`);
      const known = new Set(current.map(model => typeof model === 'string' ? model : model.slug));
      for (const model of catalog.find(provider => provider.instanceId === id)?.models || []) known.add(model.slug);
      const additions = models[target.driver].filter(model => !known.has(model));
      const next = {...instance, config: {...instance.config, customModels: [...current, ...additions]}};
      plan.push({id, driver: target.driver, instance: next, added: additions.length,
        changed: !instances[id] || additions.length > 0});
    }
  }
  return plan;
}

function findCodexBinary(settings, home) {
  const candidates = [path.join(home, '.local/share/t3-codex/node_modules/.bin/codex'),
    ...Object.values(settings.providerInstances || {}).filter(p => p.driver === 'codex').map(p => p.config?.binaryPath),
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, 'codex'))];
  return candidates.find(candidate => {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) return false;
    try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile(); } catch (_) { return false; }
  });
}

async function syncProviders(client, options) {
  const before = await client.request('server.getConfig');
  // Plan both providers before writing anything, including collision checks.
  const plan = providerPlan(before.settings, {...options, catalog: before.providers,
    codexBinary: findCodexBinary(before.settings, options.home)});
  for (const item of plan.filter(item => item.changed)) {
    // Re-read settings so a change made in T3 while discovery ran is retained.
    const current = await client.request('server.getSettings');
    const fresh = providerPlan(current, {...options, catalog: before.providers,
      codexBinary: findCodexBinary(current, options.home)}).find(provider => provider.id === item.id);
    if (!fresh) throw new SetupError('Hub provider settings changed during setup; rerun to finish model sync.');
    if (!fresh.changed) continue;
    await client.request('server.updateSettings', {patch: {}, providerInstanceMutation: {
      operation: current.providerInstances[fresh.id] ? 'upsert' : 'create', instanceId: fresh.id, instance: fresh.instance,
    }});
  }
  const result = await client.request('server.refreshProviders', {fresh: true, refreshModels: true});
  for (const item of plan) {
    const provider = result.providers?.find(provider => provider.instanceId === item.id);
    const expected = options.models[item.driver];
    const visible = new Set(provider?.models?.map(model => model.slug) || []);
    if (provider?.enabled === false) {
      console.log(`${item.instance.displayName || item.id}: models saved; provider remains disabled by your settings.`);
      continue;
    }
    if (!provider?.installed || provider.status !== 'ready' || expected.some(model => !visible.has(model))) {
      throw new SetupError(`${item.instance.displayName || item.id} needs attention in T3 Settings > Providers. Check CLI installation, version, and authentication, then rerun setup. Saved credentials and settings were preserved.`);
    }
    console.log(`${item.instance.displayName || item.id}: ${expected.length} hub coding models registered (${item.added} added).`);
    if (!expected.length) console.log(`No ${item.driver === 'codex' ? 'OpenAI' : 'Anthropic'} models are currently advertised for this connection. Connect or request an account, then rerun setup.`);
  }
}

async function connect(origin, token) {
  const reply = await fetch(origin + '/api/auth/websocket-ticket', {
    method: 'POST', headers: {authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(10000),
  });
  if (!reply.ok) throw new SetupError('Could not authorize the local T3 settings connection.');
  const {ticket} = await reply.json();
  const ws = new WebSocket(origin.replace(/^http/, 'ws') + '/ws?orchestrationProtocol=2&wsTicket=' + encodeURIComponent(ticket));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new SetupError('T3 connection timed out.')); }, 10000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, {once: true});
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new SetupError('T3 connection failed.')); }, {once: true});
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', event => {
    let message;
    try { message = JSON.parse(event.data); } catch (_) { return; }
    const item = pending.get(message.requestId);
    if (!item || message._tag !== 'Exit') return;
    pending.delete(message.requestId); clearTimeout(item.timer);
    if (message.exit?._tag === 'Success') item.resolve(message.exit.value);
    else item.reject(new SetupError('T3 rejected the settings request.'));
  });
  ws.addEventListener('close', () => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new SetupError('T3 connection closed.')); }
    pending.clear();
  });
  return {close: () => ws.close(), request: (tag, payload = {}) => new Promise((resolve, reject) => {
    const requestId = String(++id);
    const timer = setTimeout(() => { pending.delete(requestId); reject(new SetupError('T3 settings request timed out.')); }, tag === 'server.refreshProviders' ? 120000 : 30000);
    pending.set(requestId, {resolve, reject, timer});
    ws.send(JSON.stringify({_tag: 'Request', id: requestId, tag, payload, headers: []}));
  })};
}

function localT3(args) {
  const base = path.join(os.homedir(), '.t3');
  const runtime = JSON.parse(fs.readFileSync(path.join(base, 'userdata/server-runtime.json'), 'utf8'));
  const origin = new URL(runtime.origin);
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.username || origin.password || origin.pathname !== '/') {
    throw new SetupError('Expected a local T3 server.');
  }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-a-zA-Z0-9.]*)$/.test(runtime.serverVersion)) throw new SetupError('Unknown T3 runtime version.');
  const t3 = option(args, '--t3') || path.join(base, 'runtime/versions', runtime.serverVersion, 't3');
  fs.accessSync(t3, fs.constants.X_OK);
  return {origin, t3};
}

async function main(args) {
  if (typeof WebSocket !== 'function') throw new SetupError('Node.js 22 or later is required.');
  if (args.includes('--check')) {
    const {origin} = localT3(args);
    const response = await fetch(origin.origin + '/api/auth/session', {
      signal: AbortSignal.timeout(5000), redirect: 'error',
    });
    if (!response.ok) throw new SetupError('Open T3 Code before setting up the hub.');
    await response.json();
    console.log('T3 provider, model, and usage setup prerequisites are ready.');
    return;
  }
  const home = os.homedir();
  const codexHome = option(args, '--codex-home') || ['.dittodub-provider-hub/codex', '.codex-team-hub', '.codex-hub']
    .map(relative => path.join(home, relative)).find(directory => fs.existsSync(path.join(directory, 'config.toml')));
  if (!codexHome) throw new SetupError('Set up your hub connection first.');
  const dirStat = fs.lstatSync(codexHome);
  if (!dirStat.isDirectory() || dirStat.uid !== process.getuid()) throw new SetupError('Unsafe Codex home directory.');
  const configFile = path.join(codexHome, 'config.toml');
  const original = readPrivate(configFile), config = parseConfig(original);
  const keyFile = option(args, '--key-file');
  const key = keyFile ? readPrivate(keyFile).trim() : config.key;
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(key)) throw new SetupError('Invalid hub credential.');
  const authFile = path.join(codexHome, 'auth.json');
  let existingAuth;
  try {
    existingAuth = readPrivate(authFile);
    const auth = JSON.parse(existingAuth);
    if (auth.OPENAI_API_KEY !== config.key || auth.tokens) throw new SetupError('Existing Codex authentication differs; it was preserved.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const response = await fetch(ORIGIN + '/v1/usage', {
    headers: {authorization: `Bearer ${key}`}, signal: AbortSignal.timeout(30000), redirect: 'error',
  });
  if (!response.ok) throw new SetupError('The hub did not accept this usage key. No local configuration was changed.');
  const data = await response.json();
  if (!Array.isArray(data.accounts)) throw new SetupError('Invalid hub usage response.');
  const modelResponse = await fetch(ORIGIN + '/v1/models', {
    headers: {authorization: `Bearer ${config.key}`}, signal: AbortSignal.timeout(30000), redirect: 'error',
  });
  if (!modelResponse.ok) throw new SetupError('Could not fetch the hub model catalog. No local configuration was changed. Rerun setup once the hub is reachable.');
  const models = codingModels(await modelResponse.json());
  const standardRoot = path.join(home, '.dittodub-provider-hub');
  const claudeHome = path.join(standardRoot, 'claude'), claudeBinary = path.join(standardRoot, 'hub-claude');
  const standardSetup = codexHome === path.join(standardRoot, 'codex');
  if (standardSetup && (!fs.existsSync(claudeHome) || !fs.existsSync(claudeBinary))) {
    throw new SetupError('The HUB Claude home or launcher is missing. Finish the main setup-provider-hub.sh installation before syncing models.');
  }

  const {origin, t3} = localT3(args);
  const run = command => execFileSync(t3, command, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000});
  const session = JSON.parse(run(['auth', 'session', 'issue', '--scope', 'orchestration:read', '--scope', 'settings:write', '--scope', 'providers:manage',
    '--ttl', '5m', '--label', 'Hub provider and usage setup', '--json']));
  let client;
  try {
    client = await connect(origin.origin, session.token);
    await client.request('server.updateSettings', {patch: {usageLimitSources: {
      'dittodub-provider-hub': {kind: 'cliproxy', label: 'Multi-Account Hub',
        url: ORIGIN + '/usage', managementKey: key, enabled: true},
    }}});
    // Classify this connection as API-key auth. Keep the same provider, URL,
    // bearer credential, and account routing; T3 reads quotas from the source.
    if (readPrivate(configFile) !== original) throw new SetupError('Codex config changed during setup; retry.');
    if (existingAuth === undefined) fs.writeFileSync(authFile, JSON.stringify({OPENAI_API_KEY: config.key}) + '\n', {mode: 0o600, flag: 'wx'});
    if (config.text !== original) {
      fs.writeFileSync(configFile + '.before-usage-' + Date.now(), original, {mode: 0o600, flag: 'wx'});
      const temporary = configFile + '.usage-' + process.pid;
      try { fs.writeFileSync(temporary, config.text, {mode: 0o600, flag: 'wx'}); fs.renameSync(temporary, configFile); }
      finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    }
    await syncProviders(client, {home, codexHome, models,
      ...(standardSetup ? {claudeHome, claudeBinary} : {})});
    console.log(`Hub usage configured for ${data.accounts.length} accessible accounts. Fetches on request, cached for 30 seconds.`);
    if (!standardSetup) console.log('Legacy Codex connection updated. Use the main setup-provider-hub.sh installer for a separate HUB Claude connection.');
  } finally {
    client?.close();
    try { run(['auth', 'session', 'revoke', session.sessionId]); } catch (_) { /* Session expires in five minutes. */ }
  }
}

module.exports = {parseConfig, codingModels, providerPlan, syncProviders, connect, main};
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error(error instanceof SetupError ? error.message
    : 'Provider/model/usage setup failed. Check the local T3 installation, private hub configuration, and network connection. Saved credentials can be reused on the next run.');
  process.exitCode = 1;
});
