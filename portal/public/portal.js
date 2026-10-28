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
let setupExpiry;
document.querySelector('#setup').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  document.querySelector('#error').textContent = '';
  try {
    const result = await post('/portal/setup-code');
    document.querySelector('#code').textContent = result.code;
    document.querySelector('#setup-prompt').textContent = `Please connect this computer to our Multi-Account Hub for T3 Code.

My private one-time setup code is: ${result.code}
It expires in two hours and can be used once. Keep the code and resulting credentials private; do not print or share them.

Keep T3 Code running and ensure Node.js 22 or later is available. Download ${location.origin}/setup-provider-hub.sh to a private temporary directory and run it with the setup code supplied on standard input. Follow the script's instructions to add HUB Codex and HUB Claude to T3 Code if you can; otherwise tell me the exact settings it prints. The script configures per-account usage automatically. If this computer is already connected, it updates usage without consuming the setup code or replacing credentials. Preserve existing provider configurations and credentials. If setup fails, report the error; rerunning the same script can finish usage setup without a new code once credentials are saved.`;
    document.querySelector('#result').hidden = false;
    document.querySelector('#copy-prompt').disabled = false;
    document.querySelector('#copy-status').textContent = '';
    button.textContent = 'Create a new prompt';
    button.className = 'secondary';
    clearTimeout(setupExpiry);
    setupExpiry = setTimeout(() => {
      document.querySelector('#copy-prompt').disabled = true;
      document.querySelector('#copy-status').textContent = 'This prompt has expired. Create a new prompt to connect a computer.';
      document.querySelector('#setup-prompt').textContent = '';
      document.querySelector('#code').textContent = '';
    }, result.expiresInSeconds * 1000);
  } catch (error) { document.querySelector('#error').textContent = error.message; }
  finally { button.disabled = false; }
});
document.querySelector('#copy-prompt').addEventListener('click', async () => {
  const prompt = document.querySelector('#setup-prompt');
  const status = document.querySelector('#copy-status');
  try {
    await navigator.clipboard.writeText(prompt.textContent);
    status.textContent = 'Copied. Paste the prompt into your coding assistant.';
  } catch (_) {
    status.textContent = 'Could not copy automatically. Select and copy the prompt below.';
    prompt.focus();
  }
});
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
    for (const expiry of account.resetExpirations) if (date(expiry)) meta.append(element('span', `Expires ${date(expiry)}`));
    if (meta.childNodes.length) metrics.append(meta);
    if (account.checkedAt && date(account.checkedAt)) {
      metrics.append(element('p', `${account.stale ? 'Update unavailable · Last checked' : 'Checked'} ${date(account.checkedAt)}`, 'usage-checked'));
    }
    card.append(metrics);
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
  setInterval(loadUsage, 5 * 60 * 1000);
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
      details.append(element('strong',device.name),element('p',`${device.email}${device.platform ? ` · ${device.platform}` : ''}`,'note'));
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
