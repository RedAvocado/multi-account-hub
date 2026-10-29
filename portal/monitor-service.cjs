'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const crypto = require('node:crypto');

const CHECK_INTERVAL = 15 * 60 * 1000;
const STATUS_INTERVAL = 60 * 1000;
const FORCE_INTERVAL = 60 * 60 * 1000;
const REMINDER_INTERVAL = 12 * 60 * 60 * 1000;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const clean = (value, length = 80) => typeof value === 'string'
  ? value.replace(/[\x00-\x1f\x7f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, length) : '';
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function writeJson(file, value) {
  const temporary = path.join(path.dirname(file), `.monitor-${crypto.randomBytes(12).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(value) + '\n', {mode:0o600, flag:'wx'});
    fs.renameSync(temporary, file);
  } finally {try {fs.unlinkSync(temporary);} catch (error) {if (error.code !== 'ENOENT') throw error;}}
}

function enqueueEvent(directory,eventId,content) {
  if(!/^[a-z0-9-]{1,150}$/.test(eventId) || typeof content!=='string' || content.length>1900) throw new Error('Invalid notification');
  const outbox=path.join(directory,'notification-outbox');
  fs.mkdirSync(outbox,{recursive:true,mode:0o700});
  const target=path.join(outbox,eventId+'.json'),temporary=path.join(outbox,`.event-${crypto.randomBytes(12).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temporary,JSON.stringify({version:1,content,attempts:0,nextAttemptAt:0})+'\n',{mode:0o600,flag:'wx'});
    try {fs.linkSync(temporary,target);} catch(error) {if(error.code!=='EEXIST')throw error;}
  } finally {try {fs.unlinkSync(temporary);} catch(error) {if(error.code!=='ENOENT')throw error;}}
}

function enqueueDeviceEvent({directory,hubUrl='',id,device,ip}) {
  if(!/^[a-f0-9]{64}$/.test(id) || !device || device.enabled!==true || !/^[a-z][a-z0-9_-]{0,40}$/.test(device.name||'')) throw new Error('Invalid device');
  const address=net.isIP(ip||'') ? ip : 'Unavailable';
  const label=clean(device.deviceName)||'Unnamed computer', user=clean(device.email,254)||clean(device.name,41), platform=clean(device.platform,40);
  const text=`🔐 Multi-Account Hub: new computer connected\nComputer: ${label}${platform?` (${platform})`:''}\nUser: ${user}\nIP: ${address}\nReview or revoke access ${hubUrl?`in the hub website: ${hubUrl}`:'with hub-admin.py devices.'}`;
  enqueueEvent(directory,'device-'+id,text);
}

function managementClient(authDir) {
  const agent = new http.Agent({keepAlive:true, maxSockets:4});
  return (endpoint, body, timeout = 20000) => new Promise((resolve,reject) => {
    let key;
    try {key = fs.readFileSync(path.join(authDir,'management-key'),'utf8').trim();}
    catch (_) {return reject(new Error('Management unavailable'));}
    if (!['auth-files','api-call','auth-files/refresh'].includes(endpoint)) return reject(new Error('Invalid management operation'));
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = {authorization:`Bearer ${key}`, 'content-type':'application/json'};
    if (payload) headers['content-length'] = payload.length;
    const req = http.request({host:'127.0.0.1',port:8317,path:`/v0/management/${endpoint}`,
      method:payload?'POST':'GET',headers,agent}, res => {
      let data = '', size = 0;
      res.on('data', chunk => {size += chunk.length; if (size > 4 * 1024 * 1024) res.destroy(); else data += chunk;});
      res.on('error', reject);
      res.on('end', () => {
        let value = null; try {value = JSON.parse(data);} catch (_) {}
        resolve({status:res.statusCode || 0,value});
      });
    });
    req.setTimeout(timeout, () => req.destroy(new Error('Management timeout')));
    req.on('error',reject);req.end(payload || undefined);
  });
}

function discordDelivery(directory, request=https.request) {
  return content => new Promise((resolve,reject) => {
    let url;
    try {
      const file=path.join(directory,'discord-webhook-url'), stat=fs.lstatSync(file);
      if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 4096) throw new Error('Invalid webhook');
      url=new URL(fs.readFileSync(file,'utf8').trim());
      if (url.protocol!=='https:' || url.hostname!=='discord.com' || url.port || url.username || url.password || url.search || url.hash ||
          !/^\/api\/webhooks\/\d{5,30}\/[A-Za-z0-9_-]{20,256}$/.test(url.pathname)) throw new Error('Invalid webhook');
    } catch (_) {return reject(new Error('Notification configuration unavailable'));}
    const payload=Buffer.from(JSON.stringify({content,allowed_mentions:{parse:[]}}));
    const req=request({hostname:'discord.com',path:url.pathname+'?wait=true',method:'POST',
      headers:{'content-type':'application/json','content-length':payload.length},timeout:15000}, res => {
      let body='', size=0;
      res.on('data',chunk=>{size+=chunk.length;if(size<=32768)body+=chunk;});
      res.on('error',reject);
      res.on('end',()=>{
        let retry=Number(res.headers['retry-after']);
        if (!Number.isFinite(retry) || retry <= 0) {try {retry=Number(JSON.parse(body).retry_after);} catch (_) {retry=0;}}
        const remaining=Number(res.headers['x-ratelimit-remaining']);
        const reset=Number(res.headers['x-ratelimit-reset-after']);
        resolve({status:res.statusCode||0,retryAfter:Number.isFinite(retry)?retry:0,
          resetAfter:remaining===0 && Number.isFinite(reset) && reset>0 ? reset : 0});
      });
    });
    req.on('timeout',()=>req.destroy(new Error('Notification timeout')));
    req.on('error',()=>reject(new Error('Notification delivery unavailable')));
    req.end(payload);
  });
}

function createMonitor({directory,authDir,hubUrl='',management=managementClient(authDir),deliver=discordDelivery(directory),now=Date.now,pause=sleep}) {
  const stateFile=path.join(directory,'monitor-state.json'), outbox=path.join(directory,'notification-outbox');
  const deviceDir=path.join(directory,'devices'), seenDir=path.join(directory,'device-last-seen');
  fs.mkdirSync(outbox,{recursive:true,mode:0o700});fs.chmodSync(outbox,0o700);
  function deviceIds() {
    try {return fs.readdirSync(deviceDir).filter(name=>/^[a-f0-9]{64}\.json$/.test(name)).map(name=>name.slice(0,-5));}
    catch (error) {if(error.code==='ENOENT')return [];throw error;}
  }
  let state;
  try {
    state=JSON.parse(fs.readFileSync(stateFile,'utf8'));
    if(state?.version!==1 || !state.seenDevices || Array.isArray(state.seenDevices) || !state.accounts || Array.isArray(state.accounts)) throw new Error('Invalid monitor state');
  } catch(error) {
    if(error.code!=='ENOENT')throw error;
    // Existing enrollments predate this monitor; only announce new devices.
    state={version:1,seenDevices:Object.fromEntries(deviceIds().map(id=>[id,true])),accounts:{}};
    writeJson(stateFile,state);
  }
  const save=()=>writeJson(stateFile,state);
  const enqueue=(eventId,content)=>enqueueEvent(directory,eventId,content);
  function scanDevices() {
    let changed=false;
    for(const id of deviceIds()) {
      if(state.seenDevices[id])continue;
      try {
        const file=path.join(deviceDir,id+'.json'), stat=fs.lstatSync(file);
        if(!stat.isFile() || stat.size>8192)continue;
        const device=JSON.parse(fs.readFileSync(file,'utf8'));
        if(device.enabled!==true || !/^[a-z][a-z0-9_-]{0,40}$/.test(device.name||''))continue;
        let last={};try{last=JSON.parse(fs.readFileSync(path.join(seenDir,id+'.json'),'utf8'));}catch(_){}
        enqueueDeviceEvent({directory,hubUrl,id,device,ip:last.ip});
        state.seenDevices[id]=true;changed=true;
      } catch (_) { /* Retry unreadable or incomplete device records on the next scan. */ }
    }
    if(changed)save();
  }
  let nextDeliveryAt=0,deliveryBusy=false;
  async function flush() {
    if(deliveryBusy || now()<nextDeliveryAt)return;
    deliveryBusy=true;
    try {
      for(const file of fs.readdirSync(outbox).filter(x=>/^[a-z0-9-]+\.json$/.test(x)).sort().slice(0,100)) {
        const target=path.join(outbox,file);let event;
        try {const stat=fs.lstatSync(target);if(!stat.isFile()||stat.size>8192)continue;event=JSON.parse(fs.readFileSync(target,'utf8'));}
        catch (_) {continue;}
        if(event.version!==1 || typeof event.content!=='string' || event.content.length>1900 || !Number.isSafeInteger(event.attempts))continue;
        if(event.nextAttemptAt>now())continue;
        const device=/^device-([a-f0-9]{64})\.json$/.exec(file);
        if(device && !state.seenDevices[device[1]]) {state.seenDevices[device[1]]=true;save();}
        let result;
        try {result=await deliver(event.content);} catch (_) {result={status:0};}
        if(result.status>=200 && result.status<300) {
          fs.unlinkSync(target);
          if(result.resetAfter>0) {nextDeliveryAt=now()+Math.min(7*24*3600000,Math.ceil(result.resetAfter*1000));break;}
        } else {
          event.attempts=Math.min(event.attempts+1,1000000);
          const exponential=Math.min(60*60*1000,5000*2**Math.min(event.attempts-1,10));
          const wait=result.status===429 && result.retryAfter>0 ? Math.max(1000,Math.min(7*24*3600000,Math.ceil(result.retryAfter*1000))) : exponential;
          event.nextAttemptAt=now()+wait;
          writeJson(target,event);
          // Rate limits apply to the webhook, not only this event.
          if(result.status===429){nextDeliveryAt=event.nextAttemptAt;break;}
        }
      }
    } finally {deliveryBusy=false;}
  }
  function accountLabel(file) {
    let policy;try{policy=JSON.parse(fs.readFileSync(path.join(directory,'account-ownership.json'),'utf8')).accounts?.[file.id];}catch(_){}
    const provider=file.type==='codex'?'Codex':'Claude';
    if(policy?.visibility==='team') return `${provider}: ${clean(file.email,254)||'Shared account'}`;
    const owner=clean(policy?.owner,41);
    return `Personal ${provider} account${owner?` (owner: ${owner})`:''}`;
  }
  function validAccount(file) {
    if(!file || !['codex','claude'].includes(file.type) || typeof file.id!=='string' || path.basename(file.id)!==file.id ||
       !/^[A-Za-z0-9_.@-]{1,255}$/.test(file.id) || !/^[A-Za-z0-9_-]{1,128}$/.test(file.auth_index||''))return null;
    try {
      const p=path.join(authDir,file.id), stat=fs.lstatSync(p);
      if(!stat.isFile() || stat.size>1024*1024)return null;
      const auth=JSON.parse(fs.readFileSync(p,'utf8'));
      if(auth.type!==file.type || auth.disabled===true)return null;
      if(typeof auth.access_token!=='string' || !auth.access_token || typeof auth.refresh_token!=='string' || !auth.refresh_token)return {file,invalid:true,fileMtime:stat.mtimeMs};
      if(file.type==='codex' && !/^[A-Za-z0-9_-]{1,128}$/.test(auth.account_id||''))return {file,invalid:true,fileMtime:stat.mtimeMs};
      return {file,accountId:file.type==='codex'?auth.account_id:undefined,fileMtime:stat.mtimeMs};
    } catch (_) {return null;}
  }
  function authConcern(file) {
    const status=String(file.status_message||'').slice(0,2000);
    return /(?:^|\D)401(?:\D|$)|unauthori[sz]ed|invalid_grant|invalid[_ -]?token|token (?:expired|revoked)|authentication_error|refresh.{0,20}(?:expired|revoked|invalid|reuse)/i.test(status);
  }
  async function probe(account) {
    if(account.invalid)return 'invalid';
    const file=account.file, header={Authorization:'Bearer $TOKEN$',Accept:'application/json'};
    let url;
    if(file.type==='codex') {
      url='https://chatgpt.com/backend-api/wham/usage';header['ChatGPT-Account-ID']=account.accountId;header['User-Agent']='codex-tui/0.149.1';
    } else {
      url='https://api.anthropic.com/api/oauth/usage';header['User-Agent']='claude-cli/2.1.280 (external, cli)';header['anthropic-beta']='oauth-2025-04-20';
    }
    try {
      const result=await management('api-call',{auth_index:file.auth_index,method:'GET',url,header});
      if(result.status===400 && /auth token (?:not found|refresh failed)/i.test(result.value?.error||''))return 'invalid';
      if(result.status!==200)return 'transient';
      const status=result.value?.status_code;
      return status>=200&&status<300?'ok':status===401?'unauthorized':status===403?'forbidden':'transient';
    } catch (_) {return 'transient';}
  }
  async function repeatedProbe(account) {
    const results=[];
    for(let i=0;i<3;i++) {
      if(i)await pause(i===1?1500:4000);
      const result=await probe(account);results.push(result);
      if(result==='ok')return 'ok';
    }
    if(results.every(x=>x==='unauthorized'))return 'unauthorized';
    if(results.every(x=>x==='forbidden'))return 'forbidden';
    if(results.every(x=>x==='invalid'))return 'invalid';
    return 'transient';
  }
  async function checkAccount(account) {
    const file=account.file,id=hash(file.id),previous=state.accounts[id]||{};
    let outcome=await repeatedProbe(account),forced=false;
    if(outcome==='unauthorized' && !previous.incident && (!previous.lastForcedAt || now()-previous.lastForcedAt>=FORCE_INTERVAL)) {
      previous.lastForcedAt=now();state.accounts[id]=previous;save();forced=true;
      try {await management('auth-files/refresh',{name:file.id,auth_index:file.auth_index},45000);} catch (_) {}
      await pause(1500);outcome=await repeatedProbe(account);
    }
    previous.lastCheckAt=now();
    previous.fileMtime=account.fileMtime;
    previous.nextProbeAt=now()+(outcome==='transient'?STATUS_INTERVAL:CHECK_INTERVAL);
    if(outcome==='ok' && file.unavailable===true && authConcern(file)) {
      if(!previous.suspectSince) previous.suspectSince=now();
      if(now()-previous.suspectSince>=STATUS_INTERVAL) outcome='recorded';
      else previous.nextProbeAt=now()+STATUS_INTERVAL;
    } else if(outcome==='ok') previous.suspectSince=0;
    if(outcome==='ok') {previous.incident=false;previous.lastAlertAt=0;}
    else if(['unauthorized','forbidden','invalid','recorded'].includes(outcome)) {
      if(!previous.incident || !previous.lastAlertAt || now()-previous.lastAlertAt>=REMINDER_INTERVAL) {
        const note=outcome==='recorded'?'The hub reports a persistent authentication error, although the basic account check succeeded.':
          outcome==='forbidden'?'Provider access was denied after repeated checks.':'Authentication failed after repeated checks'+(forced?' and an automatic refresh attempt.':'.');
        const text=`⚠️ Multi-Account Hub: account needs attention\n${accountLabel(file)}\n${note}\nReconnect it ${hubUrl?`in the hub website (${hubUrl})`:'on the hub computer'} if needed.`;
        enqueue(`auth-${id}-${Math.floor(now()/REMINDER_INTERVAL)}`,text);
        previous.lastAlertAt=now();
      }
      previous.incident=true;
    }
    state.accounts[id]=previous;save();
  }
  let healthBusy=false,lastStatusAt=0;
  async function checkHealth({force=false}={}) {
    if(healthBusy)return;
    if(!force && now()-lastStatusAt<STATUS_INTERVAL)return;
    healthBusy=true;lastStatusAt=now();
    try {
      const response=await management('auth-files');
      const files=response.status===200&&Array.isArray(response.value?.files)?response.value.files:null;
      if(!files || files.length>1000)return;
      const due=[];
      for(const file of files) {
        const account=validAccount(file);if(!account)continue;
        const previous=state.accounts[hash(file.id)]||{};
        if(force || !previous.nextProbeAt || previous.nextProbeAt<=now() || (previous.incident && account.fileMtime!==previous.fileMtime) ||
           (authConcern(file) && !previous.incident && (!previous.lastCheckAt || now()-previous.lastCheckAt>=STATUS_INTERVAL)))due.push(account);
      }
      let cursor=0;
      await Promise.all(Array.from({length:Math.min(2,due.length)},async()=>{
        while(cursor<due.length){const account=due[cursor++];await checkAccount(account);}
      }));
    } finally {healthBusy=false;}
  }
  function status() {
    const queue=fs.readdirSync(outbox).filter(x=>/^[a-z0-9-]+\.json$/.test(x));
    return {queued:queue.length,accounts:Object.values(state.accounts).length,incidents:Object.values(state.accounts).filter(a=>a.incident).length};
  }
  return {scanDevices,flush,checkHealth,status,enqueue,accountLabel};
}
module.exports={createMonitor,managementClient,discordDelivery,enqueueDeviceEvent};
