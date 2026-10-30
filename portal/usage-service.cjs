'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const {createResetCredits, ResetError, CREDIT_URL, sanitizeCredits} = require('./reset-credit-service.cjs');

const MAX_AGE = 30 * 1000;
const RETRY_DELAY = 60 * 1000;
const CREDIT_MAX_AGE = 5 * 60 * 1000;
const CLAUDE_PROFILE_MAX_AGE = 15 * 60 * 1000;
const SHARED_DIRECTORY = '.claude-usage-cache';
const LOCK_SUFFIX = '.lock';
const LOCK_WAIT = 2000;
const LOCK_STALE = 60000;
const SHARED_SUCCESS_INTERVAL = 60 * 1000;
const CLAUDE_MAX_AGE = 90 * 1000;
const COOLDOWN_FLOOR = 60 * 1000;
const COOLDOWN_MAX = 15 * 60 * 1000;

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
function percent(value, precise = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) return null;
  return precise ? 100 - value : Math.round((100 - value) * 10) / 10;
}
function window(label, value, usedKey, resetKey, precise) {
  if (!value || typeof value !== 'object') return null;
  const remaining = percent(value[usedKey], precise);
  if (remaining === null) return null;
  return {label, remaining, resetsAt: timestamp(value[resetKey])};
}
function parseCodex(body, {precise = false} = {}) {
  const periods = body?.rate_limit;
  const windows = [];
  for (const candidate of [periods?.primary_window, periods?.secondary_window]) {
    if (!candidate) continue;
    const seconds = candidate.limit_window_seconds;
    const label = seconds === 18000 ? '5h' : seconds === 604800 ? '1w' :
      seconds >= 2419200 && seconds <= 2678400 ? '1mo' : null;
    if (!label) continue;
    const entry = window(label, candidate, 'used_percent', 'reset_at', precise);
    if (entry) windows.push({...entry, ...(precise ? {scope:'general',durationSeconds:seconds} : {})});
  }
  const plan = typeof body?.plan_type === 'string' && /^[a-z0-9 _-]{1,30}$/i.test(body.plan_type)
    ? body.plan_type : null;
  const count = body?.rate_limit_reset_credits?.available_count;
  return {plan, windows, bankedResets: Number.isSafeInteger(count) && count >= 0 && count <= 1000 ? count : null,
    resetExpirations: [], renewsAt: null};
}
function parseClaude(body, {precise = false} = {}) {
  const windows = [];
  for (const [key, label] of [['five_hour','5h'], ['seven_day','1w'], ['seven_day_opus','Opus'],
    ['seven_day_sonnet','Sonnet'], ['seven_day_cowork','Cowork'], ['iguana_necktie','Fable']]) {
    const value = body?.[key];
    // Dollar-based windows are not percentage quotas for a model.
    if (key === 'iguana_necktie' && value && ('limit_dollars' in value || 'used_dollars' in value)) continue;
    const entry = window(label, value, 'utilization', 'resets_at', precise);
    if (entry) windows.push({...entry, ...(precise ? {scope:label==='5h'||label==='1w'?'general':label.toLowerCase(),
      durationSeconds:label==='5h'?18000:604800} : {})});
  }
  if (Array.isArray(body?.limits)) {
    const fable = body.limits.find(x => x?.kind === 'weekly_scoped' &&
      /^fable(?: 5)?$/i.test(x?.scope?.model?.display_name || '') && x.is_active === true);
    const entry = window('Fable', fable, 'percent', 'resets_at', precise);
    if (entry) {
      if (precise) Object.assign(entry,{scope:'fable',durationSeconds:604800});
      const index = windows.findIndex(x => x.label === 'Fable'); if (index >= 0) windows[index] = entry; else windows.push(entry);
    }
  }
  return {plan: null, windows, bankedResets: null, resetExpirations: [], renewsAt: null};
}

function claudePlan(profile) {
  const organization = profile?.organization;
  const type = organization?.organization_type;
  if (type === 'claude_enterprise') return 'Enterprise';
  if (type === 'claude_team') {
    const seat = organization.seat_tier === 'team_standard' ? 'Standard' : organization.seat_tier === 'team_premium' ? 'Premium' : null;
    return seat ? `Team — ${seat}` : 'Team';
  }
  if (profile?.account?.has_claude_max === true || type === 'claude_max') {
    const tier = organization?.rate_limit_tier;
    const multiplier = tier === 'default_claude_max_5x' ? '5×' : tier === 'default_claude_max_20x' ? '20×' : null;
    return multiplier ? `Max ${multiplier}` : 'Max';
  }
  return profile?.account?.has_claude_pro === true || type === 'claude_pro' ? 'Pro' : null;
}

const accountId = account => crypto.createHash('sha256').update(JSON.stringify([account.id, account.provider, account.email])).digest('hex');

function createUsage({admin, authDir, management = managementClient(authDir), now = Date.now, details = true, routingCredits = false, history}) {
  const cache = new Map();
  const creditCache = new Map();
  const claudeProfiles = new Map();
  const pending = new Map();
  const generations = new Map();
  const usageKey = account => JSON.stringify([account.id, account.provider, account.email, account.personal]);
  const newestObservation = (...records) => records.filter(record => record?.value && Number.isFinite(record.checkedAt))
    .sort((left, right) => right.checkedAt - left.checkedAt)[0];
  // Keep telemetry outside the auth directory's watched JSON files: replacing
  // a quota observation must never look like a provider credential change.
  const sharedPath = authDir && path.join(authDir, SHARED_DIRECTORY);
  const sharedFile = key => sharedPath && path.join(sharedPath, `${crypto.createHash('sha256').update(key).digest('hex')}.json`);
  const sharedLock = key => sharedFile(key) && `${sharedFile(key)}${LOCK_SUFFIX}`;
  const isClaudeKey = key => {
    try { return JSON.parse(key)?.[1] === 'claude'; } catch (_) { return false; }
  };
  function readShared(key) {
    if (!key || !isClaudeKey(key) || !sharedFile(key)) return null;
    try {
      const value = JSON.parse(fs.readFileSync(sharedFile(key), 'utf8'));
      const record = value?.version === 2 && value.record;
      const validTime = time => Number.isFinite(time) && time >= 0;
      if (!record || record.__usageKey !== key || typeof record.failed !== 'boolean' ||
          !validTime(record.attemptedAt) || !validTime(record.nextAttemptAt) ||
          (record.checkedAt !== null && !validTime(record.checkedAt)) ||
          (!record.failed && !Array.isArray(record.value?.windows)) ||
          (record.value && !Array.isArray(record.value.windows))) return null;
      return record;
    }
    catch (_) { return null; }
  }
  function writeShared(key, record) {
    if (!sharedPath || !isClaudeKey(key)) return false;
    let temporary;
    try {
      const file = sharedFile(key);
      temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({version: 2, record: {...record, __usageKey: key}}), {mode: 0o600, flag: 'wx'});
      fs.renameSync(temporary, file);
      try { fs.chmodSync(file, 0o600); } catch (_) { return false; }
      return true;
    } catch (_) {
      if (temporary) { try { fs.unlinkSync(temporary); } catch (_) {} }
      return false;
    }
  }
  async function acquireShared(key) {
    const lock = sharedLock(key); if (!lock) return null;
    try { fs.mkdirSync(sharedPath, {recursive: true, mode: 0o700}); }
    catch (_) { return null; }
    const started = Date.now();
    while (Date.now() - started < LOCK_WAIT) {
      let handle;
      const token = crypto.randomBytes(16).toString('hex');
      try {
        handle = await fs.promises.open(lock, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({version: 1, token, pid: process.pid, createdAt: Date.now()}));
        return async () => {
          try {
            const current = JSON.parse(await fs.promises.readFile(lock, 'utf8'));
            if (current?.token === token) await fs.promises.unlink(lock);
          } catch (_) {}
          try { await handle.close(); } catch (_) {}
        };
      } catch (error) {
        if (handle) {
          try { await handle.close(); } catch (_) {}
          try { await fs.promises.unlink(lock); } catch (_) {}
        }
        // Keep quota failures private; the caller receives stale state only.
        if (error.code !== 'EEXIST') return null;
        try {
          const stat = await fs.promises.stat(lock);
          if (Date.now() - stat.mtimeMs > LOCK_STALE) {
            const current = JSON.parse(await fs.promises.readFile(lock, 'utf8'));
            const check = await fs.promises.stat(lock);
            if (check.ino === stat.ino && check.mtimeMs === stat.mtimeMs && current?.token) await fs.promises.unlink(lock);
          }
        } catch (_) {}
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    return null;
  }
  const resetCredits = createResetCredits({resolve: resolveCodexAccount, management, now, invalidate(account) {
    const key = usageKey(account);
    // Reset redemption invalidates this process's Codex observations. Shared
    // quota state is Claude-only, so deleting a file cannot cancel another
    // process's in-flight Codex read or make its local generation advance.
    cache.delete(key); creditCache.delete(key); generations.set(key, (generations.get(key) || 0) + 1);
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
    if (!Number.isInteger(result.status_code) || result.status_code < 200 || result.status_code >= 300) {
      const error = new Error('provider unavailable');
      const headers = result?.header && typeof result.header === 'object' ? result.header : {};
      const headerName = Object.keys(headers).find(name => name.toLowerCase() === 'retry-after');
      const raw = headerName ? headers[headerName] : undefined;
      const value = Array.isArray(raw) ? raw[0] : raw;
      const seconds = Number(value);
      const dateDelay = typeof value === 'string' && !Number.isFinite(seconds) ? Date.parse(value) - now() : NaN;
      const delay = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : dateDelay;
      error.rateLimited = result.status_code === 429;
      error.retryAfterMs = error.rateLimited
        ? Math.max(COOLDOWN_FLOOR, Number.isFinite(delay) && delay > 0 ? Math.min(delay, COOLDOWN_MAX) : COOLDOWN_FLOOR)
        : COOLDOWN_FLOOR;
      throw error;
    }
    if (typeof result.body !== 'string' || result.body.length > 500000) throw new Error('provider unavailable');
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
  async function routingCreditDetails(account, index, header, availableCount) {
    const key = usageKey(account), generation = generations.get(key) || 0;
    const previous = creditCache.get(key);
    // A changed count cannot tell us which expiration was redeemed. Refresh
    // immediately, or suppress the bonus until consistent details are known.
    const consistent = value => value && (availableCount === null || availableCount === value.availableCount);
    if (previous?.value && !consistent(previous.value)) previous.value = null;
    if (previous && now() - previous.attemptedAt < (previous.failed || !previous.value ? RETRY_DELAY : CREDIT_MAX_AGE) &&
        (previous.failed || consistent(previous.value))) return consistent(previous.value) ? previous.value : null;
    try {
      const body = await upstream(index, CREDIT_URL, {...header, 'OpenAI-Beta': 'codex-1', Originator: 'Codex Desktop'});
      const credits = sanitizeCredits(body).credits.filter(credit => credit.status === 'available' && Date.parse(credit.expires_at) > now());
      const count = Number.isSafeInteger(body.available_count) && body.available_count >= 0 && body.available_count <= 1000
        ? body.available_count : credits.length;
      const value = {checkedAt: new Date(now()).toISOString(), availableCount: count,
        expirations: credits.map(credit => credit.expires_at).sort()};
      if ((generations.get(key) || 0) !== generation) return null;
      // Do not guess which expiration survived a partial redemption while
      // provider count/list updates are inconsistent with each other.
      const accepted = count === credits.length && consistent(value) ? value : null;
      creditCache.set(key, {value: accepted, attemptedAt: now(), failed: !accepted});
      return accepted;
    } catch (_) {
      if ((generations.get(key) || 0) !== generation) return null;
      const value = previous?.value || null;
      creditCache.set(key, {value, attemptedAt: now(), failed: true});
      return consistent(value) ? value : null; // Retain successful age without reusing uncertain expirations.
    }
  }
  async function fetchClaudeQuota(account, files) {
    const key = usageKey(account);
    const latest = readShared(key);
    const current = now();
    if (latest && latest.nextAttemptAt > current) return latest;
    const release = await acquireShared(key);
    if (!release) {
      // A shared lock or state file failure must fail closed. Returning stale
      // local data is safe; starting an unlocked provider read is not.
      return {value: latest?.value || null, checkedAt: latest?.checkedAt || null, attemptedAt: current,
        nextAttemptAt: Math.max(latest?.nextAttemptAt || 0, current + COOLDOWN_FLOOR), failed: true,
        failureCount: (latest?.failureCount || 0) + 1};
    }
    let locked = null;
    try {
      locked = readShared(key);
      const at = now();
      if (locked && locked.nextAttemptAt > at) return locked;
      const {index, header} = accountContext(account, files);
      header['User-Agent'] = 'claude-cli/2.1.280 (external, cli)';
      header['anthropic-beta'] = 'oauth-2025-04-20';
      const body = await upstream(index, 'https://api.anthropic.com/api/oauth/usage', header);
      const value = parseClaude(body, {precise: true});
      if (!value.windows.length) throw new Error('no usage data');
      const attemptedAt = now();
      const nextReset = Math.min(...value.windows.map(window => Date.parse(window.resetsAt))
        .filter(reset => Number.isFinite(reset) && reset > attemptedAt));
      const record = {value, checkedAt: attemptedAt, attemptedAt,
        nextAttemptAt: Math.min(attemptedAt + SHARED_SUCCESS_INTERVAL, nextReset), failed: false, failureCount: 0};
      // A successful upstream read is useful only if every process can see it.
      if (!writeShared(key, record)) {
        return {value: locked?.value || null, checkedAt: locked?.checkedAt || null,
          attemptedAt, nextAttemptAt: attemptedAt + COOLDOWN_FLOOR, failed: true,
          failureCount: (locked?.failureCount || 0) + 1};
      }
      return record;
    } catch (error) {
      const attemptedAt = now();
      const previous = readShared(key) || locked || null;
      const failureCount = previous?.failed ? Math.min((previous.failureCount || 1) + 1, 20) : 1;
      const exponential = Math.min(COOLDOWN_MAX, COOLDOWN_FLOOR * 2 ** Math.min(failureCount - 1, 4));
      const delay = error?.rateLimited ? Math.max(exponential, error.retryAfterMs || COOLDOWN_FLOOR) : COOLDOWN_FLOOR;
      const record = {value: previous?.value || null, checkedAt: previous?.checkedAt || null, attemptedAt,
        nextAttemptAt: attemptedAt + Math.min(delay, COOLDOWN_MAX), failed: true, failureCount,
        rateLimited: error?.rateLimited === true};
      writeShared(key, record);
      return record;
    } finally { await release(); }
  }
  async function fetchAccount(account, files) {
    if (account.provider === 'codex') {
      const {index, header} = accountContext(account, files);
      const body = await upstream(index, 'https://chatgpt.com/backend-api/wham/usage', header);
      const checkedAt = now();
      const result = parseCodex(body, {precise: true});
      if (!result.windows.length) throw new Error('no usage data');
      if (routingCredits) {
        const creditDetails = await routingCreditDetails(account, index, header, result.bankedResets);
        if (creditDetails) result.resetCredits = creditDetails;
      }
      if (!details) return {value: result, checkedAt};
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
      return {value: result, checkedAt};
    }
    if (account.provider === 'claude') {
      const quota = await fetchClaudeQuota(account, files);
      if (quota.failed || !quota.value) throw Object.assign(new Error('provider unavailable'), {quota});
      const result = {...quota.value};
      const checkedAt = quota.checkedAt;
      if (!details) return {value: result, checkedAt};
      const profileKey = usageKey(account), previousProfile = claudeProfiles.get(profileKey);
      if (previousProfile && now() - previousProfile.attemptedAt <
          (previousProfile.failed ? RETRY_DELAY : CLAUDE_PROFILE_MAX_AGE)) {
        result.plan = previousProfile.plan;
        return {value: result, checkedAt};
      }
      const {header: profileHeader, index: profileIndex} = accountContext(account, files);
      profileHeader['User-Agent'] = 'claude-cli/2.1.280 (external, cli)';
      profileHeader['anthropic-beta'] = 'oauth-2025-04-20';
      try {
        const profile = await upstream(profileIndex, 'https://api.anthropic.com/api/oauth/profile', profileHeader);
        result.plan = claudePlan(profile);
        claudeProfiles.set(profileKey, {plan: result.plan, attemptedAt: now(), failed: false});
      } catch (_) {
        result.plan = previousProfile?.plan || null;
        claudeProfiles.set(profileKey, {plan: result.plan, attemptedAt: now(), failed: true});
      }
      return {value: result, checkedAt};
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
    const shared = readShared(cacheKey);
    const previous = cache.get(cacheKey);
    const minAge = refresh && !previous?.failed ? 30000 : previous?.failed ? RETRY_DELAY : MAX_AGE;
    const sharedNewer = account.provider === 'claude' && shared &&
      (!previous || shared.attemptedAt > previous.attemptedAt);
    if (sharedNewer && shared.failed && shared.nextAttemptAt > now()) {
      const best = newestObservation(previous, shared);
      return save({value: best?.value || null,
        checkedAt: best?.checkedAt ?? null,
        attemptedAt: shared.attemptedAt, failed: true, nextAttemptAt: shared.nextAttemptAt,
        rateLimited: shared.rateLimited === true});
    }
    // A newer shared success must be allowed through to fetchAccount so a
    // details-enabled process can refresh its own profile enrichment.
    const claudeRefreshDue = account.provider === 'claude' && shared && !shared.failed && shared.nextAttemptAt <= now();
    if (!sharedNewer && !claudeRefreshDue && previous && now() - previous.attemptedAt < minAge) return previous;
    if (sharedNewer && !shared.failed && !details && shared.nextAttemptAt > now()) {
      return save({value: shared.value, checkedAt: shared.checkedAt, attemptedAt: shared.attemptedAt,
        failed: false, nextAttemptAt: shared.nextAttemptAt});
    }
    if (!previous && shared?.failed && shared.nextAttemptAt > now()) {
      return save({value: shared.value || null, checkedAt: shared.checkedAt || null,
        attemptedAt: shared.attemptedAt || now(), failed: true, nextAttemptAt: shared.nextAttemptAt,
        rateLimited: shared.rateLimited === true});
    }
    if (previous?.failed && previous.nextAttemptAt > now()) return previous;
    if (pending.has(cacheKey)) return pending.get(cacheKey);
    const action = limited(async () => {
      try {
        const files = await filesPromise();
        const {value, checkedAt} = await fetchAccount(account, files);
        const record = {value, checkedAt, attemptedAt: now(), failed: false, nextAttemptAt: now() + MAX_AGE};
        return save(record);
      } catch (error) {
        const attemptedAt = now();
        const latest = account.provider === 'claude' ? readShared(cacheKey) : null;
        const quota = error?.quota;
        const best = newestObservation(previous, quota, latest);
        const record = {value: best?.value || null,
          checkedAt: best?.checkedAt ?? null, attemptedAt, failed: true,
          rateLimited: (quota || latest)?.rateLimited === true,
          nextAttemptAt: quota?.nextAttemptAt || latest?.nextAttemptAt || attemptedAt +
            (account.provider === 'claude' && Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : RETRY_DELAY)};
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
        ...(account.provider === 'claude' && details ? {plan: claudeProfiles.get(usageKey(account))?.plan ?? status.value?.plan ?? null} : {}),
        windows: (status.value?.windows || []).map(({label,remaining,resetsAt}) => ({label,remaining: Math.round(remaining * 10) / 10,resetsAt})),
        ...(history ? {burnRates: history.get(account.id, account.provider)} : {}),
        checkedAt: status.checkedAt ? new Date(status.checkedAt).toISOString() : null,
        ...(account.provider === 'claude' && status.failed && status.rateLimited ? {rateLimited: true} : {}),
        // Claude is polled once a minute across all processes. Allow a bounded
        // scheduling margin without changing the original observation time.
        // Crossing any observed reset always requires a new provider reading.
        stale: status.failed || (status.checkedAt !== null && now() - status.checkedAt >=
          (account.provider === 'claude' ? CLAUDE_MAX_AGE : MAX_AGE)) ||
          (account.provider === 'claude' && (status.value?.windows || []).some(window =>
            window.resetsAt && Date.parse(window.resetsAt) <= now()))}];
    })};
  }
  // Local scheduling data only. Account permissions are still enforced by the
  // router on every request; quota data never grants access to an account.
  async function getForRouting() {
    const allowed = snapshot => snapshot.accounts.filter(account => !account.disabled &&
      snapshot.users.some(user => user.enabled && user.editable && user.accounts.includes(account.id) &&
        (!account.personal || account.owner === user.name)));
    const accounts = allowed(await admin.snapshot());
    let files;
    const filesPromise = () => files ||= Promise.resolve().then(() => management('auth-files')).then(result => {
      if (!Array.isArray(result.files) || result.files.length > 1000) throw new Error('accounts unavailable');
      return result.files;
    });
    const values = await Promise.all(accounts.map(account => accountUsage(account, filesPromise, false)));
    const current = new Map(allowed(await admin.snapshot()).map(account => [account.id, account]));
    return {version: 1, accounts: Object.fromEntries(accounts.flatMap((account, i) => {
      const after = current.get(account.id), status = values[i];
      if (!after || after.provider !== account.provider || after.email !== account.email ||
          after.personal !== account.personal || after.owner !== account.owner || !status.value || !status.checkedAt) return [];
      return [[account.id, {provider: account.provider, checkedAt: new Date(status.checkedAt).toISOString(),
        windows: status.value.windows, ...(status.value.resetCredits ? {resetCredits: status.value.resetCredits} : {})}]];
    }))};
  }
  function invalidateAccount(id) {
    for (const key of new Set([...cache.keys(), ...creditCache.keys(), ...pending.keys(), ...generations.keys()])) {
      if (JSON.parse(key)[0] !== id) continue;
      cache.delete(key); creditCache.delete(key); generations.set(key, (generations.get(key) || 0) + 1);
    }
  }
  return {getForUser, listForUser, resetCredits, getForRouting, invalidateAccount};
}

module.exports = {createUsage, parseCodex, parseClaude, claudePlan, managementClient};
