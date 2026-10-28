'use strict';

// T3's CLIProxy usage-source protocol, backed exclusively by sanitized usage.
// Fixed usage/reset operations only; client URLs and headers are never forwarded.
const ROOT = '/usage/v0/management/';
const CODEX_USAGE = 'https://chatgpt.com/backend-api/wham/usage';
const CLAUDE_USAGE = 'https://api.anthropic.com/api/oauth/usage';
const {CREDIT_URL, ResetError} = require('./reset-credit-service.cjs');

function usageEndpoint(req) {
  return (req.method === 'GET' && [ROOT + 'auth-files', '/v1/usage'].includes(req.url)) ||
    (req.method === 'POST' && [ROOT + 'api-call', ROOT + 'reset-quota'].includes(req.url));
}

function json(res, status, value) {
  if (res.destroyed) return;
  res.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'});
  res.end(JSON.stringify(value));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    const timer = setTimeout(() => { reject(new Error('body timeout')); req.destroy(); }, 5000);
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 8192) { reject(new Error('body too large')); req.destroy(); }
      else chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('close', () => { clearTimeout(timer); if (!req.complete) reject(new Error('incomplete body')); });
    req.on('end', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); }
    });
  });
}

function providerBody(account) {
  const epoch = value => value ? Math.floor(Date.parse(value) / 1000) : null;
  if (account.provider === 'codex') {
    const durations = {'5h': 18000, '1w': 604800, '1mo': 2592000};
    const windows = account.windows.filter(w => durations[w.label]).map(w => ({
      used_percent: Math.round((100 - w.remaining) * 10) / 10,
      reset_at: epoch(w.resetsAt), limit_window_seconds: durations[w.label],
    }));
    return {...account.plan ? {plan_type: account.plan} : {},
      rate_limit: {primary_window: windows[0] || null, secondary_window: windows[1] || null}};
  }
  const window = label => {
    const value = account.windows.find(w => w.label === label);
    return value ? {utilization: Math.round((100 - value.remaining) * 10) / 10, resets_at: value.resetsAt} : null;
  };
  return {five_hour: window('5h'), seven_day: window('1w'),
    limits: account.windows.filter(w => !['5h', '1w'].includes(w.label)).map(w => ({
      kind: 'weekly_scoped', percent: Math.round((100 - w.remaining) * 10) / 10,
      resets_at: w.resetsAt, scope: {model: {display_name: w.label}},
    }))};
}

function createClientUsage({usage}) {
  return async (req, res, identity, stillAuthorized) => {
    try {
      if (!identity?.name || !identity?.email) return json(res, 403, {error: 'Usage access unavailable.'});
      let result;
      if (req.url === '/v1/usage') result = await usage.getForUser(identity);
      else if (req.method === 'GET') {
        result = {files: (await usage.listForUser(identity)).map(account => ({
          id: account.id, auth_index: account.id, provider: account.provider, email: account.email,
          disabled: false,
        }))};
      } else {
        let input;
        try { input = await readBody(req); } catch (_) { return json(res, 400, {error: 'Invalid usage request.'}); }
        if (req.url === ROOT + 'reset-quota') {
          if (!input || Object.keys(input).join(',') !== 'auth_index' || !/^[a-f0-9]{64}$/.test(input.auth_index || '')) {
            return json(res, 400, {error: 'Invalid account selection.'});
          }
          result = await usage.resetCredits.clearCooldown(identity, input.auth_index, stillAuthorized);
        } else if (input?.url === CREDIT_URL || input?.url === CREDIT_URL + '/consume') {
          if (!/^[a-f0-9]{64}$/.test(input.auth_index || '') ||
              Object.keys(input).some(key => !['auth_index', 'method', 'url', 'header', 'data'].includes(key))) {
            return json(res, 400, {error: 'Invalid reset request.'});
          }
          let body;
          if (input.url === CREDIT_URL && input.method === 'GET' && input.data === undefined) {
            body = await usage.resetCredits.getForUser(identity, input.auth_index, stillAuthorized);
          } else if (input.url === CREDIT_URL + '/consume' && input.method === 'POST' && typeof input.data === 'string') {
            let selection;
            try { selection = JSON.parse(input.data); } catch (_) { return json(res, 400, {error: 'Invalid reset selection.'}); }
            body = await usage.resetCredits.consume(identity, input.auth_index, selection, stillAuthorized);
          } else return json(res, 403, {error: 'Unsupported reset operation.'});
          result = {status_code: 200, body: JSON.stringify(body)};
        } else {
          if (!input || input.method !== 'GET' || !/^[a-f0-9]{64}$/.test(input.auth_index || '') ||
              ![CODEX_USAGE, CLAUDE_USAGE].includes(input.url) || input.data !== undefined || input.body !== undefined ||
              Object.keys(input).some(key => !['auth_index', 'method', 'url', 'header'].includes(key))) {
            return json(res, 403, {error: 'Only per-account usage reads are available.'});
          }
          const data = await usage.getForUser(identity, {id: input.auth_index});
          const account = data.accounts.find(a => a.id === input.auth_index);
          if (!account || (account.provider === 'codex' ? CODEX_USAGE : CLAUDE_USAGE) !== input.url) {
            return json(res, 404, {error: 'Account unavailable.'});
          }
          if (account.stale || !account.windows.length) return json(res, 503, {error: 'Account usage temporarily unavailable.'});
          result = {status_code: 200, body: JSON.stringify(providerBody(account))};
        }
      }
      // Devices and membership may be revoked while provider requests are pending.
      if (!stillAuthorized()) return json(res, 401, {error: 'Unauthorized'});
      json(res, 200, result);
    } catch (error) { json(res, error instanceof ResetError ? error.status : 503,
      {error: error instanceof ResetError ? error.message : 'Usage temporarily unavailable.'}); }
  };
}

module.exports = {createClientUsage, usageEndpoint, providerBody};
