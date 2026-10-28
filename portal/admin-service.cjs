'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');

class AdminError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function managementClient(authDir) {
  return (method, body) => new Promise((resolve, reject) => {
    let key;
    try { key = fs.readFileSync(path.join(authDir, 'management-key'), 'utf8').trim(); }
    catch (_) { return reject(new AdminError(503, 'Account management is temporarily unavailable.')); }
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = {authorization: `Bearer ${key}`, 'content-type': 'application/json'};
    if (payload) headers['content-length'] = payload.length;
    const req = http.request({host: '127.0.0.1', port: 8317, path: '/v0/management/plugins/key-router/config', method, headers}, reply => {
      const chunks = []; let size = 0;
      reply.on('data', chunk => {size += chunk.length; if (size > 1024 * 1024) reply.destroy(); else chunks.push(chunk);});
      reply.on('error', () => reject(new AdminError(503, 'Account management is temporarily unavailable.')));
      reply.on('end', () => {
        if (reply.statusCode !== 200) return reject(new AdminError(503, 'Account management is temporarily unavailable.'));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (_) { reject(new AdminError(503, 'Account management is temporarily unavailable.')); }
      });
    });
    req.setTimeout(10000, () => req.destroy());
    req.on('error', () => reject(new AdminError(503, 'Account management is temporarily unavailable.')));
    if (payload) req.write(payload);
    req.end();
  });
}

function createAdministration({directory, authDir, management = managementClient(authDir)}) {
  const usersFile = path.join(directory, 'gateway-users.json');
  const policiesFile = path.join(directory, 'account-ownership.json');
  let queue = Promise.resolve();
  const serialize = action => {
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result;
  };
  function readPolicies() {
    try {
      const data = JSON.parse(fs.readFileSync(policiesFile, 'utf8'));
      if (!data || data.version !== 1 || !data.accounts || Array.isArray(data.accounts) || typeof data.accounts !== 'object') throw new Error('invalid policies');
      for (const [id, entry] of Object.entries(data.accounts)) {
        if (path.basename(id) !== id || !entry || !/^[a-z][a-z0-9_-]{0,40}$/.test(entry.owner || '') ||
            !['personal','team','custom'].includes(entry.visibility)) throw new Error('invalid policy');
      }
      return data;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new AdminError(503, 'Account ownership settings are unavailable.');
    }
  }
  function writePolicies(policies) {
    const temporary = path.join(directory, `.account-ownership-${crypto.randomBytes(16).toString('hex')}.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify(policies, null, 2) + '\n', {mode:0o600,flag:'wx'});
      fs.renameSync(temporary, policiesFile);
    } finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
  function readAccounts() {
    const names = fs.readdirSync(authDir).filter(name => name.endsWith('.json'));
    if (names.length > 1000) throw new AdminError(503, 'Too many accounts to display.');
    const accounts = [];
    const policies = readPolicies();
    let labels = {};
    try {
      const data = JSON.parse(fs.readFileSync(path.join(directory, 'account-labels.json'), 'utf8'));
      if (data && typeof data === 'object' && !Array.isArray(data)) labels = data;
    } catch (_) { /* Display names are optional. */ }
    for (const id of names.sort()) {
      let record;
      try { record = JSON.parse(fs.readFileSync(path.join(authDir, id), 'utf8')); }
      catch (_) { throw new AdminError(503, 'An account record could not be read.'); }
      const provider = typeof record?.type === 'string' ? record.type.trim().toLowerCase() : '';
      const email = typeof record?.email === 'string' ? record.email.trim().toLowerCase() : '';
      if (!/^[a-z][a-z0-9_-]{0,40}$/.test(provider) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) continue;
      const organization = typeof record.organization_name === 'string' ? record.organization_name.trim().slice(0, 120) : '';
      const rawLabel = Object.hasOwn(labels, id) && typeof labels[id] === 'string' ? labels[id].trim() : '';
      const displayName = rawLabel.length <= 80 && !/[\x00-\x1f\x7f]/.test(rawLabel) ? rawLabel : '';
      // Before ownership records existed, administrators assigned every
      // account by hand. Keep that behavior until an ownership file exists.
      const policy = policies?.accounts[id] || (policies === null ? {owner:'',visibility:'custom'} : null);
      const owner = policy?.owner || '';
      const visibility = policy?.visibility || 'unmanaged';
      accounts.push({id, provider, email, organization, displayName, disabled: record.disabled === true,
        owner, visibility, personal: visibility === 'personal'});
    }
    return accounts;
  }
  function gatewayDocument() {
    const config = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
    if (!Array.isArray(config.users) || config.users.length > 1000) throw new AdminError(503, 'Access settings are unavailable.');
    return config;
  }
  function gatewayUsers() {
    const config = gatewayDocument();
    return config.users.map(user => ({name: user.name, email: user.email, enabled: user.enabled === true, role: user.role === 'admin' ? 'admin' : 'member', owner: user.owner === true}));
  }
  function validateConfig(config) {
    if (!config || config.enabled !== true || !Array.isArray(config.users)) throw new AdminError(503, 'Account routing is unavailable.');
    return config;
  }
  function selectedIds(user) {
    // The router can fall back to legacy `auths` when primary/access are
    // empty. Refuse edits until such rules are reviewed instead of allowing a
    // supposedly removed personal account to become accessible again.
    if (!Array.isArray(user.primary ?? []) || !Array.isArray(user.access ?? []) ||
        !Array.isArray(user.auths ?? []) || (user.auths ?? []).length) return null;
    const rules = [...(user.primary ?? []), ...(user.access ?? [])];
    if (rules.some(rule => typeof rule !== 'string' || !rule.startsWith('id='))) return null;
    return [...new Set(rules.map(rule => rule.slice(3)))];
  }
  function version(config, gateway) { return crypto.createHash('sha256').update(JSON.stringify([config.users, gateway])).digest('hex'); }

  async function snapshot() {
    const [config, accounts, gateway] = await Promise.all([management('GET'), Promise.resolve().then(readAccounts), Promise.resolve().then(gatewayUsers)]);
    validateConfig(config);
    const users = gateway.map(user => {
      const found = config.users.filter(candidate => candidate.name === user.name);
      if (found.length !== 1) throw new AdminError(503, 'Access settings are unavailable.');
      const selected = selectedIds(found[0]);
      const knownIds = new Set(accounts.map(account => account.id));
      const editable = selected !== null && selected.every(id => knownIds.has(id));
      return {...user, accounts: selected ?? [], editable};
    });
    return {version: version(config, gateway), accounts, users};
  }

  function setPermissions(input) {
    return serialize(async () => {
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
          Object.keys(input).sort().join(',') !== 'accounts,user,version' ||
          typeof input.user !== 'string' || !/^[a-z][a-z0-9_-]{0,40}$/.test(input.user) ||
          typeof input.version !== 'string' || !/^[a-f0-9]{64}$/.test(input.version) ||
          !Array.isArray(input.accounts) || input.accounts.length > 1000 ||
          input.accounts.some(id => typeof id !== 'string' || id.length > 255) || new Set(input.accounts).size !== input.accounts.length) {
        throw new AdminError(400, 'Invalid account selection.');
      }
      const [config, accounts, gateway] = await Promise.all([management('GET'), Promise.resolve().then(readAccounts), Promise.resolve().then(gatewayUsers)]);
      validateConfig(config);
      if (version(config, gateway) !== input.version) throw new AdminError(409, 'Access changed elsewhere. Refresh and try again.');
      const targets = gateway.filter(user => user.name === input.user);
      const configs = config.users.filter(user => user.name === input.user);
      if (targets.length !== 1 || configs.length !== 1) throw new AdminError(404, 'Team member not found.');
      const previous = selectedIds(configs[0]);
      if (previous === null || previous.some(id => !accounts.some(account => account.id === id))) {
        throw new AdminError(409, 'This member has an unrecognized account rule; use the administrator tool to review it.');
      }
      if (previous.some(id => {
        const account = accounts.find(candidate => candidate.id === id);
        return account?.personal && account.owner === targets[0].name && !account.disabled && !input.accounts.includes(id);
      })) throw new AdminError(403, 'A personal account remains available to its owner.');
      for (const id of input.accounts) {
        const account = accounts.find(candidate => candidate.id === id);
        if (!account) throw new AdminError(400, 'An account is no longer available.');
        if (account.disabled && !previous.includes(id)) throw new AdminError(400, 'A disabled account cannot be newly assigned.');
        if (account.personal && account.owner !== targets[0].name) {
          throw new AdminError(403, 'This personal account is reserved for its owner.');
        }
        if (account.visibility === 'unmanaged' && !previous.includes(id)) throw new AdminError(403, 'Account ownership must be established before granting access.');
      }
      configs[0].primary = input.accounts.map(id => 'id=' + id);
      configs[0].access = [];
      await management('PATCH', {users: config.users});
      return {ok: true};
    });
  }
  function setEnabled(input, actor) {
    return serialize(async () => {
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
          Object.keys(input).sort().join(',') !== 'enabled,user,version' ||
          typeof input.user !== 'string' || !/^[a-z][a-z0-9_-]{0,40}$/.test(input.user) ||
          typeof input.version !== 'string' || !/^[a-f0-9]{64}$/.test(input.version) || typeof input.enabled !== 'boolean') {
        throw new AdminError(400, 'Invalid access setting.');
      }
      const config = validateConfig(await management('GET'));
      const document = gatewayDocument();
      const gateway = gatewayUsers();
      if (version(config, gateway) !== input.version) throw new AdminError(409, 'Access changed elsewhere. Refresh and try again.');
      const users = document.users.filter(user => user.name === input.user);
      const configs = config.users.filter(user => user.name === input.user);
      if (users.length !== 1 || configs.length !== 1) throw new AdminError(404, 'Team member not found.');
      if (users[0].owner === true && !input.enabled) throw new AdminError(400, 'The hub owner cannot be disabled here.');
      if (actor && users[0].name === actor.name && !input.enabled) throw new AdminError(400, 'You cannot disable your own access here.');
      const selected = selectedIds(configs[0]);
      if (input.enabled && (!selected || selected.length === 0)) throw new AdminError(400, 'Assign at least one account before restoring access.');
      users[0].enabled = input.enabled;
      const temporary = path.join(directory, `.gateway-admin-${crypto.randomBytes(16).toString('hex')}.tmp`);
      try {
        fs.writeFileSync(temporary, JSON.stringify(document, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
        fs.renameSync(temporary, usersFile);
      } finally {
        try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      return {ok: true};
    });
  }
  function mine(identity) {
    return snapshot().then(data => {
      let health={};
      try {
        const file=path.join(directory,'monitor-state.json');
        if(fs.statSync(file).size<=1024*1024) {
          const state=JSON.parse(fs.readFileSync(file,'utf8'));
          if(state?.version===1 && state.accounts && typeof state.accounts==='object')health=state.accounts;
        }
      } catch (_) { /* Monitoring is optional and must not block account settings. */ }
      return {version:data.version,accounts:data.accounts.filter(account=>account.owner===identity.name && !account.disabled)
        .map(account=>({...account,needsAttention:health[crypto.createHash('sha256').update(account.id).digest('hex')]?.incident===true}))};
    });
  }

  async function changeVisibility(identity, id, visibility, requiredVersion) {
    const [config, accounts, gateway] = await Promise.all([management('GET'), Promise.resolve().then(readAccounts), Promise.resolve().then(gatewayUsers)]);
    validateConfig(config);
    if (requiredVersion && version(config, gateway) !== requiredVersion) throw new AdminError(409, 'Access changed elsewhere. Refresh and try again.');
    const actor = gateway.filter(user => user.name === identity.name && user.email?.toLowerCase() === identity.email.toLowerCase() && user.enabled);
    const account = accounts.find(item => item.id === id);
    if (actor.length !== 1 || !account || account.owner !== identity.name || account.disabled) throw new AdminError(403, 'Only the account owner can change sharing.');
    if (!['personal','team'].includes(visibility)) throw new AdminError(400, 'Choose personal or team sharing.');
    const policies = readPolicies();
    if (!policies || !policies.accounts[id] || policies.accounts[id].owner !== identity.name) throw new AdminError(503, 'Account ownership is unavailable.');
    const previous = structuredClone(policies);
    const knownUsers = new Set(gateway.map(user => user.name));
    if (config.users.length !== knownUsers.size || config.users.some(user => !knownUsers.has(user.name) || selectedIds(user) === null) ||
        [...knownUsers].some(name => config.users.filter(user => user.name === name).length !== 1)) {
      throw new AdminError(409, 'Account routing needs administrator review.');
    }
    const rule = 'id=' + id;
    const previousRouting = new Map(config.users.map(user => [user.name, selectedIds(user).includes(id)]));
    for (const user of config.users) {
      user.primary = (user.primary ?? []).filter(item => item !== rule);
      user.access = (user.access ?? []).filter(item => item !== rule);
      if (user.name === identity.name || visibility === 'team') user.primary.push(rule);
    }
    policies.accounts[id].visibility = visibility;
    if (visibility === 'team') {
      writePolicies(policies);
      try { await management('PATCH', {users:config.users}); }
      catch (_) {
        // A lost response does not mean PATCH failed: reverting the policy to
        // personal while the router has shared it would misstate its privacy.
        try {
          const current = validateConfig(await management('GET'));
          if (current.users.length === knownUsers.size && current.users.every(user => knownUsers.has(user.name)) &&
              [...knownUsers].every(name => current.users.filter(user => user.name === name).length === 1)) {
            const routes = current.users.map(user => ({name:user.name,ids:selectedIds(user)}));
            if (routes.every(user => user.ids !== null)) {
              if (routes.every(user => user.ids.includes(id))) return {ok:true};
              const previousWasPersonal = previous.accounts[id].visibility === 'personal';
              const personalIsOwnerOnly = routes.every(user => user.name === identity.name || !user.ids.includes(id));
              if ((!previousWasPersonal || personalIsOwnerOnly) &&
                  routes.every(user => user.ids.includes(id) === previousRouting.get(user.name))) writePolicies(previous);
            }
          }
        } catch (_) { /* Leave the chosen team policy visible if routing is uncertain. */ }
        throw new AdminError(503, 'The sharing update could not be confirmed. Refresh your accounts to check its current setting.');
      }
    } else {
      await management('PATCH', {users:config.users});
      writePolicies(policies);
    }
    return {ok:true};
  }
  function setVisibility(identity, input) {
    return serialize(async () => {
      if (!input || Object.keys(input).sort().join(',') !== 'id,version,visibility' ||
          typeof input.id !== 'string' || path.basename(input.id) !== input.id ||
          !/^[a-f0-9]{64}$/.test(input.version || '')) throw new AdminError(400, 'Invalid sharing setting.');
      return changeVisibility(identity, input.id, input.visibility, input.version);
    });
  }

  function sameProviderAccount(a, b) {
    if (a.type !== b.type) return false;
    if (a.type === 'codex' && a.account_id && b.account_id) return a.account_id === b.account_id;
    if (a.type === 'claude' && a.account_uuid && b.account_uuid) {
      if (a.account_uuid !== b.account_uuid) return false;
      return !(a.organization_uuid && b.organization_uuid) || a.organization_uuid === b.organization_uuid;
    }
    return String(a.email || '').toLowerCase() === String(b.email || '').toLowerCase(); // Legacy credentials: conservative fallback.
  }
  function claimAccount(identity, record, visibility) {
    return serialize(async () => {
      if (!record || !['claude','codex'].includes(record.type) || typeof record.email !== 'string' ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(record.email) || record.email.length > 254 ||
          typeof record.access_token !== 'string' || !record.access_token || typeof record.refresh_token !== 'string' || !record.refresh_token ||
          !['personal','team'].includes(visibility)) throw new AdminError(400, 'The provider did not return a usable account.');
      const policies = readPolicies();
      if (!policies) throw new AdminError(503, 'Account ownership is unavailable.');
      const [config, accounts, gateway] = await Promise.all([management('GET'),Promise.resolve().then(readAccounts),Promise.resolve().then(gatewayUsers)]);
      validateConfig(config);
      if (gateway.filter(user => user.name === identity.name && user.email?.toLowerCase() === identity.email.toLowerCase() && user.enabled).length !== 1) throw new AdminError(403, 'Your hub access is disabled.');
      const matches = [];
      for (const account of accounts) {
        if (account.provider !== record.type) continue;
        const saved = JSON.parse(fs.readFileSync(path.join(authDir, account.id), 'utf8'));
        if (sameProviderAccount(saved, record)) matches.push(account);
      }
      if (matches.some(account => account.owner !== identity.name)) throw new AdminError(409, 'This provider account is already connected by another person.');
      const active = matches.filter(account => !account.disabled);
      if (active.length > 1) throw new AdminError(409, 'This account has multiple existing connections; ask the administrator to review them.');
      const id = active[0]?.id || `hub-${record.type}-${crypto.randomBytes(16).toString('hex')}.json`;
      const target = path.join(authDir,id);
      const temporary = path.join(authDir, `.hub-credential-${crypto.randomBytes(16).toString('hex')}.tmp`);
      try {
        const savedRecord = {...record,disabled:false};
        fs.writeFileSync(temporary,JSON.stringify(savedRecord)+'\n',{mode:0o600,flag:'wx'});
        if (active.length) fs.renameSync(temporary,target);
        else { fs.linkSync(temporary,target); fs.unlinkSync(temporary); }
      } finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
      if (!active.length) { policies.accounts[id] = {owner:identity.name,visibility:'personal'}; writePolicies(policies); }
      try { await changeVisibility(identity,id,visibility); }
      catch (_) { return {id,email:record.email,assigned:false}; }
      return {id,email:record.email,assigned:true};
    });
  }
  return {snapshot, setPermissions, setEnabled, mine, setVisibility, claimAccount};
}

module.exports = {AdminError, createAdministration};
