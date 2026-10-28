# Third-party sources

This repository contains local patches against these MIT-licensed projects:

- CLIProxyAPI: https://github.com/router-for-me/CLIProxyAPI
  License: `upstream/licenses/proxy-LICENSE`.
- CLIProxyAPI key-router: https://github.com/tuzilj1/cliproxyapi-key-router
  License: `upstream/licenses/router-LICENSE`.

Exact upstream commits are recorded in `upstream/sources.json`. Upstream source
checkouts and compiled binaries are not committed. The Google authentication
library and its dependencies are pinned in `portal/package-lock.json` and
retain their own licenses when installed.

The DittoDub logo in `portal/public/` and `assets/` comes from the DittoDub press
kit. The name and logo belong to DittoDub and are not covered by any license
for this code; replace them in forks.
