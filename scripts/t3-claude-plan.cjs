'use strict';

const REGION = ['//#region src/usage/', 'UsageLimitSources.ts'].join('');
const MARKER = Symbol.for('cliproxy-hub.claude-plan-labels');

// T3 0.1.1 hardcodes Claude Subscription. Enrich only that fallback through
// the same authorized hub, matching account IDs and emails before using a plan.
// Usage windows, reset credits and non-Claude accounts pass through unchanged.
async function enrichAccounts(config, accounts, fetchUsage = fetch) {
  if (!accounts.some(account => account.driver === 'claudeAgent' && account.plan === 'Claude Subscription')) return accounts;
  try {
    const base = new URL(config.url);
    if (!['http:', 'https:'].includes(base.protocol) || !/^\/usage\/?$/.test(base.pathname)) return accounts;
    const response = await fetchUsage(new URL('/v1/usage', base), {
      headers: {authorization: `Bearer ${config.managementKey}`},
      signal: AbortSignal.timeout(5000), redirect: 'error',
    });
    if (!response.ok) return accounts;
    const text = await response.text();
    if (text.length > 1024 * 1024) return accounts;
    const data = JSON.parse(text);
    if (!Array.isArray(data.accounts) || data.accounts.length > 1000) return accounts;
    const plans = new Map(data.accounts.filter(account => account.provider === 'claude' &&
      typeof account.plan === 'string' && account.plan.trim() && account.plan.length <= 60 &&
      !/[\x00-\x1f\x7f]/.test(account.plan)).map(account => [account.id, account]));
    return accounts.map(account => {
      const confirmed = plans.get(account.id);
      return account.driver === 'claudeAgent' && account.plan === 'Claude Subscription' && confirmed &&
        confirmed.email === account.email ? {...account, plan: `Claude ${confirmed.plan.trim()}`} : account;
    });
  } catch (_) { return accounts; }
}

function installAdapter(api, flatMapEffect, promiseEffect) {
  if (!api || typeof api.readAccounts !== 'function' || typeof flatMapEffect !== 'function' || typeof promiseEffect !== 'function') {
    throw new Error('Unsupported T3 hub adapter');
  }
  if (api[MARKER]) return {patched: true, changed: false};
  const original = api.readAccounts;
  api.readAccounts = config => original(config).pipe(flatMapEffect(accounts => promiseEffect(() => enrichAccounts(config, accounts))));
  Object.defineProperty(api, MARKER, {value: true});
  return {patched: true, changed: true};
}

function adapterLocation(source, startup = false) {
  const start = source.indexOf(REGION);
  if (start < 0) return null;
  const end = source.indexOf('//#endregion', start);
  if (end < 0) return null;
  const target = startup ? 'const settingsService = yield* ServerSettingsService;' :
    'const accounts = yield* api.readAccounts(config).pipe(result$1);';
  const offset = source.indexOf(target, start);
  if (offset < 0 || offset >= end) return null;
  const preceding = source.slice(0, offset);
  return {lineNumber: preceding.split('\n').length - 1, columnNumber: offset - preceding.lastIndexOf('\n') - 1};
}

// Break briefly at the existing adapter call, replace its readAccounts method,
// then immediately resume. No source rewriting, process restart or HTTP port.
function armAdapter(session, scriptId, location, {timeout = 65000} = {}) {
  return new Promise((resolve, reject) => {
    let breakpointId, settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      session.removeListener('Debugger.paused', paused);
      if (breakpointId) session.post('Debugger.removeBreakpoint', {breakpointId}, () => {});
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('T3 adapter did not refresh before the deadline')), timeout);
    const paused = event => {
      if (!event.params.hitBreakpoints?.includes(breakpointId)) return;
      const expression = `process.getBuiltinModule('module').createRequire(process.execPath)(${JSON.stringify(__filename)}).installAdapter(api, flatMap$3, promise)`;
      session.post('Debugger.evaluateOnCallFrame', {callFrameId: event.params.callFrames[0].callFrameId, expression, returnByValue: true}, (error, result) => {
        session.post('Debugger.resume', {}, resumeError => {
          if (error || resumeError || result?.exceptionDetails || result?.result?.value?.patched !== true) {
            finish(new Error(`T3 adapter installation failed: ${error?.message || resumeError?.message || result?.exceptionDetails?.exception?.description?.split('\n')[0] || 'unsupported adapter'}`));
          } else finish(null, result.result.value);
        });
      });
    };
    session.on('Debugger.paused', paused);
    session.post('Debugger.setBreakpoint', {location: {scriptId, ...location}}, (error, result) => {
      if (error) finish(error); else breakpointId = result.breakpointId;
    });
  });
}

function installStartup() {
  if (require('node:path').basename(process.execPath) !== 't3') return;
  const {Session} = require('node:inspector');
  const session = new Session();
  let armed = false, closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(deadline);
    session.post('Debugger.disable', {}, () => session.disconnect());
  };
  const deadline = setTimeout(close, 30000);
  deadline.unref();
  session.on('Debugger.scriptParsed', event => {
    if (armed || event.params.url !== require('node:url').pathToFileURL(process.execPath).href) return;
    armed = true;
    session.post('Debugger.getScriptSource', {scriptId: event.params.scriptId}, (error, result) => {
      const location = !error && adapterLocation(result.scriptSource, true);
      if (!location) { console.warn('[claude-hub-plans] Unsupported T3 adapter; default labels retained.'); close(); return; }
      armAdapter(session, event.params.scriptId, location, {timeout: 25000}).then(
        () => { console.warn('[claude-hub-plans] Subscription labels enabled.'); close(); },
        error => { console.warn(`[claude-hub-plans] ${error.message}; default labels retained.`); close(); },
      );
    });
  });
  session.connect();
  session.post('Debugger.enable', {}, error => { if (error) close(); });
}

module.exports = {enrichAccounts, installAdapter, adapterLocation, armAdapter, installStartup};
