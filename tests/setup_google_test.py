#!/usr/bin/env python3
import os
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile

source = Path(__file__).resolve().parent.parent / 'onboarding/setup-provider-hub.sh'
with tempfile.TemporaryDirectory(prefix='hub-onboarding-test-') as tmp:
    root = Path(tmp)
    # The hub fills in its address when serving the script.
    script = root / 'setup.sh'
    script.write_text(source.read_text().replace('__HUB_ORIGIN__', 'https://hub.example.com'))
    home = root / 'home'
    home.mkdir()
    binaries = root / 'bin'
    binaries.mkdir()
    fake = binaries / 'python3'
    fake.write_text(f'''#!{sys.executable}
import json,sys,urllib.request,os,pathlib
class Response:
    def __enter__(self): return self
    def __exit__(self,*args): pass
    def read(self,limit): return json.dumps({{"key": "k" * 64}}).encode()
class Opener:
    def open(self,request,timeout):
        if request.full_url == "https://hub.example.com/v1/models":
            with open(os.environ["SETUP_EVENTS"],"a") as log: log.write("verify\\n")
            assert request.get_header("Authorization") == "Bearer " + "d" * 43
            return Response()
        assert request.full_url == "https://hub.example.com/portal/redeem"
        with open(os.environ["SETUP_EVENTS"],"a") as log: log.write("redeem\\n")
        payload=json.loads(request.data)
        assert payload["code"] == "c" * 43
        assert isinstance(payload["deviceName"],str) and isinstance(payload["platform"],str)
        return Response()
urllib.request.build_opener = lambda *args: Opener()
assert sys.argv[1] == "-c"
source=sys.argv[2]
sys.argv=["-c"]+sys.argv[3:]  # as python3 -c would see it
exec(compile(source,"<setup>","exec"), {{"__name__":"__main__"}})
''')
    fake.chmod(0o700)
    events = root / 'events'
    fake_curl = binaries / 'curl'
    helper = root / 'usage.cjs'
    helper.write_text((source.parent.parent / 'scripts/configure-t3-usage.cjs').read_text().replace('__HUB_ORIGIN__', 'https://hub.example.com'))
    fake_curl.write_text('#!/bin/sh\nfor arg; do destination="$arg"; done\ncp "$USAGE_FIXTURE" "$destination"\n')
    fake_curl.chmod(0o700)
    fake_node = binaries / 'node'
    fake_node.write_text(f'''#!{sys.executable}
import os,sys,pathlib,subprocess
with open(os.environ["SETUP_EVENTS"],"a") as log: log.write(sys.argv[2]+"\\n")
if sys.argv[2] == "--check":
    sys.exit(1 if os.environ.get("FAIL_CHECK") else 0)
if sys.argv[2] == "--check-environment":
    sys.exit(subprocess.run([{shutil.which('node')!r}, sys.argv[1], '--check-environment']).returncode)
assert sys.argv[2] == "--codex-home"
assert pathlib.Path(sys.argv[3],"hub-connection.json").is_file()
if os.environ.get("FAIL_USAGE"): sys.exit(1)
sys.exit(subprocess.run([{shutil.which('node')!r}, '-e', "require(process.argv[1]).environmentPlan(require('os').homedir()).apply()", sys.argv[1]]).returncode)
''')
    fake_node.chmod(0o700)
    env = {**os.environ, 'HOME': str(home), 'PATH': str(binaries) + ':' + os.environ['PATH'], 'SETUP_EVENTS': str(events), 'USAGE_FIXTURE': str(helper)}
    def run(code):
        return subprocess.run(['/bin/bash', str(script)], input=code + '\n', text=True, capture_output=True, env=env, timeout=10)
    first = run('c' * 43)
    assert first.returncode == 0, first.stderr
    config = home / '.dittodub-provider-hub/codex/config.toml'
    assert config.exists() and config.stat().st_mode & 0o777 == 0o600
    assert config.is_symlink() and config.read_text() == ''
    assert 'k' * 64 in (config.parent / 'auth.json').read_text()
    device_key = home / '.dittodub-provider-hub/device-key'
    wrapper = home / '.dittodub-provider-hub/hub-claude'
    assert device_key.stat().st_mode & 0o777 == 0o600
    assert wrapper.stat().st_mode & 0o777 == 0o700
    assert (home / '.dittodub-provider-hub/claude').stat().st_mode & 0o777 == 0o700
    assert device_key.read_text().strip() == 'k' * 64
    assert 'k' * 64 not in first.stdout + first.stderr
    fake_claude = binaries / 'claude'
    fake_claude.write_text('''#!/bin/sh
set -eu
test "$ANTHROPIC_BASE_URL" = "https://hub.example.com"
test "$ANTHROPIC_AUTH_TOKEN" = "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk"
test -z "${ANTHROPIC_API_KEY:-}"
test "$1" = "--version"
printf 'launcher verified\\n'
''')
    fake_claude.chmod(0o700)
    launched = subprocess.run([str(wrapper), '--version'], env={**env, 'ANTHROPIC_API_KEY': 'do-not-use'}, text=True, capture_output=True, timeout=10)
    assert launched.returncode == 0 and launched.stdout.strip() == 'launcher verified'
    assert 'k' * 64 not in launched.stdout + launched.stderr
    previous = config.read_bytes()
    second = run('c' * 43)
    assert second.returncode == 0 and config.read_bytes() == previous
    assert events.read_text().splitlines() == ['--check', '--check-environment', 'redeem', '--codex-home', '--check', '--check-environment', '--codex-home']
    # A missing prerequisite must not consume a setup code or create credentials.
    blocked_home = root / 'blocked-home'; blocked_home.mkdir()
    blocked = subprocess.run(['/bin/bash', str(script)], input='c' * 43 + '\n', text=True, capture_output=True,
        env={**env, 'HOME': str(blocked_home), 'FAIL_CHECK': '1'}, timeout=10)
    assert blocked.returncode != 0 and not (blocked_home / '.dittodub-provider-hub').exists()
    assert events.read_text().splitlines().count('redeem') == 1
    # If usage setup fails after enrollment, retry uses the saved key, not a new code.
    retry_home = root / 'retry-home'; retry_home.mkdir()
    failed = subprocess.run(['/bin/bash', str(script)], input='c' * 43 + '\n', text=True, capture_output=True,
        env={**env, 'HOME': str(retry_home), 'FAIL_USAGE': '1'}, timeout=10)
    assert failed.returncode != 0 and 'rerun this setup' in failed.stderr
    saved = retry_home / '.dittodub-provider-hub/codex/hub-connection.json'
    saved_bytes = saved.read_bytes()
    retried = subprocess.run(['/bin/bash', str(script)], input='', text=True, capture_output=True,
        env={**env, 'HOME': str(retry_home)}, timeout=10)
    assert retried.returncode == 0 and saved.read_bytes() == saved_bytes
    assert events.read_text().splitlines().count('redeem') == 2
    # Without a website: a device key from hub-admin.py add-device is checked, then saved.
    key_home = root / 'key-home'; key_home.mkdir()
    keyed = subprocess.run(['/bin/bash', str(script), '--key'], input='d' * 43 + '\n', text=True, capture_output=True,
        env={**env, 'HOME': str(key_home)}, timeout=10)
    assert keyed.returncode == 0, keyed.stderr
    assert (key_home / '.dittodub-provider-hub/device-key').read_text().strip() == 'd' * 43
    assert 'https://hub.example.com/v1' in (key_home / '.dittodub-provider-hub/codex/hub-connection.json').read_text()
    assert 'd' * 43 not in keyed.stdout + keyed.stderr
    assert events.read_text().splitlines().count('redeem') == 2 and events.read_text().splitlines().count('verify') == 1
    rejected = subprocess.run(['/bin/bash', str(script), '--key'], input='not a key\n', text=True, capture_output=True,
        env={**env, 'HOME': str(root / 'rejected-home')}, timeout=10)
    assert rejected.returncode != 0
    print('PASS: one-use-code and device-key setup prepares private Codex and Claude configs with automatic usage setup, safe preflight, and credential-preserving retries')
