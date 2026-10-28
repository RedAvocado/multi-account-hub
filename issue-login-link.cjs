#!/usr/bin/env node
'use strict';
const path = require('node:path');
const {issueLoginLink} = require('./portal/login-link-service.cjs');
const {loadHubConfig} = require('./portal/hub-config.cjs');
process.umask(0o077);
try {
  if (process.argv.length !== 3) throw new Error('Expected one member email');
  const directory = path.join(process.env.HOME, '.local/share/cliproxy-hub');
  const hub = loadHubConfig(directory);
  if (!hub.portal) throw new Error('No website');
  const result = issueLoginLink({directory, email: process.argv[2], workspaceDomain: hub.portal.workspaceDomain});
  console.log(`${hub.hubUrl}/login-link#${result.token}`);
  console.log(`Single use for ${result.email}; expires ${new Date(result.expires).toISOString()}.`);
} catch (_) {
  console.error('Could not issue a login link. Check hub.json, the enabled member, and private identity files.');
  process.exitCode = 1;
}
