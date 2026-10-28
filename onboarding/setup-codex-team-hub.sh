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
dir="$HOME/.codex-team-hub"
config="$dir/config.toml"
if [ -e "$config" ]; then
  configure_usage
  exit 0
fi
printf 'Paste your personal team-hub key (it will not be displayed): '
IFS= read -r -s hub_key
printf '\n'
if [[ ! "$hub_key" =~ ^[A-Za-z0-9_-]{40,128}$ ]]; then
  printf 'That key does not have the expected format. No configuration was written.\n' >&2
  exit 1
fi
mkdir -p "$dir"
chmod 700 "$dir"
cat > "$config" <<EOF
model_provider = "dittodub-hub"

[model_providers.dittodub-hub]
name = "Multi-Account Hub"
base_url = "__HUB_ORIGIN__/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = true
experimental_bearer_token = "$hub_key"
EOF
chmod 600 "$config"
unset hub_key
printf '\nConfiguration saved privately at %s.\n' "$config"
printf 'In T3 Code, add a Codex provider using your existing CLI and set its CODEX_HOME path to %s.\n' "$dir"

configure_usage
