'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {managementClient} = require('./usage-service.cjs');
const {CREDIT_URL, USAGE_URL, sanitizeCredits, redemptionId, contextKey} = require('./reset-credit-service.cjs');

const LEAD = 60000, DETAILS_INTERVAL = 5 * 60000, RETENTION = 30 * 86400000;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const active = credit => !credit.finishedAt;

// Operator-owned policy for connected Codex accounts, independent of member
// grants. No provider calls run on model requests. Credit IDs are private state;
// credentials, account emails and provider bodies are never persisted here.
function createResetCreditWatcher({directory, authDir, enqueue, accountLabel = () => 'Codex account',
  management = managementClient(authDir), now = Date.now, afterReset = async () => {}}) {
  const stateFile = path.join(directory, 'reset-credit-watcher.json');
  let state;
  try {
    const stat = fs.lstatSync(stateFile);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('Invalid watcher state');
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (state?.version !== 1 || !state.accounts || Array.isArray(state.accounts)) throw new Error('Invalid watcher state');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = {version: 1, accounts: {}};
  }
  const contexts = new Map(), busy = new Set();
  let refreshing, stopped = false;
  function save() {
    state.updatedAt = now();
    const temporary = path.join(directory, `.reset-watcher-${crypto.randomBytes(12).toString('hex')}.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify(state) + '\n', {mode: 0o600, flag: 'wx'});
      fs.renameSync(temporary, stateFile);
    } finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
  function context(file) {
    if (file?.type !== 'codex' || file.disabled === true || typeof file.id !== 'string' ||
        !/^[A-Za-z0-9_.@-]{1,255}$/.test(file.id) || path.basename(file.id) !== file.id ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(file.auth_index || '')) return null;
    try {
      const target = path.join(authDir, file.id), stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.size > 1024 * 1024) return null;
      const auth = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (auth.type !== 'codex' || auth.disabled === true || typeof auth.email !== 'string' ||
          auth.email.toLowerCase() !== file.email?.toLowerCase() || !/^[A-Za-z0-9_-]{1,128}$/.test(auth.account_id || '')) return null;
      return {account: {id: file.id, email: auth.email.toLowerCase()}, index: file.auth_index, file,
        header: {Authorization: 'Bearer $TOKEN$', Accept: 'application/json', 'ChatGPT-Account-ID': auth.account_id,
          'User-Agent': 'codex-tui/0.149.1'}};
    } catch (_) { return null; }
  }
  async function accounts() {
    const response = await management('auth-files');
    if (!Array.isArray(response?.files) || response.files.length > 1000) throw new Error('accounts_unavailable');
    const result = new Map();
    const ids = new Set();
    for (const file of response.files) {
      // Duplicate IDs cannot be resolved safely.
      if (ids.has(file.id)) throw new Error('ambiguous_account');
      ids.add(file.id);
      const value = context(file);
      if (value) result.set(hash(contextKey(value)), value);
    }
    return result;
  }
  async function call(ctx, url, data) {
    const response = await management('api-call', {auth_index: ctx.index, method: data ? 'POST' : 'GET', url,
      header: {...ctx.header, 'Content-Type': 'application/json', 'OpenAI-Beta': 'codex-1', Originator: 'Codex Desktop'},
      ...(data ? {data: JSON.stringify(data)} : {})});
    if (!Number.isInteger(response?.status_code) || response.status_code < 200 || response.status_code >= 300) {
      const error = new Error('provider_unavailable');
      const retry = Object.entries(response?.header || {}).find(([key]) => key.toLowerCase() === 'retry-after')?.[1];
      const value = Array.isArray(retry) ? retry[0] : retry;
      const delay = /^\d+(\.\d+)?$/.test(String(value)) ? Number(value) * 1000 : Date.parse(value) - now();
      if (Number.isFinite(delay) && delay > 0) error.retryAfter = Math.min(delay, 86400000);
      throw error;
    }
    if (typeof response.body !== 'string' || response.body.length > 500000) throw new Error('invalid_response');
    try { return JSON.parse(response.body); } catch (_) { throw new Error('invalid_response'); }
  }
  function notify(ctx, credit) {
    if (!credit.finishedAt || credit.notified) return;
    const description = {
      reset: '✅ Expiring banked reset redeemed automatically.',
      already_redeemed: '✅ Provider confirmed the banked reset was already redeemed.',
      no_credit: 'ℹ️ Expiring reset credit is no longer available; no reset was confirmed.',
      expired: credit.lastOutcome === 'nothing_to_reset'
        ? '⚠️ Banked reset expired unused: the provider reported nothing to reset.'
        : '⚠️ Banked reset expired without a confirmed redemption.',
      unavailable: '⚠️ Banked reset could not be redeemed: the account was removed, disabled or changed.',
    }[credit.outcome];
    if (!description) { credit.notified = true; return; }
    // The durable outbox is written before marking notified, so a crash cannot
    // lose an alert. The stable event ID also deduplicates queued retries.
    enqueue(credit.eventId, `${description}\n${ctx ? accountLabel(ctx.file) : 'Disconnected Codex account'}\nExpiry: ${new Date(credit.expiresAt).toISOString()}\nTarget: 60 seconds before expiry.`);
    credit.notified = true;
  }
  function finish(ctx, credit, outcome) {
    credit.outcome = outcome; credit.finishedAt = now();
    save();
    try { notify(ctx, credit); } catch (_) { /* Retry delivery enqueue on refresh. */ }
    save();
  }
  function refresh() {
    if (refreshing) return refreshing;
    refreshing = Promise.resolve().then(async () => {
      if (stopped) return;
      const current = await accounts();
      for (const [key, record] of Object.entries(state.accounts)) {
        if (!current.has(key) && !busy.has(key)) {
          for (const credit of Object.values(record.credits)) {
            if (active(credit)) finish(contexts.get(key), credit, 'unavailable');
            else { try { notify(contexts.get(key), credit); } catch (_) {} }
          }
        }
      }
      contexts.clear(); for (const [key, ctx] of current) contexts.set(key, ctx);
      for (const [key, record] of Object.entries(state.accounts)) {
        for (const [id, credit] of Object.entries(record.credits)) {
          if (credit.finishedAt && now() - credit.finishedAt > RETENTION) delete record.credits[id];
        }
        if (!current.has(key) && !Object.keys(record.credits).length) delete state.accounts[key];
      }
      // Two optional probes at a time; deadline execution has its own loop and
      // cannot be held behind a slow details refresh.
      let cursor = 0; const entries = [...current];
      await Promise.all(Array.from({length: Math.min(2, entries.length)}, async () => {
        while (cursor < entries.length && !stopped) {
          const [key, ctx] = entries[cursor++];
          const record = state.accounts[key] ||= {credits: {}, nextRefreshAt: 0};
          for (const credit of Object.values(record.credits)) { try { notify(ctx, credit); } catch (_) {} }
          if (now() < record.nextRefreshAt) continue;
          try {
            const credits = sanitizeCredits(await call(ctx, CREDIT_URL)).credits;
            for (const value of credits) {
              const id = hash(value.id), previous = record.credits[id];
              if (value.status === 'available' && Date.parse(value.expires_at) > now()) {
                record.credits[id] ||= {id: value.id, expiresAt: Date.parse(value.expires_at),
                  targetAt: Date.parse(value.expires_at) - LEAD, nextAttemptAt: 0, attempts: 0,
                  eventId: 'reset-' + redemptionId(ctx, value.id)};
              } else if (previous && active(previous) && !previous.attempts && value.status !== 'available') {
                finish(ctx, previous, 'externally_used');
              }
            }
            record.checkedAt = now(); record.nextRefreshAt = now() + DETAILS_INTERVAL;
            delete record.error;
          } catch (_) {
            record.error = 'credits_unavailable'; record.nextRefreshAt = now() + 30000;
          }
          save();
        }
      }));
      state.lastDiscoveryAt = now(); save();
      return status();
    }).finally(() => { refreshing = undefined; });
    return refreshing;
  }
  async function redeem(key, credit, original) {
    // Re-resolve immediately before mutation; stale discovery never authorizes
    // redemption through a replaced auth index or a disconnected account.
    const ctx = (await accounts()).get(key);
    if (!ctx) { finish(original, credit, 'unavailable'); return; }
    if (stopped) return;
    if (now() >= credit.expiresAt) { finish(ctx, credit, 'expired'); return; }
    credit.attempts++; credit.lastAttemptAt = now(); save();
    const result = await call(ctx, CREDIT_URL + '/consume', {
      credit_id: credit.id, redeem_request_id: redemptionId(ctx, credit.id),
    });
    if (!['reset', 'already_redeemed', 'nothing_to_reset', 'no_credit'].includes(result?.code)) throw new Error('unknown_outcome');
    credit.lastOutcome = result.code;
    if (result.code === 'nothing_to_reset') {
      credit.nextAttemptAt = now() + 10000; save(); return;
    }
    finish(ctx, credit, result.code);
    if (result.code === 'reset' || result.code === 'already_redeemed') {
      // Provider success alone must not erase a quota cooldown: verify usage
      // and the exact account again, as the manual reset flow does.
      try {
        const usage = await call(ctx, USAGE_URL);
        const current = (await accounts()).get(key);
        if (current && usage?.rate_limit?.allowed === true && usage.rate_limit.limit_reached !== true &&
            now() - credit.lastAttemptAt < 60000) {
          const result = await management('reset-quota', {auth_index: current.index});
          credit.cooldownCleared = result?.status === 'ok';
        }
      } catch (_) { credit.cooldownCleared = false; }
      try { await afterReset(ctx.account.id); } catch (_) {}
      state.accounts[key].nextRefreshAt = 0; save();
    }
  }
  async function redeemDue() {
    if (stopped) return;
    const jobs = [];
    for (const [key, record] of Object.entries(state.accounts)) {
      if (busy.has(key)) continue;
      if (busy.size >= 2) break;
      const ctx = contexts.get(key);
      const due = Object.values(record.credits).filter(credit => active(credit) && now() >= credit.targetAt)
        .sort((a, b) => a.expiresAt - b.expiresAt);
      for (const credit of due) {
        if (now() >= credit.expiresAt) { finish(ctx, credit, 'expired'); continue; }
        if (now() < credit.nextAttemptAt) continue;
        // A startup must establish current account identity before any POST.
        if (!state.lastDiscoveryAt || !ctx) continue;
        busy.add(key);
        jobs.push(Promise.resolve().then(() => redeem(key, credit, ctx)).catch(error => {
          credit.lastError = error.message === 'unknown_outcome' ? 'unknown_outcome' : 'provider_unavailable';
          credit.nextAttemptAt = now() + Math.max(Math.min(5000 * 2 ** Math.min(credit.attempts - 1, 2), 15000), error.retryAfter || 0);
          save();
        }).finally(() => busy.delete(key)));
        break; // One redemption in flight per account.
      }
    }
    await Promise.all(jobs);
  }
  function status() {
    const credits = Object.values(state.accounts).flatMap(a => Object.values(a.credits));
    const scheduled = credits.filter(active);
    return {accounts: contexts.size, scheduled: scheduled.length,
      nextTargetAt: scheduled.length ? Math.min(...scheduled.map(c => c.targetAt)) : null,
      discoveryAt: state.lastDiscoveryAt || null};
  }
  return {refresh, redeemDue, status, stop() { stopped = true; }};
}
module.exports = {createResetCreditWatcher};
