'use strict';
const crypto = require('node:crypto');

const CREDIT_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const validCredit = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
class ResetError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function sanitizeCredits(body) {
  if (!Array.isArray(body?.credits) || body.credits.length > 1000) throw new ResetError(503, 'Reset credits unavailable.');
  const ids = new Set();
  return {credits: body.credits.flatMap(credit => {
    if (!validCredit(credit?.id) || ids.has(credit.id) || credit.reset_type !== 'codex_rate_limits' ||
        !['available', 'used', 'expired', 'redeemed'].includes(credit.status) ||
        typeof credit.expires_at !== 'string' || !Number.isFinite(Date.parse(credit.expires_at))) return [];
    ids.add(credit.id);
    return [{id: credit.id, status: credit.status, reset_type: 'codex_rate_limits',
      expires_at: new Date(credit.expires_at).toISOString()}];
  })};
}
function contextKey(context) {
  return JSON.stringify([context.account.id, context.account.email, context.header['ChatGPT-Account-ID']]);
}
function sameContext(a, b) {
  return contextKey(a) === contextKey(b) && a.index === b.index &&
    a.account.owner === b.account.owner && a.account.personal === b.account.personal;
}
function redemptionId(context, credit) {
  // Stable across devices, retries and gateway restarts. A client cannot turn a
  // retry into a second redemption by changing its supplied request UUID.
  const bytes = crypto.createHash('sha256').update('dittodub-reset-v1\0' + contextKey(context) + '\0' + credit).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x50; bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function createResetCredits({resolve, management, invalidate, now = Date.now}) {
  const cache = new Map(), pending = new Map(), generations = new Map(), consuming = new Set(), receipts = new Map();
  async function call(context, url, data) {
    const response = await management('api-call', {auth_index: context.index, method: data ? 'POST' : 'GET', url,
      header: {...context.header, 'Content-Type': 'application/json', 'OpenAI-Beta': 'codex-1', Originator: 'Codex Desktop'},
      ...(data ? {data: JSON.stringify(data)} : {})});
    if (!Number.isInteger(response.status_code) || response.status_code < 200 || response.status_code >= 300 ||
        typeof response.body !== 'string' || response.body.length > 500000) throw new ResetError(503, 'Provider reset request unavailable.');
    return JSON.parse(response.body);
  }
  function expire(context) {
    const key = contextKey(context);
    cache.delete(key); generations.set(key, (generations.get(key) || 0) + 1);
    invalidate(context.account);
  }
  async function read(context) {
    const key = contextKey(context), previous = cache.get(key), generation = generations.get(key) || 0;
    if (previous && now() - previous.at < (previous.error ? 60000 : 30000)) {
      if (previous.error) throw new ResetError(503, 'Reset credits temporarily unavailable.');
      return previous.value;
    }
    if (pending.has(key)) return pending.get(key);
    const work = (async () => {
      try {
        const value = sanitizeCredits(await call(context, CREDIT_URL));
        if ((generations.get(key) || 0) !== generation) throw new ResetError(503, 'Reset credits changed; refresh again.');
        cache.set(key, {at: now(), value}); return value;
      } catch (error) {
        if ((generations.get(key) || 0) === generation) cache.set(key, {at: now(), error: true});
        throw error;
      }
    })();
    pending.set(key, work);
    try { return await work; } finally { pending.delete(key); }
  }
  async function current(identity, id, context, stillAuthorized) {
    if (!stillAuthorized()) throw new ResetError(401, 'Unauthorized');
    const next = await resolve(identity, id);
    if (!stillAuthorized() || (context && !sameContext(context, next))) throw new ResetError(403, 'Account access changed.');
    return next;
  }
  const receiptKey = (identity, id) => JSON.stringify([identity.name, identity.email, id]);
  function cleanReceipts() {
    for (const [key, value] of receipts) if (now() - value.at > 60000) receipts.delete(key);
  }
  async function getForUser(identity, id, stillAuthorized) {
    const context = await current(identity, id, null, stillAuthorized);
    const value = await read(context);
    await current(identity, id, context, stillAuthorized);
    return value;
  }
  async function consume(identity, id, input, stillAuthorized) {
    if (!input || Object.keys(input).sort().join(',') !== 'credit_id,redeem_request_id' || !validCredit(input.credit_id) ||
        typeof input.redeem_request_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.redeem_request_id)) {
      throw new ResetError(400, 'Invalid reset selection.');
    }
    const context = await current(identity, id, null, stillAuthorized), key = contextKey(context);
    if (consuming.has(key)) throw new ResetError(409, 'A reset is already in progress for this account. Retry shortly.');
    consuming.add(key); cleanReceipts(); receipts.delete(receiptKey(identity, id));
    try {
      await current(identity, id, context, stillAuthorized);
      const result = await call(context, CREDIT_URL + '/consume', {
        credit_id: input.credit_id, redeem_request_id: redemptionId(context, input.credit_id),
      });
      if (!['reset', 'already_redeemed', 'nothing_to_reset', 'no_credit'].includes(result?.code)) {
        throw new ResetError(503, 'Unexpected reset response. Refresh before retrying.');
      }
      await current(identity, id, context, stillAuthorized);
      if (['reset', 'already_redeemed'].includes(result.code)) receipts.set(receiptKey(identity, id), {at: now(), context, cleared: false});
      return {code: result.code};
    } finally { expire(context); consuming.delete(key); }
  }
  async function clearCooldown(identity, id, stillAuthorized) {
    cleanReceipts();
    const receipt = receipts.get(receiptKey(identity, id));
    if (!receipt) throw new ResetError(409, 'A successful reset is required before clearing cooldown.');
    const context = await current(identity, id, receipt.context, stillAuthorized);
    if (receipt.cleared) return {status: 'ok'};
    if (receipt.clearing) throw new ResetError(409, 'Cooldown refresh is already in progress.');
    receipt.clearing = true;
    try {
      // An old idempotent success cannot clear a newly exhausted account's cooldown.
      const usage = await call(context, USAGE_URL);
      if (usage?.rate_limit?.allowed !== true || usage.rate_limit.limit_reached === true) {
        throw new ResetError(409, 'Provider has not confirmed that usage is available.');
      }
      await current(identity, id, context, stillAuthorized);
      if (now() - receipt.at > 60000 || receipts.get(receiptKey(identity, id)) !== receipt) {
        throw new ResetError(409, 'Reset confirmation expired. Refresh usage.');
      }
      const result = await management('reset-quota', {auth_index: context.index});
      if (result?.status !== 'ok') throw new ResetError(503, 'Routing cooldown could not be cleared.');
      receipt.cleared = true; expire(context);
      return {status: 'ok'};
    } finally { receipt.clearing = false; }
  }
  return {getForUser, consume, clearCooldown};
}

module.exports = {createResetCredits, ResetError, CREDIT_URL, USAGE_URL, sanitizeCredits, redemptionId, contextKey};
