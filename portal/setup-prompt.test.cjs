'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const portalSource = fs.readFileSync(require.resolve('./public/portal.js'), 'utf8');
// The install guide is declared at the end of portal.js.
const guideSource = portalSource.slice(portalSource.indexOf('function t3SetupGuide('));

test('setup prompt copies the current one-time code and expires safely', async () => {
  const source = portalSource.split("document.querySelector('#logout')")[0];
  const nodes = new Map();
  const element = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {textContent: '', hidden: true, disabled: false,
      addEventListener(_name, callback) { this.callback = callback; }, focus() { this.focused = true; }});
    return nodes.get(selector);
  };
  element('meta[name="hub-csrf"]').content = 'test-csrf';
  let code = 'A'.repeat(43), copied, expire, delay, rejectCopy = false;
  const context = vm.createContext({document: {querySelector: element}, location: {origin: 'https://hub.example.com'},
    navigator: {clipboard: {writeText: async text => {if (rejectCopy) throw Error('denied'); copied = text;}}},
    fetch: async () => ({ok: true, json: async () => ({code, expiresInSeconds: 7200})}),
    setTimeout: (callback, ms) => {expire = callback; delay = ms; return 1;}, clearTimeout() {}});
  vm.runInContext(guideSource, context);
  vm.runInContext(source, context);
  await element('#setup').callback({currentTarget: element('#setup')});
  assert.equal(element('#result').hidden, false);
  assert.equal(element('#copy-install-prompt').disabled, false);
  assert.match(element('#setup-prompt').textContent, new RegExp(code));
  assert.match(element('#setup-prompt').textContent, /expires in two hours/);
  assert.match(element('#setup-prompt').textContent, /https:\/\/hub\.example\.com\/setup-provider-hub\.sh/);
  assert.match(element('#setup-prompt').textContent, /per-account usage automatically/);
  assert.match(element('#setup-prompt').textContent, /without consuming the setup code or replacing credentials/);
  assert.match(element('#setup-prompt').textContent, /HUB Codex config\.toml, skills, plugins, and AGENTS\.md to ~\/\.codex/);
  assert.match(element('#setup-prompt').textContent, /HUB Claude skills to ~\/\.claude\/skills/);
  assert.match(element('#setup-prompt').textContent, /repairs environment sharing/);
  assert.match(element('#setup-prompt').textContent, /syncs their coding models from the hub's current model catalog/);
  assert.match(element('#setup-prompt').textContent, /custom models, model preferences/);
  assert.equal(delay, 2 * 60 * 60 * 1000);
  await element('#copy-prompt').callback();
  assert.equal(copied, element('#setup-prompt').textContent);
  const standard = copied;

  await element('#copy-install-prompt').callback();
  assert.notEqual(copied, standard);
  assert.match(copied, /^Please set up T3 Code and the DittoDub Provider HUB/);
  assert.equal(copied.split(code).length, 2, 'the code appears exactly once');
  assert.match(copied, /curl -fsS https:\/\/hub\.example\.com\/setup-provider-hub\.sh -o/);
  assert.match(copied, /curl -fsS https:\/\/hub\.example\.com\/setup-hub-usage\.cjs -o/);
  assert.match(copied, /signed-in browser session at https:\/\/hub\.example\.com\//);
  assert.doesNotMatch(copied, /devpigs|\$\{/);
  assert.match(copied, /share the same folders natively through links, not by copying files/);
  assert.match(copied, /## 6\. Share every MCP server, skill, and plugin through the same folders/);
  assert.match(copied, /config\.toml \(which holds every \[mcp_servers\] entry\)/);
  for (const name of ['skills', 'agents', 'commands', 'plugins', 'CLAUDE\\.md', 'settings\\.json']) {
    assert.match(copied, new RegExp(`~/\\.dittodub-provider-hub/claude/${name} -> ~/\\.claude/${name}`));
  }
  assert.match(copied, /Never link or copy auth\.json, \.credentials\.json, \.claude\.json/);
  assert.match(copied, /Reply with exactly: HUB Codex OK/);
  assert.match(copied, /Reply with exactly: HUB Claude OK/);
  assert.match(copied, /node "\$setup_dir\/finish-hub\.cjs" "\$setup_dir\/setup-hub-usage\.cjs" "\$t3_cli"/);
  assert.match(element('#copy-status').textContent, /installation instructions/);
  // Copying the install guide leaves the displayed standard prompt in place.
  assert.equal(element('#setup-prompt').textContent, standard);

  code = 'B'.repeat(43);
  await element('#setup').callback({currentTarget: element('#setup')});
  assert.match(element('#setup-prompt').textContent, new RegExp(code));
  assert.doesNotMatch(element('#setup-prompt').textContent, /A{43}/);
  await element('#copy-install-prompt').callback();
  assert.match(copied, /B{43}/);
  assert.doesNotMatch(copied, /A{43}/);
  rejectCopy = true;
  await element('#copy-install-prompt').callback();
  assert.match(element('#copy-status').textContent, /Select and copy/);
  assert.match(element('#setup-prompt').textContent, /^Please set up T3 Code/);
  await element('#copy-prompt').callback();
  assert.match(element('#setup-prompt').textContent, /^Please connect this computer/);
  assert.equal(element('#setup-prompt').focused, true);
  expire();
  assert.equal(element('#copy-prompt').disabled, true);
  assert.equal(element('#copy-install-prompt').disabled, true);
  assert.equal(element('#setup-prompt').textContent, '');
  assert.equal(element('#code').textContent, '');
  rejectCopy = false;
  copied = undefined;
  await element('#copy-install-prompt').callback();
  assert.equal(copied, undefined, 'an expired code is never copied');
});

test('the install guide carries a compatibility adapter that parses as CommonJS', () => {
  const context = vm.createContext({});
  vm.runInContext(guideSource, context);
  const guide = context.t3SetupGuide('https://hub.example.com', 'C'.repeat(43));
  const adapter = /Save this block as finish-hub\.cjs[\s\S]*?```js\n([\s\S]*?)```/.exec(guide)[1];
  assert.match(adapter, /^'use strict';/);
  assert.match(adapter, /client\.request\('server\.getConfig'\)/);
  assert.doesNotMatch(adapter, /C{43}/, 'the adapter contains no credentials');
  // Compile without running it, as Node would wrap a CommonJS module.
  assert.doesNotThrow(() => new vm.Script(`(function (exports, require, module, __filename, __dirname) {${adapter}\n})`));
});
