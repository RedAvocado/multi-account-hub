#!/usr/bin/env node
'use strict';

// Upgrade an existing hub connection using T3's supported local session/settings
// APIs. Secrets stay in memory and T3's secret store, never in command arguments.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
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
  // Inspect and open without following a symlink; recheck the open inode so
  // a rename between preflight and read cannot redirect a credential read.
  const stat = fs.lstatSync(file);
  const valid = value => value.isFile() && value.uid === process.getuid() &&
    !(value.mode & 0o077) && value.nlink === 1 && value.size <= 1024 * 1024;
  if (!valid(stat)) throw new SetupError('Expected a private, owned regular file: ' + file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!valid(opened) || opened.ino !== stat.ino || opened.dev !== stat.dev) {
      throw new SetupError('Private HUB file changed during setup; retry.');
    }
    return fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
}
function lstat(file) {
  try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function ownedDirectory(directory) {
  const stat = lstat(directory);
  if (stat && (!stat.isDirectory() || stat.uid !== process.getuid())) {
    throw new SetupError('Expected an owned directory, without symbolic links: ' + directory);
  }
}
function optionalPrivate(file) { return lstat(file) ? readPrivate(file) : undefined; }
function privateAuth(codexHome) {
  const text = optionalPrivate(path.join(codexHome, 'auth.json'));
  if (text === undefined) return undefined;
  let auth;
  try { auth = JSON.parse(text); } catch (_) { throw new SetupError('Invalid private HUB auth.json; it was preserved.'); }
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(auth?.OPENAI_API_KEY || '') || auth.tokens) {
    throw new SetupError('Existing Codex authentication differs; it was preserved.');
  }
  return auth.OPENAI_API_KEY;
}
function recognizedBase(base, origins) {
  return [ 'http://127.0.0.1:8317/v1', ...origins.map(origin => origin + '/v1') ].includes(base);
}
function parseConfig(text, origins = HUB_ORIGINS, minimal = false) {
  // Read only the old installer format. Never evaluate TOML or include its
  // contents in errors: the old config contains a bearer credential.
  const top = text.split(/^\s*\[/m)[0];
  const name = /^model_provider\s*=\s*"([a-zA-Z0-9_-]+)"\s*$/m.exec(top)?.[1];
  if (!name) throw new SetupError('Could not find the selected hub provider. Preserve custom HUB settings in PERSONAL config or T3 launch arguments, then move the old config aside and rerun.');
  const block = new RegExp('^\\[model_providers\\.' + name + '\\]\\s*\\n([^]*?)(?=^\\[|(?![^]))', 'm').exec(text);
  if (!block) throw new SetupError('Could not read the hub provider configuration.');
  const baseUrl = /^base_url\s*=\s*"([^"]+)"\s*$/m.exec(block[1])?.[1];
  const key = /^experimental_bearer_token\s*=\s*"([A-Za-z0-9_-]{40,128})"\s*$/m.exec(block[1])?.[1];
  if (!key || !recognizedBase(baseUrl, origins)) throw new SetupError('This is not a recognized hub connection.');
  if (minimal) {
    let section = '', seen = new Set();
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      if (line === '[model_providers.' + name + ']' && !section) { section = name; continue; }
      const pair = /^([a-z_]+)\s*=\s*(.*)$/.exec(line);
      const allowed = section
        ? {name: /^"[^"\\]*"$/, base_url: /^"[^"\\]*"$/, wire_api: /^"responses"$/,
          requires_openai_auth: /^(true|false)$/, supports_websockets: /^true$/,
          experimental_bearer_token: /^"[A-Za-z0-9_-]{40,128}"$/}
        : {model_provider: /^"[a-zA-Z0-9_-]+"$/};
      const id = section + '.' + pair?.[1];
      if (!pair || !allowed[pair[1]]?.test(pair[2]) || seen.has(id)) {
        throw new SetupError('Custom HUB config.toml settings need a deliberate merge into ~/.codex/config.toml or T3 launch arguments. No config was replaced. Preserve those settings, then move the old config aside and rerun.');
      }
      seen.add(id);
    }
  }
  return {key, baseUrl};
}
function readConnection(codexHome, {home, origins = HUB_ORIGINS, minimal = false} = {}) {
  ownedDirectory(codexHome);
  const standard = codexHome === path.join(home, '.dittodub-provider-hub/codex');
  if (standard) ownedDirectory(path.dirname(codexHome));
  const config = path.join(codexHome, 'config.toml'), stat = lstat(config);
  let old;
  if (stat?.isSymbolicLink()) {
    const source = path.join(home, '.codex/config.toml');
    ownedDirectory(path.dirname(source));
    if (!standard || stat.uid !== process.getuid() ||
        path.resolve(path.dirname(config), fs.readlinkSync(config)) !== source || lstat(source)?.isSymbolicLink()) {
      throw new SetupError('Unexpected HUB config.toml link; only the owned link to ~/.codex/config.toml is supported.');
    }
  } else if (stat) old = parseConfig(readPrivate(config), origins, minimal);
  const saved = optionalPrivate(path.join(codexHome, 'hub-connection.json'));
  let metadata;
  if (saved !== undefined) {
    try { metadata = JSON.parse(saved); } catch (_) { throw new SetupError('Invalid private HUB connection metadata.'); }
    if (metadata?.version !== 1 || !recognizedBase(metadata.baseUrl, origins)) throw new SetupError('Unrecognized private HUB connection metadata.');
  }
  const auth = privateAuth(codexHome);
  const device = standard ? optionalPrivate(path.join(path.dirname(codexHome), 'device-key'))?.trim() : undefined;
  const keys = [old?.key, auth, device].filter(key => key !== undefined);
  if (keys.some(key => !/^[A-Za-z0-9_-]{40,128}$/.test(key)) || new Set(keys).size > 1) {
    throw new SetupError('HUB credentials disagree; all files were preserved. Reconcile auth.json, device-key, and the old HUB config before rerunning.');
  }
  if (!keys.length) {
    if (metadata || stat) throw new SetupError('No private HUB credential found. Restore HUB auth.json or device-key before rerunning.');
    return null;
  }
  return {key: keys[0], baseUrl: metadata?.baseUrl || old?.baseUrl || origins[0] + '/v1'};
}
function saveConnection(codexHome, connection) {
  ownedDirectory(codexHome);
  fs.mkdirSync(codexHome, {recursive: true, mode: 0o700});
  if (!lstat(path.join(codexHome, 'auth.json'))) {
    fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({OPENAI_API_KEY: connection.key}) + '\n', {mode: 0o600, flag: 'wx'});
  } else if (privateAuth(codexHome) !== connection.key) throw new SetupError('HUB auth changed during setup; retry.');
  const file = path.join(codexHome, 'hub-connection.json');
  if (!lstat(file)) fs.writeFileSync(file, JSON.stringify({version: 1, baseUrl: connection.baseUrl}) + '\n', {mode: 0o600, flag: 'wx'});
}

function saveClaudeCompanion(root, connection) {
  const directory = path.join(root, 'claude'), device = path.join(root, 'device-key'), wrapper = path.join(root, 'hub-claude');
  ownedDirectory(root); ownedDirectory(directory);
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  if (!lstat(device)) fs.writeFileSync(device, connection.key + '\n', {mode: 0o600, flag: 'wx'});
  if (!lstat(wrapper)) {
    const origin = new URL(connection.baseUrl).origin;
    fs.writeFileSync(wrapper, '#!/bin/sh\nset -eu\nexport ANTHROPIC_BASE_URL=' + JSON.stringify(origin) + '\n' +
      'export ANTHROPIC_AUTH_TOKEN="$(cat "$HOME/.dittodub-provider-hub/device-key")"\n' +
      'unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY\n' +
      'exec claude "$@"\n', {mode: 0o700, flag: 'wx'});
  }
}

// A plan is validated before enrollment/network/T3 mutations. Applying it
// revalidates after provider launch arguments are saved, before discovery.
function environmentPlan(home, origins = HUB_ORIGINS) {
  const root = path.join(home, '.dittodub-provider-hub'), codexHome = path.join(root, 'codex');
  for (const dir of [root, codexHome, path.join(root, 'claude'), path.join(root, 'backups'),
    path.join(home, '.codex'), path.join(home, '.claude')]) ownedDirectory(dir);
  const wrapper = lstat(path.join(root, 'hub-claude'));
  if (wrapper && (!wrapper.isFile() || wrapper.uid !== process.getuid() || !(wrapper.mode & 0o100))) {
    throw new SetupError('Expected an owned executable HUB Claude launcher, without symbolic links.');
  }
  const entries = [
    ['codex', 'config.toml', false], ['codex', 'skills', true], ['codex', 'plugins', true],
    ['codex', 'AGENTS.md', false], ['claude', 'skills', true],
  ].map(([provider, name, directory]) => ({provider, name, directory,
    source: path.join(home, '.' + provider, name), target: path.join(root, provider, name)}));
  for (const entry of entries) {
    const {source, target, directory, name} = entry;
    const sourceStat = lstat(source), targetStat = lstat(target);
    if (sourceStat && (sourceStat.uid !== process.getuid() ||
        !(directory ? sourceStat.isDirectory() : sourceStat.isFile()))) {
      throw new SetupError('Expected an owned PERSONAL file/folder without symbolic links: ' + source);
    }
    if (name === 'config.toml' && sourceStat && fs.readFileSync(source, 'utf8').includes(providerName(codexHome))) {
      throw new SetupError('PERSONAL config contains the reserved HUB provider identifier. Remove that conflicting provider definition before rerunning; the file was preserved.');
    }
    if (targetStat?.isSymbolicLink()) {
      if (targetStat.uid !== process.getuid() || path.resolve(path.dirname(target), fs.readlinkSync(target)) !== source) {
        throw new SetupError(target + ' already links elsewhere. Preserve and resolve that link before rerunning.');
      }
      continue;
    }
    if (!targetStat) continue;
    if (targetStat.uid !== process.getuid() || !(directory ? targetStat.isDirectory() : targetStat.isFile())) {
      throw new SetupError('Unsafe existing HUB path: ' + target);
    }
    if (name === 'config.toml') continue; // Strict old-config check below.
    const harmless = directory
      ? fs.readdirSync(target).every(name => entry.name === 'skills' && name === '.system')
      : targetStat.size === 0 || (sourceStat && fs.readFileSync(target).equals(fs.readFileSync(source)));
    if (!harmless) throw new SetupError(target + ' contains custom files. Merge those ' + name + ' settings/files into ' + source + ', then move the old path aside and rerun. Nothing was hidden.');
  }
  const connection = readConnection(codexHome, {home, origins, minimal: true});
  return {connection, apply() {
    const fresh = environmentPlan(home, origins);
    if (JSON.stringify(fresh.connection) !== JSON.stringify(connection)) throw new SetupError('HUB connection changed during setup; retry.');
    if (!connection) throw new SetupError('Set up your hub connection first.');
    saveConnection(codexHome, connection);
    saveClaudeCompanion(root, connection);
    for (const {source, target, directory, provider, name} of entries) {
      fs.mkdirSync(path.dirname(source), {recursive: true, mode: 0o700});
      fs.mkdirSync(path.dirname(target), {recursive: true, mode: 0o700});
      if (!lstat(source)) {
        if (directory) fs.mkdirSync(source, {mode: 0o700});
        else fs.writeFileSync(source, '', {mode: 0o600, flag: 'wx'});
      }
      if (lstat(target)?.isSymbolicLink()) continue;
      let backup;
      if (lstat(target)) {
        const backups = path.join(root, 'backups');
        fs.mkdirSync(backups, {mode: 0o700, recursive: true});
        backup = path.join(fs.mkdtempSync(path.join(backups, 'environment-')), provider + '-' + name);
        fs.renameSync(target, backup);
      }
      try { fs.symlinkSync(source, target, directory ? 'dir' : 'file'); }
      catch (error) { if (backup) fs.renameSync(backup, target); throw error; }
      if (backup) console.log('Previous HUB file/folder preserved at ' + backup);
    }
  }};
}

function providerName(codexHome) {
  // Codex merges CLI tables with config.toml (it does not replace them).
  // A stable, installation-specific namespace avoids inheriting credentials
  // or headers from any normal PERSONAL/old HUB provider definition.
  return 'dittodub-provider-hub-' + crypto.createHash('sha256').update(path.resolve(codexHome)).digest('hex').slice(0, 16);
}
function routingArgs(baseUrl, codexHome) {
  const name = providerName(codexHome);
  return '-c \'model_provider="' + name + '"\' -c \'model_providers.' + name + '={name="Multi-Account Hub",base_url=' +
    JSON.stringify(baseUrl) + ',wire_api="responses",requires_openai_auth=true,supports_websockets=true}\' ' +
    '-c \'cli_auth_credentials_store="file"\' -c \'forced_login_method="api"\'';
}
function withRoutingArgs(current = '', baseUrl, codexHome) {
  if (typeof current !== 'string') throw new SetupError('Unexpected Codex launch arguments; they were preserved.');
  // Keep arbitrary user arguments byte-for-byte. Reuse our exact trailing
  // suffix on reruns. Refuse a malformed quote or "--" which could swallow it.
  let quote = '', escaped = false, token = '';
  for (const char of current) {
    if (escaped) { escaped = false; token += char; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ''; else token += char; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (/\s/.test(char)) { if (token === '--') throw new SetupError('HUB launch arguments contain "--"; resolve it before setup.'); token = ''; }
    else token += char;
  }
  if (token === '--') throw new SetupError('HUB launch arguments contain "--"; resolve it before setup.');
  if (quote || escaped) throw new SetupError('Malformed HUB launch arguments; they were preserved.');
  const suffix = routingArgs(baseUrl, codexHome);
  if (current.trimEnd().endsWith(suffix)) return current;
  return [current, suffix].filter(Boolean).join(' ');
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

function providerPlan(settings, {home, codexHome, codexBinary, claudeHome, claudeBinary, models, baseUrl = ORIGIN + '/v1', catalog = []}) {
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
      if (target.driver === 'codex' && (instance.config?.shadowHomePath?.trim() ||
          instance.environment?.some(variable => variable.name === 'T3CODE_CODEX_LAUNCH_ARGS' && (variable.value?.trim() || variable.valueRedacted)) || process.env.T3CODE_CODEX_LAUNCH_ARGS?.trim())) {
        throw new SetupError('HUB Codex uses shadowHomePath or T3CODE_CODEX_LAUNCH_ARGS, which overrides its home/routing settings. Resolve that conflict before rerunning.');
      }
      const launchArgs = target.driver === 'codex' ? withRoutingArgs(instance.config?.launchArgs, baseUrl, codexHome) : undefined;
      const next = {...instance, config: {...instance.config, customModels: [...current, ...additions],
        ...(launchArgs === undefined ? {} : {launchArgs})}};
      plan.push({id, driver: target.driver, instance: next, added: additions.length,
        changed: !instances[id] || additions.length > 0 || launchArgs !== undefined && launchArgs !== instance.config?.launchArgs});
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
  options.beforeRefresh?.();
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

async function main(args, dependencies = {}) {
  const locateT3 = dependencies.localT3 || localT3;
  const openT3 = dependencies.connect || connect;
  const execute = dependencies.execFileSync || execFileSync;
  if (typeof WebSocket !== 'function') throw new SetupError('Node.js 22 or later is required.');
  if (args.includes('--check')) {
    const {origin} = locateT3(args);
    const response = await fetch(origin.origin + '/api/auth/session', {
      signal: AbortSignal.timeout(5000), redirect: 'error',
    });
    if (!response.ok) throw new SetupError('Open T3 Code before setting up the hub.');
    await response.json();
    console.log('T3 provider, model, and usage setup prerequisites are ready.');
    return;
  }
  const home = os.homedir();
  if (args.includes('--check-environment')) { environmentPlan(home); return; }
  const codexHome = option(args, '--codex-home') || ['.dittodub-provider-hub/codex', '.codex-team-hub', '.codex-hub']
    .map(relative => path.join(home, relative)).find(directory => lstat(path.join(directory, 'hub-connection.json')) || lstat(path.join(directory, 'config.toml')));
  if (!codexHome) throw new SetupError('Set up your hub connection first.');
  const standardRoot = path.join(home, '.dittodub-provider-hub');
  const standardSetup = codexHome === path.join(standardRoot, 'codex');
  const environment = standardSetup ? environmentPlan(home) : undefined;
  const connection = environment ? environment.connection : readConnection(codexHome, {home});
  if (!connection) throw new SetupError('Set up your hub connection first.');
  const keyFile = option(args, '--key-file');
  const key = keyFile ? readPrivate(keyFile).trim() : connection.key;
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(key)) throw new SetupError('Invalid hub credential.');
  const response = await fetch(ORIGIN + '/v1/usage', {
    headers: {authorization: `Bearer ${key}`}, signal: AbortSignal.timeout(30000), redirect: 'error',
  });
  if (!response.ok) throw new SetupError('The hub did not accept this usage key. No local configuration was changed.');
  const data = await response.json();
  if (!Array.isArray(data.accounts)) throw new SetupError('Invalid hub usage response.');
  const modelResponse = await fetch(ORIGIN + '/v1/models', {
    headers: {authorization: `Bearer ${connection.key}`}, signal: AbortSignal.timeout(30000), redirect: 'error',
  });
  if (!modelResponse.ok) throw new SetupError('Could not fetch the hub model catalog. No local configuration was changed. Rerun setup once the hub is reachable.');
  const models = codingModels(await modelResponse.json());
  const claudeHome = path.join(standardRoot, 'claude'), claudeBinary = path.join(standardRoot, 'hub-claude');

  const {origin, t3} = locateT3(args);
  const run = command => execute(t3, command, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000});
  const session = JSON.parse(run(['auth', 'session', 'issue', '--scope', 'orchestration:read', '--scope', 'settings:write', '--scope', 'providers:manage',
    '--ttl', '5m', '--label', 'Hub provider and usage setup', '--json']));
  let client;
  try {
    client = await openT3(origin.origin, session.token);
    await client.request('server.updateSettings', {patch: {usageLimitSources: {
      'dittodub-provider-hub': {kind: 'cliproxy', label: 'Multi-Account Hub',
        url: ORIGIN + '/usage', managementKey: key, enabled: true},
    }}});
    // Credentials remain private. Apply links only after every provider has
    // received explicit routing, and before T3 refresh starts fresh probes.
    if (JSON.stringify(readConnection(codexHome, {home})) !== JSON.stringify(connection)) throw new SetupError('HUB connection changed during setup; retry.');
    saveConnection(codexHome, connection);
    if (standardSetup) saveClaudeCompanion(standardRoot, connection);
    await syncProviders(client, {home, codexHome, models, baseUrl: connection.baseUrl,
      ...(standardSetup ? {claudeHome, claudeBinary, beforeRefresh: () => environment.apply()} : {})});
    if (standardSetup) console.log('HUB Codex shares PERSONAL config, skills, plugins, and AGENTS.md. Auth and runtime state remain separate. Start a fresh provider process to load changes; a catalog refresh does not replace running conversations.');
    console.log(`Hub usage configured for ${data.accounts.length} accessible accounts. Fetches on request, cached for 30 seconds.`);
    if (!standardSetup) console.log('Legacy Codex connection updated. Use the main setup-provider-hub.sh installer for a separate HUB Claude connection.');
  } finally {
    client?.close();
    try { run(['auth', 'session', 'revoke', session.sessionId]); } catch (_) { /* Session expires in five minutes. */ }
  }
}

module.exports = {providerName, environmentPlan, readConnection, saveConnection, routingArgs, withRoutingArgs, parseConfig, codingModels, providerPlan, syncProviders, connect, main};
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error(error instanceof SetupError ? error.message
    : 'Provider/model/usage setup failed. Check the local T3 installation, private hub configuration, and network connection. Saved credentials can be reused on the next run.');
  process.exitCode = 1;
});
