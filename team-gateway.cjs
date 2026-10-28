#!/usr/bin/env node
'use strict';

// Gateway in front of the local proxy. It authenticates each caller with a
// distinct bearer key, exposes only the Codex and Claude endpoints (plus the
// optional sign-in website), and streams bytes without storing or logging
// request/response bodies.
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const {PassThrough} = require('stream');
const {createDevices, clientIp} = require('./portal/device-service.cjs');
const {createAdministration} = require('./portal/admin-service.cjs');
const {createUsage} = require('./portal/usage-service.cjs');
const {createClientUsage, usageEndpoint} = require('./portal/client-usage-service.cjs');
const {loadHubConfig, renderClientScript} = require('./portal/hub-config.cjs');

const directory = process.env.HUB_GATEWAY_DIR || path.join(process.env.HOME, '.local/share/cliproxy-hub');
const listenPort = Number(process.env.HUB_GATEWAY_PORT || '18317');
const backendPort = Number(process.env.HUB_BACKEND_PORT || '8317');
const portalPort = Number(process.env.HUB_PORTAL_PORT || '18318');
const allowedFile = path.join(directory, 'gateway-users.json');
const hub = loadHubConfig(directory);
const portalHosts = new Set(hub.portal ? hub.hosts : []);
const hopHeaders = new Set(['connection', 'proxy-connection', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailers', 'transfer-encoding', 'upgrade', 'host', 'cookie',
  'x-api-key', 'x-goog-api-key']);
const active = new Map();
let activeTotal = 0;
const perDeviceLimit = 1024;
const globalLimit = 8192;
const devices = createDevices({directory});
const authDir = path.join(process.env.HOME, '.cli-proxy-api');
const clientUsage = createClientUsage({usage: createUsage({
  admin: createAdministration({directory, authDir}), authDir,
})});

function portalEndpoint(req) {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (_) { return false; }
  if (url.origin !== 'http://localhost') return false;
  const reads = new Set(['/', '/dittodub-white.svg', '/favicon.svg', '/sign-in', '/oauth/callback', '/oauth/complete', '/portal.css', '/portal.js', '/login-link', '/login-link.js', '/portal/admin', '/portal/usage', '/portal/accounts/mine', '/portal/admin/devices']);
  const writes = new Set(['/portal/login-link', '/portal/setup-code', '/portal/logout', '/portal/redeem', '/portal/admin', '/portal/admin/access', '/portal/claude/start', '/portal/claude/complete', '/portal/claude/cancel', '/portal/claude/status', '/portal/providers/start', '/portal/providers/complete', '/portal/providers/cancel', '/portal/providers/status', '/portal/accounts/sharing', '/portal/admin/devices/revoke']);
  return (req.method === 'GET' && reads.has(url.pathname)) || (req.method === 'POST' && writes.has(url.pathname));
}

function forwardPortal(req, res) {
  if (!portalHosts.has(req.headers.host || '')) { res.writeHead(400); res.end('Invalid host'); return; }
  const headers = {host: req.headers.host};
  for (const key of ['cookie', 'origin', 'content-type', 'content-length', 'x-hub-csrf']) {
    if (req.headers[key] !== undefined) headers[key] = req.headers[key];
  }
  const ip=clientIp(req.headers);
  if (ip) headers['x-hub-client-ip']=ip;
  forwardHttp(req, res, {host: '127.0.0.1', port: portalPort, path: req.url, method: req.method, headers},
    503, 'Sign-in temporarily unavailable');
}

function forwardHttp(req, res, options, errorStatus = 502, errorBody = '') {
  const upstream = http.request(options, reply => {
    if (res.destroyed) { reply.destroy(); return; }
    // pipe() does not propagate a truncated source response. Close the caller
    // as incomplete so it can recover, rather than hanging or accepting a
    // partial model response as a successful completion.
    reply.on('error', () => res.destroy());
    reply.on('aborted', () => res.destroy());
    res.writeHead(reply.statusCode || 502, reply.headers);
    reply.pipe(res);
  });
  upstream.on('error', () => {
    if (res.destroyed) return;
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(errorStatus);
    res.end(errorBody);
  });
  req.on('aborted', () => upstream.destroy());
  req.on('error', () => upstream.destroy());
  res.on('error', () => upstream.destroy());
  res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
  req.pipe(upstream);
}

function rejectedResponse(socket, status = 401) {
  const body = status === 404 ? 'Not found' : 'Unauthorized';
  socket.end(`HTTP/1.1 ${status} ${status === 404 ? 'Not Found' : 'Unauthorized'}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}

function validKey(req) {
  try {
    const authorization = req.headers.authorization || '';
    const match = /^Bearer ([A-Za-z0-9_-]{40,128})$/.exec(authorization);
    if (!match) return null;
    const candidate = crypto.createHash('sha256').update(match[1]).digest();
    const config = JSON.parse(fs.readFileSync(allowedFile, 'utf8'));
    if (!Array.isArray(config.users)) return null;
    const permitted = [];
    for (const user of config.users) {
      if (user.enabled !== true || !/^[a-f0-9]{64}$/.test(user.keyHash || '')) continue;
      const hash = Buffer.from(user.keyHash, 'hex');
      if (crypto.timingSafeEqual(candidate, hash)) permitted.push(user);
    }
    const id = candidate.toString('hex');
    if (permitted.length === 1) return {id, authorization, kind:'legacy',
      identity: {name: permitted[0].name, email: permitted[0].email}};
    if (permitted.length > 1) return null;
    const device = JSON.parse(fs.readFileSync(path.join(directory, 'devices', `${id}.json`), 'utf8'));
    if (!device || device.enabled !== true || !/^[a-z][a-z0-9_-]{0,40}$/.test(device.name || '') || typeof device.email !== 'string') return null;
    const users = config.users.filter(user => user.enabled === true && user.name === device.name &&
      typeof user.email === 'string' && user.email.toLowerCase() === device.email.toLowerCase());
    if (users.length !== 1 || !/^[a-f0-9]{64}$/.test(users[0].keyHash || '')) return null;
    const internalKey = fs.readFileSync(path.join(directory, 'team-keys', `${device.name}.key`), 'utf8').trim();
    const internalHash = crypto.createHash('sha256').update(internalKey).digest();
    if (!/^[A-Za-z0-9_-]{40,128}$/.test(internalKey) || !crypto.timingSafeEqual(internalHash, Buffer.from(users[0].keyHash, 'hex'))) return null;
    return {id, authorization: `Bearer ${internalKey}`, kind:'device',
      identity: {name: users[0].name, email: users[0].email}};
  } catch (_) {
    return null; // Missing or malformed access configuration fails closed.
  }
}

function validEndpoint(req, upgrade) {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (_) { return false; }
  if (url.origin !== 'http://localhost') return false;
  for (const key of url.searchParams.keys()) {
    if (/^(key|api[_-]?key|token|authorization)$/i.test(key)) return false;
  }
  if (upgrade) return req.method === 'GET' && url.pathname === '/v1/responses';
  return (req.method === 'GET' && url.pathname === '/v1/models') ||
    (req.method === 'POST' && ['/v1/responses', '/v1/responses/compact', '/v1/messages', '/v1/messages/count_tokens'].includes(url.pathname));
}

function reserve(key) {
  const count = active.get(key) || 0;
  if (count >= perDeviceLimit || activeTotal >= globalLimit) return null;
  active.set(key, count + 1);
  activeTotal++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeTotal--;
    const remaining = (active.get(key) || 1) - 1;
    if (remaining) active.set(key, remaining); else active.delete(key);
  };
}

function backendHeaders(req, upgrade, authorization) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (hopHeaders.has(key) || key.startsWith('cf-') || key.startsWith('x-forwarded-') || key === 'forwarded') continue;
    headers[key] = value;
  }
  headers.host = `127.0.0.1:${backendPort}`;
  headers.authorization = authorization;
  if (upgrade) { headers.connection = 'Upgrade'; headers.upgrade = 'websocket'; }
  return headers;
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/setup-codex-hub.sh' || req.url === '/setup-google-hub.sh' || req.url === '/setup-provider-hub.sh' || req.url === '/setup-hub-usage.cjs')) {
    try {
      const name = req.url === '/setup-codex-hub.sh' ? 'setup-codex-team-hub.sh' :
        req.url === '/setup-google-hub.sh' ? 'setup-google-hub.sh' : 'setup-provider-hub.sh';
      const script = renderClientScript(fs.readFileSync(req.url === '/setup-hub-usage.cjs'
        ? path.join(directory, 'scripts', 'configure-t3-usage.cjs') : path.join(directory, 'onboarding', name), 'utf8'), hub);
      if (script.length > 65536) throw new Error('setup script too large');
      res.writeHead(200, {'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store'});
      res.end(script);
    } catch (_) { res.writeHead(404); res.end('Not found'); }
    return;
  }
  // Without a website (for example a Tailscale-only hub), these routes do not exist.
  if (hub.portal && portalEndpoint(req)) { forwardPortal(req, res); return; }
  const isUsage = usageEndpoint(req);
  if (!isUsage && !validEndpoint(req, false)) { res.writeHead(404); res.end('Not found'); return; }
  const key = validKey(req);
  if (!key) { res.writeHead(401); res.end('Unauthorized'); return; }
  devices.note(key.id,clientIp(req.headers),key.kind);
  const release = reserve(key.id);
  if (!release) { res.writeHead(429); res.end('Too many active requests'); return; }
  res.on('close', release);
  if (isUsage) {
    void clientUsage(req, res, key.identity, () => {
      const current = validKey(req);
      return current?.id === key.id && current.identity?.name === key.identity?.name &&
        current.identity?.email === key.identity?.email;
    });
    return;
  }
  forwardHttp(req, res, {host: '127.0.0.1', port: backendPort, path: req.url,
    method: req.method, headers: backendHeaders(req, false, key.authorization)});
});

server.on('upgrade', (req, client, clientHead) => {
  // Upgrade sockets no longer have the HTTP server's normal lifecycle.
  client.on('error', () => client.destroy());
  if (!validEndpoint(req, true)) { rejectedResponse(client, 404); return; }
  const key = validKey(req);
  if (!key) { rejectedResponse(client); return; }
  devices.note(key.id,clientIp(req.headers),key.kind);
  const release = reserve(key.id);
  if (!release) { client.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
  client.on('close', release);
  const upstream = http.request({host: '127.0.0.1', port: backendPort, path: req.url,
    method: 'GET', headers: backendHeaders(req, true, key.authorization)});
  // Read while the upgrade is pending so a disconnected caller is detected.
  // Preserve early frames with bounded buffering and normal backpressure.
  const pendingClient = new PassThrough();
  pendingClient.on('error', () => client.destroy());
  client.pipe(pendingClient);
  let backendSocket;
  client.on('end', () => client.destroy());
  client.on('close', () => { upstream.destroy(); pendingClient.destroy(); backendSocket?.destroy(); });
  upstream.on('upgrade', (reply, backend, backendHead) => {
    if (client.destroyed) { backend.destroy(); return; }
    backendSocket = backend;
    backend.on('error', () => client.destroy());
    backend.on('close', () => { if (!backend.readableEnded) client.destroy(); });
    client.write(`HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}\r\n`);
    for (let i = 0; i < reply.rawHeaders.length; i += 2) client.write(`${reply.rawHeaders[i]}: ${reply.rawHeaders[i + 1]}\r\n`);
    client.write('\r\n');
    if (backendHead.length) client.write(backendHead);
    if (clientHead.length) backend.write(clientHead);
    pendingClient.pipe(backend).pipe(client);
  });
  upstream.on('response', (reply) => { client.end(`HTTP/1.1 ${reply.statusCode} Upstream Error\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); reply.resume(); });
  upstream.on('error', () => { if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
  client.on('error', () => upstream.destroy());
  upstream.end();
});

server.headersTimeout = 15000;
server.requestTimeout = 0; // Long-lived model streams must not be cut off.
server.listen(listenPort, '127.0.0.1');
