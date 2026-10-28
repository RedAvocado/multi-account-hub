'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
async function until(condition, message) {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await pause(10);
  }
  assert.fail(message);
}

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-reliability-'));
  const key = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(path.join(directory, 'gateway-users.json'), JSON.stringify({users: [
    {name: 'tester', enabled: true, keyHash: crypto.createHash('sha256').update(key).digest('hex')},
  ]}));
  fs.writeFileSync(path.join(directory, 'hub.json'), JSON.stringify({hubUrl: 'https://hub.example.com', portal: {workspaceDomain: 'example.org'}}));
  const upstream = http.createServer();
  const backendSockets = new Set();
  upstream.on('connection', socket => {
    backendSockets.add(socket);
    socket.on('close', () => backendSockets.delete(socket));
  });
  await listen(upstream);
  const reservation = http.createServer();
  await listen(reservation);
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const gateway = spawn(process.execPath, [path.join(__dirname, '../team-gateway.cjs')], {
    env: {...process.env, HUB_GATEWAY_DIR: directory, HUB_GATEWAY_PORT: String(port),
      HUB_BACKEND_PORT: String(upstream.address().port), HUB_PORTAL_PORT: String(upstream.address().port)},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  gateway.stdout.on('data', chunk => output += chunk);
  gateway.stderr.on('data', chunk => output += chunk);
  const clients = new Set();
  t.after(async () => {
    for (const client of clients) client.destroy();
    gateway.kill();
    await new Promise(resolve => gateway.exitCode !== null || gateway.signalCode !== null ? resolve() : gateway.once('exit', resolve));
    for (const socket of backendSockets) socket.destroy();
    await new Promise(resolve => upstream.close(resolve));
    fs.rmSync(directory, {recursive: true, force: true});
  });
  for (let i = 0; i < 100; i++) {
    assert.equal(gateway.exitCode, null, 'gateway exited during startup');
    const ready = await new Promise(resolve => {
      const socket = net.connect(port, '127.0.0.1');
      socket.on('connect', () => {socket.destroy(); resolve(true);});
      socket.on('error', () => resolve(false));
    });
    if (ready) break;
    await pause(10);
  }
  return {upstream, gateway, port, key, clients, output: () => output};
}

for (const [name, target] of [['model', '/v1/responses'], ['portal', '/']]) {
  test(`an interrupted ${name} response promptly closes the caller as incomplete`, {timeout: 5000}, async t => {
    const f = await fixture(t);
    let reply;
    f.upstream.on('request', (req, res) => {
      reply = res;
      res.writeHead(200, {'content-type': 'text/event-stream'});
      res.write('data: synthetic partial output\n\n');
    });
    let closed = false, response;
    await new Promise((resolve, reject) => {
      const req = http.request({host: '127.0.0.1', port: f.port, path: target,
        method: name === 'model' ? 'POST' : 'GET', agent: false,
        headers: {authorization: `Bearer ${f.key}`, host: 'hub.example.com'}}, res => {
        response = res;
        res.on('error', () => {});
        res.on('close', () => closed = true);
        res.once('data', resolve);
        res.resume();
      });
      f.clients.add(req);
      req.on('error', reject);
      req.end();
    });
    reply.destroy();
    await until(() => closed, 'caller hung after upstream response was interrupted');
    assert.equal(response.complete, false, 'a truncated stream must not be reported as complete');
    assert.equal(f.gateway.exitCode, null, 'gateway must survive upstream disconnects');
    assert.equal(f.output().includes('synthetic partial output'), false);
  });
}

test('cancelling a WebSocket handshake closes the pending upstream socket', {timeout: 5000}, async t => {
  const f = await fixture(t);
  let backend, backendClosed = false;
  f.upstream.on('upgrade', (req, socket) => {
    backend = socket;
    // Simulate an upstream that has received the upgrade but has not replied.
    socket.on('close', () => backendClosed = true);
    socket.on('end', () => { backendClosed = true; socket.destroy(); });
    socket.resume();
  });
  const client = net.connect(f.port, '127.0.0.1');
  f.clients.add(client);
  client.on('error', () => {});
  client.write(`GET /v1/responses HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${f.key}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
  await until(() => !!backend, 'upstream did not receive handshake');
  client.destroy();
  await until(() => backendClosed, 'cancelled handshake leaked its upstream socket');
  assert.equal(f.gateway.exitCode, null);
});

test('WebSockets preserve early frames and flush buffered output before a clean close', {timeout: 5000}, async t => {
  const f = await fixture(t);
  const earlyHead = Buffer.from('synthetic frame in upgrade head');
  const earlyPending = Buffer.from('synthetic frame during handshake');
  const output = Buffer.alloc(2 * 1024 * 1024, 'x');
  const received = [];
  let backend;
  f.upstream.on('upgrade', (req, socket, head) => {
    backend = socket;
    if (head.length) received.push(head);
    socket.on('data', chunk => received.push(chunk));
    socket.on('error', () => {});
  });
  const client = net.connect(f.port, '127.0.0.1');
  f.clients.add(client);
  client.on('error', () => {});
  const handshake = `GET /v1/responses HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${f.key}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`;
  client.write(Buffer.concat([Buffer.from(handshake), earlyHead]));
  await until(() => !!backend, 'upstream did not receive handshake');
  client.write(earlyPending);
  await pause(30);
  backend.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  await until(() => Buffer.concat(received).length === earlyHead.length + earlyPending.length, 'early frames were lost');
  assert.deepEqual(Buffer.concat(received), Buffer.concat([earlyHead, earlyPending]));
  backend.end(output);
  // Delay reads to exercise backpressure and output queued at upstream close.
  await pause(30);
  const chunks = [];
  let ended = false;
  client.on('data', chunk => chunks.push(chunk));
  client.on('end', () => { ended = true; });
  await until(() => ended, 'clean upstream close did not finish the caller');
  const wire = Buffer.concat(chunks), split = wire.indexOf('\r\n\r\n');
  assert.ok(split >= 0);
  assert.deepEqual(wire.subarray(split + 4), output);
  assert.equal(f.gateway.exitCode, null);
});

test('closing an established WebSocket releases the upstream connection', {timeout: 5000}, async t => {
  const f = await fixture(t);
  let backendClosed = false;
  f.upstream.on('upgrade', (req, socket) => {
    socket.on('end', () => { backendClosed = true; socket.destroy(); });
    socket.on('close', () => backendClosed = true);
    socket.on('error', () => {});
    socket.resume();
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  });
  const client = net.connect(f.port, '127.0.0.1');
  f.clients.add(client);
  client.on('error', () => {});
  let upgraded = false;
  client.on('data', () => upgraded = true);
  client.write(`GET /v1/responses HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${f.key}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
  await until(() => upgraded, 'WebSocket did not upgrade');
  client.destroy();
  await until(() => backendClosed, 'established WebSocket leaked its upstream connection');
  assert.equal(f.gateway.exitCode, null);
});
