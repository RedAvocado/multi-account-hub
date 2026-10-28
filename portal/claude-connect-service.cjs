'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

class ConnectError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function managementClient(authDir) {
  return (method, endpoint, body) => new Promise((resolve, reject) => {
    let key;
    try { key = fs.readFileSync(path.join(authDir, 'management-key'), 'utf8').trim(); }
    catch (_) { return reject(new Error('management unavailable')); }
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = {authorization: `Bearer ${key}`, 'content-type': 'application/json'};
    if (payload) headers['content-length'] = payload.length;
    const req = http.request({host:'127.0.0.1',port:8317,path:`/v0/management/${endpoint}`,method,headers}, reply => {
      let size = 0; const chunks = [];
      reply.on('data', chunk => {size += chunk.length; if (size > 65536) reply.destroy(); else chunks.push(chunk);});
      reply.on('error', reject);
      reply.on('end', () => {
        if (reply.statusCode !== 200) return reject(new Error('management unavailable'));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (_) { reject(new Error('invalid response')); }
      });
    });
    req.setTimeout(12000, () => req.destroy());
    req.on('error', reject); if (payload) req.write(payload); req.end();
  });
}

function privatizeCredential(authDir, id) {
  if (typeof id !== 'string' || path.basename(id) !== id) throw new Error('invalid credential');
  const fd = fs.openSync(path.join(authDir,id), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid()) throw new Error('invalid credential');
    fs.fchmodSync(fd,0o600);
  } finally { fs.closeSync(fd); }
}

function createClaudeConnect({admin, authDir, management = managementClient(authDir), now = Date.now,
  secureCredential = id => privatizeCredential(authDir,id)}) {
  const flows = new Map();
  const lifetime = 4 * 60 * 1000 + 50 * 1000;
  const belongs = (flow, identity) => flow && flow.email === identity.email && flow.name === identity.name;
  function clean() {
    for (const [id, flow] of flows) if (flow.expires <= now()) flows.delete(id);
  }
  function current(identity) {
    clean();
    const flow = flows.get(identity.id);
    return belongs(flow, identity) ? flow : null;
  }
  async function start(identity) {
    let flow = current(identity);
    if (flow && ['starting','waiting','submitting','exchanging','finishing'].includes(flow.status)) {
      if (flow.status === 'starting') throw new ConnectError(409, 'A Claude sign-in is starting. Please wait.');
      return describe(flow);
    }
    if (flows.size >= 128) throw new ConnectError(503, 'Claude sign-in is busy. Try again shortly.');
    flow = {email:identity.email,name:identity.name,status:'starting',expires:now()+lifetime};
    flows.set(identity.id, flow);
    try {
      const before = await admin.snapshot();
      flow.before = new Set(before.accounts.filter(account => account.provider === 'claude').map(account => account.id));
      const result = await management('GET','anthropic-auth-url');
      if (flows.get(identity.id) !== flow) throw new Error('sign-in cancelled');
      const url = new URL(result.url);
      if (result.status !== 'ok' || !/^[a-f0-9]{32}$/.test(result.state || '') ||
          url.origin !== 'https://claude.ai' || url.pathname !== '/oauth/authorize' ||
          url.searchParams.get('state') !== result.state || url.searchParams.get('redirect_uri') !== 'http://localhost:54545/callback' ||
          url.searchParams.get('code_challenge_method') !== 'S256') throw new Error('invalid authorization URL');
      flow.state = result.state; flow.url = url.href; flow.status = 'waiting';
      return describe(flow);
    } catch (_) {
      if (flows.get(identity.id) === flow) flows.delete(identity.id);
      throw new ConnectError(503, 'Claude sign-in could not be started. Please try again.');
    }
  }
  function describe(flow) {
    if (!flow) return {status:'idle'};
    if (flow.status === 'waiting') return {status:'waiting',url:flow.url};
    if (flow.status === 'complete') return {status:'complete',account:flow.account || null,assigned:flow.assigned === true};
    if (flow.status === 'failed') return {status:'failed',message:flow.message || 'Claude sign-in did not complete. Please try again.'};
    return {status:flow.status};
  }
  async function submit(identity, input) {
    const flow = current(identity);
    if (!flow || flow.status !== 'waiting') throw new ConnectError(409, 'Start a new Claude sign-in.');
    if (!input || Object.keys(input).join(',') !== 'callback' || typeof input.callback !== 'string' || input.callback.length > 3500) {
      throw new ConnectError(400, 'Paste the complete address from your browser.');
    }
    let callback;
    try { callback = new URL(input.callback.trim()); } catch (_) { throw new ConnectError(400, 'Paste the complete address from your browser.'); }
    if (callback.origin !== 'http://localhost:54545' || callback.pathname !== '/callback' || callback.username || callback.password ||
        callback.hash || callback.searchParams.getAll('state').length !== 1 || callback.searchParams.getAll('code').length !== 1 ||
        callback.searchParams.get('state') !== flow.state) throw new ConnectError(400, 'That address does not match this sign-in. Start over if it expired.');
    const code = callback.searchParams.get('code');
    if (!code || code.length > 2048 || /[\s\x00-\x1f\x7f]/.test(code)) throw new ConnectError(400, 'The address is missing a valid authorization code.');
    flow.status = 'submitting';
    try {
      const result = await management('POST','oauth-callback',{provider:'anthropic',code,state:flow.state});
      if (flows.get(identity.id) !== flow) throw new Error('sign-in cancelled');
      if (result.status !== 'ok') throw new Error('callback failed');
      flow.status = 'exchanging';
      return describe(flow);
    } catch (_) {
      flow.status = 'failed'; flow.message = 'The sign-in could not be completed. Please start again.';
      throw new ConnectError(503, flow.message);
    }
  }
  async function finalize(flow, identity) {
    const snapshot = await admin.snapshot();
    if (flows.get(identity.id) !== flow) return;
    const added = snapshot.accounts.filter(account => account.provider === 'claude' && !account.disabled && !flow.before.has(account.id));
    // Do not guess if multiple accounts arrived or if this is a re-login. The
    // administrator can assign access explicitly in Team access instead.
    if (added.length !== 1) return;
    flow.account = added[0].email;
    secureCredential(added[0].id);
    // Give the administrator who connected the account access to it.
    const connector = snapshot.users.filter(user => user.name === identity.name && user.email === identity.email && user.enabled && user.editable);
    if (connector.length !== 1) return;
    try {
      await admin.setPermissions({user:identity.name,accounts:[...new Set([...connector[0].accounts,added[0].id])],version:snapshot.version});
      flow.assigned = true;
    } catch (_) { /* Access can be set manually if settings changed concurrently. */ }
  }
  async function status(identity) {
    const flow = current(identity);
    if (!flow || flow.status !== 'exchanging') return describe(flow);
    if (flow.statusRequest) return flow.statusRequest;
    flow.statusRequest = (async () => {
      try {
        const result = await management('GET',`get-auth-status?state=${encodeURIComponent(flow.state)}`);
        if (flows.get(identity.id) !== flow) return {status:'idle'};
        if (result.status === 'ok') {
          flow.status = 'finishing';
          try { await finalize(flow, identity); } catch (_) { /* Admin can assign access manually. */ }
          flow.status = 'complete';
        } else if (result.status === 'error') {
          flow.status = 'failed'; flow.message = 'Claude sign-in did not complete. Please try again.';
        }
        return describe(flow);
      } catch (_) { return describe(flow); }
    })();
    try { return await flow.statusRequest; } finally { flow.statusRequest = null; }
  }
  async function cancel(identity) {
    const flow = current(identity);
    if (!flow) return;
    flows.delete(identity.id);
    if (flow.state && !['complete','failed'].includes(flow.status)) {
      try { await management('DELETE',`oauth-session?state=${encodeURIComponent(flow.state)}`); } catch (_) {}
    }
  }
  return {start,submit,status,cancel};
}
module.exports = {createClaudeConnect, ConnectError, privatizeCredential};
