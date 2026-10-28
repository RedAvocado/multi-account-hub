'use strict';

// Deployment settings live in a private hub.json beside the source, so the
// code carries no hostnames, domains, or local paths. See
// examples/hub.example.json (website + Google sign-in) and
// examples/hub.tailscale.example.json (Tailscale only).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_LABEL_PREFIX = 'com.dittodub.multi-account-hub.';

function origin(value, field) {
  if (typeof value !== 'string' || !/^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/.test(value) || new URL(value).origin !== value) {
    throw new Error(`hub.json: ${field} must be an https origin such as https://hub.example.com`);
  }
  return value;
}

function expandHome(value) {
  return value === '~' || value.startsWith('~/') ? path.join(os.homedir(), value.slice(1)) : value;
}

function portalSettings(raw, origins) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('hub.json: portal must be an object or omitted');
  const workspaceDomain = raw.workspaceDomain;
  if (typeof workspaceDomain !== 'string' || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(workspaceDomain)) {
    throw new Error('hub.json: portal.workspaceDomain must be a lowercase domain such as example.com');
  }
  const googleRedirectUri = raw.googleRedirectUri ?? origins[0] + '/';
  let redirect;
  try { redirect = new URL(googleRedirectUri); } catch (_) { redirect = null; }
  if (!redirect || !origins.includes(redirect.origin) || redirect.search || redirect.hash) {
    throw new Error('hub.json: portal.googleRedirectUri must be on the hub URL or an alternate URL');
  }
  const credentials = raw.googleCredentialsFile ?? '~/.config/multi-account-hub/google-oauth.env';
  if (typeof credentials !== 'string' || !credentials) throw new Error('hub.json: portal.googleCredentialsFile must be a path');
  return Object.freeze({workspaceDomain, googleRedirectUri, googleCredentialsFile: path.resolve(expandHome(credentials))});
}

function loadHubConfig(directory) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.join(directory, 'hub.json'), 'utf8')); }
  catch (_) { throw new Error('hub.json is missing or invalid. Copy one of the examples/hub.*.json files and fill it in.'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('hub.json must contain an object.');
  const hubUrl = origin(raw.hubUrl, 'hubUrl');
  const alternateUrls = (raw.alternateUrls ?? []).map((value, index) => origin(value, `alternateUrls[${index}]`));
  const origins = [hubUrl, ...alternateUrls];
  const labelPrefix = raw.launchdLabelPrefix ?? DEFAULT_LABEL_PREFIX;
  if (typeof labelPrefix !== 'string' || !/^[A-Za-z0-9.-]+$/.test(labelPrefix)) throw new Error('hub.json: launchdLabelPrefix is invalid');
  return Object.freeze({
    hubUrl,
    alternateUrls: Object.freeze(alternateUrls),
    hosts: Object.freeze(origins.map(value => new URL(value).host)),
    portal: portalSettings(raw.portal, origins),
    launchdLabelPrefix: labelPrefix,
  });
}

// Setup scripts are served with the hub's own addresses filled in.
function renderClientScript(text, config) {
  return text.replaceAll('__HUB_ORIGIN__', config.hubUrl)
    .replace('/* __HUB_ALTERNATE_ORIGINS__ */', config.alternateUrls.map(value => JSON.stringify(value)).join(', '));
}

module.exports = {loadHubConfig, renderClientScript, DEFAULT_LABEL_PREFIX};
