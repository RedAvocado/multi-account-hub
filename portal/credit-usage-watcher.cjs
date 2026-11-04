'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// A spending episode ends after this long without a balance decrease; the next
// decrease then notifies again.
const QUIET = 60 * 60 * 1000;
const MAX_GAP = 10 * 60 * 1000; // Observations further apart are not compared.
const EPSILON = 0.005;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const amount = value => value.toLocaleString('en-US', {maximumFractionDigits: 2});
const day = value => new Date(value).toLocaleDateString('en-US', {year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC'});

// Watches the routing snapshot for falling credit balances, so operators learn
// when credits start being spent, whether through hub fallback or direct use.
// Only hashed account IDs, balances and times are persisted.
function createCreditUsageWatcher({directory, enqueue, accountLabel = file => `${file.type === 'codex' ? 'Codex' : 'Claude'} account`, now = Date.now}) {
  const stateFile = path.join(directory, 'credit-usage-watcher.json');
  let state;
  try {
    const stat = fs.lstatSync(stateFile);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Invalid credit watcher state');
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (state?.version !== 1 || !state.accounts || typeof state.accounts !== 'object' || Array.isArray(state.accounts)) throw new Error('Invalid credit watcher state');
  } catch (error) {
    if (error.code !== 'ENOENT' && error.message !== 'Invalid credit watcher state' && !(error instanceof SyntaxError)) throw error;
    state = {version: 1, accounts: {}};
  }
  function save() {
    const temporary = path.join(directory, `.credit-watcher-${crypto.randomBytes(12).toString('hex')}.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify(state) + '\n', {mode: 0o600, flag: 'wx'});
      fs.renameSync(temporary, stateFile);
    } finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
  function planSummary(quota) {
    const windows = Array.isArray(quota.windows) ? quota.windows : [];
    if (!windows.length) return 'Plan quota: unknown';
    return 'Plan quota left: ' + windows.map(window => `${window.label} ${Math.max(0, Math.round(window.remaining))}%` +
      (window.resetsAt ? ` (resets ${new Date(window.resetsAt).toUTCString().replace(/:\d\d GMT$/, ' UTC')})` : '')).join(', ');
  }
  // Another permitted plan with headroom means the hub would not have chosen
  // credits; the spending most likely came from outside the hub.
  function otherPlanHasQuota(snapshot, id, provider) {
    return Object.entries(snapshot.accounts).some(([otherId, quota]) => otherId !== id && quota?.provider === provider &&
      Array.isArray(quota.windows) && quota.windows.length > 0 && quota.windows.every(window => window.remaining > 0));
  }
  function observe(snapshot) {
    if (!snapshot || snapshot.version !== 1 || !snapshot.accounts || typeof snapshot.accounts !== 'object') return;
    const at = now();
    let changed = false;
    const seen = new Set();
    for (const [id, quota] of Object.entries(snapshot.accounts)) {
      const balance = quota?.credits?.balance;
      const observedAt = Date.parse(quota?.checkedAt);
      if (typeof balance !== 'number' || !Number.isFinite(balance) || !Number.isFinite(observedAt)) continue;
      const key = hash(id);
      seen.add(key);
      const previous = state.accounts[key];
      const next = {balance, observedAt, lastSpendAt: previous?.lastSpendAt || 0, episodeAt: previous?.episodeAt || 0};
      if (previous && observedAt <= previous.observedAt) continue;
      const comparable = previous && observedAt - previous.observedAt <= MAX_GAP;
      if (comparable && balance < previous.balance - EPSILON) {
        if (!previous.lastSpendAt || observedAt - previous.lastSpendAt > QUIET) {
          next.episodeAt = observedAt;
          const provider = quota.provider === 'claude' ? 'Claude' : 'Codex';
          const spent = previous.balance - balance;
          const expires = quota.credits.expiresAt ? `, expiring ${day(quota.credits.expiresAt)}` : '';
          const cause = otherPlanHasQuota(snapshot, id, quota.provider)
            ? `Other ${provider} plans still have quota, so the hub did not choose credits here. This is likely direct use of the account outside the hub.`
            : `Every ${provider} plan in the hub is used up, so the hub is falling back to credits.`;
          const text = `💳 Multi-Account Hub: ${provider} credits are being used\n` +
            `${accountLabel({id, type: quota.provider, email: quota.email})}\n` +
            `Spent ${amount(spent)} credits since the last check; ${amount(balance)} left${expires}.\n` +
            `${planSummary(quota)}\n${cause}`;
          try { enqueue(`credits-${key.slice(0, 16)}-${Math.floor(observedAt / 60000)}`, text.slice(0, 1900)); }
          catch (_) { continue; } // Leave state unchanged so the next refresh retries.
        }
        next.lastSpendAt = observedAt;
      }
      state.accounts[key] = next;
      changed = true;
    }
    for (const key of Object.keys(state.accounts)) {
      if (!seen.has(key) && at - (state.accounts[key].observedAt || 0) > 30 * 86400000) { delete state.accounts[key]; changed = true; }
    }
    if (changed) { state.updatedAt = at; save(); }
  }
  return {observe};
}

module.exports = {createCreditUsageWatcher};
