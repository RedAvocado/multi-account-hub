#!/usr/bin/env node
'use strict';
const path=require('node:path');
const {createMonitor}=require('./monitor-service.cjs');
const {loadHubConfig}=require('./hub-config.cjs');
const {createAdministration}=require('./admin-service.cjs');
const {createUsage}=require('./usage-service.cjs');
const {createRoutingUsage}=require('./routing-usage-service.cjs');
const {createUsageHistory}=require('./usage-history-service.cjs');
const {createClaudeExtraUsagePolicy}=require('./claude-extra-usage-policy.cjs');
const {createResetCreditWatcher}=require('./reset-credit-watcher.cjs');
process.umask(0o077);
const directory=path.join(process.env.HOME,'.local/share/cliproxy-hub');
const authDir=path.join(process.env.HOME,'.cli-proxy-api');
const hub=loadHubConfig(directory);
// Alerts link to the website when there is one; otherwise to the admin CLI.
const monitor=createMonitor({directory,authDir,hubUrl:hub.portal?hub.hubUrl+'/':''});
const usage=createUsage({
  admin:createAdministration({directory,authDir}),authDir,details:false,routingCredits:true,
});
const routingUsage=createRoutingUsage({directory,history:createUsageHistory({directory}),usage});
const claudePolicy=createClaudeExtraUsagePolicy({directory,authDir});
// Keep an optional watcher failure isolated from quota feeds and model traffic.
let resetWatcher;
try {
  resetWatcher=createResetCreditWatcher({directory,authDir,enqueue:monitor.enqueue,accountLabel:monitor.accountLabel,
    async afterReset(id) {
      usage.invalidateAccount(id);
      await routingUsage.refresh();
      // A refresh already in progress may have observed the pre-reset generation.
      await routingUsage.refresh();
    }});
} catch (_) {
  console.error('Reset credit watcher could not start; check its private state.');
  try {monitor.enqueue('reset-watcher-start-failed','⚠️ Multi-Account Hub: automatic banked reset redemption could not start. Check the private watcher state on the hub computer. Model requests are still running.');} catch (_) {}
}
let stopped=false;
let quotaTimer;
let policyTimer;
function scanAndDeliver() {
  if(stopped)return;
  try {monitor.scanDevices();} catch (_) {}
  void monitor.flush().catch(()=>{});
}
function health() {if(!stopped)void monitor.checkHealth().catch(()=>{});}
function quotas() {
  if(stopped)return;
  void routingUsage.refresh().catch(()=>{}).finally(()=>{
    if(!stopped)quotaTimer=setTimeout(quotas,50000+Math.floor(Math.random()*20000));
  });
}
function billingPolicy() {
  if(stopped)return;
  void claudePolicy.refresh().catch(()=>{}).finally(()=>{
    if(!stopped)policyTimer=setTimeout(billingPolicy,60000);
  });
}
function resetDiscovery() {if(!stopped && resetWatcher)void resetWatcher.refresh().catch(()=>{});}
function resetDeadlines() {if(!stopped && resetWatcher)void resetWatcher.redeemDue().catch(()=>{});}
scanAndDeliver();health();quotas();billingPolicy();resetDiscovery();resetDeadlines();
const scanTimer=setInterval(scanAndDeliver,5000),healthTimer=setInterval(health,60000);
const resetDiscoveryTimer=setInterval(resetDiscovery,30000),resetDeadlineTimer=setInterval(resetDeadlines,1000);
function shutdown() {stopped=true;resetWatcher?.stop();clearInterval(resetDiscoveryTimer);clearInterval(resetDeadlineTimer);clearInterval(scanTimer);clearInterval(healthTimer);clearTimeout(quotaTimer);clearTimeout(policyTimer);setTimeout(()=>process.exit(0),1000).unref();}
process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
