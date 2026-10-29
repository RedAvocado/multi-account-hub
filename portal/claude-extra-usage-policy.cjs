'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {managementClient} = require('./usage-service.cjs');

const PROFILE = 'https://api.anthropic.com/api/oauth/profile';
const CHECK_INTERVAL = 5 * 60 * 1000;
const hash = id => crypto.createHash('sha256').update(JSON.stringify([id, 'claude'])).digest('hex');

// This is an account setting, not an inference option. Run independently of
// routing so a billing-settings outage cannot interrupt model streams.
function createClaudeExtraUsagePolicy({directory, authDir, management = managementClient(authDir), now = Date.now}) {
  let pending;
  const records = new Map();
  async function call(account, method, url, data, organization) {
    const response = await management('api-call', {auth_index: account.auth_index, method, url,
      header: {Authorization: 'Bearer $TOKEN$', Accept: 'application/json', 'Content-Type': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-cli/2.1.312 (external, cli)',
        ...(organization ? {'x-organization-uuid': organization} : {})},
      ...(data ? {data: JSON.stringify(data)} : {})});
    if (!Number.isInteger(response?.status_code) || response.status_code < 200 || response.status_code >= 300) {
      const error = new Error(Number.isInteger(response?.status_code) ? `http_${response.status_code}` : 'provider_unavailable');
      const headers = response?.header || {};
      const retry = Object.entries(headers).find(([name]) => name.toLowerCase() === 'retry-after')?.[1];
      const value = Array.isArray(retry) ? retry[0] : retry;
      const delay = /^\d+(\.\d+)?$/.test(String(value)) ? Number(value) * 1000 : Date.parse(value) - now();
      if (Number.isFinite(delay) && delay > 0) error.retryAfter = Math.min(delay, 60 * 60 * 1000);
      throw error;
    }
    if (typeof response.body !== 'string' || response.body.length > 500000) throw new Error('invalid_response');
    try { return JSON.parse(response.body); } catch (_) { throw new Error('invalid_response'); }
  }
  async function enforce(account) {
    const key = hash(account.id), previous = records.get(key);
    if (previous && now() < previous.nextCheckAt) return;
    try {
      const profile = await call(account, 'GET', PROFILE);
      const organization = profile?.organization;
      if (typeof organization?.has_extra_usage_enabled !== 'boolean') throw new Error('unknown_setting');
      let changed = false;
      if (organization.has_extra_usage_enabled) {
        if (organization.organization_type === 'claude_team' || organization.organization_type === 'claude_enterprise') {
          const error = new Error('team_admin_required');
          error.retryAfter = CHECK_INTERVAL;
          throw error;
        }
        const uuid = organization.uuid;
        if (typeof uuid !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(uuid)) throw new Error('invalid_organization');
        // Never set up billing, enable extra usage, buy credits or change limits.
        const result = await call(account, 'PUT', `https://api.anthropic.com/api/oauth/organizations/${uuid}/overage_spend_limit`,
          {is_enabled: false}, uuid);
        if (result?.is_enabled !== false) throw new Error('disable_unconfirmed');
        const verification = await call(account, 'GET', PROFILE);
        if (verification?.organization?.uuid !== uuid || verification.organization.has_extra_usage_enabled !== false) {
          throw new Error('disable_unconfirmed');
        }
        changed = true;
      }
      records.set(key, {state: 'off', checkedAt: now(), lastAttemptAt: now(), nextCheckAt: now() + CHECK_INTERVAL,
        failures: 0, disabledAt: changed ? now() : previous?.disabledAt ?? null});
    } catch (error) {
      const failures = Math.min((previous?.failures || 0) + 1, 10);
      const retry = Math.max(Math.min(60000 * 2 ** (failures - 1), CHECK_INTERVAL), error.retryAfter || 0);
      records.set(key, {state: 'unverified', checkedAt: previous?.checkedAt ?? null, lastAttemptAt: now(), nextCheckAt: now() + retry,
        failures, disabledAt: previous?.disabledAt ?? null,
        error: /^(http_\d{3}|invalid_response|unknown_setting|invalid_organization|disable_unconfirmed|team_admin_required)$/.test(error.message) ? error.message : 'provider_unavailable'});
    }
  }
  function persist() {
    const temporary = path.join(directory, `.claude-extra-usage-${crypto.randomBytes(12).toString('hex')}.tmp`);
    const value = {version: 1, updatedAt: now(), accounts: Object.fromEntries(records)};
    try {
      fs.writeFileSync(temporary, JSON.stringify(value) + '\n', {mode: 0o600, flag: 'wx'});
      fs.renameSync(temporary, path.join(directory, 'claude-extra-usage-policy.json'));
    } finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    return value;
  }
  function refresh() {
    if (pending) return pending;
    pending = Promise.resolve().then(async () => {
      const response = await management('auth-files');
      if (!Array.isArray(response?.files) || response.files.length > 1000) throw new Error('accounts_unavailable');
      // Include disabled and unassigned accounts too; grants do not control billing.
      const accounts = response.files.filter(a => a?.type === 'claude' && typeof a.id === 'string' && a.id.length <= 1024 &&
        /^[a-zA-Z0-9_-]{1,128}$/.test(a.auth_index || ''));
      const current = new Set(accounts.map(a => hash(a.id)));
      for (const key of records.keys()) if (!current.has(key)) records.delete(key);
      // Sequential probes keep these optional checks from adding a request burst.
      for (const account of accounts) await enforce(account);
      return persist();
    }).finally(() => { pending = undefined; });
    return pending;
  }
  return {refresh};
}

module.exports = {createClaudeExtraUsagePolicy};
