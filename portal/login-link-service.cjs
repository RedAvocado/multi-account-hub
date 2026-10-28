'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const LIFETIME = 2 * 60 * 60 * 1000;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function identity(directory, email) {
  const document = JSON.parse(fs.readFileSync(path.join(directory, 'gateway-users.json'), 'utf8'));
  if (!Array.isArray(document.users) || document.users.length > 1000) throw new Error('Access unavailable');
  const matches = document.users.filter(user => user.enabled === true && typeof user.email === 'string' && user.email.toLowerCase() === email);
  if (matches.length !== 1 || !/^[a-z][a-z0-9_-]{0,40}$/.test(matches[0].name || '') ||
      !/^[a-f0-9]{64}$/.test(matches[0].keyHash || '')) throw new Error('Access unavailable');
  const bindings = JSON.parse(fs.readFileSync(path.join(directory, 'google-bindings.json'), 'utf8'));
  if (!bindings || Array.isArray(bindings) || typeof bindings !== 'object') throw new Error('Identity unavailable');
  const subject = Object.hasOwn(bindings, email) ? bindings[email] : null;
  if (subject !== null && (typeof subject !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(subject))) throw new Error('Identity unavailable');
  return {email, name: matches[0].name, subject, keyHash: matches[0].keyHash};
}

function linkDirectory(directory, create = false) {
  const target = path.join(directory, 'portal-login-links');
  if (create) fs.mkdirSync(target, {recursive: true, mode: 0o700});
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.mode & 0o077 || stat.uid !== process.getuid()) throw new Error('Private link storage unavailable');
  return target;
}

// Issuance is available only to a local operator; no web route exposes it.
function issueLoginLink({directory, email, workspaceDomain, now = Date.now()}) {
  if (typeof workspaceDomain !== 'string' || !workspaceDomain) throw new Error('Workspace domain required');
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(email) || !email.toLowerCase().endsWith('@' + workspaceDomain)) throw new Error('Invalid member');
  const member = identity(directory, email.toLowerCase());
  const folder = linkDirectory(directory, true);
  const raw = crypto.randomBytes(32).toString('base64url');
  const expires = now + LIFETIME;
  fs.writeFileSync(path.join(folder, `${hash(raw)}.json`), JSON.stringify({version: 1, ...member, createdAt: now, expires}) + '\n', {mode: 0o600, flag: 'wx'});
  return {token: raw, expires, email: member.email};
}

function consumeLoginLink({directory, token, now = Date.now()}) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid link');
  const target = path.join(linkDirectory(directory), `${hash(token)}.json`);
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.mode & 0o077 || stat.uid !== process.getuid() || stat.size > 4096) throw new Error('Invalid link');
  const record = JSON.parse(fs.readFileSync(target, 'utf8'));
  if (record?.version !== 1 || typeof record.email !== 'string' ||
      !Number.isSafeInteger(record.createdAt) || !Number.isSafeInteger(record.expires) ||
      record.createdAt > now || record.expires <= now || record.expires !== record.createdAt + LIFETIME) throw new Error('Expired link');
  const current = identity(directory, record.email);
  if (current.name !== record.name || current.subject !== record.subject || current.keyHash !== record.keyHash) throw new Error('Identity changed');
  // Unlink before creating a session. Only one concurrent caller can succeed,
  // including across portal processes or restarts.
  fs.unlinkSync(target);
  return {email: current.email, name: current.name, subject: current.subject, authMethod: 'login-link'};
}

module.exports = {issueLoginLink, consumeLoginLink};
