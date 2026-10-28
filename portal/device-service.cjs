'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const net=require('node:net');

function cleanLabel(value, max=80) {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g,'').trim().slice(0,max) : '';
}
function clientIp(headers) {
  // This service is behind the loopback-only Cloudflare Tunnel gateway.
  // CF-Connecting-IP is supplied by Cloudflare; forwarded-for is not trusted.
  const ipv6=headers['cf-connecting-ipv6'];
  if (typeof ipv6==='string' && net.isIP(ipv6)===6) return ipv6;
  const value=headers['cf-connecting-ip'];
  return typeof value==='string' && net.isIP(value) ? value : '';
}
function createDevices({directory, now=Date.now}) {
  const devicesDir=path.join(directory,'devices'), seenDir=path.join(directory,'device-last-seen');
  const last=new Map();
  function note(id,ip,kind='device') {
    if (!/^[a-f0-9]{64}$/.test(id) || !['device','legacy'].includes(kind)) return;
    ip=typeof ip==='string' && net.isIP(ip) ? ip : '';
    const previous=last.get(id), current=now();
    if (previous && previous.ip===ip && current-previous.at<60000) return;
    try {
      fs.mkdirSync(seenDir,{recursive:true,mode:0o700});
      const temporary=path.join(seenDir,`.seen-${crypto.randomBytes(12).toString('hex')}.tmp`);
      try {
        fs.writeFileSync(temporary,JSON.stringify({kind,ip,seenAt:new Date(current).toISOString()})+'\n',{mode:0o600,flag:'wx'});
        fs.renameSync(temporary,path.join(seenDir,`${id}.json`));
      } finally {try {fs.unlinkSync(temporary);} catch(error){if(error.code!=='ENOENT')throw error;}}
      last.set(id,{ip,at:current});
    } catch (_) { /* Device telemetry must not interrupt model requests. */ }
  }
  function seen(id) {
    try {
      const data=JSON.parse(fs.readFileSync(path.join(seenDir,`${id}.json`),'utf8'));
      const ip=typeof data.ip==='string' && net.isIP(data.ip) ? data.ip : '';
      const date=typeof data.seenAt==='string' && Number.isFinite(Date.parse(data.seenAt)) ? data.seenAt : null;
      return {lastIp:ip,lastSeenAt:date};
    } catch (_) {return {lastIp:'',lastSeenAt:null};}
  }
  function list() {
    let files=[];
    try {files=fs.readdirSync(devicesDir);} catch(error) {if(error.code!=='ENOENT')throw error;}
    if (files.length>5000) throw new Error('too many devices');
    const result=[];
    for (const file of files) {
      const match=/^([a-f0-9]{64})\.json$/.exec(file); if (!match) continue;
      let record;
      try {record=JSON.parse(fs.readFileSync(path.join(devicesDir,file),'utf8'));} catch (_) {continue;}
      if (!record || !/^[a-z][a-z0-9_-]{0,40}$/.test(record.name||'') || typeof record.email!=='string' || record.email.length>254) continue;
      result.push({id:match[1],kind:'device',user:record.name,email:record.email,enabled:record.enabled===true,
        name:cleanLabel(record.deviceName)||'Unnamed computer',platform:cleanLabel(record.platform,40),
        createdAt:record.createdAt||null,...seen(match[1])});
    }
    let users=[];
    try {users=JSON.parse(fs.readFileSync(path.join(directory,'gateway-users.json'),'utf8')).users || [];} catch (_) {}
    for (const user of users) {
      if (!/^[a-f0-9]{64}$/.test(user.keyHash||'')) continue;
      const info=seen(user.keyHash);
      if (!info.lastSeenAt) continue;
      result.push({id:user.keyHash,kind:'legacy',user:cleanLabel(user.name,41),email:cleanLabel(user.email,254),
        enabled:user.enabled===true,name:'Legacy shared credential',platform:'',createdAt:null,...info});
    }
    return result.sort((a,b)=>String(b.lastSeenAt||b.createdAt||'').localeCompare(String(a.lastSeenAt||a.createdAt||'')));
  }
  function revoke(id) {
    if (typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id)) throw new Error('invalid device');
    fs.unlinkSync(path.join(devicesDir,`${id}.json`));
    try {fs.unlinkSync(path.join(seenDir,`${id}.json`));} catch (_) {}
    last.delete(id);
  }
  return {list,note,revoke};
}
module.exports={createDevices,cleanLabel,clientIp};
