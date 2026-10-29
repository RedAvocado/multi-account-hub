#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {parseEnv} = require('node:util');
const {OAuth2Client} = require('google-auth-library');
const {createPortal} = require('./portal-service.cjs');
const {createAdministration} = require('./admin-service.cjs');
const {createUsage} = require('./usage-service.cjs');
const {createUsageHistory} = require('./usage-history-service.cjs');
const {createProviderConnect} = require('./provider-connect-service.cjs');
const {createDevices} = require('./device-service.cjs');
const {enqueueDeviceEvent} = require('./monitor-service.cjs');
const {loadHubConfig} = require('./hub-config.cjs');

process.umask(0o077);
const directory = path.join(process.env.HOME, '.local/share/cliproxy-hub');
const hub = loadHubConfig(directory);
if (!hub.portal) {
  console.error('The website is not configured in hub.json, so the portal is not needed. Unload its LaunchAgent.');
  process.exit(78);
}
const credentialsPath = hub.portal.googleCredentialsFile;
if (fs.statSync(credentialsPath).mode & 0o077) throw new Error('Google credentials must be private');
const credentials = parseEnv(fs.readFileSync(credentialsPath, 'utf8'));
if (!credentials.GOOGLE_CLIENT_ID || !credentials.GOOGLE_CLIENT_SECRET) throw new Error('Google credentials unavailable');
const origin = hub.hubUrl;
const redirectUri = hub.portal.googleRedirectUri;
const callbackOrigin = new URL(redirectUri).origin;
const callbackPath = new URL(redirectUri).pathname;
const client = new OAuth2Client({clientId: credentials.GOOGLE_CLIENT_ID, clientSecret: credentials.GOOGLE_CLIENT_SECRET,
  redirectUri});
client.transporter.defaults.timeout = 20000;
client.transporter.defaults.maxRedirects = 0;
const oauth = {
  authorizationUrl({state, nonce, challenge}) {
    return client.generateAuthUrl({access_type: 'online', scope: ['openid', 'email', 'profile'], state, nonce,
      prompt: 'select_account', code_challenge: challenge, code_challenge_method: 'S256'});
  },
  async exchange({code, verifier}) {
    const {tokens} = await client.getToken({code, codeVerifier: verifier});
    if (!tokens.id_token) throw new Error('Identity unavailable');
    const ticket = await client.verifyIdToken({idToken: tokens.id_token, audience: credentials.GOOGLE_CLIENT_ID});
    return ticket.getPayload();
  },
};
const authDir = path.join(process.env.HOME, '.cli-proxy-api');
const admin = createAdministration({directory, authDir});
const usage = createUsage({admin, authDir, history: createUsageHistory({directory})});
const devices = createDevices({directory});
const providerConnect = createProviderConnect({directory,admin});
const server = createPortal({directory, origin, callbackOrigin, callbackPath, workspaceDomain: hub.portal.workspaceDomain,
  oauth, admin, usage, providerConnect, devices,
  notifyDevice: event => enqueueDeviceEvent({directory, hubUrl: origin + '/', ...event})});
server.listen(18318, '127.0.0.1');
process.once('SIGTERM', () => {
  providerConnect.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});
