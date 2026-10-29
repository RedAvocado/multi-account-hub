'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MINUTE = 60000;
const DAY = 24 * 60 * MINUTE;
const MAX_GAP = 3 * MINUTE;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_POINTS = 3000;
const periods = {tenMinutes: [30 * MINUTE, 10 * MINUTE], hour: [60 * MINUTE, 60 * MINUTE], day: [DAY, DAY]};
const historyKey = (id, provider) => crypto.createHash('sha256').update(JSON.stringify([id, provider])).digest('hex');

function basisWindow(windows) {
  // General windows overlap; never add their percentages together.
  for (const label of ['1mo', '1w', '5h']) {
    const value = windows?.find(w => w.label === label && (!w.scope || w.scope === 'general') &&
      Number.isFinite(w.remaining) && w.remaining >= 0 && w.remaining <= 100);
    if (value) return value;
  }
  return null;
}

function validPoint(point) {
  return Array.isArray(point) && point.length === 3 && Number.isSafeInteger(point[0]) && point[0] > 0 && point[0] < 8640000000000000 &&
    Number.isFinite(point[1]) && point[1] >= 0 && point[1] <= 100 &&
    (point[2] === null || Number.isSafeInteger(point[2]) && point[2] > 0 && point[2] < 8640000000000000);
}

function rate(points, now, horizon, unit) {
  let burned = 0, observed = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], duration = b[0] - a[0];
    // Refills, changed reset cycles and long outages cannot establish burn.
    if (duration <= 0 || duration > MAX_GAP || b[1] > a[1] || a[2] !== b[2] ||
        a[2] !== null && a[0] < a[2] && b[0] >= a[2]) continue;
    const overlap = Math.min(b[0], now) - Math.max(a[0], now - horizon);
    if (overlap <= 0) continue;
    burned += (a[1] - b[1]) * overlap / duration;
    observed += overlap;
  }
  return {percent: observed >= 5 * MINUTE ? Math.round(burned * unit / observed * 100) / 100 : null,
    observedSeconds: Math.round(observed / 1000), windowSeconds: horizon / 1000};
}

function createUsageHistory({directory, now = Date.now}) {
  const file = path.join(directory, 'usage-history.json');
  let cached = {version: 1, accounts: {}}, loadedAt = -Infinity;
  function load(force = false) {
    if (!force && now() - loadedAt >= 0 && now() - loadedAt < 2000) return cached;
    loadedAt = now();
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.mode & 0o077 || stat.size > MAX_BYTES) return cached;
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (value.version !== 1 || !value.accounts || typeof value.accounts !== 'object' || Array.isArray(value.accounts) || Object.keys(value.accounts).length > 1000) return cached;
      const accounts = {};
      for (const [key, account] of Object.entries(value.accounts)) {
        if (!/^[a-f0-9]{64}$/.test(key) || !['1mo', '1w', '5h'].includes(account?.basis) ||
            !Array.isArray(account.points) || !account.points.length || account.points.length > MAX_POINTS || !account.points.every(validPoint) ||
            account.points.some((p, i) => i > 0 && p[0] <= account.points[i - 1][0])) continue;
        accounts[key] = account;
      }
      cached = {version: 1, accounts};
    } catch (_) { /* Keep valid history through transient reads; its points still age. */ }
    return cached;
  }
  function record(snapshot) {
    if (snapshot?.version !== 1 || !snapshot.accounts || Object.keys(snapshot.accounts).length > 1000) return;
    const previous = load(true), accounts = {}, current = now();
    // A temporarily unavailable account can be absent from the routing feed.
    // Keep its history until it ages out; browser access is checked separately.
    for (const [key, account] of Object.entries(previous.accounts)) {
      const points = account.points.filter(p => p[0] >= current - DAY - MAX_GAP && p[0] <= current + 5000);
      if (points.length) accounts[key] = {basis: account.basis, points};
    }
    for (const [id, quota] of Object.entries(snapshot.accounts)) {
      const basis = basisWindow(quota.windows), at = Date.parse(quota.checkedAt);
      if (!basis) continue;
      const key = historyKey(id, quota.provider), old = previous.accounts[key];
      const points = old?.basis === basis.label ? old.points.filter(p => p[0] >= current - DAY - MAX_GAP && p[0] <= current + 5000) : [];
      if (Number.isFinite(at) && current - at <= MAX_GAP && at <= current + 5000 &&
          (!points.length || at - points[points.length - 1][0] >= 30000)) {
        const resetsAt = Date.parse(basis.resetsAt);
        points.push([at, basis.remaining, Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt : null]);
      }
      if (points.length) accounts[key] = {basis: basis.label, points: points.slice(-MAX_POINTS)};
    }
    const bounded = Object.fromEntries(Object.entries(accounts).sort((a, b) => b[1].points.at(-1)[0] - a[1].points.at(-1)[0]).slice(0, 1000));
    const value = {version: 1, accounts: bounded}, raw = JSON.stringify(value) + '\n';
    if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error('Usage history is too large');
    const temporary = path.join(directory, `.usage-history-${crypto.randomBytes(12).toString('hex')}.tmp`);
    try {
      fs.writeFileSync(temporary, raw, {mode: 0o600, flag: 'wx'});
      fs.renameSync(temporary, file);
      cached = value; loadedAt = current;
    } finally {
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  function get(id, provider) {
    const current = now(), account = load().accounts[historyKey(id, provider)];
    if (!account) return null;
    const last = account.points.at(-1);
    return {basis: account.basis, checkedAt: new Date(last[0]).toISOString(), stale: current - last[0] > MAX_GAP,
      ...Object.fromEntries(Object.entries(periods).map(([name, [horizon, unit]]) => [name, rate(account.points, current, horizon, unit)]))};
  }
  return {record, get};
}

module.exports = {createUsageHistory};
