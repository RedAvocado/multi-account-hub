'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('setup prompt copies the current one-time code and expires safely', async () => {
  const source = fs.readFileSync(require.resolve('./public/portal.js'), 'utf8').split("document.querySelector('#logout')")[0];
  const nodes = new Map();
  const element = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {textContent: '', hidden: true, disabled: false,
      addEventListener(_name, callback) { this.callback = callback; }, focus() { this.focused = true; }});
    return nodes.get(selector);
  };
  element('meta[name="hub-csrf"]').content = 'test-csrf';
  let code = 'A'.repeat(43), copied, expire, delay, rejectCopy = false;
  const context = {document: {querySelector: element}, location: {origin: 'https://hub.example.com'},
    navigator: {clipboard: {writeText: async text => {if (rejectCopy) throw Error('denied'); copied = text;}}},
    fetch: async () => ({ok: true, json: async () => ({code, expiresInSeconds: 7200})}),
    setTimeout: (callback, ms) => {expire = callback; delay = ms; return 1;}, clearTimeout() {}};
  vm.runInNewContext(source, context);
  await element('#setup').callback({currentTarget: element('#setup')});
  assert.equal(element('#result').hidden, false);
  assert.match(element('#setup-prompt').textContent, new RegExp(code));
  assert.match(element('#setup-prompt').textContent, /expires in two hours/);
  assert.match(element('#setup-prompt').textContent, /https:\/\/hub\.example\.com\/setup-provider-hub\.sh/);
  assert.match(element('#setup-prompt').textContent, /per-account usage automatically/);
  assert.match(element('#setup-prompt').textContent, /without consuming the setup code or replacing credentials/);
  assert.match(element('#setup-prompt').textContent, /HUB Codex skills to ~\/\.codex\/skills/);
  assert.match(element('#setup-prompt').textContent, /HUB Claude skills to ~\/\.claude\/skills/);
  assert.match(element('#setup-prompt').textContent, /repairs skills sharing/);
  assert.match(element('#setup-prompt').textContent, /syncs their coding models from the hub's current model catalog/);
  assert.match(element('#setup-prompt').textContent, /custom models, model preferences/);
  assert.equal(delay, 2 * 60 * 60 * 1000);
  await element('#copy-prompt').callback();
  assert.equal(copied, element('#setup-prompt').textContent);
  code = 'B'.repeat(43);
  await element('#setup').callback({currentTarget: element('#setup')});
  assert.match(element('#setup-prompt').textContent, new RegExp(code));
  assert.doesNotMatch(element('#setup-prompt').textContent, /A{43}/);
  rejectCopy = true;
  await element('#copy-prompt').callback();
  assert.match(element('#copy-status').textContent, /Select and copy/);
  assert.equal(element('#setup-prompt').focused, true);
  expire();
  assert.equal(element('#copy-prompt').disabled, true);
  assert.equal(element('#setup-prompt').textContent, '');
  assert.equal(element('#code').textContent, '');
});
