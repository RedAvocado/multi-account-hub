'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Scheduling reads this local snapshot, never a provider endpoint on the
// request path. Atomic replacement prevents readers seeing half-written JSON.
function createRoutingUsage({directory, usage}) {
  let pending;
  function refresh() {
    if (pending) return pending;
    pending = Promise.resolve().then(async () => {
      const snapshot = await usage.getForRouting();
      const temporary = path.join(directory, `.routing-usage-${crypto.randomBytes(12).toString('hex')}.tmp`);
      try {
        fs.writeFileSync(temporary, JSON.stringify(snapshot) + '\n', {mode: 0o600, flag: 'wx'});
        fs.renameSync(temporary, path.join(directory, 'routing-usage.json'));
      } finally {
        try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }).finally(() => { pending = undefined; });
    return pending;
  }
  return {refresh};
}

module.exports = {createRoutingUsage};
