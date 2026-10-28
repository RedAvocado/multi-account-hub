'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {codingModels, providerPlan, syncProviders} = require('../scripts/configure-t3-usage.cjs');

const model = (id, owned_by = 'openai') => ({id, owned_by});
const models = {codex: ['gpt-6.1-terra', 'gpt-6-astra'], claudeAgent: ['claude-opus-5-5', 'claude-fable-5-1']};
function options(home = '/test-home') {
  return {home, codexHome: path.join(home, '.dittodub-provider-hub/codex'),
    codexBinary: '/installed/codex', claudeHome: path.join(home, '.dittodub-provider-hub/claude'),
    claudeBinary: path.join(home, '.dittodub-provider-hub/hub-claude'), models};
}

test('catalog selects both coding families dynamically and excludes image/audio/internal helpers', () => {
  const result = codingModels({data: [model('gpt-6.1-terra'), model('gpt-99-new'), model('gpt-6.1-terra'),
    model('o3'), model('gpt-image-2.5'), model('gpt-4o-audio-preview'), model('gpt-4o-transcribe'),
    model('gpt-4o-mini-tts'), model('codex-auto-review'), model('claude-future-model', 'anthropic'),
    model('claude-fake', 'other'), model('gpt-99-other', 'other') ]});
  assert.deepEqual(result, {codex: ['gpt-6.1-terra', 'gpt-99-new', 'o3'], claudeAgent: ['claude-future-model']});
  assert.throws(() => codingModels({data: []}), /no coding models/);
  assert.throws(() => codingModels({data: [model('bad\nmodel')]}), /Invalid model ID/);
  assert.throws(() => codingModels({}), /Invalid hub model catalog/);
});

test('fresh settings create enabled providers with separate homes and correctly routed models', () => {
  const plan = providerPlan({providerInstances: {}}, options());
  assert.deepEqual(plan.map(x => x.id), ['hub_codex', 'hub_claude']);
  for (const item of plan) {
    assert.equal(item.changed, true);
    assert.equal(item.instance.enabled, true);
    assert.deepEqual(item.instance.config.customModels, models[item.driver]);
  }
  assert.equal(plan[0].instance.config.homePath, options().codexHome);
  assert.equal(plan[1].instance.config.binaryPath, options().claudeBinary);
});

test('upgrade reuses renamed providers and preserves custom descriptors, credentials, launch options, disabled state, and preferences', () => {
  const descriptor = {slug: 'custom-model', name: 'My Model', capabilities: {optionDescriptors: []}};
  const settings = {providerModelPreferences: {renamed: {hiddenModels: ['gpt-6.1-terra']}}, providerInstances: {
    unrelated: {driver: 'codex', config: {homePath: '/another/home', customModels: ['keep']}},
    renamed: {driver: 'codex', displayName: 'My Hub', enabled: false, environment: {KEEP: 'private-value'},
      config: {homePath: '~/.dittodub-provider-hub/codex', binaryPath: '/my/codex', launchArgs: '--existing',
        customModels: [descriptor, 'gpt-6.1-terra']}}
  }};
  const original = structuredClone(settings);
  const plan = providerPlan(settings, {...options(), catalog: [{instanceId: 'renamed', models: [{slug: 'gpt-6-astra'}]}]});
  const codex = plan.find(x => x.id === 'renamed');
  assert.equal(codex.changed, false);
  assert.deepEqual(codex.instance, settings.providerInstances.renamed);
  assert.equal(plan.some(x => x.id === 'unrelated'), false);
  assert.deepEqual(settings, original);
});

test('new models append without replacing existing models, and the second run is idempotent', () => {
  const settings = {providerInstances: {hub_codex: {driver: 'codex', enabled: true,
    config: {homePath: options().codexHome, customModels: ['my-private-model']}}}};
  const first = providerPlan(settings, options());
  assert.deepEqual(first[0].instance.config.customModels, ['my-private-model', ...models.codex]);
  for (const item of first) settings.providerInstances[item.id] = item.instance;
  const second = providerPlan(settings, options());
  assert.ok(second.every(item => !item.changed));
});

test('provider ID collision stops before mutation and legacy setup remains Codex-only', () => {
  assert.throws(() => providerPlan({providerInstances: {hub_claude: {driver: 'claudeAgent', config: {homePath: '/another/home'}}}}, options()), /another provider/);
  const plan = providerPlan({providerInstances: {}}, {...options(), claudeHome: undefined, claudeBinary: undefined});
  assert.equal(plan.length, 1);
  assert.equal(plan[0].driver, 'codex');
  assert.throws(() => providerPlan({providerInstances: {}}, {...options(), codexBinary: undefined}), /Install Codex/);
});

function fakeClient(settings, {beforeWrite, brokenDriver} = {}) {
  const updates = [];
  let refreshed = false;
  return {updates, async request(tag, payload) {
    if (tag === 'server.getConfig') return {settings: structuredClone(settings), providers: []};
    if (tag === 'server.getSettings') {
      beforeWrite?.(settings);
      return structuredClone(settings);
    }
    if (tag === 'server.updateSettings') {
      const mutation = payload.providerInstanceMutation;
      assert.deepEqual(payload.patch, {});
      updates.push(mutation);
      if (mutation.operation === 'create') assert.equal(settings.providerInstances[mutation.instanceId], undefined);
      settings.providerInstances[mutation.instanceId] = structuredClone(mutation.instance);
      return structuredClone(settings);
    }
    if (tag === 'server.refreshProviders') {
      assert.deepEqual(payload, {fresh: true, refreshModels: true});
      refreshed = true;
      return {providers: Object.entries(settings.providerInstances).map(([instanceId, instance]) => ({
        instanceId, installed: instance.driver !== brokenDriver, enabled: instance.enabled, status: 'ready',
        models: (instance.config.customModels || []).map(m => ({slug: typeof m === 'string' ? m : m.slug})),
      }))};
    }
    throw Error('Unexpected RPC: ' + tag);
  }, get refreshed() { return refreshed; }};
}

test('T3 sync creates both providers, refreshes the catalog, preserves unrelated settings, and is idempotent', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-model-test-'));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const binary = path.join(home, '.local/share/t3-codex/node_modules/.bin/codex');
  fs.mkdirSync(path.dirname(binary), {recursive: true});
  fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', {mode: 0o700});
  const unrelated = {driver: 'codex', enabled: false, config: {homePath: '/other', customModels: ['keep']}};
  const settings = {providerModelPreferences: {anything: 'untouched'}, providerInstances: {unrelated}};
  const client = fakeClient(settings);
  await syncProviders(client, options(home));
  assert.equal(client.updates.length, 2);
  assert.ok(client.updates.every(m => m.operation === 'create'));
  assert.ok(client.refreshed);
  assert.deepEqual(settings.providerInstances.unrelated, unrelated);
  assert.deepEqual(settings.providerModelPreferences, {anything: 'untouched'});
  await syncProviders(client, options(home));
  assert.equal(client.updates.length, 2);
});

test('T3 sync retains settings edited after model discovery and reports a missing CLI', async () => {
  const settings = {providerInstances: {hub_codex: {driver: 'codex', enabled: true,
    config: {homePath: options().codexHome, customModels: []}}}};
  const client = fakeClient(settings, {beforeWrite: current => {
    current.providerInstances.hub_codex.displayName = 'Edited during setup';
    current.providerInstances.hub_codex.config.customModels = ['added-during-setup'];
  }, brokenDriver: 'codex'});
  await assert.rejects(syncProviders(client, {...options(), claudeHome: undefined, claudeBinary: undefined}), /needs attention/);
  assert.equal(settings.providerInstances.hub_codex.displayName, 'Edited during setup');
  assert.ok(settings.providerInstances.hub_codex.config.customModels.includes('added-during-setup'));
});

test('a disabled provider is not enabled by model sync', async () => {
  const settings = {providerInstances: {hub_codex: {driver: 'codex', enabled: false,
    config: {homePath: options().codexHome}}}};
  await syncProviders(fakeClient(settings), {...options(), claudeHome: undefined, claudeBinary: undefined});
  assert.equal(settings.providerInstances.hub_codex.enabled, false);
});
