'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createResetCreditWatcher} = require('./reset-credit-watcher.cjs');
const {redemptionId, CREDIT_URL, USAGE_URL} = require('./reset-credit-service.cjs');

const response = body => ({status_code: 200, body: JSON.stringify(body)});
function fixture(t, count = 1) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-reset-watcher-'));
  const authDir = path.join(directory, 'auth'); fs.mkdirSync(authDir);
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const state = {clock: Date.parse('2026-10-29T18:00:00Z'), posts: [], clears: [], alerts: [], applied: 0, invalidations: [],
    allowed: true, ledger: new Map(), files: [], credits: new Map()};
  for (let i = 0; i < count; i++) {
    const file = {id: `account${i}.json`, type: 'codex', email: `owner${i}@private.example`, auth_index: `auth${i}`};
    state.files.push(file);
    fs.writeFileSync(path.join(authDir, file.id), JSON.stringify({type: 'codex', email: file.email, account_id: `acct${i}`}));
    state.credits.set(file.auth_index, [{id: `credit${i}`, status: 'available', reset_type: 'codex_rate_limits',
      expires_at: new Date(state.clock + 120000).toISOString()}]);
  }
  const management = async (endpoint, input) => {
    if (endpoint === 'auth-files') {
      if (state.failAccounts) throw new Error('private upstream error');
      return {files: state.files};
    }
    if (endpoint === 'reset-quota') { state.clears.push(input); return {status: 'ok'}; }
    assert.equal(endpoint, 'api-call');
    assert.equal(input.header.Authorization, 'Bearer $TOKEN$');
    if (input.url === CREDIT_URL && input.method === 'GET') {
      if (state.blockDetails) await state.blockDetails;
      if (state.failDetails) throw new Error('private provider detail');
      return response({credits: state.credits.get(input.auth_index)});
    }
    if (input.url === USAGE_URL) return response({rate_limit: {allowed: state.allowed, limit_reached: !state.allowed}});
    assert.equal(input.url, CREDIT_URL + '/consume'); assert.equal(input.method, 'POST');
    const body = JSON.parse(input.data); state.posts.push({...body, index: input.auth_index, at: state.clock});
    if (state.blockConsume) await state.blockConsume;
    if (state.providerReply) return state.providerReply(input);
    if (state.outcome) return response({code: state.outcome});
    if (state.ledger.has(body.redeem_request_id)) return response({code: 'already_redeemed'});
    const credit = state.credits.get(input.auth_index)?.find(c => c.id === body.credit_id && c.status === 'available');
    if (!credit) return response({code: 'no_credit'});
    state.ledger.set(body.redeem_request_id, true); credit.status = 'used'; state.applied++;
    if (state.loseResponse) throw new Error('response lost after provider applied reset');
    return response({code: 'reset'});
  };
  const options = {directory, authDir, management, now: () => state.clock,
    enqueue(id, content) { if (state.failEnqueue) throw new Error('disk unavailable'); state.alerts.push({id, content}); },
    accountLabel: () => 'Personal Codex account', afterReset: async id => { state.invalidations.push(id); }};
  return {state, directory, authDir, options, make: () => createResetCreditWatcher(options), advance: ms => { state.clock += ms; },
    read: () => JSON.parse(fs.readFileSync(path.join(directory, 'reset-credit-watcher.json'), 'utf8'))};
}
const credits = f => Object.values(f.read().accounts).flatMap(a => Object.values(a.credits));

test('per-account deadlines never redeem early, then redeem at expiry minus one minute with private state and alerts', async t => {
  const f = fixture(t, 2), watcher = f.make();
  f.state.credits.get('auth1')[0].expires_at = new Date(f.state.clock + 180000).toISOString();
  await watcher.refresh();
  assert.deepEqual(watcher.status(), {accounts: 2, scheduled: 2, nextTargetAt: f.state.clock + 60000, discoveryAt: f.state.clock});
  await watcher.redeemDue(); f.advance(59999); await watcher.redeemDue(); assert.equal(f.state.posts.length, 0);
  f.advance(1); await watcher.redeemDue();
  assert.equal(f.state.applied, 1); assert.equal(f.state.posts[0].index, 'auth0');
  assert.equal(f.state.alerts.length, 1); assert.match(f.state.alerts[0].content, /redeemed automatically/);
  assert.equal(f.state.clears.length, 1); assert.deepEqual(f.state.invalidations, ['account0.json']);
  f.advance(60000); await watcher.redeemDue(); assert.equal(f.state.applied, 2);
  await watcher.redeemDue(); assert.equal(f.state.posts.length, 2);
  assert.equal(fs.statSync(path.join(f.directory, 'reset-credit-watcher.json')).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(f.read()), /private.example|Bearer|acct0/);
  assert.ok(f.state.alerts.every(a => !/credit0|private.example/.test(a.content)));
});

test('a lost response survives restart and retries the same ID used by manual redemption', async t => {
  const f = fixture(t); let watcher = f.make();
  await watcher.refresh(); f.advance(60000); f.state.loseResponse = true;
  await watcher.redeemDue(); assert.equal(f.state.applied, 1); assert.equal(f.state.alerts.length, 0);
  const expected = redemptionId({account: {id: 'account0.json', email: 'owner0@private.example'},
    header: {'ChatGPT-Account-ID': 'acct0'}}, 'credit0');
  assert.equal(f.state.posts[0].redeem_request_id, expected);
  watcher.stop(); watcher = f.make(); f.advance(5000); f.state.loseResponse = false;
  await watcher.redeemDue(); assert.equal(f.state.posts.length, 1, 'startup first revalidates connected accounts');
  await watcher.refresh(); await watcher.redeemDue();
  assert.equal(f.state.posts.length, 2); assert.equal(f.state.applied, 1);
  assert.equal(f.state.posts[1].redeem_request_id, expected);
  assert.equal(credits(f)[0].outcome, 'already_redeemed');
  assert.match(f.state.alerts[0].content, /already redeemed/);
});

test('starting inside the final minute attempts immediately; waking after expiry reports missed without a POST', async t => {
  const f = fixture(t); let watcher = f.make();
  f.advance(90000); await watcher.refresh(); await watcher.redeemDue(); assert.equal(f.state.applied, 1);
  const g = fixture(t); watcher = g.make(); await watcher.refresh();
  watcher.stop(); g.advance(120001); watcher = g.make();
  await watcher.refresh(); await watcher.redeemDue();
  assert.equal(g.state.posts.length, 0); assert.equal(credits(g)[0].outcome, 'expired');
  assert.match(g.state.alerts[0].content, /without a confirmed redemption/);
});

test('nothing-to-reset retries during the final minute, expires accurately, and never clears cooldown', async t => {
  const f = fixture(t), watcher = f.make(); f.state.outcome = 'nothing_to_reset';
  await watcher.refresh(); f.advance(60000); await watcher.redeemDue();
  assert.equal(f.state.alerts.length, 0); assert.equal(f.state.clears.length, 0);
  f.advance(9999); await watcher.redeemDue(); assert.equal(f.state.posts.length, 1);
  f.advance(1); await watcher.redeemDue(); assert.equal(f.state.posts.length, 2);
  f.advance(50000); await watcher.redeemDue();
  assert.equal(f.state.posts.length, 2); assert.equal(f.state.alerts.length, 1);
  assert.match(f.state.alerts[0].content, /nothing to reset/); assert.equal(f.state.clears.length, 0);
});

test('provider retries respect retry-after and cannot send expired credits', async t => {
  const f = fixture(t), watcher = f.make();
  f.state.providerReply = () => ({status_code: 429, header: {'Retry-After': ['40']}, body: '{}'});
  await watcher.refresh(); f.advance(60000); await watcher.redeemDue();
  f.advance(39999); await watcher.redeemDue(); assert.equal(f.state.posts.length, 1);
  f.advance(1); await watcher.redeemDue(); assert.equal(f.state.posts.length, 2);
  f.advance(20000); await watcher.redeemDue(); assert.equal(f.state.posts.length, 2);
  assert.equal(credits(f)[0].outcome, 'expired'); assert.equal(f.state.alerts.length, 1);
});

test('no-credit and unknown outcomes cannot claim success or clear cooldown; success also requires usable quota', async t => {
  for (const outcome of ['no_credit', 'unknown', 'reset']) {
    const f = fixture(t), watcher = f.make(); f.state.outcome = outcome; f.state.allowed = false;
    await watcher.refresh(); f.advance(60000); await watcher.redeemDue();
    assert.equal(f.state.clears.length, 0, outcome);
    if (outcome === 'no_credit') assert.match(f.state.alerts[0].content, /no longer available/);
    if (outcome === 'unknown') { assert.equal(f.state.alerts.length, 0); assert.equal(credits(f)[0].lastError, 'unknown_outcome'); }
    if (outcome === 'reset') assert.equal(f.state.invalidations.length, 1);
  }
});

test('rechecks account identity before mutation and rejects disabled, removed, changed or symlinked accounts', async t => {
  for (const kind of ['disabled', 'removed', 'changed', 'symlink']) {
    const f = fixture(t), watcher = f.make(); await watcher.refresh();
    if (kind === 'disabled') f.state.files[0].disabled = true;
    if (kind === 'removed') f.state.files = [];
    const auth = path.join(f.authDir, 'account0.json');
    if (kind === 'changed') fs.writeFileSync(auth, JSON.stringify({type: 'codex', email: 'owner0@private.example', account_id: 'replacement'}));
    if (kind === 'symlink') { fs.renameSync(auth, auth + '.real'); fs.symlinkSync(auth + '.real', auth); }
    f.advance(60000); await watcher.redeemDue();
    assert.equal(f.state.posts.length, 0, kind); assert.equal(credits(f)[0].outcome, 'unavailable', kind);
  }
});

test('manual redemption before deadline is recognized without another POST', async t => {
  const f = fixture(t), watcher = f.make(); await watcher.refresh();
  f.state.credits.get('auth0')[0].status = 'used'; f.advance(5 * 60000);
  await watcher.refresh(); await watcher.redeemDue();
  assert.equal(f.state.posts.length, 0); assert.equal(credits(f)[0].outcome, 'externally_used');
});

test('slow details refresh does not block known deadlines; simultaneous sweeps share in-flight account work', async t => {
  const f = fixture(t), watcher = f.make(); await watcher.refresh();
  f.advance(30000); let release;
  // Make refresh due without crossing the known deadline.
  const stored = f.read(); Object.values(stored.accounts)[0].nextRefreshAt = 0;
  fs.writeFileSync(path.join(f.directory, 'reset-credit-watcher.json'), JSON.stringify(stored));
  watcher.stop(); const restarted = f.make();
  f.state.blockDetails = new Promise(resolve => { release = resolve; });
  const refreshing = restarted.refresh(); await new Promise(resolve => setImmediate(resolve));
  f.advance(30000); let finish;
  f.state.blockConsume = new Promise(resolve => { finish = resolve; });
  const first = restarted.redeemDue(); await new Promise(resolve => setImmediate(resolve));
  await restarted.redeemDue(); assert.equal(f.state.posts.length, 1);
  finish(); await first; assert.equal(f.state.applied, 1);
  release(); await refreshing; assert.equal(f.state.posts.length, 1);
});

test('notification enqueue failures survive restart without repeating successful redemptions', async t => {
  const f = fixture(t); let watcher = f.make(); await watcher.refresh();
  f.state.failEnqueue = true; f.advance(60000); await watcher.redeemDue();
  assert.equal(f.state.applied, 1); assert.equal(credits(f)[0].notified, undefined);
  watcher.stop(); watcher = f.make(); f.state.failEnqueue = false;
  await watcher.refresh(); await watcher.redeemDue();
  assert.equal(f.state.applied, 1); assert.equal(f.state.posts.length, 1);
  assert.equal(f.state.alerts.length, 1); assert.equal(credits(f)[0].notified, true);
});

test('details outages preserve known deadlines, account outages never authorize a POST, and malformed state fails closed', async t => {
  const f = fixture(t), watcher = f.make(); await watcher.refresh();
  f.state.failAccounts = true; f.advance(60000); await watcher.redeemDue();
  assert.equal(f.state.posts.length, 0); await assert.rejects(watcher.refresh());
  f.state.failAccounts = false; f.state.failDetails = true; f.advance(10000);
  await watcher.refresh(); await watcher.redeemDue(); assert.equal(f.state.applied, 1);
  watcher.stop(); fs.writeFileSync(path.join(f.directory, 'reset-credit-watcher.json'), '{broken');
  assert.throws(() => f.make());
});
