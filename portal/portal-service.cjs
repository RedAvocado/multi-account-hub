'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {AdminError} = require('./admin-service.cjs');
const {ConnectError} = require('./claude-connect-service.cjs');
const {consumeLoginLink} = require('./login-link-service.cjs');

const BROWSER_COOKIE = '__Host-ddhub_oauth';
const SESSION_COOKIE = '__Host-ddhub_session';
const TEN_MINUTES = 10 * 60 * 1000;
const SESSION_LIFETIME = 7 * 24 * 60 * 60 * 1000;
const CODE_LIFETIME = 2 * 60 * 60 * 1000;
const MAX_ENTRIES = 1024;
const token = () => crypto.randomBytes(32).toString('base64url');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const equals = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function cookies(req) {
  const found = Object.create(null);
  for (const part of (req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    if (Object.hasOwn(found, name)) return Object.create(null);
    found[name] = part.slice(index + 1).trim();
  }
  return found;
}

function browserCookie(name, value, seconds) {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`;
}

function createPortal({directory, origin, callbackOrigin = origin, callbackPath = '/oauth/callback', workspaceDomain, oauth, admin, usage, claudeConnect, providerConnect, devices, notifyDevice, now = Date.now}) {
  if (typeof workspaceDomain !== 'string' || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(workspaceDomain)) throw new Error('A workspace domain is required');
  const flows = new Map();
  const relays = new Map();
  const sessions = new Map();
  const codes = new Map();
  const bindingsFile = path.join(directory, 'google-bindings.json');
  const usersFile = path.join(directory, 'gateway-users.json');
  const staticDir = path.join(__dirname, 'public');
  const sessionsDir = path.join(directory, 'portal-sessions');
  const codesDir = path.join(directory, 'portal-setup-codes');

  // Persist only hashes of browser session tokens; cookies remain the sole
  // bearer credential. A restart must not invalidate otherwise valid sessions.
  fs.mkdirSync(sessionsDir, {recursive: true, mode: 0o700});
  const sessionDirStat = fs.lstatSync(sessionsDir);
  if (!sessionDirStat.isDirectory() || (sessionDirStat.mode & 0o077)) throw new Error('Invalid session directory');
  for (const file of fs.readdirSync(sessionsDir)) {
    if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
    const target = path.join(sessionsDir, file);
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 4096) continue;
      const value = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (!value || typeof value.email !== 'string' || value.email.length > 254 ||
          !/^[a-z][a-z0-9_-]{0,40}$/.test(value.name || '') ||
          !(typeof value.subject === 'string' && /^[A-Za-z0-9_-]{1,255}$/.test(value.subject) ||
            value.authMethod === 'login-link' && value.subject === null) ||
          !/^[A-Za-z0-9_-]{43}$/.test(value.csrf || '') || !Number.isSafeInteger(value.expires)) continue;
      if (value.expires <= now()) { try { fs.unlinkSync(target); } catch (_) {} continue; }
      if (value.expires > now() + SESSION_LIFETIME || sessions.size >= MAX_ENTRIES) continue;
      sessions.set(file.slice(0, -5), value);
    } catch (_) { /* An unreadable session fails closed. */ }
  }

  // Setup codes are stored only by their hashes and remain bound to the
  // originating session, including across portal restarts.
  fs.mkdirSync(codesDir, {recursive: true, mode: 0o700});
  const codeDirStat = fs.lstatSync(codesDir);
  if (!codeDirStat.isDirectory() || (codeDirStat.mode & 0o077)) throw new Error('Invalid setup-code directory');
  for (const file of fs.readdirSync(codesDir)) {
    if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
    const target = path.join(codesDir, file);
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 4096) continue;
      const value = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (!value || typeof value.email !== 'string' || value.email.length > 254 ||
          !/^[a-z][a-z0-9_-]{0,40}$/.test(value.name || '') ||
          !/^[a-f0-9]{64}$/.test(value.sessionId || '') || !Number.isSafeInteger(value.expires)) continue;
      if (value.expires <= now()) { try { fs.unlinkSync(target); } catch (_) {} continue; }
      const owner = sessions.get(value.sessionId);
      if (!owner || owner.email !== value.email || owner.name !== value.name ||
          value.expires > now() + CODE_LIFETIME || codes.size >= MAX_ENTRIES) continue;
      codes.set(file.slice(0, -5), value);
    } catch (_) { /* An unreadable code fails closed. */ }
  }

  function removeSession(id) {
    try { fs.unlinkSync(path.join(sessionsDir, `${id}.json`)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    sessions.delete(id);
  }

  function removeCode(id) {
    try { fs.unlinkSync(path.join(codesDir, `${id}.json`)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    codes.delete(id);
  }

  function cleanup() {
    const current = now();
    for (const map of [flows, relays]) {
      for (const [key, value] of map) if (value.expires <= current) map.delete(key);
    }
    for (const [id, value] of codes) if (value.expires <= current) {
      try { removeCode(id); } catch (_) { codes.delete(id); }
    }
    for (const [id, value] of sessions) if (value.expires <= current) {
      try { removeSession(id); } catch (_) { sessions.delete(id); }
    }
  }

  function users() {
    const data = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
    if (!Array.isArray(data.users) || data.users.length > 1000) throw new Error('invalid users');
    return data.users;
  }

  function allowedUser(email) {
    if (typeof email !== 'string') return null;
    const matches = users().filter(user => user.enabled === true &&
      typeof user.email === 'string' && user.email.toLowerCase() === email.toLowerCase());
    if (matches.length !== 1) return null;
    const user = matches[0];
    if (!/^[a-z][a-z0-9_-]{0,40}$/.test(user.name || '') || !/^[a-f0-9]{64}$/.test(user.keyHash || '')) return null;
    return user;
  }

  function bindIdentity(identity) {
    if (!identity || typeof identity.email !== 'string' || identity.email_verified !== true ||
        typeof identity.hd !== 'string' || !identity.hd.trim() ||
        typeof identity.sub !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(identity.sub)) return null;
    const email = identity.email.toLowerCase();
    if (!email.endsWith('@' + workspaceDomain)) return null;
    const user = allowedUser(email);
    if (!user) return null;
    let bindings = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(bindingsFile, 'utf8'));
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('invalid bindings');
      bindings = parsed;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (Object.hasOwn(bindings, email) && bindings[email] !== identity.sub) return null;
    if (Object.entries(bindings).some(([otherEmail, subject]) => otherEmail !== email && subject === identity.sub)) return null;
    if (!Object.hasOwn(bindings, email)) {
      bindings[email] = identity.sub;
      const temporary = path.join(directory, `.google-bindings-${token()}.tmp`);
      try {
        fs.writeFileSync(temporary, JSON.stringify(bindings, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
        fs.renameSync(temporary, bindingsFile);
      } finally {
        try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    return {email, name: user.name, subject: identity.sub};
  }

  function sessionUser(value) {
    if (!value || value.expires <= now()) return null;
    const user = allowedUser(value.email);
    if (!user || user.name !== value.name) return null;
    try {
      const bindings = JSON.parse(fs.readFileSync(bindingsFile, 'utf8'));
      if (!bindings || Array.isArray(bindings) || typeof bindings !== 'object') return null;
      const subject = Object.hasOwn(bindings, value.email) ? bindings[value.email] : null;
      if (value.subject === null && value.authMethod !== 'login-link' || subject !== value.subject) return null;
    } catch (_) { return null; }
    return user;
  }

  function session(req) {
    cleanup();
    const raw = cookies(req)[SESSION_COOKIE];
    if (!/^[A-Za-z0-9_-]{43}$/.test(raw || '')) return null;
    const id = hash(raw);
    const value = sessions.get(id);
    if (!value) return null;
    const user = sessionUser(value);
    if (!user) return null;
    return {id, ...value, isAdmin: user.role === 'admin'};
  }

  function headers(res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader('X-Frame-Options', 'DENY');
  }

  function respond(res, status, body, type = 'text/plain; charset=utf-8') {
    res.writeHead(status, {'Content-Type': type});
    res.end(body);
  }
  function json(res, status, body) { respond(res, status, JSON.stringify(body), 'application/json; charset=utf-8'); }
  function redirect(res, destination) { res.writeHead(303, {Location: destination}); res.end(); }
  function shell(title, body, scripts = '') {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${title}</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/portal.css">${scripts}</head><body>${body}</body></html>`;
  }
  function brand() {
    return '<a class="brand" href="/"><img src="/dittodub-white.svg" alt="DittoDub" width="104" height="15"><span>Multi-Account Hub</span></a>';
  }
  function page(current, message = '') {
    if (!current) {
      return shell('Multi-Account Hub', `<main class="welcome"><section class="card hero">${brand()}<h1>Every Claude and Codex account, one hub.</h1><p>Sign in with your ${escapeHtml(workspaceDomain)} Google account to see usage, connect a computer, or add an account.</p><a class="button" href="/sign-in">Sign in with Google</a>${message ? `<p class="error">${escapeHtml(message)}</p>` : ''}</section></main>`);
    }
    const admin = current.isAdmin ? `<section class="card" id="admin"><h2>Team access</h2><p class="lead">Choose which shared accounts each person can use. Personal accounts stay with their owners.</p><div id="admin-list"><p class="muted">Loading access settings…</p></div><p id="admin-status" class="status" role="status"></p></section><section class="card" id="admin-devices"><div class="card-heading"><div><h2>Computers</h2><p class="lead">Registered computers and the address each was last seen from.</p></div><button id="devices-refresh" type="button" class="secondary small">Refresh</button></div><div id="devices-list"><p class="muted">Loading computers…</p></div><p class="note">The hub computer may also use a direct local connection, which is not listed. Addresses can change and are never used as an access rule.</p><p id="devices-status" class="status" role="status"></p></section>` : '';
    return shell('Multi-Account Hub', `<header class="topbar">${brand()}<div class="session"><p>Signed in as <strong>${escapeHtml(current.email)}</strong></p><button id="logout" type="button" class="secondary small">Sign out</button></div></header><main>`
      + `<section class="card" id="usage"><div class="card-heading"><div><h2>Usage</h2><p class="lead">Accounts you can use. Updated when you refresh, at most every 30 seconds.</p></div><button id="usage-refresh" type="button" class="secondary small">Refresh</button></div><div id="usage-list" aria-live="polite"><p class="muted">Loading usage…</p></div></section>`
      + `<section class="card setup-section"><h2>Connect a computer</h2><p class="lead">Create a setup prompt, then paste it into the coding assistant on the computer where you use T3 Code.</p><button id="setup" type="button">Create setup prompt</button><div id="result" hidden><p class="note">This prompt contains a private one-time code. It expires in two hours.</p><pre id="setup-prompt" tabindex="0"></pre><div class="actions"><button id="copy-prompt" type="button">Copy prompt</button><p id="copy-status" class="status" role="status"></p></div><details><summary>Set up in Terminal instead</summary><p>Your one-time setup code:</p><code id="code"></code><p>Run this, then paste the code when asked:</p><pre>setup_dir="$(mktemp -d)" &amp;&amp; curl -fsS ${escapeHtml(origin)}/setup-provider-hub.sh -o "$setup_dir/setup.sh" &amp;&amp; bash "$setup_dir/setup.sh"</pre><p class="note">The script saves a private connection on this computer and explains how to add HUB Codex and HUB Claude to T3 Code.</p></details></div><p id="error" role="alert"></p></section>`
      + `<section class="card" id="provider-connect"><h2>Connect an account</h2><p class="lead">Add your own Claude or Codex account and choose who can use it.</p><form id="provider-start-form"><div class="fields"><div><label for="provider-type">Provider</label><select id="provider-type"><option value="codex">Codex</option><option value="claude">Claude</option></select></div><div><label for="provider-visibility">Sharing</label><select id="provider-visibility"><option value="personal">Personal: only me</option><option value="team">Shared with the team</option></select></div></div><p class="note">Personal accounts are only ever used for you, even by administrators. You can change this later.</p><button type="submit">Connect account</button></form><div id="provider-flow" hidden><p id="provider-instructions"></p><a id="provider-link" class="button" href="#" target="_blank" rel="noopener noreferrer">Open provider sign-in</a><div id="provider-device" hidden><p>Enter this code on the provider sign-in page:</p><code id="provider-code"></code><p class="note">Come back here after you approve it.</p></div><div id="provider-callback-wrap" hidden><p>After approving, your browser may say it cannot connect to localhost. Copy the whole address from the address bar and paste it here.</p><form id="provider-callback-form" autocomplete="off"><label for="provider-callback">Claude callback address</label><input id="provider-callback" type="text" spellcheck="false" autocomplete="off" placeholder="http://localhost:54545/callback?…" required><div class="actions"><button type="submit">Complete sign-in</button></div></form><p class="note">Paste it only here. It contains a short-lived sign-in code.</p></div><button id="provider-cancel" type="button" class="secondary">Cancel</button></div><p id="provider-status" class="status" role="status"></p><h3 class="subheading">Your accounts</h3><div id="owned-accounts"><p class="muted">Loading your accounts…</p></div><p id="owned-status" class="status" role="status"></p></section>`
      + `${admin}</main><meta name="hub-user" content="${escapeHtml(current.name)}"><meta name="hub-csrf" content="${escapeHtml(current.csrf)}"><script src="/portal.js" defer></script>`);
  }

  async function readJson(req) {
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 4096) throw new Error('too large');
      chunks.push(chunk);
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('invalid body');
    return parsed;
  }

  function establishSession(res, user) {
    if (sessions.size >= MAX_ENTRIES) return false;
    const rawSession = token();
    const sessionId = hash(rawSession), sessionValue = {...user, csrf: token(), expires: now() + SESSION_LIFETIME};
    fs.writeFileSync(path.join(sessionsDir, `${sessionId}.json`), JSON.stringify(sessionValue) + '\n', {mode: 0o600, flag: 'wx'});
    sessions.set(sessionId, sessionValue);
    res.setHeader('Set-Cookie', [browserCookie(BROWSER_COOKIE, '', 0), browserCookie(SESSION_COOKIE, rawSession, SESSION_LIFETIME / 1000)]);
    return true;
  }

  async function finishLogin(req, res, state, code) {
    const binding = cookies(req)[BROWSER_COOKIE];
    const flow = /^[A-Za-z0-9_-]{43}$/.test(state || '') ? flows.get(hash(state)) : null;
    if (!flow || !/^[A-Za-z0-9_-]{43}$/.test(binding || '') || !equals(flow.binding, hash(binding))) {
      return respond(res, 401, page(null, 'Sign-in could not be completed. Please try again.'), 'text/html; charset=utf-8');
    }
    flows.delete(hash(state));
    res.setHeader('Set-Cookie', browserCookie(BROWSER_COOKIE, '', 0));
    const identity = await oauth.exchange({code, verifier: flow.verifier});
    if (!equals(identity?.nonce, flow.nonce)) return respond(res, 401, page(null, 'Sign-in could not be verified.'), 'text/html; charset=utf-8');
    const user = bindIdentity(identity);
    if (!user) return respond(res, 403, page(null, 'This Google account is not enabled for the hub.'), 'text/html; charset=utf-8');
    if (!establishSession(res, user)) return respond(res, 503, 'Sign-in is busy. Please try again.');
    return redirect(res, '/');
  }

  const server = http.createServer(async (req, res) => {
    headers(res);
    try {
      if (!req.url.startsWith('/') || req.url.startsWith('//')) return respond(res, 400, 'Invalid request');
      const url = new URL(req.url, origin);
      if (url.origin !== origin) return respond(res, 400, 'Invalid request');
      const host = req.headers.host;
      const isPortalHost = host === new URL(origin).host;
      const isCallbackHost = host === new URL(callbackOrigin).host;
      const isCallback = req.method === 'GET' && url.pathname === callbackPath &&
        (callbackPath !== '/' || url.searchParams.has('state') || url.searchParams.has('code') || url.searchParams.has('error'));
      if (!isPortalHost && !(isCallbackHost && isCallback)) {
        if (isCallbackHost && req.method === 'GET' && (url.pathname === '/' || url.pathname === '/sign-in')) return redirect(res, origin + '/');
        return respond(res, 400, 'Invalid request');
      }
      cleanup();
      if (req.method === 'GET' && url.pathname === '/login-link' && !url.search) {
        return respond(res, 200, shell('Sign in · Multi-Account Hub', `<main class="welcome"><section class="card hero">${brand()}<h1>Your private sign-in link</h1><p>Continue to sign in as the member this link was made for. It works once and expires two hours after it was created.</p><button id="continue-login" type="button">Continue</button><p id="link-status" class="status" role="status"></p><p class="note"><a href="/sign-in">Sign in with Google instead</a></p></section></main>`, '<script src="/login-link.js" defer></script>'), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname === '/login-link.js' && !url.search) {
        return respond(res, 200, fs.readFileSync(path.join(staticDir, 'login-link.js')), 'text/javascript; charset=utf-8');
      }
      if (req.method === 'POST' && url.pathname === '/portal/login-link' && !url.search) {
        if (req.headers.origin !== origin || !(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return json(res, 403, {error: 'Invalid sign-in request.'});
        if (sessions.size >= MAX_ENTRIES) return json(res, 503, {error: 'Sign-in is busy. Please try again.'});
        try {
          const input = await readJson(req);
          if (Object.keys(input).join(',') !== 'token') return json(res, 400, {error: 'Invalid sign-in request.'});
          const user = consumeLoginLink({directory, token: input.token, now: now()});
          if (!establishSession(res, user)) return json(res, 503, {error: 'Sign-in is busy. Please try again.'});
          return json(res, 200, {ok: true});
        } catch (_) { return json(res, 401, {error: 'This sign-in link is no longer valid.'}); }
      }
      if (req.method === 'GET' && url.pathname === '/portal.css' && !url.search) {
        return respond(res, 200, fs.readFileSync(path.join(staticDir, 'portal.css')), 'text/css; charset=utf-8');
      }
      if (req.method === 'GET' && ['/dittodub-white.svg', '/favicon.svg'].includes(url.pathname) && !url.search) {
        res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return respond(res, 200, fs.readFileSync(path.join(staticDir, url.pathname.slice(1))), 'image/svg+xml');
      }
      if (req.method === 'GET' && url.pathname === '/portal.js' && !url.search) {
        return respond(res, 200, fs.readFileSync(path.join(staticDir, 'portal.js')), 'text/javascript; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname === '/' && !url.search) {
        return respond(res, 200, page(session(req)), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname === '/sign-in' && !url.search) {
        if (flows.size >= MAX_ENTRIES) return respond(res, 503, 'Sign-in is busy. Please try again.');
        const state = token(), binding = token(), nonce = token(), verifier = token();
        const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
        const destination = oauth.authorizationUrl({state, nonce, challenge});
        flows.set(hash(state), {binding: hash(binding), nonce, verifier, expires: now() + TEN_MINUTES});
        res.setHeader('Set-Cookie', browserCookie(BROWSER_COOKIE, binding, TEN_MINUTES / 1000));
        return redirect(res, destination);
      }
      if (isCallback) {
        if (!isCallbackHost) return respond(res, 404, 'Not found');
        const state = url.searchParams.get('state');
        const flow = /^[A-Za-z0-9_-]{43}$/.test(state || '') ? flows.get(hash(state)) : null;
        if (!flow || url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length !== 1 ||
            !url.searchParams.get('code') || url.searchParams.get('code').length > 4096 || url.searchParams.has('error')) {
          return respond(res, 401, page(null, 'Sign-in could not be completed. Please try again.'), 'text/html; charset=utf-8');
        }
        if (callbackOrigin === origin) return await finishLogin(req, res, state, url.searchParams.get('code'));
        if (relays.size >= MAX_ENTRIES) return respond(res, 503, 'Sign-in is busy. Please try again.');
        const relay = token();
        relays.set(hash(relay), {state, code: url.searchParams.get('code'), expires: now() + 90000});
        return redirect(res, `${origin}/oauth/complete?relay=${relay}`);
      }
      if (req.method === 'GET' && url.pathname === '/oauth/complete' && isPortalHost) {
        const relay = url.searchParams.get('relay');
        const id = /^[A-Za-z0-9_-]{43}$/.test(relay || '') ? hash(relay) : null;
        const pending = id ? relays.get(id) : null;
        if (pending) relays.delete(id);
        if (!pending || url.searchParams.getAll('relay').length !== 1) return respond(res, 401, page(null, 'Sign-in expired. Please try again.'), 'text/html; charset=utf-8');
        return await finishLogin(req, res, pending.state, pending.code);
      }
      if (req.method === 'GET' && url.pathname === '/portal/usage' && (!url.search || url.search === '?refresh=1')) {
        const current = session(req);
        if (!current) return json(res, 403, {error: 'Sign in again to see usage.'});
        if (!usage) return json(res, 503, {error: 'Usage is temporarily unavailable.'});
        try {
          const data = await usage.getForUser(current, {refresh: url.search === '?refresh=1'});
          const stillCurrent = session(req);
          if (!stillCurrent || stillCurrent.id !== current.id) return json(res, 403, {error: 'Sign in again to see usage.'});
          return json(res, 200, data);
        } catch (_) { return json(res, 503, {error: 'Usage is temporarily unavailable.'}); }
      }
      if (req.method === 'POST' && ['/portal/providers/start','/portal/providers/complete','/portal/providers/cancel','/portal/providers/status'].includes(url.pathname) && !url.search) {
        const current=session(req);
        if (!current || req.headers.origin!==origin || !equals(req.headers['x-hub-csrf'],current.csrf)) return json(res,403,{error:'Sign in again.'});
        if (!providerConnect) return json(res,503,{error:'Provider sign-in is temporarily unavailable.'});
        try {
          let result;
          if (url.pathname==='/portal/providers/status') result=await providerConnect.status(current);
          else if (url.pathname==='/portal/providers/cancel') {await providerConnect.cancel(current);result={status:'idle'};}
          else {
            if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return json(res,400,{error:'Invalid request.'});
            const input=await readJson(req);
            result=await (url.pathname==='/portal/providers/start'?providerConnect.start(current,input):providerConnect.submit(current,input));
          }
          const stillCurrent=session(req);
          if (!stillCurrent || stillCurrent.id!==current.id) {void providerConnect.cancel(current);return json(res,403,{error:'Sign in again.'});}
          return json(res,200,result);
        } catch(error) {
          return error instanceof ConnectError || error instanceof AdminError ? json(res,error.status,{error:error.message}) : json(res,503,{error:'Provider sign-in is temporarily unavailable.'});
        }
      }
      if (((req.method==='GET' && url.pathname==='/portal/accounts/mine') || (req.method==='POST' && url.pathname==='/portal/accounts/sharing')) && !url.search) {
        const current=session(req);
        if (!current) return json(res,403,{error:'Sign in again.'});
        if (!admin) return json(res,503,{error:'Account settings are temporarily unavailable.'});
        if (req.method==='POST' && (req.headers.origin!==origin || !equals(req.headers['x-hub-csrf'],current.csrf))) return json(res,403,{error:'Sign in again.'});
        try {
          if (req.method==='GET') {
            const data=await admin.mine(current);
            if (!session(req)) return json(res,403,{error:'Sign in again.'});
            return json(res,200,data);
          }
          if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return json(res,400,{error:'Invalid request.'});
          return json(res,200,await admin.setVisibility(current,await readJson(req)));
        } catch(error) {return error instanceof AdminError?json(res,error.status,{error:error.message}):json(res,503,{error:'Account settings are temporarily unavailable.'});}
      }
      if (req.method === 'POST' && ['/portal/claude/start','/portal/claude/complete','/portal/claude/cancel','/portal/claude/status'].includes(url.pathname) && !url.search) {
        const current = session(req);
        if (!current || !current.isAdmin) return json(res, 403, {error:'Administrator access is required.'});
        if (!claudeConnect) return json(res, 503, {error:'Claude sign-in is temporarily unavailable.'});
        if (req.method === 'POST' && (req.headers.origin !== origin || !equals(req.headers['x-hub-csrf'], current.csrf))) return json(res, 403, {error:'Sign in again.'});
        try {
          let result;
          if (url.pathname === '/portal/claude/status') result = await claudeConnect.status(current);
          else if (url.pathname === '/portal/claude/start') result = await claudeConnect.start(current);
          else if (url.pathname === '/portal/claude/cancel') { await claudeConnect.cancel(current); result = {status:'idle'}; }
          else {
            if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return json(res, 400, {error:'Invalid request.'});
            result = await claudeConnect.submit(current, await readJson(req));
          }
          const stillCurrent = session(req);
          if (!stillCurrent || stillCurrent.id !== current.id) { void claudeConnect.cancel(current); return json(res, 403, {error:'Sign in again.'}); }
          return json(res, 200, result);
        } catch (error) {
          return error instanceof ConnectError ? json(res,error.status,{error:error.message}) : json(res,503,{error:'Claude sign-in is temporarily unavailable.'});
        }
      }
      if (((req.method === 'GET' && url.pathname === '/portal/admin/devices') ||
          (req.method === 'POST' && url.pathname === '/portal/admin/devices/revoke')) && !url.search) {
        const current = session(req);
        if (!current || !current.isAdmin) return json(res,403,{error:'Administrator access is required.'});
        if (!devices) return json(res,503,{error:'Computer details are temporarily unavailable.'});
        if (req.method === 'POST' && (req.headers.origin !== origin || !equals(req.headers['x-hub-csrf'], current.csrf))) return json(res,403,{error:'Sign in again.'});
        try {
          if (req.method === 'GET') return json(res,200,{devices:devices.list()});
          if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return json(res,400,{error:'Invalid request.'});
          const input=await readJson(req);
          if (Object.keys(input).join(',')!=='id'||!/^[a-f0-9]{64}$/.test(input.id || '')) return json(res,400,{error:'Invalid computer.'});
          devices.revoke(input.id); return json(res,200,{ok:true});
        } catch (_) {return json(res,503,{error:'Computer details are temporarily unavailable.'});}
      }
      if ((req.method === 'GET' || req.method === 'POST') && (url.pathname === '/portal/admin' || url.pathname === '/portal/admin/access') && !url.search) {
        const current = session(req);
        if (!current || !current.isAdmin) return json(res, 403, {error: 'Administrator access is required.'});
        if (!admin) return json(res, 503, {error: 'Account management is temporarily unavailable.'});
        if (req.method === 'POST' && (req.headers.origin !== origin || !equals(req.headers['x-hub-csrf'], current.csrf))) return json(res, 403, {error: 'Sign in again.'});
        try {
          if (req.method === 'GET' && url.pathname === '/portal/admin') return json(res, 200, await admin.snapshot());
          if (req.method !== 'POST') return json(res, 404, {error: 'Not found.'});
          if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return json(res, 400, {error: 'Invalid request.'});
          const input = await readJson(req);
          return json(res, 200, await (url.pathname === '/portal/admin' ? admin.setPermissions(input) : admin.setEnabled(input, current)));
        } catch (error) {
          return error instanceof AdminError ? json(res, error.status, {error: error.message}) : json(res, 503, {error: 'Account management is temporarily unavailable.'});
        }
      }
      if (req.method === 'POST' && url.pathname === '/portal/setup-code' && !url.search) {
        const current = session(req);
        if (!current || req.headers.origin !== origin || !equals(req.headers['x-hub-csrf'], current.csrf)) return json(res, 403, {error: 'Sign in again.'});
        if (codes.size >= MAX_ENTRIES) return json(res, 503, {error: 'Please try again shortly.'});
        for (const [id, code] of codes) if (code.sessionId === current.id) removeCode(id);
        const code = token();
        const codeId = hash(code), codeValue = {email: current.email, name: current.name, sessionId: current.id, expires: now() + CODE_LIFETIME};
        fs.writeFileSync(path.join(codesDir, `${codeId}.json`), JSON.stringify(codeValue) + '\n', {mode: 0o600, flag: 'wx'});
        codes.set(codeId, codeValue);
        return json(res, 200, {code, expiresInSeconds: CODE_LIFETIME / 1000});
      }
      if (req.method === 'POST' && url.pathname === '/portal/logout' && !url.search) {
        const current = session(req);
        if (!current || req.headers.origin !== origin || !equals(req.headers['x-hub-csrf'], current.csrf)) return json(res, 403, {error: 'Sign in again.'});
        removeSession(current.id);
        if (claudeConnect) void claudeConnect.cancel(current);
        if (providerConnect) void providerConnect.cancel(current);
        for (const [id, code] of codes) if (code.sessionId === current.id) {
          try { removeCode(id); } catch (_) { codes.delete(id); }
        }
        res.setHeader('Set-Cookie', browserCookie(SESSION_COOKIE, '', 0));
        return json(res, 200, {ok: true});
      }
      if (req.method === 'POST' && url.pathname === '/portal/redeem' && !url.search) {
        if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return json(res, 400, {error: 'Invalid request.'});
        const input = await readJson(req);
        if (Object.keys(input).some(key=>!['code','deviceName','platform'].includes(key)) || !/^[A-Za-z0-9_-]{43}$/.test(input.code || '') ||
            (input.deviceName !== undefined && (typeof input.deviceName !== 'string' || input.deviceName.length > 80 || /[\x00-\x1f\x7f]/.test(input.deviceName))) ||
            (input.platform !== undefined && (typeof input.platform !== 'string' || input.platform.length > 40 || /[\x00-\x1f\x7f]/.test(input.platform)))) return json(res, 400, {error: 'Invalid setup code.'});
        const id = hash(input.code), issued = codes.get(id);
        if (issued) removeCode(id);
        if (!issued || !sessions.has(issued.sessionId)) return json(res, 401, {error: 'Setup code expired. Create a new one.'});
        const user = allowedUser(issued.email);
        if (!user || user.name !== issued.name || !sessionUser(sessions.get(issued.sessionId))) return json(res, 403, {error: 'Access is disabled.'});
        const internalKey = fs.readFileSync(path.join(directory, 'team-keys', `${user.name}.key`), 'utf8').trim();
        if (!/^[A-Za-z0-9_-]{40,128}$/.test(internalKey) || !equals(hash(internalKey), user.keyHash)) return json(res, 503, {error: 'Setup is temporarily unavailable.'});
        const key = token();
        const deviceDir = path.join(directory, 'devices');
        fs.mkdirSync(deviceDir, {recursive: true, mode: 0o700});
        const record = {name: user.name, email: issued.email, enabled: true, createdAt: new Date(now()).toISOString(),
          deviceName:(input.deviceName || '').trim(),platform:(input.platform || '').trim()};
        const deviceId=hash(key);
        fs.writeFileSync(path.join(deviceDir, `${deviceId}.json`), JSON.stringify(record) + '\n', {mode: 0o600, flag: 'wx'});
        devices?.note(deviceId, req.headers['x-hub-client-ip'] || '', 'device');
        try {notifyDevice?.({id:deviceId,device:record,ip:req.headers['x-hub-client-ip'] || ''});} catch (_) { /* The monitor retries from the device inventory. */ }
        return json(res, 200, {key});
      }
      return respond(res, 404, 'Not found');
    } catch (_) {
      if (!res.headersSent) return json(res, 500, {error: 'Sign-in is temporarily unavailable.'});
      res.end();
    }
  });
  server.headersTimeout = 15000;
  server.requestTimeout = 30000;
  return server;
}

module.exports = {createPortal};
