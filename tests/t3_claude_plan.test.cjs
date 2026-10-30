'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {enrichAccounts, installAdapter, adapterLocation} = require('../scripts/t3-claude-plan.cjs');
const config = {url: 'https://hub.example/usage', managementKey: 'private-fixture-key'};
const accounts = [
  {id: 'max', driver: 'claudeAgent', email: 'max@example.com', plan: 'Claude Subscription', usageLimits: {windows: ['unchanged']}},
  {id: 'team', driver: 'claudeAgent', email: 'team@example.com', plan: 'Claude Subscription'},
  {id: 'codex', driver: 'codex', email: 'codex@example.com', plan: 'Pro'},
];
const metadata = {accounts: [
  {id: 'max', provider: 'claude', email: 'max@example.com', plan: 'Max 20×'},
  {id: 'team', provider: 'claude', email: 'team@example.com', plan: 'Team — Standard'},
]};
const reply = value => ({ok: true, text: async () => JSON.stringify(value)});

test('T3 compatibility enriches exact account matches without changing quotas, credits or Codex', async () => {
  const result = await enrichAccounts(config, accounts, async (url, options) => {
    assert.equal(url.href, 'https://hub.example/v1/usage');
    assert.equal(options.headers.authorization, 'Bearer private-fixture-key');
    assert.equal(options.redirect, 'error');
    return reply(metadata);
  });
  assert.equal(result[0].plan, 'Claude Max 20×');
  assert.equal(result[1].plan, 'Claude Team — Standard');
  assert.equal(result[0].usageLimits, accounts[0].usageLimits);
  assert.equal(result[2], accounts[2]);
  assert.equal(accounts[0].plan, 'Claude Subscription');
});

test('missing, mismatched, invalid and failed metadata retain generic labels', async () => {
  for (const data of [null, {}, {accounts: []}, {accounts: metadata.accounts.map(a => ({...a, email: 'other@example.com'}))},
    {accounts: metadata.accounts.map(a => ({...a, provider: 'codex'}))},
    ...[null, {}, '', ' ', 'x'.repeat(61), 'Max\n20×'].map(plan => ({accounts: metadata.accounts.map(a => ({...a,plan}))}))]) {
    assert.deepEqual(await enrichAccounts(config, accounts, async () => reply(data)), accounts);
  }
  assert.equal(await enrichAccounts(config, accounts, async () => {throw new Error('outage');}), accounts);
  assert.equal(await enrichAccounts(config, accounts, async () => ({ok: false})), accounts);
  assert.equal(await enrichAccounts(config, accounts, async () => ({ok: true, text: async () => 'invalid'})), accounts);
  let requests = 0;
  const fetcher = async () => { requests++; return reply(metadata); };
  assert.equal(await enrichAccounts({...config, url: 'https://other.example/'}, accounts, fetcher), accounts);
  const named = [{...accounts[0], plan: 'Claude Max 5×'}];
  assert.equal(await enrichAccounts(config, named, fetcher), named);
  assert.equal(requests, 0, 'other proxies and clients with native tier support need no enrichment');
});

test('adapter installation is idempotent and preserves other API operations', () => {
  const consume = () => 'reset';
  const api = {readAccounts: () => ({pipe: change => change(accounts)}), consume};
  const flatMap = change => change, promise = run => run();
  assert.deepEqual(installAdapter(api, flatMap, promise), {patched: true, changed: true});
  const installed = api.readAccounts;
  assert.deepEqual(installAdapter(api, flatMap, promise), {patched: true, changed: false});
  assert.equal(api.readAccounts, installed);
  assert.equal(api.consume, consume);
  assert.throws(() => installAdapter({}, flatMap, promise), /Unsupported/);
});

test('breakpoint locations target only the initialized usage source adapter', () => {
  const source = `ignored\n//#region src/usage/UsageLimitSources.ts\nconst api = yield* makeCliproxyApi;\nconst settingsService = yield* ServerSettingsService;\nconst accounts = yield* api.readAccounts(config).pipe(result$1);\n//#endregion`;
  assert.deepEqual(adapterLocation(source), {lineNumber: 4, columnNumber: 0});
  assert.deepEqual(adapterLocation(source, true), {lineNumber: 3, columnNumber: 0});
  assert.equal(adapterLocation('unknown adapter'), null);
  assert.equal(adapterLocation(source.replace('//#endregion', '')), null);
});

test('startup hook installs on an isolated running adapter without a restart or open inspector port', t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-t3-plan-startup-')));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const main = path.join(directory, 't3'), preload = path.join(directory, 'preload.cjs');
  const helper = require.resolve('../scripts/t3-claude-plan.cjs');
  fs.writeFileSync(preload, `process.execPath=${JSON.stringify(main)}; require(${JSON.stringify(helper)}).installStartup();`);
  fs.writeFileSync(main, `
    const assert = require('node:assert/strict');
    const flatMap$3 = change => change, promise = run => run();
    const ServerSettingsService = [];
    //#region src/usage/UsageLimitSources.ts
    function* make() {
      void [flatMap$3, promise];
      const api = {readAccounts: () => ({pipe: change => change([])}), consume: () => 'preserved'};
      const settingsService = yield* ServerSettingsService;
      return api;
    }
    //#endregion
    const api = make().next().value;
    setImmediate(async () => {
      try {
        assert.equal(api[Symbol.for('cliproxy-hub.claude-plan-labels')], true);
        assert.equal(api.consume(), 'preserved');
        assert.deepEqual(await api.readAccounts({}), []);
        assert.equal(require('node:inspector').url(), undefined);
        console.log('PASS');
      } catch (error) { console.error(error); process.exitCode = 1; }
    });
  `);
  const result = spawnSync(process.execPath, ['--require', preload, main], {encoding: 'utf8', timeout: 10000});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'PASS');
});
