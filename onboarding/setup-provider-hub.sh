#!/bin/bash
# Connect this computer to a Multi-Account Hub. The hub fills in its own
# address when it serves this script.
#   bash setup.sh          paste a one-time setup code from the hub website
#   bash setup.sh --key    paste a device key from `hub-admin.py add-device`
set -euo pipefail
umask 077
mode=code
case "${1:-}" in
  '') ;;
  --key) mode=key ;;
  *) printf 'Usage: bash setup.sh [--key]\n' >&2; exit 2 ;;
esac

# Fetch and check the usage integration before consuming a setup code/key.
usage_setup_dir="$(mktemp -d)"
trap 'rm -rf "$usage_setup_dir"' EXIT
curl --fail --silent --show-error --connect-timeout 10 --max-time 30 \
  __HUB_ORIGIN__/setup-hub-usage.cjs -o "$usage_setup_dir/setup.cjs"
node "$usage_setup_dir/setup.cjs" --check
configure_usage() {
  if ! node "$usage_setup_dir/setup.cjs" --codex-home "$HOME/.dittodub-provider-hub/codex"; then
    printf 'Your saved hub credentials were preserved. Open T3 and rerun this setup command to finish usage setup.\n' >&2
    return 1
  fi
}

if [ -e "$HOME/.dittodub-provider-hub/codex/config.toml" ]; then
  configure_usage
  exit 0
fi
if [ "$mode" = key ]; then
  printf 'Paste the device key from your hub administrator (it will not be displayed): '
  IFS= read -r -s setup_code
  printf '\n'
  if [[ ! "$setup_code" =~ ^[A-Za-z0-9_-]{40,128}$ ]]; then
    printf 'That is not a device key. Ask the hub administrator for a new one.\n' >&2
    exit 1
  fi
else
  printf 'Paste the one-time setup code from the hub website: '
  IFS= read -r -s setup_code
  printf '\n'
  if [[ ! "$setup_code" =~ ^[A-Za-z0-9_-]{43}$ ]]; then
    printf 'Invalid setup code. Create a new one on the hub website.\n' >&2
    exit 1
  fi
fi

python_source=$(cat <<'PY'
import json, os, pathlib, platform, re, socket, sys, urllib.error, urllib.request

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

HUB = '__HUB_ORIGIN__'
secret = sys.stdin.read(200).strip()
del sys.stdin
opener = urllib.request.build_opener(NoRedirect())
if sys.argv[1] == 'key':
    # A device key issued on the hub computer: confirm the hub accepts it.
    key = secret
    request = urllib.request.Request(HUB + '/v1/models',
        headers={'Authorization': 'Bearer ' + key, 'User-Agent': 'curl/8.7.1'})
    try:
        with opener.open(request, timeout=20) as response:
            response.read(1)
    except urllib.error.HTTPError as error:
        print('The hub did not accept this key.' if error.code in (401, 403) else 'The hub could not check this key.', file=sys.stderr)
        raise SystemExit(1)
    except urllib.error.URLError:
        print('Could not reach the hub. Check the network (and Tailscale, if the hub uses it).', file=sys.stderr)
        raise SystemExit(1)
else:
    request = urllib.request.Request(
        HUB + '/portal/redeem',
        data=json.dumps({'code': secret,
            'deviceName': re.sub(r'[\x00-\x1f\x7f]', '', socket.gethostname()).strip()[:80],
            'platform': re.sub(r'[\x00-\x1f\x7f]', '', platform.system()).strip()[:40]}).encode(),
        headers={'Content-Type': 'application/json', 'User-Agent': 'curl/8.7.1'},
        method='POST')
    try:
        with opener.open(request, timeout=20) as response:
            document = json.loads(response.read(4097))
        key = document.get('key', '')
        if not isinstance(key, str) or not re.fullmatch(r'[A-Za-z0-9_-]{40,128}', key):
            raise ValueError('invalid response')
    except (urllib.error.URLError, ValueError, KeyError, json.JSONDecodeError):
        print('Setup failed or the code expired. Sign in and create a new code.', file=sys.stderr)
        raise SystemExit(1)

root = pathlib.Path.home() / '.dittodub-provider-hub'
if root.is_symlink():
    print('The hub directory is a symbolic link; no configuration was written.', file=sys.stderr)
    raise SystemExit(1)
root.mkdir(mode=0o700, exist_ok=True)
if root.stat().st_uid != os.getuid():
    print('The hub directory has a different owner; no configuration was written.', file=sys.stderr)
    raise SystemExit(1)
root.chmod(0o700)
directory = root / 'codex'
if directory.is_symlink():
    print('The team hub directory is a symbolic link; no configuration was written.', file=sys.stderr)
    raise SystemExit(1)
directory.mkdir(mode=0o700, exist_ok=True)
if directory.stat().st_uid != os.getuid():
    print('The team hub directory has a different owner; no configuration was written.', file=sys.stderr)
    raise SystemExit(1)
directory.chmod(0o700)
target = directory / 'config.toml'
claude_directory = root / 'claude'
if claude_directory.is_symlink():
    print('The Claude hub directory is a symbolic link; no configuration was written.', file=sys.stderr)
    raise SystemExit(1)
claude_directory.mkdir(mode=0o700, exist_ok=True)
if claude_directory.stat().st_uid != os.getuid():
    print('The Claude hub directory has a different owner; no configuration was written.', file=sys.stderr)
    raise SystemExit(1)
claude_directory.chmod(0o700)
device_key = root / 'device-key'
wrapper = root / 'hub-claude'
for candidate in (target, device_key, wrapper):
    if candidate.exists() or candidate.is_symlink():
        print('A hub config already exists. No credentials were overwritten.', file=sys.stderr)
        raise SystemExit(1)
flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0)
content = f'''model_provider = "dittodub-provider-hub"

[model_providers.dittodub-provider-hub]
name = "Multi-Account Hub"
base_url = "{HUB}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = true
experimental_bearer_token = "{key}"
'''
launcher = f'''#!/bin/sh
set -eu
export ANTHROPIC_BASE_URL="{HUB}"
export ANTHROPIC_AUTH_TOKEN="$(cat "$HOME/.dittodub-provider-hub/device-key")"
unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY
exec claude "$@"
'''
written = []
try:
    for destination, data, mode in ((target, content, 0o600), (device_key, key + '\n', 0o600), (wrapper, launcher, 0o700)):
        descriptor = os.open(destination, flags, mode)
        written.append(destination)
        with os.fdopen(descriptor, 'w') as output:
            output.write(data)
except OSError:
    for destination in written:
        try: destination.unlink()
        except OSError: pass
    print('Hub configuration could not be saved. Create a new setup code and try again.', file=sys.stderr)
    raise SystemExit(1)
print(f'Private configuration saved at {target}.')
print(f'In T3 Code, add a Codex provider named HUB Codex with CODEX_HOME set to {directory}.')
print(f'Add a Claude provider named HUB Claude with CLAUDE_CONFIG_DIR set to {claude_directory} and binary path set to {wrapper}.')
print('Claude starts working once a Claude account is shared with you or you connect your own.')
PY
)
printf '%s' "$setup_code" | python3 -c "$python_source" "$mode"
unset setup_code python_source

configure_usage
