'use strict';
const csrf = document.querySelector('meta[name="hub-csrf"]').content;
async function post(path, body) {
  const headers = {'X-Hub-CSRF': csrf};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, {method: 'POST', headers, credentials: 'same-origin',
    ...(body !== undefined ? {body: JSON.stringify(body)} : {})});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Please try again.');
  return data;
}
let setupExpiry, setupPrompts;
document.querySelector('#setup').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  document.querySelector('#error').textContent = '';
  try {
    const result = await post('/portal/setup-code');
    document.querySelector('#code').textContent = result.code;
    setupPrompts = {standard: `Please connect this computer to our Multi-Account Hub for T3 Code.

My private one-time setup code is: ${result.code}
It expires in two hours and can be used once. Keep the code and resulting credentials private; do not print or share them.

Keep T3 Code running and ensure Node.js 22 or later is available. Ensure Codex and Claude are installed through T3 Code or their normal installers. Download ${location.origin}/setup-provider-hub.sh to a private temporary directory and run it with the setup code supplied on standard input. The script registers HUB Codex and HUB Claude, syncs their coding models from the hub's current model catalog, and configures per-account usage automatically. Verify both enabled providers are ready and their models appear in T3 Code; report any missing CLI or authentication problem. It links HUB Codex config.toml, skills, plugins, and AGENTS.md to ~/.codex on this computer, and HUB Claude skills to ~/.claude/skills, so common configuration, MCP registrations, plugins, instructions, and future additions stay shared. Keep HUB authentication and runtime state separate. Explicit non-secret T3 startup overrides keep Codex routed through HUB while preserving PERSONAL defaults. If this computer is already connected, it migrates and repairs environment sharing, syncs models, and updates usage without consuming the setup code or replacing credentials. Preserve existing credentials, custom models, model preferences, and custom files. If migration reports custom HUB settings or conflicting links, preserve and resolve them explicitly before rerunning; never silently hide them. If setup fails, report the error; rerunning the same script can finish skills, model, and usage setup without a new code once credentials are saved. After setup, use a fresh provider process/conversation to load changes. A provider catalog refresh does not guarantee an existing cached process reloads its environment; do not restart T3 or active conversations automatically. Rerun setup when new hub models become available.`,
      install: t3SetupGuide(location.origin, result.code)};
    document.querySelector('#setup-prompt').textContent = setupPrompts.standard;
    document.querySelector('#result').hidden = false;
    document.querySelector('#copy-prompt').disabled = false;
    document.querySelector('#copy-install-prompt').disabled = false;
    document.querySelector('#copy-status').textContent = '';
    button.textContent = 'Create a new prompt';
    button.className = 'secondary';
    clearTimeout(setupExpiry);
    setupExpiry = setTimeout(() => {
      setupPrompts = undefined;
      document.querySelector('#copy-prompt').disabled = true;
      document.querySelector('#copy-install-prompt').disabled = true;
      document.querySelector('#copy-status').textContent = 'This prompt has expired. Create a new prompt to connect a computer.';
      document.querySelector('#setup-prompt').textContent = '';
      document.querySelector('#code').textContent = '';
    }, result.expiresInSeconds * 1000);
  } catch (error) { document.querySelector('#error').textContent = error.message; }
  finally { button.disabled = false; }
});
async function copySetupPrompt(kind, copied) {
  if (!setupPrompts) return;
  const prompt = document.querySelector('#setup-prompt');
  const status = document.querySelector('#copy-status');
  try {
    await navigator.clipboard.writeText(setupPrompts[kind]);
    status.textContent = copied;
  } catch (_) {
    // Show the requested prompt so it can be selected by hand.
    prompt.textContent = setupPrompts[kind];
    status.textContent = 'Could not copy automatically. Select and copy the prompt below.';
    prompt.focus();
  }
}
document.querySelector('#copy-prompt').addEventListener('click', () =>
  copySetupPrompt('standard', 'Copied. Paste the prompt into your coding assistant.'));
document.querySelector('#copy-install-prompt').addEventListener('click', () =>
  copySetupPrompt('install', 'Copied with T3 Code installation instructions. Paste it into the coding assistant on the new computer.'));
document.querySelector('#logout').addEventListener('click', async event => {
  event.currentTarget.disabled = true;
  try { await post('/portal/logout'); location.assign('/'); }
  catch (error) { document.querySelector('#error').textContent = error.message; event.currentTarget.disabled = false; }
});

const usageList = document.querySelector('#usage-list');
const refreshUsage = document.querySelector('#usage-refresh');
if (usageList && refreshUsage) {
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const date = value => {
    const parsed = new Date(value);
    return Number.isNaN(parsed.valueOf()) ? '' : new Intl.DateTimeFormat(undefined,
      {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}).format(parsed);
  };
  // Grants expire at midnight UTC; show that calendar date rather than the
  // previous evening in the viewer's time zone.
  const day = value => {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.valueOf())) return '';
    const midnight = parsed.getUTCHours() === 0 && parsed.getUTCMinutes() === 0 && parsed.getUTCSeconds() === 0;
    return new Intl.DateTimeFormat(undefined, {year: 'numeric', month: 'short', day: 'numeric',
      ...(midnight ? {timeZone: 'UTC'} : {})}).format(parsed);
  };
  const number = value => new Intl.NumberFormat(undefined, {maximumFractionDigits: 0}).format(value);
  const grantNames = {promotional_credit: 'promotional'};
  // Credits keep an account usable after its plan quota; the hub spends them
  // only once every plan in the provider section is used up.
  function creditsBlock(account) {
    const credits = account.credits;
    if (!credits) return null;
    const hasBalance = credits.unlimited || (typeof credits.balance === 'number' && credits.balance > 0);
    if (!hasBalance && !credits.grants?.length) {
      return account.provider === 'claude' && credits.extraUsage === false
        ? element('p', 'No usage credits · extra usage off', 'usage-credits-empty') : null;
    }
    const block = element('div', undefined, 'usage-credits');
    const head = element('div', undefined, 'usage-credits-head');
    head.append(element('span', 'Credits', 'usage-period'));
    const money = account.provider === 'claude' && credits.currency;
    const value = credits.unlimited ? 'Unlimited' : money
      ? new Intl.NumberFormat(undefined, {style: 'currency', currency: credits.currency}).format(credits.balance)
      : `${number(credits.balance)} left`;
    head.append(element('strong', value, 'usage-credits-balance'));
    head.append(element('span', credits.usable ? 'Fallback ready' : 'Unavailable', `usage-credits-state${credits.usable ? '' : ' off'}`));
    block.append(head);
    for (const grant of credits.grants || []) {
      const kind = grantNames[grant.type] || (grant.type ? grant.type.replace(/_/g, ' ') : 'credit');
      const granted = typeof grant.granted === 'number' ? ` of ${number(grant.granted)} ${kind}` : ` ${kind}`;
      const line = element('p', undefined, 'usage-credits-grant');
      line.append(element('span', `${number(grant.remaining)}${granted}`));
      if (day(grant.expiresAt)) line.append(element('span', `Credits expire ${day(grant.expiresAt)}`, 'usage-credits-expiry'));
      block.append(line);
    }
    return block;
  }
  function creditSummary(accounts) {
    const usable = accounts.filter(account => account.credits?.usable && account.provider !== 'claude');
    if (!usable.length) return null;
    const total = usable.reduce((sum, account) => sum + (account.credits.balance || 0), 0);
    const expiries = usable.flatMap(account => (account.credits.grants || []).map(grant => grant.expiresAt)).filter(day).sort();
    const text = `${usable.some(account => account.credits.unlimited) ? 'Unlimited' : number(total)} credits across ${usable.length} ` +
      `${usable.length === 1 ? 'account' : 'accounts'}${expiries.length ? ` · first expiry ${day(expiries[0])}` : ''}. ` +
      'Used only after every plan here is used up.';
    return element('p', text, 'provider-credits');
  }
  function accountCard(account) {
    const card = element('article', undefined, 'usage-card');
    const identity = element('div', undefined, 'usage-identity');
    identity.append(element('h4', account.displayName || account.email));
    if (account.displayName) identity.append(element('p', account.email, 'usage-email'));
    const details = element('div', undefined, 'usage-details');
    if (account.plan) details.append(element('span', account.plan.replace(/\b\w/g, c => c.toUpperCase()), 'plan-pill'));
    const defaultOrganization = `${account.email}'s organization`;
    if (account.organization && account.organization.toLowerCase() !== defaultOrganization.toLowerCase()) details.append(element('span', account.organization));
    identity.append(details);
    card.append(identity);
    const metrics = element('div', undefined, 'usage-metrics');
    for (const item of account.windows) {
      const row = element('div', undefined, 'usage-row');
      row.append(element('span', item.label, 'usage-period'));
      const bar = element('div', undefined, 'usage-bar');
      const fill = element('span', undefined, item.remaining <= 10 ? 'low' : item.remaining <= 30 ? 'medium' : 'good');
      fill.style.width = `${item.remaining}%`;
      bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-label', `${item.label} remaining`);
      bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100');
      bar.setAttribute('aria-valuenow', String(item.remaining));
      bar.append(fill);
      row.append(bar, element('strong', `${item.remaining}%`, `usage-percent ${fill.className}`));
      if (item.resetsAt && date(item.resetsAt)) row.append(element('span', `Resets ${date(item.resetsAt)}`, 'usage-reset'));
      metrics.append(row);
    }
    if (!account.windows.length) metrics.append(element('p', 'Usage is currently unavailable.', 'usage-unavailable'));
    const meta = element('div', undefined, 'usage-meta');
    if (account.renewsAt && date(account.renewsAt)) meta.append(element('span', `Renews ${date(account.renewsAt)}`));
    if (account.bankedResets !== null) meta.append(element('span', `${account.bankedResets} banked ${account.bankedResets === 1 ? 'reset' : 'resets'}`));
    for (const expiry of account.resetExpirations) if (date(expiry)) meta.append(element('span', `Reset expires ${date(expiry)}`));
    if (meta.childNodes.length) metrics.append(meta);
    const credits = creditsBlock(account);
    if (credits) metrics.append(credits);
    if (account.checkedAt && date(account.checkedAt)) {
      metrics.append(element('p', `${account.stale ? 'Update unavailable · Last checked' : 'Checked'} ${date(account.checkedAt)}`, 'usage-checked'));
    }
    card.append(metrics);
    const rates = element('div', undefined, 'usage-burn');
    const burn = account.burnRates;
    const basisNames = {'1w': 'Weekly', '1mo': 'Monthly', '5h': '5-hour'};
    rates.append(element('p', `${basisNames[burn?.basis] || 'Quota'} burn`, 'usage-burn-heading'));
    const values = element('div', undefined, 'usage-burn-values');
    const duration = seconds => seconds >= 3600 ? `${(seconds / 3600).toFixed(1)}h` : `${Math.floor(seconds / 60)}m`;
    for (const [key, label, average] of [['tenMinutes', '10 min', '30m average'], ['hour', 'Hour', '1h average'], ['day', 'Day', '24h average']]) {
      const entry = burn?.[key];
      const value = entry?.percent;
      const available = !burn?.stale && typeof value === 'number' && Number.isFinite(value) && value >= 0;
      const column = element('div', undefined, 'usage-burn-column');
      column.append(element('span', label, 'usage-burn-label'));
      column.append(element('strong', available ? `${value > 0 ? '−' : ''}${value.toFixed(value > 0 && value < 1 ? 2 : 1)}%` : '—', 'usage-burn-value'));
      const partial = entry && entry.observedSeconds < entry.windowSeconds * 0.95;
      column.append(element('span', available && partial ? `${duration(entry.observedSeconds)} observed` : average, 'usage-burn-average'));
      column.title = available ? `${basisNames[burn.basis]} quota percentage points burned per ${label.toLowerCase()}; ${duration(entry.observedSeconds)} observed in the last ${duration(entry.windowSeconds)}. Refills and gaps are excluded.` :
        burn?.stale ? 'Waiting for a fresh usage observation.' : 'Collecting usage history; rates appear after five minutes of observations.';
      values.append(column);
    }
    rates.append(values);
    card.append(rates);
    return card;
  }
  async function loadUsage(refresh = false) {
    refreshUsage.disabled = true;
    try {
      const response = await fetch(`/portal/usage${refresh ? '?refresh=1' : ''}`, {credentials: 'same-origin', cache: 'no-store'});
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Usage is temporarily unavailable.');
      usageList.replaceChildren();
      const providers = [['codex', 'Codex'], ['claude', 'Claude']];
      for (const provider of [...new Set(data.accounts.map(account => account.provider))]) {
        if (!providers.some(([id]) => id === provider)) providers.push([provider, provider]);
      }
      for (const [id, name] of providers) {
        const accounts = data.accounts.filter(account => account.provider === id);
        const section = element('section', undefined, 'provider-usage');
        const heading = element('div', undefined, 'provider-heading');
        heading.append(element('h3', name), element('span', String(accounts.length), 'provider-count'));
        section.append(heading);
        const summary = creditSummary(accounts);
        if (summary) section.append(summary);
        if (!accounts.length) section.append(element('p', `No ${name} accounts available yet.`, 'provider-empty'));
        else for (const account of accounts) section.append(accountCard(account));
        usageList.append(section);
      }
    } catch (error) { usageList.replaceChildren(element('p', error.message, 'error')); }
    finally { refreshUsage.disabled = false; }
  }
  refreshUsage.addEventListener('click', () => loadUsage(true));
  document.addEventListener('hub:accounts-changed', () => loadUsage(true));
  loadUsage();
  setInterval(() => { if (!document.hidden) loadUsage(); }, 60 * 1000);
}

const providerForm = document.querySelector('#provider-start-form');
if (providerForm) {
  const providerPanel = document.querySelector('#provider-flow');
  const providerStatus = document.querySelector('#provider-status');
  const providerLink = document.querySelector('#provider-link');
  const providerDevice = document.querySelector('#provider-device');
  const callbackWrap = document.querySelector('#provider-callback-wrap');
  const callbackForm = document.querySelector('#provider-callback-form');
  const callbackField = document.querySelector('#provider-callback');
  let providerTimer, previousStatus = 'idle';
  function showProvider(data) {
    clearTimeout(providerTimer);
    const active = ['starting','waiting','exchanging','finishing'].includes(data.status);
    providerForm.hidden = active;
    providerPanel.hidden = data.status !== 'waiting';
    if (data.status === 'waiting') {
      providerLink.href = data.url;
      providerLink.textContent = data.provider === 'codex' ? 'Open Codex sign-in' : 'Open Claude sign-in';
      document.querySelector('#provider-instructions').textContent = data.provider === 'codex'
        ? 'Open Codex sign-in, sign in to the account, and enter the code below.'
        : 'Open Claude sign-in, sign in to the account, and approve access.';
      providerDevice.hidden = data.provider !== 'codex';
      callbackWrap.hidden = data.provider !== 'claude';
      if (data.provider === 'codex') document.querySelector('#provider-code').textContent = data.deviceCode;
      providerStatus.textContent = data.provider === 'codex' ? 'Waiting for authorization…' : 'The sign-in link expires in about five minutes.';
      providerTimer = setTimeout(checkProvider, data.provider === 'codex' ? 3000 : 10000);
    } else if (['starting','exchanging','finishing'].includes(data.status)) {
      providerStatus.textContent = 'Connecting account…';
      providerTimer = setTimeout(checkProvider, 2000);
    } else if (data.status === 'complete') {
      providerStatus.textContent = data.assigned
        ? `${data.account} connected. ${data.visibility === 'team' ? 'Shared with the team.' : 'Personal: only you can use it.'}`
        : `${data.account} connected, but the requested sharing setting could not be confirmed. Check Your connected accounts or ask the administrator.`;
      document.dispatchEvent(new Event('hub:accounts-changed'));
    } else if (data.status === 'failed') providerStatus.textContent = data.message || 'Sign-in did not complete. Please try again.';
    else providerStatus.textContent = previousStatus !== 'idle' && previousStatus !== 'complete' ? 'The sign-in ended or expired. Start again when ready.' : '';
    previousStatus = data.status;
  }
  async function checkProvider() {
    try {showProvider(await post('/portal/providers/status'));}
    catch(error) {providerForm.hidden=false;providerPanel.hidden=true;providerStatus.textContent=error.message;}
  }
  providerForm.addEventListener('submit', async event => {
    event.preventDefault();const button=providerForm.querySelector('button[type="submit"]');button.disabled=true;providerStatus.textContent='';
    try {showProvider(await post('/portal/providers/start',{provider:document.querySelector('#provider-type').value,visibility:document.querySelector('#provider-visibility').value}));}
    catch(error) {providerStatus.textContent=error.message;}
    finally {button.disabled=false;}
  });
  callbackForm.addEventListener('submit', async event => {
    event.preventDefault();const button=callbackForm.querySelector('button[type="submit"]');button.disabled=true;providerStatus.textContent='';
    try {const data=await post('/portal/providers/complete',{callback:callbackField.value});callbackField.value='';showProvider(data);}
    catch(error) {providerStatus.textContent=error.message;}
    finally {button.disabled=false;}
  });
  document.querySelector('#provider-cancel').addEventListener('click', async () => {
    try {await post('/portal/providers/cancel');callbackField.value='';previousStatus='idle';showProvider({status:'idle'});}
    catch(error) {providerStatus.textContent=error.message;}
  });
  checkProvider();
}

const ownedAccounts = document.querySelector('#owned-accounts');
if (ownedAccounts) {
  const ownedStatus = document.querySelector('#owned-status');
  const element = (tag,text,className) => {const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;};
  async function loadOwned() {
    const response=await fetch('/portal/accounts/mine',{credentials:'same-origin',cache:'no-store'});const data=await response.json();
    if(!response.ok)throw new Error(data.error || 'Account settings are unavailable.');
    ownedAccounts.replaceChildren();
    if(!data.accounts.length)ownedAccounts.append(element('p','You have not connected an account yet.','note'));
    for(const account of data.accounts) {
      const row=element('section',undefined,'owned-card');const details=element('div');
      const provider=account.provider==='codex'?'Codex':account.provider==='claude'?'Claude':account.provider;
      details.append(element('strong',`${provider} · ${account.displayName || account.email}`));
      if(account.displayName)details.append(element('p',account.email,'note'));
      details.append(element('p',account.visibility==='team'?'Shared with team':account.visibility==='personal'?'Personal · only you':'Custom team access','note'));
      if(account.needsAttention)details.append(element('p','Authentication needs attention. Reconnect this account above.','error'));
      const controls=element('div',undefined,'member-actions');
      for(const [visibility,label] of [['personal','Keep personal'],['team','Share with team']]) {
        const button=element('button',label,'secondary');button.type='button';
        button.disabled=account.visibility===visibility;
        button.addEventListener('click',async()=>{button.disabled=true;ownedStatus.textContent='';try{
          await post('/portal/accounts/sharing',{id:account.id,visibility,version:data.version});
          ownedStatus.textContent=visibility==='team'?'Account shared with the team.':'Account is personal; team access was removed.';
          document.dispatchEvent(new Event('hub:accounts-changed'));
        }catch(error){ownedStatus.textContent=error.message;try{await loadOwned();}catch(_){button.disabled=false;}}});
        controls.append(button);
      }
      row.append(details,controls);ownedAccounts.append(row);
    }
  }
  const reloadOwned=()=>loadOwned().catch(error=>{ownedAccounts.replaceChildren(element('p',error.message,'error'));});
  document.addEventListener('hub:accounts-changed',reloadOwned);reloadOwned();
}

const deviceList=document.querySelector('#devices-list');
if(deviceList) {
  const deviceStatus=document.querySelector('#devices-status');
  const element=(tag,text,className)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;};
  async function loadDevices() {
    const response=await fetch('/portal/admin/devices',{credentials:'same-origin',cache:'no-store'});const data=await response.json();
    if(!response.ok)throw new Error(data.error||'Computer details are unavailable.');
    deviceList.replaceChildren();
    if(!data.devices.length)deviceList.append(element('p','No registered computers yet.','note'));
    for(const device of data.devices) {
      const card=element('section',undefined,'device-card'),details=element('div');
      details.append(element('strong',device.name),element('p',`${device.email}${device.platform ? ` · ${device.platform}` : ''}${device.usageOnly ? ' · usage-only key' : ''}`,'note'));
      const when=device.lastSeenAt?new Date(device.lastSeenAt).toLocaleString():'Not seen yet';
      details.append(element('p',`Last IP: ${device.lastIp || 'Unavailable'} · Last seen: ${when}`,'note'));
      if(device.kind==='legacy')details.append(element('p','Legacy key: disable the person under Team access to block it.','note'));
      card.append(details);
      if(device.kind==='device') {
        const button=element('button','Revoke','secondary');button.type='button';
        button.addEventListener('click',async()=>{button.disabled=true;deviceStatus.textContent='';try{
          await post('/portal/admin/devices/revoke',{id:device.id});await loadDevices();deviceStatus.textContent=`${device.name} was revoked.`;
        }catch(error){deviceStatus.textContent=error.message;button.disabled=false;}});
        card.append(button);
      }
      deviceList.append(card);
    }
  }
  const refresh=()=>loadDevices().catch(error=>{deviceList.replaceChildren(element('p',error.message,'error'));});
  document.querySelector('#devices-refresh').addEventListener('click',refresh);refresh();
}

const adminList = document.querySelector('#admin-list');
const adminStatus = document.querySelector('#admin-status');
if (adminList) {
  const providerNames = {codex: 'OpenAI / Codex', claude: 'Anthropic / Claude'};
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  async function loadAccess() {
    const response = await fetch('/portal/admin', {credentials: 'same-origin'});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Access settings are unavailable.');
    adminList.replaceChildren();
    for (const user of data.users) {
      const card = element('section', undefined, 'member-card');
      const header = element('div', undefined, 'member-heading');
      const name = user.name.charAt(0).toUpperCase() + user.name.slice(1);
      const details = element('div');
      details.append(element('h3', name), element('p', user.email, 'member-email'));
      header.append(details, element('span', (user.owner ? 'Owner · ' : user.role === 'admin' ? 'Admin · ' : '') + (user.enabled ? 'Active' : 'Access off'), user.enabled ? 'badge' : 'badge muted'));
      card.append(header);
      const form = element('form');
      const selected = new Set(user.accounts);
      for (const account of data.accounts) {
        const label = element('label', undefined, 'account');
        const checkbox = element('input');
        checkbox.type = 'checkbox'; checkbox.value = account.id; checkbox.checked = selected.has(account.id);
        const restricted = account.personal && account.owner !== user.name;
        const ownerPersonal = account.personal && account.owner === user.name && checkbox.checked;
        checkbox.disabled = !user.editable || ownerPersonal || (!checkbox.checked && (restricted || account.disabled || account.visibility === 'unmanaged'));
        const activeDuplicates = data.accounts.filter(other => other.provider === account.provider && other.email === account.email && !other.disabled);
        const sameActiveEmail = !account.disabled && activeDuplicates.length > 1;
        const defaultOrganization = `${account.email}'s organization`;
        const organization = account.organization && account.organization.toLowerCase() !== defaultOrganization.toLowerCase() ? ` (${account.organization})` : '';
        const distinction = sameActiveEmail ? ` · Account ${activeDuplicates.findIndex(other => other.id === account.id) + 1}` : '';
        const identity = account.displayName ? `${account.displayName} (${account.email})` : account.email;
        const accountText = `${providerNames[account.provider] || account.provider} · ${identity}${organization}${distinction}`;
        const note = restricted ? ` — personal to ${account.owner || 'its owner'}` : account.disabled ? ' — previous sign-in, unavailable' : account.visibility === 'unmanaged' ? ' — ownership needs review' : '';
        label.append(checkbox, element('span', accountText + note));
        form.append(label);
      }
      if (!data.accounts.length) form.append(element('p', 'No provider accounts are connected.'));
      if (!user.editable) form.append(element('p', 'This member has an unrecognized account rule; review it with the administrator tool.', 'error'));
      const actions = element('div', undefined, 'member-actions');
      const save = element('button', 'Save accounts'); save.type = 'submit'; save.disabled = !user.editable;
      actions.append(save);
      if (!user.owner && user.name !== document.querySelector('meta[name=hub-user]')?.content) {
        const toggle = element('button', user.enabled ? 'Disable access' : 'Restore access', 'secondary');
        toggle.type = 'button';
        toggle.addEventListener('click', async () => {
          toggle.disabled = true; adminStatus.textContent = '';
          try {
            await post('/portal/admin/access', {user: user.name, enabled: !user.enabled, version: data.version});
            await loadAccess(); adminStatus.textContent = `${name}'s access was ${user.enabled ? 'disabled' : 'restored'}.`;
          } catch (error) { adminStatus.textContent = error.message; toggle.disabled = false; }
        });
        actions.append(toggle);
      }
      form.append(actions);
      form.addEventListener('submit', async event => {
        event.preventDefault(); save.disabled = true; adminStatus.textContent = '';
        const accounts = [...form.querySelectorAll('input[type="checkbox"]')].filter(input => input.checked).map(input => input.value);
        try {
          await post('/portal/admin', {user: user.name, accounts, version: data.version});
          await loadAccess(); adminStatus.textContent = `${name}'s accounts were updated.`;
        } catch (error) { adminStatus.textContent = error.message; save.disabled = false; }
      });
      card.append(form); adminList.append(card);
    }
  }
  const reloadAccess = () => loadAccess().catch(error => { adminList.replaceChildren(element('p', error.message, 'error')); });
  document.addEventListener('hub:accounts-changed', reloadAccess);
  reloadAccess();
}

// Complete T3 Code installation and HUB enrollment guide, copied by "Copy with
// instructions to install T3 Code". It carries the same one-time code as the
// standard prompt and points every download at this hub's own origin. Kept at
// the end of the file because it is long; the declaration is hoisted.
function t3SetupGuide(origin, code) {
  const fence = '```';
  return `Please set up T3 Code and the DittoDub Provider HUB on this computer from start to finish using the guide below. Carry out the work; do not return a checklist for me to perform.

My private one-time HUB setup code is: ${code}
It expires in two hours and can be used once. Keep the code and resulting credentials private: do not print, log, or share them, and keep them out of chat, screenshots, command arguments, and shell history.

You may install the required software from its official source, open T3 Code, and supply the setup code above directly to the local installer. If that code has expired or was consumed without saving a connection, you may use my existing signed-in browser session at ${origin}/ to create a fresh private one-time setup prompt. Use my existing HUB access and already-shared accounts. Do not ask me or an administrator to copy codes or perform steps you can complete yourself.

Reuse existing valid HUB credentials before creating any new enrollment. Preserve personal credentials, custom settings, models, skills, plugins, instructions, and conversations. Enable and repair the two HUB providers without changing unrelated provider preferences.

Make every MCP server, skill, plugin, and instruction file already set up in this computer's Claude and Codex installations available to the matching HUB provider in T3 Code. Do this by making the HUB homes share the same folders natively through links, not by copying files, as described in section 6.

Recover automatically from the barriers documented below. Continue after a partial installation using its saved credential. Complete T3 onboarding, verify both HUB providers with separate harmless fresh conversations, verify usage and shared paths, and leave T3 ready to use.

Use normal shell tools and local APIs for installation. You may use computer or browser controls for the HUB portal and T3 interface, including in a workspace that otherwise prefers realm connections. Follow applicable tool permission requirements. Do not bypass MFA, operating-system approval, ownership restrictions, or access controls. If a required authorization is genuinely unavailable, finish all independent work and report the single exact remaining requirement.

====================================================================
T3 Code + DittoDub Provider HUB: complete setup and recovery
Guide updated October 30, 2026.
====================================================================

This guide is for a coding assistant to execute, including installation, enrollment, automatic repairs, and verification. The person requesting setup should not have to operate Terminal, copy setup codes, configure providers, or troubleshoot routine errors.

The recovery procedures below come from a successful macOS setup on October 29, 2026. The HUB installer and integration helper were checked again on October 30. Start with the current official software; use the compatibility fixes when the installed version needs them.

## What makes setup unattended

A signed-in HUB website and an enrolled local computer are different things. A person can already see team accounts in the website while T3 has no local HUB connection.

Setup can finish without user interaction when at least one of these is available:
- A valid existing local HUB connection.
- The one-time setup code included at the top of this prompt.
- An existing authorized HUB website session, or a normal sign-in that the assistant can complete with available authorized credentials and sessions.
- A device credential already provisioned for this user and computer through an approved private mechanism.

Use the first available route. Shared accounts already accessible through HUB do not require separate ChatGPT or Claude logins on this computer.

No document can create missing account access or supply a human-only MFA approval, password, device unlock, administrator authorization, or mandatory software agreement. Do not promise otherwise. These are exceptional authorization dependencies, not reasons to stop at ordinary installer prompts. Never ask someone to paste secrets into chat.

## Scope and completion criteria

The verified workflow is for macOS. Detect Apple Silicon versus Intel and the actual installed application path. Do not present the macOS commands as a tested Windows or Linux installer.

Setup is complete only when all of these are true:
- T3 Code is open and initial onboarding is complete.
- A working Node.js 22-or-newer executable and npm are available.
- Compatible Codex and Claude executables are installed and reachable by T3.
- HUB Codex and HUB Claude are enabled, ready, and show appropriate models from the current HUB catalog.
- Each HUB provider completes a separate fresh conversation.
- Per-account usage is visible in T3 for accounts that expose it.
- Shared configuration paths resolve correctly and existing personal files are preserved.
- Every MCP server, skill, and plugin from this computer's Claude and Codex installations is available to the matching HUB provider through shared folders.

Provider discovery, a successful download, a saved key, or an installer exit message alone does not meet these criteria.

## 1. Inspect and preserve the existing installation

Use the current user's home directory and actual paths. Do not copy another person's credentials or hard-code the username from a different computer.

Inspect these locations without displaying their secret contents:
- ~/.t3/bin/t3: desktop-installed T3 command-line launcher
- ~/.t3/userdata/server-runtime.json: running local T3 address and version
- ~/.dittodub-provider-hub/: standard HUB connection
- ~/.codex-team-hub/ and ~/.codex-hub/: possible older HUB connections
- ~/.codex/: personal Codex configuration and skills
- ~/.claude/: personal Claude configuration, skills, agents, commands, and plugins
- ~/.claude.json: personal Claude MCP servers mixed with account and session state (never linked or copied whole)
- Any CODEX_HOME or CLAUDE_CONFIG_DIR set in the person's shell profiles, and the homePath of each T3 provider instance: other Claude or Codex installations whose MCP servers and skills must also be shared
- ~/.local/share/t3-codex/: separate Codex installation for T3
- ~/.local/bin/claude: common native Claude executable

Before changing existing settings, record their hashes and the current skill directory entries. Keep any necessary backups private and local. Do not print or export authentication files. Do not delete chats, runtime databases, project files, or credentials as a repair.

If a valid standard HUB credential exists, use it. If only a legacy connection exists, validate it with the current helper's readConnection function. Migrate only the same authorized user's recognized HUB connection, in memory, into a missing standard connection using saveConnection. Validate the standard paths first; preserve the legacy copy. Do not overwrite a different existing credential.

Keep the task's non-secret temporary paths in assistant state. Separate shell tool calls may not share variables or PATH, so pass those paths explicitly when necessary.

Create one private working directory and reuse it throughout this guide:

${fence}sh
umask 077
setup_dir="$(mktemp -d)"
chmod 700 "$setup_dir"
${fence}

## 2. Install prerequisites automatically

### T3 Code

If the installed app is already running, use it. Otherwise locate and open the installed copy by its full path.

If T3 is absent, obtain the current stable build for the detected architecture from the official T3 download page (https://t3.codes). On macOS, the assistant can download and mount the official disk image, copy the application into an authorized application directory, detach the image, and open the installed copy. Use the current user's Applications directory when a system-wide installation would require unavailable administrator privileges.

Do not run the app from the mounted installer image. If both copies have the same bundle identifier, use the full installed application path instead of an ambiguous app name or bundle identifier.

Keep T3 running. Do not require T3 Connect cloud sign-in when the local computer is already connected; that is separate from HUB enrollment.

### Node.js and npm

Check the actual executable:

${fence}sh
node --version
npm --version
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'
${fence}

If Node is absent or too old, install a supported release using an existing authorized package manager or an official binary from Node.js (https://nodejs.org/en/download). A per-user binary installation can avoid an administrator password. Verify the vendor checksum and the resulting version.

Use the new executable in the setup process immediately. Do not ask the person to reopen Terminal. Keep its bin directory available in the HUB provider environment as well.

The shell installer also invokes Python 3 during first enrollment. Check that it runs before consuming a setup code. If missing, install it through the existing authorized package manager or the official Python distribution, then verify it. Reuse an already-enrolled connection without reenrolling.

### Codex: fix an incompatible old executable

A command named codex may exist but be too old to support app-server. During the reference setup, Codex 0.38.0 caused the startup probe to fail; restarting T3 could not fix that binary.

Reuse a compatible existing T3-specific installation. Otherwise install the official package into a separate per-user directory:

${fence}sh
npm install --prefix "$HOME/.local/share/t3-codex" --no-audit --no-fund @openai/codex@latest
"$HOME/.local/share/t3-codex/node_modules/.bin/codex" --version
"$HOME/.local/share/t3-codex/node_modules/.bin/codex" app-server --help
${fence}

Verify that app-server help is actually shown; an old CLI can print generic help and exit successfully. Configure HUB Codex with the absolute executable path above. Preserve an older global Codex installation and personal authentication unless changing them is explicitly required.

See the official Codex CLI documentation (https://github.com/openai/codex).

### Claude: install the CLI, then make it reachable

Use T3's official Claude install action, or download and run the official Claude installer:

${fence}sh
curl -fsSL https://claude.ai/install.sh -o "$setup_dir/install-claude.sh"
bash "$setup_dir/install-claude.sh"
"$HOME/.local/bin/claude" --version
${fence}

Use the private setup_dir created in section 1.

A completed installation does not guarantee that an already-running T3 process can find Claude. The native installer can place it in ~/.local/bin while T3 still reports "not found."

Make ~/.local/bin available to the HUB Claude provider, whose HUB launcher runs claude internally. Also include the Node bin directory needed by the Codex launcher. The compatibility adapter in section 5 supplies these paths without requiring a global shell configuration edit or restarting active conversations.

Do not request a separate personal Claude login just to use accounts already shared through HUB.

## 3. Prepare the current HUB installer

Download the current scripts into the existing private working directory:

${fence}sh
umask 077
chmod 700 "$setup_dir"
curl -fsS ${origin}/setup-provider-hub.sh -o "$setup_dir/setup-provider-hub.sh"
curl -fsS ${origin}/setup-hub-usage.cjs -o "$setup_dir/setup-hub-usage.cjs"
export PATH="$HOME/.local/bin:$HOME/.local/share/t3-codex/node_modules/.bin:$PATH"
${fence}

Inspect these current scripts before running them. Do not enable shell tracing.

Resolve the real T3 CLI. Prefer the executable at ~/.t3/bin/t3 when present; otherwise inspect the installed runtime and use its actual executable. Store that absolute non-secret path as t3_cli.

Test the running app using the helper's explicit override:

${fence}sh
node "$setup_dir/setup-hub-usage.cjs" --check --t3 "$t3_cli"
node "$setup_dir/setup-hub-usage.cjs" --check-environment
${fence}

If the generic prerequisite error disappears with --t3, the problem is the assumed CLI path, not authentication.

### Missing versioned T3 path

The October 30 installer still assumes ~/.t3/runtime/versions/<serverVersion>/t3. The verified desktop installation instead provides ~/.t3/bin/t3.

For an existing saved HUB connection, skip the shell installer and run the registration adapter in section 5 with --t3 supplied internally. No compatibility link is needed.

For first enrollment, the shell installer performs its own check before reading the code and does not accept --t3. If the current script still has this mismatch:
1. Read serverVersion from the current runtime JSON and validate its version format.
2. Verify the actual desktop CLI works.
3. Only if the expected versioned executable is absent, create a temporary link to the actual CLI at that exact expected path.
4. Never overwrite an existing file or link.
5. Track the link and directories created by this task. Install exit, interruption, and termination cleanup handlers that remove only that link and any newly created empty directories.
6. Run the unchanged shell installer while this temporary compatibility link exists.
7. Remove the temporary link after enrollment, including when registration subsequently fails. Use the adapter for registration.

Do not create a permanent guessed runtime, edit T3's runtime JSON, or replace a working T3 launcher. Derive the version each time; do not hard-code 0.1.5.

## 4. Enroll this computer without asking the person to copy a code

### Existing local connection

If the current helper can read and validate the saved connection, continue directly to section 5 and do not consume the setup code. A failed later registration step does not invalidate the saved credential.

### Setup code included in this prompt

Start the local installer in a private terminal process using normal shell tooling:

${fence}sh
bash "$setup_dir/setup-provider-hub.sh"
${fence}

Wait until the installer is visibly or programmatically at its hidden code input. Supply the setup code from the top of this prompt through the tool's protected stdin mechanism. If a tool would expose stdin arguments in its transcript, use an approved secret-input facility instead. Do not paste the code into an echoed shell command, a script, a model conversation, or a command-line argument. Clear any transient copy of the code afterward.

Continue to section 5 even if the installer reports the known settings-method failure, provided its saved connection validates.

### Signed-in HUB website (only when the included code cannot be used)

If the included code has expired or the redemption result is uncertain, check first whether credentials were saved. Create a fresh code only when no valid enrollment was saved.

Use the existing authorized browser session at ${origin}/. Verify the displayed account belongs to the requesting user. If ordinary sign-in can be completed with their available authorized session, complete it. Then:
1. Confirm the website shows accounts the user is allowed to use.
2. Under "Connect a computer," choose "Create setup prompt" or "Create a new prompt."
3. Read the private one-time code into a transient runtime variable. Do not emit the prompt, DOM, screenshot, clipboard value, or code into chat or logs. Suppress or redact tool observations that would expose it.
4. Supply it to the installer exactly as described above.
5. Clear the transient code variable and any task-created secret clipboard content. Reload the HUB portal after the code is consumed so the secret prompt is no longer displayed.

Use computer control only where the active tool permits it. Do not drive terminal applications through a desktop-control runtime that forbids terminal automation.

The one-time code is not an instruction to stop. Supplying it to the installer is part of this setup. Do not require the person to connect their own provider account when shared HUB accounts are already available. Do not repeatedly redeem a consumed code or repeatedly enroll an already-connected computer.

### Privately provisioned device credential

If a device credential has already been provisioned for this exact user and computer, the installer supports:

${fence}sh
bash "$setup_dir/setup-provider-hub.sh" --key
${fence}

Supply that credential through protected stdin. Do not request that an administrator send a device key in chat, use another person's key, or replace an existing mismatched credential.

## 5. Register or repair providers using the current local T3 API

### Why the original installer can stop partway through

In the verified T3 0.1.5 release, the installer saved the credential and usage source, then failed with "T3 rejected the settings request." The underlying response was:

${fence}
Unknown request tag: server.getSettings
${fence}

The supported way to obtain those settings in that release is:

${fence}js
(await client.request('server.getConfig')).settings
${fence}

Do not reenroll, ask for a new code, reinstall T3, or delete credentials for this error. Use the existing saved connection and the adapter below. It uses the downloaded helper's own registration logic and maps the outdated read call to the supported API.

If the helper hides the underlying reason, inspect the relevant local T3 trace or the bundled API contract. A temporary diagnostic copy may reveal only the failed response cause after redacting credential-shaped values; never dump request payloads, complete settings, or session tokens. Keep the installed app and the downloaded original helper unchanged.

### Compatibility adapter

Save this block as finish-hub.cjs inside the private setup directory. It contains no credentials.

It repairs only instances whose driver and home directory identify the standard HUB connection. It preserves unrelated providers, custom models, and other environment variables. Existing matching HUB entries are explicitly enabled because this task requests both HUB providers to work.

${fence}js
'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

async function finish() {
  const helperFile = process.argv[2];
  const t3Cli = process.argv[3];
  if (!helperFile || !t3Cli) {
    throw new Error('Supply the helper path and the real T3 CLI path.');
  }
  fs.accessSync(t3Cli, fs.constants.X_OK);
  const helper = require(path.resolve(helperFile));
  if (typeof helper.main !== 'function' ||
      typeof helper.connect !== 'function') {
    throw new Error('The current helper API changed; inspect it before adapting.');
  }

  const home = os.homedir();
  const root = path.join(home, '.dittodub-provider-hub');
  const codexBinary = path.join(home,
    '.local/share/t3-codex/node_modules/.bin/codex');
  fs.accessSync(codexBinary, fs.constants.X_OK);

  function normalizedHome(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const expanded = value === '~' ? home :
      value.startsWith('~/') ? path.join(home, value.slice(2)) : value;
    return path.resolve(expanded);
  }

  function prepare(instance) {
    const config = instance.config || {};
    const directory = normalizedHome(config.homePath);
    const isCodex = instance.driver === 'codex' &&
      directory === path.join(root, 'codex');
    const isClaude = instance.driver === 'claudeAgent' &&
      directory === path.join(root, 'claude');
    if (!isCodex && !isClaude) return instance;

    const environment = instance.environment || [];
    const previous = environment.find(entry => entry.name === 'PATH');
    if (previous?.valueRedacted) {
      throw new Error('The HUB PATH override is masked; preserve it and inspect its configuration.');
    }
    const entries = [
      path.dirname(process.execPath),
      path.join(home, '.local/bin'),
      path.join(home, '.local/share/t3-codex/node_modules/.bin'),
      ...(previous?.value || '').split(path.delimiter),
      ...(process.env.PATH || '').split(path.delimiter),
      '/usr/bin', '/bin', '/usr/sbin', '/sbin',
    ].filter(Boolean);
    const runtimePath = [...new Set(entries)].join(path.delimiter);
    const pathEntry = {
      ...(previous || {}),
      name: 'PATH',
      value: runtimePath,
      sensitive: false,
      valueRedacted: false,
    };
    const nextEnvironment = previous
      ? environment.map(entry => entry.name === 'PATH' ? pathEntry : entry)
      : [...environment, pathEntry];

    return {
      ...instance,
      enabled: true,
      environment: nextEnvironment,
      config: {
        ...config,
        ...(config.enabled === false ? {enabled: true} : {}),
        binaryPath: isCodex ? codexBinary : path.join(root, 'hub-claude'),
        ...(isCodex ? {setupMode: 'existing'} : {}),
      },
    };
  }

  await helper.main([
    '--t3', path.resolve(t3Cli),
    '--codex-home', path.join(root, 'codex'),
  ], {
    connect: async (origin, token) => {
      const client = await helper.connect(origin, token);
      async function currentConfig() {
        let result = await client.request('server.getConfig');
        let changed = false;
        for (const [id, instance] of Object.entries(
          result.settings?.providerInstances || {})) {
          const next = prepare(instance);
          if (JSON.stringify(next) === JSON.stringify(instance)) continue;
          await client.request('server.updateSettings', {
            patch: {},
            providerInstanceMutation: {
              operation: 'upsert', instanceId: id, instance: next,
            },
          });
          changed = true;
        }
        if (changed) result = await client.request('server.getConfig');
        return result;
      }
      return {
        close: () => client.close(),
        request: async (tag, payload = {}) => {
          if (tag === 'server.getSettings') {
            return (await currentConfig()).settings;
          }
          if (tag === 'server.getConfig') return currentConfig();
          const mutation = payload.providerInstanceMutation;
          if (tag === 'server.updateSettings' && mutation?.instance) {
            payload = {
              ...payload,
              providerInstanceMutation: {
                ...mutation, instance: prepare(mutation.instance),
              },
            };
          }
          return client.request(tag, payload);
        },
      };
    },
  });
}

finish().catch(() => {
  console.error('HUB registration failed. Inspect redacted T3 diagnostics and preserve the saved connection.');
  process.exitCode = 1;
});
${fence}

Run it with non-secret paths:

${fence}sh
node "$setup_dir/finish-hub.cjs" "$setup_dir/setup-hub-usage.cjs" "$t3_cli"
${fence}

Keep the helper's authentication validation, provider-routing arguments, environment checks, scoped local sessions, and session revocation intact. Do not put the device key in a URL or provider launch argument.

If a future helper changes its exports or T3 changes its API, inspect the current helper, supported local API, and redacted local errors. Adapt the narrow compatibility layer and reverify. Do not assume a different failure is the same old method error.

## 6. Share every MCP server, skill, and plugin through the same folders

Everything the person already set up in Claude and Codex must also work in T3's HUB providers. Make each HUB home use the personal folders natively through links instead of copying files. The personal paths stay the single source of truth, so a skill, plugin, or MCP server added later in either environment appears in both.

Authentication and runtime state stay separate. Never link or copy auth.json, .credentials.json, .claude.json, the device key, sessions, projects, history, or caches between homes. Make these changes while no HUB conversation is running, and record every link, merge, and backup you make.

### Find every installation

Look beyond the default homes:
- Codex: ~/.codex, any CODEX_HOME set in the shell profile, the homePath of each T3 Codex provider instance, and older HUB homes (~/.codex-team-hub, ~/.codex-hub).
- Claude: ~/.claude and ~/.claude.json, any CLAUDE_CONFIG_DIR set in the shell profile, and the homePath of each T3 Claude provider instance.
- Skills folders outside every provider home (for example ~/.agents/skills, if the installed CLI reads it) are already shared by every home; leave them where they are.

~/.codex and ~/.claude are the shared sources. If another non-HUB installation has skills, agents, commands, plugins, instructions, or Codex MCP servers that the shared source lacks, add the missing items to the shared source: copy skill, agent, and command folders in; add missing [mcp_servers.<name>] tables to ~/.codex/config.toml; and install missing Claude plugins with the personal Claude's own claude plugin commands. Leave the other installation unchanged. If two definitions share a name but differ, keep both originals and report the conflict instead of choosing one.

### Codex

The registration in section 5 links these HUB Codex paths to the personal ones: config.toml (which holds every [mcp_servers] entry), skills, plugins, and AGENTS.md. Verify each is a link to the matching path in ~/.codex. If one is missing because registration stopped early or reported custom HUB files, merge the HUB copy's unique content into ~/.codex, move the old HUB path into a new folder under ~/.dittodub-provider-hub/backups, and rerun the section 5 registration so the helper creates the link. Do not add HUB routing to the shared config.toml; T3 launch arguments supply it.

### Claude

Registration links only ~/.dittodub-provider-hub/claude/skills to ~/.claude/skills. Link the rest of Claude's shareable configuration the same way, with the personal path as the link target:
- ~/.dittodub-provider-hub/claude/agents -> ~/.claude/agents
- ~/.dittodub-provider-hub/claude/commands -> ~/.claude/commands
- ~/.dittodub-provider-hub/claude/plugins -> ~/.claude/plugins (plugin skills, agents, hooks, and plugin-provided MCP servers)
- ~/.dittodub-provider-hub/claude/CLAUDE.md -> ~/.claude/CLAUDE.md
- ~/.dittodub-provider-hub/claude/settings.json -> ~/.claude/settings.json (enabled plugins, marketplaces, permissions, and hooks)

For each path:
1. If the personal path is missing, create it empty (folders 700, files 600) so both homes share it from now on.
2. If the HUB path already links to the personal path, leave it.
3. If the HUB path exists with content, first add anything the personal path lacks. For plugins, install missing marketplaces and plugins into the personal Claude with claude plugin commands instead of merging plugin registries by hand. Then move the old HUB path into a new folder under ~/.dittodub-provider-hub/backups.
4. Create the link and confirm it resolves to the personal path.

Link settings.json only when the personal file cannot change how HUB Claude authenticates or where it sends requests: no apiKeyHelper, awsAuthRefresh, awsCredentialExport, forceLoginMethod, or forceLoginOrgUUID key, and no env entry named ANTHROPIC_*, CLAUDE_CODE_USE_*, or CLAUDE_CODE_OAUTH_TOKEN. Those would override the HUB launcher and route HUB Claude around the hub. If any are present, keep the HUB settings.json separate, set only its enabledPlugins and extraKnownMarketplaces to match the personal file, and report this exception.

### Claude MCP servers added with claude mcp add

Claude stores user-scope and local-scope MCP servers inside .claude.json: ~/.claude.json, or $CLAUDE_CONFIG_DIR/.claude.json for a home that sets CLAUDE_CONFIG_DIR. HUB Claude's file is ~/.dittodub-provider-hub/claude/.claude.json. Because that file also holds each home's account identity, onboarding, project trust, and session state, it cannot be shared by link. This is the only exception to folder sharing:
- Read the top-level mcpServers entries, and each project's mcpServers entries, from every personal Claude .claude.json found above.
- Add the missing entries to HUB Claude's .claude.json under the same names and project paths, changing nothing else in that file. Use a small local script that reads both files privately, writes atomically, and keeps mode 600. Do not print the definitions, which can contain tokens, and do not pass them as command arguments.
- Skip identical entries. If a name already exists with a different definition, keep the HUB entry and report the conflict.
- Prefer the folder-native route where it exists: MCP servers provided by plugins are already shared through the plugins link. Rerun this step to pick up servers added later.

### Verify sharing

Compare MCP server names only, never their configuration: codex mcp list with CODEX_HOME set to ~/.dittodub-provider-hub/codex against ~/.codex, and claude mcp list with CLAUDE_CONFIG_DIR set to ~/.dittodub-provider-hub/claude against the personal Claude. Every personal server should appear for the matching HUB provider. Parse the output privately; do not display commands, URLs, headers, or environment values. Also confirm the HUB skill folders list the same skills as the personal ones.

Codex and Claude use different MCP and configuration formats, so each HUB provider shares with its own personal counterpart; do not copy Codex skills or servers into Claude, or the reverse. MCP servers that keep their own OAuth sign-in per home may need one sign-in from the HUB provider; report which ones.

## 7. Finish onboarding and verify in fresh conversations

Complete the local "Connect" and "Agents" steps in T3. A connected local computer is expected. Select the HUB entries when offered.

The original personal Codex or Claude entry may still be unavailable because it has a separate executable or login configuration. That does not invalidate a verified HUB provider. Do not repeatedly reauthenticate unrelated personal providers.

At the Projects step, finish onboarding without importing unrelated project history. Use "Start without a project" for the connection tests. Do not send private repository files to a model to test enrollment.

In two separate fresh conversations:

1. Select HUB Codex and a model actually advertised by the current HUB catalog. Send:

${fence}
Connection test only. Do not use tools, inspect files, or change anything.
Reply with exactly: HUB Codex OK
${fence}

2. Select HUB Claude and an available HUB Claude model. Send:

${fence}
Connection test only. Do not use tools, inspect files, or change anything.
Reply with exactly: HUB Claude OK
${fence}

Wait for completed assistant responses. Both must succeed. Use a model available to this connection; do not pin yesterday's model list or infer access merely because a model appears in a menu.

A catalog refresh does not guarantee that a cached provider process reloads configuration. Use new conversations with fresh provider processes. If a new conversation still reuses a stale process, close or refresh only that idle test session. Do not restart T3 or interrupt active work by default.

The reference setup completed both exact-response tests successfully.

## 8. Verify usage, shared paths, preservation, and cleanup

Open T3's Usage view and choose Limits. Verify that accessible Codex and Claude account limits appear. Account counts and percentages depend on the signed-in user's live access; do not hard-code the reference installation's values. If supported telemetry remains unreachable after bounded retries, report it as an outstanding verification issue instead of claiming that usage works.

Expected shared paths (HUB path -> normal personal path):
- ~/.dittodub-provider-hub/codex/config.toml -> ~/.codex/config.toml (includes Codex MCP servers)
- ~/.dittodub-provider-hub/codex/skills -> ~/.codex/skills
- ~/.dittodub-provider-hub/codex/plugins -> ~/.codex/plugins
- ~/.dittodub-provider-hub/codex/AGENTS.md -> ~/.codex/AGENTS.md
- ~/.dittodub-provider-hub/claude/skills -> ~/.claude/skills
- ~/.dittodub-provider-hub/claude/agents -> ~/.claude/agents
- ~/.dittodub-provider-hub/claude/commands -> ~/.claude/commands
- ~/.dittodub-provider-hub/claude/plugins -> ~/.claude/plugins
- ~/.dittodub-provider-hub/claude/CLAUDE.md -> ~/.claude/CLAUDE.md
- ~/.dittodub-provider-hub/claude/settings.json -> ~/.claude/settings.json (unless the section 6 exception applies)

Verify the actual link destinations and that each HUB provider lists the same MCP server names as its personal counterpart. Authentication and runtime state stay separate. An empty personal folder is valid; linking it does not install anything new.

Compare the personal-file hashes and existing skill entries recorded before setup. Explain any intended change; do not silently overwrite personal configuration.

Verify HUB credential files are private to their owner. Remove only task-created temporary compatibility links, unused temporary secret material, and task-issued local sessions. Keep installed software, working HUB configuration, and any required recovery backups. Finish any computer-control session according to the active runtime's lifecycle instructions.

Leave T3 open with the working HUB providers available. Report which real checks passed and show a secret-free verification image when the computer-use tool requires one.

## Recovery reference: continue until the actual problem is resolved

- "I am connected," but no local HUB directory exists: distinguish portal sign-in from device enrollment. Use the setup code in this prompt, or the signed-in portal, to enroll automatically.
- Installer asks for a setup code: complete the installer flow in section 4. This prompt alone is not a reason to hand work back.
- Generic prerequisite failure: check Node's version, T3's local runtime address, the actual executable, and the helper's --check --t3 override.
- Expected versioned T3 executable is absent: use the explicit CLI override for registration; use a tracked temporary link only while the unchanged first-enrollment installer requires it.
- Ambiguous T3 application identifier: target the full installed app path; avoid the mounted installer copy.
- Codex App Server exits immediately: inspect the CLI version and actual app-server support. Install or select a compatible T3-specific Codex binary before retrying.
- Claude not installed: complete the official installer, verify the executable, then refresh HUB discovery.
- Claude installed but "not found": put its real bin directory in the HUB provider environment. A new Terminal window does not repair T3's existing environment.
- Credentials saved, then "T3 rejected the settings request": inspect the redacted underlying error. For server.getSettings, use section 5; reuse the saved credential.
- One HUB entry is disabled: enable that requested HUB instance while preserving unrelated provider preferences. Rerun registration and verify its ready state.
- Provider is ready but a new turn fails: read the test turn's actual error. Check its selected HUB instance, model access, binary, routing, and fresh-process state. Retry only after addressing the cause.
- Provider models are missing: read the live /v1/models catalog through the helper's existing authenticated connection and sync it. Preserve custom entries and model preferences.
- An MCP server, skill, or plugin works in personal Claude or Codex but not in the HUB provider: check that the HUB path links to the personal path, that the plugin is enabled in the shared settings.json, and, for Claude servers added with claude mcp add, that HUB Claude's .claude.json has the entry (section 6). Start a fresh conversation; running provider processes do not reload MCP configuration.
- Usage is empty or temporarily returns 503: verify the enabled HUB usage source and saved authorization. Retry bounded read-only refreshes with backoff. Confirm unavailable account telemetry honestly; do not invent limits or alter inference credentials.
- Code expired or the redemption result is uncertain: check for a saved valid connection first. Generate a fresh code only if enrollment did not save one. Do not blindly repeat state-changing requests.
- DNS, download, or localhost access fails in a sandbox: use the authorized tool's supported network or filesystem approval route. Retry idempotent reads with bounded backoff. A sandbox error does not prove that the service is down.
- Existing custom files or conflicting links: back up locally, compare, and merge deterministic non-secret differences. Preserve nonmatching files with an explicit migration record; never hide or overwrite them. Continue unaffected steps.
- Two credential files disagree: check their provenance and validate the known authorized connection privately. Do not guess, silently choose another person's access, overwrite secrets, or request secrets in chat.
- No valid login, account permission, or provisioned credential exists: complete independent installation and diagnostics. State the exact missing authorization once. No instruction can manufacture it or bypass a required human approval.

Do not retry credential redemption, inference turns, or other state-changing operations indiscriminately. For read-only transient failures, use a small bounded retry with backoff, then report the actual remaining condition.

## What not to change to "make it work"

- Do not disable sandboxing, certificate checks, MFA, operating-system security, or approval policies.
- Do not delete personal authentication or log the user out to repair a HUB setting.
- Do not link or copy auth.json, .credentials.json, .claude.json, the device key, sessions, or history between homes to share configuration.
- Do not copy browser cookie databases, scrape password stores, or reuse another person's account.
- Do not broaden account sharing or purchase a subscription as an assumed setup step.
- Do not expose the local T3 server publicly.
- Do not describe a partially configured or untested provider as complete.

## Official sources and maintenance

- T3 Code stable downloads: https://t3.codes
- Node.js downloads: https://nodejs.org/en/download
- Codex CLI and App Server: https://github.com/openai/codex
- Claude Code installer: https://claude.ai/install.sh
- DittoDub Provider HUB: ${origin}/
- Current HUB installer: ${origin}/setup-provider-hub.sh
- Current T3 integration helper: ${origin}/setup-hub-usage.cjs

Recheck vendor installers and the HUB helper when software changes. The reference setup used T3 0.1.5, Node.js 23.1.0, Codex CLI 0.166.0, and Claude Code 2.1.312. Those versions identify the verified troubleshooting context; they are not a requirement to downgrade a working newer installation.

The compatibility adapter was syntax-checked and exercised against simulated new and partial T3 registrations on October 30, including disabled HUB entries, obsolete executable paths, custom models, and preserved masked environment values. This validation does not replace the live acceptance checks on each target computer.`;
}
