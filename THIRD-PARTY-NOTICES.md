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
kit. The name and logo belong to DittoDub and are not covered by this
project's MIT license; replace them in forks.

The music in `assets/multi-account-hub.mp4` is "Mechanichal Meaning of a Peanut" by
Lemoneight (https://ccmixter.org/files/Lemoneight/61928), licensed under
Creative Commons Attribution 3.0 (https://creativecommons.org/licenses/by/3.0/).
