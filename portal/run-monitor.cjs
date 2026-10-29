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
process.umask(0o077);
const directory=path.join(process.env.HOME,'.local/share/cliproxy-hub');
const authDir=path.join(process.env.HOME,'.cli-proxy-api');
const hub=loadHubConfig(directory);
// Alerts link to the website when there is one; otherwise to the admin CLI.
const monitor=createMonitor({directory,authDir,hubUrl:hub.portal?hub.hubUrl+'/':''});
const routingUsage=createRoutingUsage({directory,history:createUsageHistory({directory}),usage:createUsage({
  admin:createAdministration({directory,authDir}),authDir,details:false,routingCredits:true,
})});
const claudePolicy=createClaudeExtraUsagePolicy({directory,authDir});
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
scanAndDeliver();health();quotas();billingPolicy();
const scanTimer=setInterval(scanAndDeliver,5000),healthTimer=setInterval(health,60000);
function shutdown() {stopped=true;clearInterval(scanTimer);clearInterval(healthTimer);clearTimeout(quotaTimer);clearTimeout(policyTimer);setTimeout(()=>process.exit(0),1000).unref();}
process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
