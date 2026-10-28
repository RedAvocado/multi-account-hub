'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createPortal} = require('../portal/portal-service.cjs');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-account-hub-preview-'));
const origin = 'http://127.0.0.1:18765';
fs.writeFileSync(path.join(directory, 'gateway-users.json'), JSON.stringify({users: [
  {name: 'riley', email: 'riley@example.org', enabled: true, role: 'admin', owner: true, keyHash: 'a'.repeat(64)},
  {name: 'jordan', email: 'jordan@example.org', enabled: true, keyHash: 'b'.repeat(64)},
]}));
const data = {version: 'a'.repeat(64), accounts: [
  {id: 'codex-work.json', provider: 'codex', email: 'work@example.com', personal: false, disabled: false, owner:'riley', visibility:'team'},
  {id: 'codex-personal.json', provider: 'codex', email: 'owner-private@example.net', personal: true, disabled: false, owner:'riley', visibility:'personal'},
  {id: 'claude-work.json', provider: 'claude', email: 'work@example.com', displayName: 'Team Claude', organization: "work@example.com's Organization", personal: true, disabled: false, owner:'riley', visibility:'personal'},
  {id: 'claude-old.json', provider: 'claude', email: 'work@example.com', organization: "work@example.com's Organization", personal: false, disabled: true},
], users: [
  {name: 'riley', email: 'riley@example.org', enabled: true, editable: true, role:'admin', owner: true, accounts: ['codex-work.json','codex-personal.json']},
  {name: 'jordan', email: 'jordan@example.org', enabled: true, editable: true, role:'member', accounts: ['codex-work.json']},
]};
let nonce;
const oauth = {authorizationUrl(args) {nonce = args.nonce; return `${origin}/oauth/callback?state=${args.state}&code=synthetic`;},
  async exchange() {return {email: 'riley@example.org', email_verified: true, hd: 'example.org', sub: 'synthetic-riley', nonce};}};
const admin = {async snapshot() {return data;}, async setPermissions(input) {data.users.find(u=>u.name===input.user).accounts=input.accounts;return {ok:true};},
  async setEnabled(input) {data.users.find(u=>u.name===input.user).enabled=input.enabled;return {ok:true};},
  async mine(current) {return {version:data.version,accounts:data.accounts.filter(a=>a.owner===current.name && !a.disabled)};},
  async setVisibility(current,input) {data.accounts.find(a=>a.id===input.id).visibility=input.visibility;return {ok:true};}};
const usage = {async getForUser() {return {accounts: [
  {provider:'codex',email:'work@example.com',plan:'pro',organization:'',windows:[{label:'1w',remaining:56,resetsAt:'2026-11-01T19:00:00Z'}],bankedResets:2,resetExpirations:['2026-11-03T19:00:00Z'],renewsAt:'2026-11-07T19:00:00Z',checkedAt:new Date().toISOString(),stale:false},
  {provider:'codex',email:'personal@example.com',plan:'pro',organization:'',windows:[{label:'1w',remaining:9,resetsAt:'2026-11-01T19:00:00Z'}],bankedResets:2,resetExpirations:[],renewsAt:null,checkedAt:new Date().toISOString(),stale:false},
  {provider:'claude',email:'work@example.com',displayName:'Team Claude',plan:'Max',organization:"work@example.com's Organization",windows:[{label:'5h',remaining:92,resetsAt:'2026-10-27T19:00:00Z'},{label:'1w',remaining:65,resetsAt:'2026-11-01T19:00:00Z'}],bankedResets:null,resetExpirations:[],renewsAt:null,checkedAt:new Date().toISOString(),stale:false},
]};}};
let providerState = {status:'idle'};
const providerConnect = {
  async start(current,input) {providerState={status:'waiting',provider:input.provider,visibility:input.visibility,url:input.provider==='codex'?'https://auth.openai.com/codex/device':'https://claude.ai/oauth/authorize?synthetic=1',deviceCode:'TEST-1234'};return providerState;},
  async submit() {providerState={status:'complete',account:'demo@example.com',assigned:true,visibility:'personal'};return providerState;},
  async status() {return providerState;},async cancel() {providerState={status:'idle'};},
};
const devices={list(){return [{id:'a'.repeat(64),kind:'device',name:'Example laptop',email:'jordan@example.org',platform:'Darwin',lastIp:'203.0.113.42',lastSeenAt:new Date().toISOString()}];},revoke(){},note(){}};
const server=createPortal({directory, origin, workspaceDomain: 'example.org', oauth, admin, usage, providerConnect, devices});
server.listen(18765,'127.0.0.1');
process.on('SIGINT',()=>server.close(()=>{fs.rmSync(directory,{recursive:true,force:true});process.exit(0);}));
