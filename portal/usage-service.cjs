'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const {createResetCredits, ResetError} = require('./reset-credit-service.cjs');

const MAX_AGE = 30 * 1000;
const RETRY_DELAY = 60 * 1000;

// The management API is local only. Neither its credential nor the upstream
// response is returned to a browser; callers receive sanitized usage fields.
function managementClient(authDir) {
  return (endpoint, body) => new Promise((resolve, reject) => {
    let key;
    try { key = fs.readFileSync(path.join(authDir, 'management-key'), 'utf8').trim(); }
    catch (_) { return reject(new Error('management unavailable')); }
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = {authorization: `Bearer ${key}`, 'content-type': 'application/json'};
    if (payload) headers['content-length'] = payload.length;
    const req = http.request({host: '127.0.0.1', port: 8317, path: `/v0/management/${endpoint}`,
      method: payload ? 'POST' : 'GET', headers}, reply => {
      const chunks = []; let size = 0;
      reply.on('data', chunk => {size += chunk.length; if (size > 1024 * 1024) reply.destroy(); else chunks.push(chunk);});
      reply.on('error', reject);
      reply.on('end', () => {
        if (reply.statusCode !== 200) return reject(new Error('management unavailable'));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (_) { reject(new Error('invalid management response')); }
      });
    });
    req.setTimeout(15000, () => req.destroy());
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) value = value < 1e12 ? value * 1000 : value;
  else if (typeof value === 'string' && value.length <= 80) value = Date.parse(value);
  else return null;
  return Number.isFinite(value) && value > 0 && value < 8640000000000000 ? new Date(value).toISOString() : null;
}
function percent(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? Math.round((100 - value) * 10) / 10 : null;
}
function window(label, value, usedKey, resetKey) {
  if (!value || typeof value !== 'object') return null;
  const remaining = percent(value[usedKey]);
  if (remaining === null) return null;
  return {label, remaining, resetsAt: timestamp(value[resetKey])};
}
function parseCodex(body) {
  const periods = body?.rate_limit;
  const windows = [];
  for (const candidate of [periods?.primary_window, periods?.secondary_window]) {
    if (!candidate) continue;
    const seconds = candidate.limit_window_seconds;
    const label = seconds === 18000 ? '5h' : seconds === 604800 ? '1w' :
      seconds >= 2419200 && seconds <= 2678400 ? '1mo' : null;
    if (!label) continue;
    const entry = window(label, candidate, 'used_percent', 'reset_at');
    if (entry) windows.push(entry);
  }
  const plan = typeof body?.plan_type === 'string' && /^[a-z0-9 _-]{1,30}$/i.test(body.plan_type)
    ? body.plan_type : null;
  const count = body?.rate_limit_reset_credits?.available_count;
  return {plan, windows, bankedResets: Number.isSafeInteger(count) && count >= 0 && count <= 1000 ? count : null,
    resetExpirations: [], renewsAt: null};
}
function parseClaude(body) {
  const windows = [];
  for (const [key, label] of [['five_hour','5h'], ['seven_day','1w'], ['seven_day_opus','Opus'],
    ['seven_day_sonnet','Sonnet'], ['seven_day_cowork','Cowork'], ['iguana_necktie','Fable']]) {
    const value = body?.[key];
    // Dollar-based windows are not percentage quotas for a model.
    if (key === 'iguana_necktie' && value && ('limit_dollars' in value || 'used_dollars' in value)) continue;
    const entry = window(label, value, 'utilization', 'resets_at');
    if (entry) windows.push(entry);
  }
  if (Array.isArray(body?.limits)) {
    const fable = body.limits.find(x => x?.kind === 'weekly_scoped' &&
      /^fable(?: 5)?$/i.test(x?.scope?.model?.display_name || '') && x.is_active === true);
    const entry = window('Fable', fable, 'percent', 'resets_at');
    if (entry) { const index = windows.findIndex(x => x.label === 'Fable'); if (index >= 0) windows[index] = entry; else windows.push(entry); }
  }
  return {plan: null, windows, bankedResets: null, resetExpirations: [], renewsAt: null};
}

const accountId = account => crypto.createHash('sha256').update(JSON.stringify([account.id, account.provider, account.email])).digest('hex');

function createUsage({admin, authDir, management = managementClient(authDir), now = Date.now}) {
  const cache = new Map();
  const pending = new Map();
  const generations = new Map();
  const usageKey = account => JSON.stringify([account.id, account.provider, account.email, account.personal]);
  const resetCredits = createResetCredits({resolve: resolveCodexAccount, management, now, invalidate(account) {
    const key = usageKey(account);
    cache.delete(key); generations.set(key, (generations.get(key) || 0) + 1);
  }});
  let running = 0;
  const waiting = [];
  async function limited(work) {
    if (running >= 3) await new Promise(resolve => waiting.push(resolve));
    else running++;
    try { return await work(); }
    finally { const next = waiting.shift(); if (next) next(); else running--; }
  }
  async function authorized(identity) {
    const snapshot = await admin.snapshot();
    const users = snapshot.users.filter(user => user.name === identity.name &&
      user.email?.toLowerCase() === identity.email.toLowerCase() && user.enabled && user.editable);
    if (users.length !== 1 || !Array.isArray(users[0].accounts)) throw new Error('access unavailable');
    const ids = new Set(users[0].accounts);
    return snapshot.accounts.filter(account => ids.has(account.id) && !account.disabled &&
      (!account.personal || account.owner === identity.name));
  }
  async function upstream(index, url, header) {
    const result = await management('api-call', {auth_index: index, method: 'GET', url, header});
    if (!Number.isInteger(result.status_code) || result.status_code < 200 || result.status_code >= 300 || typeof result.body !== 'string' || result.body.length > 500000) throw new Error('provider unavailable');
    return JSON.parse(result.body);
  }
  function accountContext(account, files) {
    const matches = files.filter(file => file.id === account.id && file.type === account.provider && file.disabled !== true);
    if (matches.length !== 1 || !/^[a-zA-Z0-9_-]{1,128}$/.test(matches[0].auth_index || '')) throw new Error('account unavailable');
    const index = matches[0].auth_index;
    const header = {Authorization: 'Bearer $TOKEN$', Accept: 'application/json'};
    if (account.provider === 'codex') {
      if (path.basename(account.id) !== account.id) throw new Error('invalid account');
      const authFile = path.join(authDir, account.id);
      if (!fs.lstatSync(authFile).isFile()) throw new Error('invalid account');
      const record = JSON.parse(fs.readFileSync(authFile, 'utf8'));
      if (record.type !== 'codex' || record.email?.toLowerCase() !== account.email ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(record.account_id || '')) throw new Error('invalid account');
      header['ChatGPT-Account-ID'] = record.account_id;
      header['User-Agent'] = 'codex-tui/0.149.1';
    }
    return {account, index, header};
  }
  async function resolveCodexAccount(identity, id) {
    const matches = (await authorized(identity)).filter(a => accountId(a) === id && a.provider === 'codex');
    if (matches.length !== 1) throw new ResetError(404, 'Codex account unavailable.');
    const result = await management('auth-files');
    if (!Array.isArray(result.files) || result.files.length > 1000) throw new ResetError(503, 'Accounts unavailable.');
    const current = (await authorized(identity)).find(a => accountId(a) === id && a.provider === 'codex');
    if (!current || current.owner !== matches[0].owner || current.personal !== matches[0].personal) {
      throw new ResetError(403, 'Account access changed.');
    }
    return accountContext(current, result.files);
  }
  async function fetchAccount(account, files) {
    const {index, header} = accountContext(account, files);
    if (account.provider === 'codex') {
      const result = parseCodex(await upstream(index, 'https://chatgpt.com/backend-api/wham/usage', header));
      if (!result.windows.length) throw new Error('no usage data');
      try {
        const credits = await upstream(index, 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
          {...header, 'OpenAI-Beta': 'codex-1', Originator: 'Codex Desktop'});
        if (Number.isSafeInteger(credits.available_count) && credits.available_count >= 0 && credits.available_count <= 1000) result.bankedResets = credits.available_count;
        if (Array.isArray(credits.credits)) result.resetExpirations = credits.credits.filter(x => x?.status === 'available')
          .map(x => timestamp(x.expires_at)).filter(Boolean).sort().slice(0, 20);
      } catch (_) { /* Optional detail; the usage window is still useful. */ }
      try {
        const subscription = await upstream(index, `https://chatgpt.com/backend-api/subscriptions?account_id=${encodeURIComponent(header['ChatGPT-Account-ID'])}`, header);
        if ((subscription.will_renew ?? subscription.last_active_subscription?.will_renew) === true) {
          result.renewsAt = timestamp(subscription.entitlement?.renews_at || subscription.active_until);
        }
      } catch (_) { /* Optional detail. */ }
      return result;
    }
    if (account.provider === 'claude') {
      header['User-Agent'] = 'claude-cli/2.1.280 (external, cli)';
      header['anthropic-beta'] = 'oauth-2025-04-20';
      const result = parseClaude(await upstream(index, 'https://api.anthropic.com/api/oauth/usage', header));
      if (!result.windows.length) throw new Error('no usage data');
      try {
        const profile = await upstream(index, 'https://api.anthropic.com/api/oauth/profile', header);
        if (profile.account?.has_claude_max === true) result.plan = 'Max';
        else if (profile.account?.has_claude_pro === true) result.plan = 'Pro';
        else if (profile.organization?.organization_type === 'claude_team') result.plan = 'Team';
      } catch (_) { /* Optional detail. */ }
      return result;
    }
    throw new Error('unsupported provider');
  }
  async function accountUsage(account, filesPromise, refresh) {
    const cacheKey = usageKey(account);
    const generation = generations.get(cacheKey) || 0;
    const save = record => {
      if ((generations.get(cacheKey) || 0) !== generation) return {value: null, checkedAt: null, attemptedAt: now(), failed: true};
      cache.set(cacheKey, record); return record;
    };
    const previous = cache.get(cacheKey);
    const minAge = refresh && !previous?.failed ? 30000 : previous?.failed ? RETRY_DELAY : MAX_AGE;
    if (previous && now() - previous.attemptedAt < minAge) return previous;
    if (pending.has(cacheKey)) return pending.get(cacheKey);
    const action = limited(async () => {
      try {
        const files = await filesPromise();
        const value = await fetchAccount(account, files);
        const record = {value, checkedAt: now(), attemptedAt: now(), failed: false};
        return save(record);
      } catch (_) {
        const record = {value: previous?.value || null, checkedAt: previous?.checkedAt || null, attemptedAt: now(), failed: true};
        return save(record);
      }
    });
    pending.set(cacheKey, action);
    try { return await action; } finally { pending.delete(cacheKey); }
  }
  async function listForUser(identity) {
    return (await authorized(identity)).map(account => ({id: accountId(account), provider: account.provider,
      email: account.email, organization: account.organization, displayName: account.displayName || ''}));
  }
  async function getForUser(identity, {refresh = false, id} = {}) {
    const accounts = (await authorized(identity)).filter(account => id === undefined || accountId(account) === id);
    let files;
    const filesPromise = () => files ||= Promise.resolve().then(() => management('auth-files')).then(result => {
      if (!Array.isArray(result.files) || result.files.length > 1000) throw new Error('accounts unavailable');
      return result.files;
    });
    const values = await Promise.all(accounts.map(account => accountUsage(account, filesPromise, refresh)));
    const allowedNow = new Map((await authorized(identity)).map(account => [account.id, account]));
    return {accounts: accounts.flatMap((account, index) => {
      const current = allowedNow.get(account.id);
      if (!current || current.email !== account.email || current.provider !== account.provider || current.personal !== account.personal || current.owner !== account.owner) return [];
      const status = values[index];
      return [{id: accountId(account), provider: account.provider, email: account.email, organization: account.organization, displayName: account.displayName || '',
        ...(status.value || {plan: null, windows: [], bankedResets: null, resetExpirations: [], renewsAt: null}),
        checkedAt: status.checkedAt ? new Date(status.checkedAt).toISOString() : null,
        stale: status.failed || (status.checkedAt !== null && now() - status.checkedAt >= MAX_AGE)}];
    })};
  }
  return {getForUser, listForUser, resetCredits};
}

module.exports = {createUsage, parseCodex, parseClaude};
