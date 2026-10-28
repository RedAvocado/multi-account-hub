#!/bin/bash
# Older Codex-only setup, kept for computers enrolled before setup-provider-hub.sh.
set -euo pipefail
umask 077

# Fetch and check the usage integration before consuming a setup code/key.
usage_setup_dir="$(mktemp -d)"
trap 'rm -rf "$usage_setup_dir"' EXIT
curl --fail --silent --show-error --connect-timeout 10 --max-time 30 \
  __HUB_ORIGIN__/setup-hub-usage.cjs -o "$usage_setup_dir/setup.cjs"
node "$usage_setup_dir/setup.cjs" --check
configure_usage() {
  if ! node "$usage_setup_dir/setup.cjs" --codex-home "$HOME/.codex-team-hub"; then
    printf 'Your saved hub credentials were preserved. Open T3 and rerun this setup command to finish usage setup.\n' >&2
    return 1
  fi
}

if [ -e "$HOME/.codex-team-hub/config.toml" ]; then
  configure_usage
  exit 0
fi
printf 'Paste the one-time setup code from the hub website: '
IFS= read -r -s setup_code
printf '\n'
if [[ ! "$setup_code" =~ ^[A-Za-z0-9_-]{43}$ ]]; then
  printf 'Invalid setup code. Create a new one on the sign-in page.\n' >&2
  exit 1
fi

python_source=$(cat <<'PY'
import json, os, pathlib, re, sys, urllib.error, urllib.request

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

setup_code = sys.stdin.read(100).strip()
del sys.stdin
request = urllib.request.Request(
    '__HUB_ORIGIN__/portal/redeem',
    data=json.dumps({'code': setup_code}).encode(),
    headers={'Content-Type': 'application/json', 'User-Agent': 'curl/8.7.1'},
    method='POST')
try:
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=20) as response:
        document = json.loads(response.read(4097))
    key = document.get('key', '')
    if not isinstance(key, str) or not re.fullmatch(r'[A-Za-z0-9_-]{40,128}', key):
        raise ValueError('invalid response')
except (urllib.error.URLError, ValueError, KeyError, json.JSONDecodeError):
    print('Setup failed or the code expired. Sign in and create a new code.', file=sys.stderr)
    raise SystemExit(1)

directory = pathlib.Path.home() / '.codex-team-hub'
if directory.is_symlink():
    print('The team hub directory is a symbolic link; no configuration was written.', file=sys.stderr)
    raise SystemExit(1)
directory.mkdir(mode=0o700, exist_ok=True)
if directory.stat().st_uid != os.getuid():
    print('The team hub directory has a different owner; no configuration was written.', file=sys.stderr)
    raise SystemExit(1)
directory.chmod(0o700)
target = directory / 'config.toml'
flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0)
content = f'''model_provider = "dittodub-hub"

[model_providers.dittodub-hub]
name = "Multi-Account Hub"
base_url = "__HUB_ORIGIN__/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = true
experimental_bearer_token = "{key}"
'''
try:
    descriptor = os.open(target, flags, 0o600)
    with os.fdopen(descriptor, 'w') as output:
        output.write(content)
except FileExistsError:
    print('A team hub config already exists. No changes were made.', file=sys.stderr)
    raise SystemExit(1)
print(f'Private configuration saved at {target}.')
print(f'In T3 Code, add a Codex provider with your existing CLI and set CODEX_HOME to {directory}.')
PY
)
printf '%s' "$setup_code" | python3 -c "$python_source"
unset setup_code python_source

configure_usage
