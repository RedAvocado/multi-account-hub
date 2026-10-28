#!/usr/bin/env node
'use strict';
const path=require('node:path');
const {createMonitor}=require('./monitor-service.cjs');
const {loadHubConfig}=require('./hub-config.cjs');
process.umask(0o077);
const directory=path.join(process.env.HOME,'.local/share/cliproxy-hub');
const authDir=path.join(process.env.HOME,'.cli-proxy-api');
const hub=loadHubConfig(directory);
// Alerts link to the website when there is one; otherwise to the admin CLI.
const monitor=createMonitor({directory,authDir,hubUrl:hub.portal?hub.hubUrl+'/':''});
let stopped=false;
function scanAndDeliver() {
  if(stopped)return;
  try {monitor.scanDevices();} catch (_) {}
  void monitor.flush().catch(()=>{});
}
function health() {if(!stopped)void monitor.checkHealth().catch(()=>{});}
scanAndDeliver();health();
const scanTimer=setInterval(scanAndDeliver,5000),healthTimer=setInterval(health,60000);
function shutdown() {stopped=true;clearInterval(scanTimer);clearInterval(healthTimer);setTimeout(()=>process.exit(0),1000).unref();}
process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
