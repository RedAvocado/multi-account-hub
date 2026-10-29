<p align="center"><img src="assets/banner.png" alt="DittoDub logo above the title Multi-Account Hub" width="100%"></p>

One always-on computer holds all your Claude and Codex accounts. Every
computer you work on connects to it with its own key: laptops, desktops,
servers. T3 Code shows each account's remaining usage and can spend Codex reset
credits from its usage panel.

It works for one person or for many:

- **Solo.** Sign each account in once, on one machine at home, and use them all
  from every computer you own.
- **Many solos, one hub.** Each person connects their own accounts, and those
  accounts stay theirs: only that person's computers use them. One hub runs
  everyone's setup, so nobody keeps their own box alive.

Run it privately over **Tailscale**, or add an optional **website** where people
sign in with Google, connect their computers and add their own accounts.

<p align="center"><a href="assets/multi-account-hub.mp4"><img src="assets/video-poster.png" alt="Watch the 32-second tour of Multi-Account Hub" width="480"></a><br><sub>Music: "Mechanichal Meaning of a Peanut" by Lemoneight, <a href="https://creativecommons.org/licenses/by/3.0/">CC BY 3.0</a></sub></p>

## Inspired by T3 Code

We spend our days in [T3 Code](https://t3.codes), and this hub grew out of it.
Theo's guide, [How I manage 7 Claude and 3 Codex accounts across 12+ computers](https://gist.github.com/t3dotgg/59a521d2ee8d70aaf90e280c175072af),
lays out the idea:

- Sign every account into one always-on box at home running
  [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI).
- Point every machine at it over Tailscale.
- Let T3 Code read each account's limits through its **Usage providers**
  setting.

We wanted that for several people, each with their own accounts, without
everyone running a box. T3 Code shaped the result in three ways:

- **Usage where you work.** The hub speaks the CLIProxy usage API that T3 Code's
  usage panel reads. Each computer sees its accounts' live limits, reset times
  and banked Codex resets, and can redeem a reset without leaving T3.
- **Setup by prompt.** To connect a computer, paste one prompt into the coding
  agent you already use. The agent runs the setup script, which adds **HUB
  Codex** and **HUB Claude** providers to T3 Code and turns on usage.
- **Same rules as the guide.** One home machine, no datacenter sign-ins,
  session affinity so prompt caches stay warm, and Codex over WebSockets.

What the hub adds:

- **Accounts stay personal.** An account is used only for the person who
  connected it, and administrators can't change that. Its owner can choose to
  share it, but nothing is shared by default.
- **A key per computer.** Every computer gets its own key, and any one can be
  revoked without touching the others. The hub stores only hashes.
- **Watchdog and alerts.** A cron watchdog restarts stopped services and posts
  to Discord when a service, the public route or an account's sign-in needs
  attention.

> [!WARNING]
> Routing subscriptions through a proxy may break a provider's terms, and
> accounts can be banned. Keep Theo's two rules: use your subscriptions for
> your own work, never to serve anyone else's traffic, and use Claude
> subscriptions only from Claude Code. Run the hub at home, never on a VPS or
> behind a VPN.

<p align="center"><img src="assets/portal.png" alt="The hub website: usage per account and computer setup" width="760"></p>

## How it works

```
 T3 Code · Codex CLI · Claude Code      (one key per computer)
                 │
     Tailscale  ─┴─  or Cloudflare Tunnel + website
                 │
   gateway       checks the key → member → that member's accounts
                 │                (member keys never leave the hub)
   CLIProxyAPI   + key router: picks one of the member's accounts,
                 │               keeps sessions on the same account
   Anthropic · OpenAI
```

| Piece | What it does |
| --- | --- |
| `team-gateway.cjs` | The only listener clients reach. Authenticates computer keys, exposes only the model, usage and reset endpoints, and streams without logging bodies. |
| CLIProxyAPI + key router | Pinned upstream builds with local patches (`upstream/`) so each member can use only the accounts assigned to them. Requests fail closed if routing is unavailable. |
| `portal/` | Optional website: Google sign-in, setup prompts, connecting accounts, access settings and computers. |
| `hub-admin.py` | Members, computers and account sharing from the hub's terminal. This is everything a Tailscale-only hub needs. |
| `watchdog.py`, `portal/run-monitor.cjs` | Availability checks, account sign-in health and Discord alerts. |
| `onboarding/`, `scripts/configure-t3-usage.cjs` | Client setup the hub serves with its own address filled in. |

### Choosing an account

New sessions use a weighted choice among the member's permitted, available
accounts. More remaining quota gets more weight; an approaching quota reset
adds a small bonus. Every applicable window counts, so an empty weekly quota
cannot be offset by a full five-hour quota. Claude model-specific limits apply
only to that model family; Cowork limits do not constrain coding requests.

The selection keeps a 3% reserve for existing sessions when healthier accounts
are available. Healthy sessions stay on the same account for prompt caching,
with a one-hour idle timeout. At an observed, unrounded zero, subsequent
requests move to another permitted account. A provider quota rejection before
streaming also retries another available account. Responses already streaming
are not replayed, which avoids duplicate output or tool calls.

The monitor refreshes private quota data roughly once a minute into
`routing-usage.json`; selection makes no provider calls. Observations older
than three minutes become unknown, rather than looking like unlimited quota
or locking users out. Unknown accounts together receive at most 20% of new
sessions when known healthy alternatives exist. Missing telemetry preserves
existing session bindings and falls back to equal weighting for new sessions.

Weights use relative percentages, without guessing different plans' token
capacities. Accounts with banked Codex resets expiring within seven days receive
up to 4× the weight for new sessions. More available credits and nearer
expirations strengthen the preference, while actual quota and the 3% admission
reserve still apply. Credit details refresh every five minutes and when the
available count changes, with a separate 15-minute freshness limit. An uncertain
count change suppresses the credit bonus. Selection does not redeem credits;
use the existing reset action to apply them. Account priority and primary/access permissions
still apply.
Replacing the plugin resets its in-memory bindings once; normal quota updates
do not move healthy sessions.

## Choose a mode

|  | Tailscale only | Website |
| --- | --- | --- |
| Who can reach it | Devices on your tailnet | Anyone on the internet (every request still needs a key) |
| Signing in | None; the hub admin issues keys | Google Workspace accounts on your domain |
| Connecting a computer | `hub-admin.py add-device`, then `setup.sh --key` | Paste the setup prompt from the website |
| Connecting provider accounts | Hub terminal, then `hub-admin.py share` | In the browser |
| Extra services | none | Cloudflare Tunnel, Google OAuth client |

Both modes share the same gateway, router, admin tool and T3 Code integration,
and you can add the website later.

## Set up a hub

The hub runs on macOS with LaunchAgents. Keep the Mac plugged in, awake and
signed in. You need Node.js 24+, Python 3.9+, Xcode Command Line Tools and Go
(the build fetches the pinned toolchain).

**1. Build.** Clone into `~/.local/share/cliproxy-hub`, install the portal's
one dependency, then build the patched proxy, router and sign-in helper.
`--prepare-only` checks the patches without compiling.

```bash
git clone https://github.com/RedAvocado/multi-account-hub ~/.local/share/cliproxy-hub
cd ~/.local/share/cliproxy-hub
npm ci --prefix portal --ignore-scripts --no-audit --no-fund
python3 scripts/build-upstream.py
```

Copy the artifacts from `.build/upstream-*/artifacts`:

- `cliproxyapi-guarded` and `cliproxyapi-auth-helper` go in the hub directory.
- The router goes at `plugins/key-router.dylib`.

**2. Configure.** Copy the examples, replace every placeholder, and keep secret
files mode `0600`:

| Copy | To | Notes |
| --- | --- | --- |
| `examples/hub.tailscale.example.json` *or* `examples/hub.example.json` | `hub.json` | The mode, the address clients use, and (website only) your Google Workspace domain |
| `examples/guarded-config.example.yaml` | `guarded-config.yaml` | Proxy settings: loopback only, router on, request logging off |
| `examples/gateway-users.example.json` | `gateway-users.json` | Start with `{"users": []}`; `add-member` fills it in |
| `examples/account-ownership.example.json` | `account-ownership.json` | Who owns each provider account |

Then:

- Put the proxy's management secret in `~/.cli-proxy-api/management-key`.
- Put a Discord webhook URL in `discord-webhook-url` to get alerts.

**3. Start the services.** In copies of `examples/launchd/*.plist.example`:

1. Replace `__HOME__` and check the Node and cloudflared paths.
2. Install them in `~/Library/LaunchAgents` and `launchctl bootstrap` them.

A Tailscale-only hub needs only `proxy`, `gateway`, `monitor` and
`cli-updates`. Then add the watchdog to your crontab:

```cron
* * * * * /usr/bin/python3 $HOME/.local/share/cliproxy-hub/watchdog.py >> $HOME/.local/share/cliproxy-hub/watchdog-cron.log 2>&1
```

**4a. Tailscale.** Serve the gateway to your tailnet. Set `hubUrl` in
`hub.json` to the resulting address, such as `https://hub.your-tailnet.ts.net`.

```bash
tailscale serve --bg --https=443 http://127.0.0.1:18317
```

**4b. Website.** Create a Cloudflare Tunnel to `http://127.0.0.1:18317` (see
`examples/tunnel.example.yaml`), and a Google OAuth web client whose redirect
URI is your `hubUrl` followed by `/`. Store its `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET` in the private file named by
`portal.googleCredentialsFile`. Then load the `portal` and `tunnel` agents.

**5. Add people and accounts.** Run these from the hub directory:

```bash
python3 hub-admin.py add-member alex alex@example.com --admin

# Sign a provider account in on the hub, then say who owns it and who can use it
./cliproxyapi-auth-helper -config guarded-config.yaml -codex-device-login
./cliproxyapi-auth-helper -config guarded-config.yaml -claude-login
python3 hub-admin.py accounts
python3 hub-admin.py share codex:alex@example.com alex personal
python3 hub-admin.py enable alex
```

A member without any accounts starts disabled until one is connected for
them, then `enable` turns them on. If an owner has chosen to share an account,
new members get it automatically. On your
own record in `gateway-users.json`, set `"owner": true` so nobody can disable
you from the website. Once the website is running, people can connect their
own accounts in the browser instead.

**6. Connect computers.**

- **Website:** sign in, click **Create setup prompt**, and paste it into the
  coding agent on the computer that runs T3 Code.
- **Tailscale:** run `python3 hub-admin.py add-device alex "Alex's laptop"`. It
  prints a one-time key and the command to run on that computer:

```bash
setup_dir="$(mktemp -d)" && curl -fsS https://hub.your-tailnet.ts.net/setup-provider-hub.sh -o "$setup_dir/setup.sh" && bash "$setup_dir/setup.sh" --key
```

The script writes a private Codex home and a Claude launcher under
`~/.dittodub-provider-hub`. It registers **HUB Codex** and **HUB Claude** in
T3 Code, syncs the hub's advertised coding models, and registers the hub as a
T3 usage source. Keep T3 Code running with Codex and Claude installed, and
Node.js 22+ available while it runs. Rerunning it on a connected computer
repairs skills sharing, syncs models, and refreshes usage without consuming
another setup code or replacing credentials.

Model discovery reads the authenticated hub `/v1/models` endpoint. OpenAI
coding models go to Codex; Anthropic Claude models go to Claude. Image/audio
models and internal helpers are excluded from the coding picker. T3's CLI
catalog can lag behind the hub, especially for API-key connections, so setup
adds missing models through T3's supported custom-model settings. Existing
custom models, provider names, launch settings, disabled states, and model
preferences are preserved. Matching providers are reused by their configured
home directory. A conflicting provider ID is reported instead of overwritten.

Setup refreshes T3 and checks that the enabled hub providers are ready and
contain the advertised coding models. Missing CLIs, authentication failures,
and model discovery failures are reported; resolve them and rerun. Models
are synchronized on each setup run, not continuously: rerun after new hub
models or account access are added. The older `setup-hub-usage.cjs` command
also syncs providers and models; use `setup-provider-hub.sh` to repair skills
sharing as well. Legacy Codex-only homes remain Codex-only.

The hub providers use the same local skills as the usual installations:

- `~/.dittodub-provider-hub/codex/skills` links to `~/.codex/skills`.
- `~/.dittodub-provider-hub/claude/skills` links to `~/.claude/skills`.

These links share edits and future additions automatically. Missing source
folders are created. Only skills folders are shared; provider configuration
and credentials remain in the separate hub homes. Skills come from the
computer running T3 Code, including when that computer also hosts the hub.

When upgrading an older installation, an empty or built-in-only hub skills
folder is backed up under `~/.dittodub-provider-hub/backups` before linking.
If a hub skills folder contains custom files or links elsewhere, setup stops
before reading a setup code and explains what to merge or move. Resolve that
conflict and rerun the script. Start a new conversation afterward to reload
skills, and refresh T3 Code if the skill picker is stale.

## Day to day

```bash
python3 hub-admin.py list                 # people and the accounts they use
python3 hub-admin.py devices [alex]       # registered computers
python3 hub-admin.py revoke-device ID     # cut off one computer
python3 hub-admin.py disable alex         # cut off a person
python3 hub-admin.py grant alex claude:alex@example.com
python3 watchdog.py --verbose             # run every check now
node issue-login-link.cjs alex@example.com # website: one-time sign-in link
```

Changes apply to new requests, and requests already streaming may finish. To
retire an account, set `"disabled": true` in its file in `~/.cli-proxy-api`.
If a Codex account reports `token_invalidated`, sign it in again.

## Security notes

- **Loopback only.** The proxy, gateway and portal listen on loopback.
  Tailscale or Cloudflare is the only way in. The proxy's management API is
  never exposed.
- **Separate keys.** Computer keys and member routing keys are different. The
  gateway swaps one for the other, so a stolen laptop key can be revoked alone.
  Member keys never leave the hub.
- **Personal accounts stay personal.** They are owner-only for administrators
  too. The router fails closed if routing is unavailable.
- **Usage and resets.** These are re-authorized on every request. Reset
  redemption is idempotent across retries and restarts. Routing cooldowns
  clear only after the provider confirms a reset.
- **Logging.** Request-body logging is off. The gateway, portal and watchdog
  never log prompts, responses or credentials. Providers and your tunnel
  handle traffic under their own policies.
- **Website sessions.** Google sign-in binds the first verified Google account
  for each email. Sessions last seven days. Setup codes and login links are
  single-use, expire after two hours, and are stored only as hashes.

## Development

Tests use temporary directories and synthetic credentials:

```bash
node --test portal/*.test.cjs tests/*.test.cjs
python3 -m unittest discover -s tests -p '*_test.py'
python3 tests/gateway_integration.py
python3 tests/router_integration.py   # needs the built proxy and router
node tests/portal_preview_fixture.cjs # website preview at http://127.0.0.1:18765
```

Git tracks source only. `.gitignore` is an allowlist, so credentials, keys,
sessions, logs and `hub.json` stay local. Upstream sources and licenses are in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

---

Built by [DittoDub](https://dittodub.com). [MIT licensed](LICENSE). The
DittoDub name and logo are not covered by the license; if you fork this,
replace them with your own.
