#!/usr/bin/env python3
"""Update only the hub's Codex CLI and the user's native Claude CLI.

The previous Codex releases remain available for rollback. No prompts or
credentials are logged, and the active release is switched only after a new
installation passes local startup checks.
"""
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

BASE = Path.home() / ".local/share/cliproxy-hub"
RELEASES = BASE / "codex-releases"
CURRENT = BASE / "codex-current"
CLAUDE = Path.home() / ".local/bin/claude"
NPM = Path("/opt/homebrew/bin/npm")
LOG = BASE / "cli-update.log"
os.umask(0o077)
ENV = os.environ.copy()
ENV.update({"PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", "NO_COLOR": "1"})


def log(message):
    stamp = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    with LOG.open("a", encoding="utf-8") as output:
        output.write(f"{stamp} {message}\n")
    os.chmod(LOG, 0o600)


def run(args, timeout=180):
    return subprocess.run(args, env=ENV, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          text=True, timeout=timeout, check=True)


def codex_version(path):
    output = run([str(path), "--version"], timeout=20).stdout.strip()
    match = re.fullmatch(r"codex-cli (\d+\.\d+\.\d+)", output)
    if not match:
        raise RuntimeError("installed Codex version could not be verified")
    return match.group(1)


def check_app_server(path):
    # Verify the protocol T3 uses without signing in or sending model requests.
    request = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
               "params": {"clientInfo": {"name": "hub-update-check", "version": "1.0"},
                          "capabilities": {"experimentalApi": True}}}
    with tempfile.TemporaryDirectory(prefix="hub-cli-check-") as home:
        env = {**ENV, "CODEX_HOME": home}
        result = subprocess.run([str(path), "app-server"], input=json.dumps(request) + "\n",
                                env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, timeout=20, check=True)
        for line in result.stdout.splitlines():
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if message.get("id") == 1 and "result" in message and "error" not in message:
                return
    raise RuntimeError("Codex app-server initialization failed")


def update_codex():
    raw = run([str(NPM), "view", "@openai/codex", "version", "--json"], timeout=60).stdout
    version = json.loads(raw)
    if not isinstance(version, str) or not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise RuntimeError("npm returned an invalid stable Codex version")
    active = CURRENT / "node_modules/.bin/codex"
    if active.is_file() and codex_version(active) == version:
        log(f"Codex already current: {version}")
        return
    RELEASES.mkdir(mode=0o700, parents=True, exist_ok=True)
    release = RELEASES / version
    binary = release / "node_modules/.bin/codex"
    if not binary.is_file() or codex_version(binary) != version:
        if release.exists():
            raise RuntimeError(f"existing release {version} did not validate; retained unchanged")
        stage = Path(tempfile.mkdtemp(prefix=".install-", dir=RELEASES))
        try:
            run([str(NPM), "install", "--prefix", str(stage), "--no-save", "--ignore-scripts",
                 "--no-audit", "--no-fund", "--no-package-lock", "--no-progress",
                 f"@openai/codex@{version}"], timeout=300)
            staged_binary = stage / "node_modules/.bin/codex"
            if codex_version(staged_binary) != version:
                raise RuntimeError("staged Codex version did not match the requested version")
            check_app_server(staged_binary)
            stage.rename(release)
        finally:
            if stage.exists():
                shutil.rmtree(stage)
    check_app_server(binary)
    temporary = BASE / f".codex-current-{os.getpid()}"
    try:
        temporary.symlink_to(os.path.relpath(release, BASE), target_is_directory=True)
        os.replace(temporary, CURRENT)
    finally:
        temporary.unlink(missing_ok=True)
    log(f"Codex updated to {version}; previous release retained")


def update_claude():
    if not CLAUDE.is_file():
        raise RuntimeError("native Claude executable is missing")
    before = run([str(CLAUDE), "--version"], timeout=20).stdout.strip()
    run([str(CLAUDE), "update"], timeout=300)
    after = run([str(CLAUDE), "--version"], timeout=20).stdout.strip()
    log(f"Claude check completed: {before} -> {after}")


def main():
    BASE.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (BASE / "cli-update.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        failures = 0
        for name, fn in (("Codex", update_codex), ("Claude", update_claude)):
            try:
                fn()
            except Exception as exc:
                failures += 1
                # Avoid storing subprocess output, environment, or request contents.
                log(f"{name} update check failed: {type(exc).__name__}")
        if failures:
            raise SystemExit(1)


if __name__ == "__main__":
    main()
