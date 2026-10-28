'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createAdministration} = require('./admin-service.cjs');

test('admin controls preserve user boundaries and reject stale or unsafe assignments', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-admin-test-'));
  const authDir = path.join(directory, 'auth'); fs.mkdirSync(authDir);
  const files = {
    'codex-work.json': {type: 'codex', email: 'work@example.com', access_token: 'SYNTHETIC_PROVIDER_SECRET'},
    'codex-private.json': {type: 'codex', email: 'owner-private@example.net', access_token: 'SYNTHETIC_PRIVATE_SECRET'},
    'claude-work.json': {type: 'claude', email: 'work@example.com', access_token: 'SYNTHETIC_CLAUDE_SECRET'},
    'claude-disabled.json': {type: 'claude', email: 'old@example.com', disabled: true},
  };
  for (const [name, record] of Object.entries(files)) fs.writeFileSync(path.join(authDir, name), JSON.stringify(record));
  fs.writeFileSync(path.join(directory, 'account-ownership.json'), JSON.stringify({version: 1, accounts: {
    'codex-private.json': {owner: 'riley', visibility: 'personal'}, 'codex-work.json': {owner: 'riley', visibility: 'custom'},
    'claude-work.json': {owner: 'riley', visibility: 'custom'}, 'claude-disabled.json': {owner: 'riley', visibility: 'custom'}}}));
  fs.writeFileSync(path.join(directory, 'account-labels.json'), JSON.stringify({'claude-work.json':'Team Claude','codex-work.json':'invalid\nlabel'}));
  const gateway = {users: [{name: 'riley', email: 'riley@example.org', keyHash: 'INTERNAL_SECRET', enabled: true, role: 'admin', owner: true},
    {name: 'jordan', email: 'jordan@example.org', keyHash: 'OTHER_SECRET', enabled: true}]};
  fs.writeFileSync(path.join(directory, 'gateway-users.json'), JSON.stringify(gateway));
  let config = {enabled: true, users: [{name: 'riley', 'api-keys': ['ADMIN_SECRET'], primary: ['id=codex-private.json'], access: []},
    {name: 'jordan', 'api-keys': ['TEAM_SECRET'], primary: ['id=codex-work.json'], access: []}]};
  const management = async (method, body) => {
    if (method === 'PATCH') config = {...config, ...structuredClone(body)};
    return structuredClone(config);
  };
  const admin = createAdministration({directory, authDir, management});
  try {
    let snapshot = await admin.snapshot();
    assert.equal(snapshot.accounts.length, 4);
    assert.equal(snapshot.accounts.find(account => account.id === 'claude-work.json').displayName, 'Team Claude');
    assert.equal(snapshot.accounts.find(account => account.id === 'codex-work.json').displayName, '');
    assert.ok(!JSON.stringify(snapshot).includes('SECRET'));
    const input = (accounts, version = snapshot.version) => ({user: 'jordan', accounts, version});
    await assert.rejects(admin.setPermissions(input(['codex-private.json'])), error => error.status === 403);
    await assert.rejects(admin.setPermissions(input(['claude-disabled.json'])), error => error.status === 400);
    await assert.rejects(admin.setPermissions(input(['unknown.json'])), error => error.status === 400);
    await assert.rejects(admin.setPermissions(input(['codex-work.json'], 'f'.repeat(64))), error => error.status === 409);
    await admin.setPermissions(input(['codex-work.json', 'claude-work.json']));
    assert.deepEqual(config.users[1].primary, ['id=codex-work.json', 'id=claude-work.json']);
    assert.deepEqual(config.users[0].primary, ['id=codex-private.json']);
    assert.deepEqual(config.users[1]['api-keys'], ['TEAM_SECRET']);
    await assert.rejects(admin.setEnabled({user: 'jordan', enabled: false, version: snapshot.version}), error => error.status === 409);
    snapshot = await admin.snapshot();
    await assert.rejects(admin.setEnabled({user: 'riley', enabled: false, version: snapshot.version}), error => error.status === 400);
    await assert.rejects(admin.setEnabled({user: 'jordan', enabled: false, version: snapshot.version}, {name:'jordan'}), error => error.status === 400);
    await admin.setEnabled({user: 'jordan', enabled: false, version: snapshot.version});
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'gateway-users.json'))).users[1].enabled, false);
    snapshot = await admin.snapshot();
    await admin.setEnabled({user: 'jordan', enabled: true, version: snapshot.version});
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'gateway-users.json'))).users[1].enabled, true);
    snapshot = await admin.snapshot();
    await admin.setPermissions(input([], snapshot.version));
    snapshot = await admin.snapshot();
    await assert.rejects(admin.setEnabled({user: 'jordan', enabled: true, version: snapshot.version}), error => error.status === 400);
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});
