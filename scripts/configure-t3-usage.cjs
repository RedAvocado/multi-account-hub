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
    const timer = setTimeout(() => { pending.delete(requestId); reject(new SetupError('T3 settings request timed out.')); }, 30000);
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
    console.log('T3 usage setup prerequisites are ready.');
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

  const {origin, t3} = localT3(args);
  const run = command => execFileSync(t3, command, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000});
  const session = JSON.parse(run(['auth', 'session', 'issue', '--scope', 'orchestration:read', '--scope', 'settings:write', '--scope', 'providers:manage',
    '--ttl', '5m', '--label', 'Hub usage setup', '--json']));
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
    await client.request('server.refreshProviders');
    console.log(`Hub usage configured for ${data.accounts.length} accessible accounts. Fetches on request, cached for 30 seconds.`);
  } finally {
    client?.close();
    try { run(['auth', 'session', 'revoke', session.sessionId]); } catch (_) { /* Session expires in five minutes. */ }
  }
}

module.exports = {parseConfig, connect, main};
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error(error instanceof SetupError ? error.message
    : 'Usage setup failed. Check the local T3 installation, private hub configuration, and network connection.');
  process.exitCode = 1;
});
