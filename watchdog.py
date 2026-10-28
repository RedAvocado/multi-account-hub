#!/usr/bin/env python3
"""Cron-driven availability monitor for the local Multi-Account Hub.

The watchdog never terminates a running service: active model streams and
provider sign-ins may be using it. launchd is asked to start only jobs that
are stopped or missing. Discord delivery is independent of the hub monitor.
"""

import concurrent.futures
import datetime
import fcntl
import hashlib
import hmac
import http.client
import json
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit


DIRECTORY = Path(__file__).resolve().parent
AUTH_DIR = Path.home() / ".cli-proxy-api"
# Filled in from hub.json by configure(). A hub without a website (for example
# one reached over Tailscale) has no portal or Cloudflare tunnel to watch.
HOST = "hub.example.com"
PORT = 443
URL = "https://hub.example.com/"
LABEL_PREFIX = "com.dittodub.multi-account-hub."
WEBSITE = True
SERVICES = ("proxy", "gateway", "portal", "tunnel", "monitor")
MARKER = b"Multi-Account Hub"


def configure(directory=DIRECTORY):
    global HOST, PORT, URL, LABEL_PREFIX, WEBSITE, SERVICES
    config = json.loads((directory / "hub.json").read_text())
    hub_url = urlsplit(config["hubUrl"])
    if hub_url.scheme != "https" or not hub_url.hostname or hub_url.path not in ("", "/"):
        raise ValueError("hub.json hubUrl must be an https origin")
    prefix = config.get("launchdLabelPrefix", LABEL_PREFIX)
    if not isinstance(prefix, str) or not re.fullmatch(r"[A-Za-z0-9.-]+", prefix):
        raise ValueError("hub.json launchdLabelPrefix is invalid")
    HOST, PORT = hub_url.hostname, hub_url.port or 443
    URL = config["hubUrl"].rstrip("/") + "/"
    LABEL_PREFIX = prefix
    WEBSITE = isinstance(config.get("portal"), dict)
    SERVICES = ("proxy", "gateway", "portal", "tunnel", "monitor") if WEBSITE else ("proxy", "gateway", "monitor")
NAMES = {
    "service-proxy": "proxy service",
    "service-gateway": "gateway service",
    "service-portal": "portal service",
    "service-tunnel": "tunnel service",
    "service-monitor": "notification monitor",
    "proxy-management": "local proxy management",
    "proxy-models": "local authenticated proxy API",
    "portal-local": "local sign-in portal",
    "gateway-local": "local gateway and portal",
    "gateway-api": "local gateway API",
    "public-portal": "hub website",
    "public-api": "hub API",
    "discord-config": "Discord webhook configuration",
}
REMINDER_SECONDS = 12 * 60 * 60
RECOVERY_RETRY_SECONDS = 2 * 60
MAX_RETRY_SECONDS = 7 * 24 * 60 * 60
MISSED_CHECK_SECONDS = 5 * 60


def log(message):
    stamp = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    print(f"{stamp} {message}", flush=True)


def load_webhook(directory):
    """Validate the existing private webhook file without exposing its value."""
    file = directory / "discord-webhook-url"
    metadata = file.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o077 or metadata.st_size > 4096:
        raise ValueError("invalid notification configuration")
    url = urlsplit(file.read_text(encoding="utf-8").strip())
    if (url.scheme != "https" or url.hostname != "discord.com" or url.port is not None
            or url.username or url.password or url.query or url.fragment
            or not re.fullmatch(r"/api/webhooks/\d{5,30}/[A-Za-z0-9_-]{20,256}", url.path)):
        raise ValueError("invalid notification configuration")
    return url.path


def seconds(value, default=0):
    try:
        number = float(value)
        if math.isfinite(number) and number > 0:
            return min(number, MAX_RETRY_SECONDS)
    except (TypeError, ValueError, OverflowError):
        pass
    return default


def deliver_discord(directory, content, connection_factory=http.client.HTTPSConnection):
    """Use the same webhook and mention policy as the provider monitor."""
    connection = None
    try:
        webhook_path = load_webhook(directory)
        payload = json.dumps({"content": content, "allowed_mentions": {"parse": []}}).encode("utf-8")
        connection = connection_factory("discord.com", timeout=12)
        connection.request("POST", webhook_path + "?wait=true", payload,
                           {"Content-Type": "application/json", "Content-Length": str(len(payload))})
        response = connection.getresponse()
        body = response.read(32768)
        retry = seconds(response.getheader("retry-after"))
        if not retry:
            try:
                retry = seconds(json.loads(body).get("retry_after"))
            except (ValueError, TypeError, AttributeError):
                pass
        reset = seconds(response.getheader("x-ratelimit-reset-after")) if response.getheader("x-ratelimit-remaining") == "0" else 0
        return {"status": response.status, "retry": retry, "reset": reset}
    except Exception:
        # Never log exceptions: network errors can contain the webhook URL.
        return {"status": 0, "retry": 0, "reset": 0}
    finally:
        if connection is not None:
            connection.close()


def http_check(host, port, target, expected, marker=None, headers=None, secure=False):
    connection = None
    try:
        cls = http.client.HTTPSConnection if secure else http.client.HTTPConnection
        connection = cls(host, port=port, timeout=8)
        request_headers = {"Connection": "close", "Cache-Control": "no-cache"}
        request_headers.update(headers or {})
        connection.request("GET", target, headers=request_headers)
        response = connection.getresponse()
        body = response.read(65536) if marker else b""
        return response.status == expected and (marker is None or marker in body)
    except Exception:
        return False
    finally:
        if connection is not None:
            connection.close()


def proxy_management_check(auth_dir):
    try:
        key = (auth_dir / "management-key").read_text(encoding="utf-8").strip()
        if not key or len(key) > 4096 or "\n" in key or "\r" in key:
            return False
        return http_check("127.0.0.1", 8317, "/v0/management/auth-files", 200,
                          headers={"Authorization": "Bearer " + key})
    except (OSError, UnicodeError):
        return False


def proxy_models_check(directory):
    """Check an enabled internal key only against loopback, without device telemetry."""
    try:
        users = json.loads((directory / "gateway-users.json").read_text(encoding="utf-8"))["users"]
        if not isinstance(users, list) or len(users) > 1000:
            return False
        for user in users:
            if not isinstance(user, dict) or user.get("enabled") is not True:
                continue
            name, expected = user.get("name", ""), user.get("keyHash", "")
            if not isinstance(name, str) or not re.fullmatch(r"[a-z][a-z0-9_-]{0,40}", name):
                continue
            if not isinstance(expected, str) or not re.fullmatch(r"[a-f0-9]{64}", expected):
                continue
            try:
                key = (directory / "team-keys" / (name + ".key")).read_text(encoding="utf-8").strip()
            except (OSError, UnicodeError):
                continue
            if not re.fullmatch(r"[A-Za-z0-9_-]{40,128}", key):
                continue
            if not hmac.compare_digest(hashlib.sha256(key.encode()).hexdigest(), expected):
                continue
            return http_check("127.0.0.1", 8317, "/v1/models", 200,
                              headers={"Authorization": "Bearer " + key})
        return False
    except (OSError, UnicodeError, ValueError, TypeError, KeyError):
        return False


def service_status(service, runner=subprocess.run):
    target = f"gui/{os.getuid()}/{LABEL_PREFIX}{service}"
    try:
        result = runner(["/bin/launchctl", "print", target], capture_output=True, text=True, timeout=5)
        if result.returncode == 113:
            return "missing"
        if result.returncode:
            return "unknown"
        if re.search(r"^\s*state = running\s*$", result.stdout, re.MULTILINE) and re.search(
                r"^\s*pid = \d+\s*$", result.stdout, re.MULTILINE):
            return "running"
        return "stopped"
    except (OSError, subprocess.SubprocessError):
        return "unknown"


def start_service(service, status, runner=subprocess.run):
    """Start a stopped/unloaded job without killing an existing process."""
    if service not in SERVICES:
        return False
    domain = f"gui/{os.getuid()}"
    label = LABEL_PREFIX + service
    if status == "stopped":
        command = ["/bin/launchctl", "kickstart", f"{domain}/{label}"]
    elif status == "missing":
        plist = Path.home() / "Library" / "LaunchAgents" / (label + ".plist")
        if not plist.is_file():
            return False
        command = ["/bin/launchctl", "bootstrap", domain, str(plist)]
    else:
        return False
    try:
        result = runner(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8)
        return result.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def collect_checks(directory=DIRECTORY, auth_dir=AUTH_DIR):
    """Gather checks in parallel, with no model generation or external user keys."""
    jobs = {
        "proxy-management": lambda: proxy_management_check(auth_dir),
        "proxy-models": lambda: proxy_models_check(directory),
        "gateway-api": lambda: http_check("127.0.0.1", 18317, "/v1/models", 401),
        "public-api": lambda: http_check(HOST, PORT, "/v1/models", 401, secure=True),
    }
    if WEBSITE:
        jobs["portal-local"] = lambda: http_check("127.0.0.1", 18318, "/", 200, MARKER, {"Host": HOST})
        jobs["gateway-local"] = lambda: http_check("127.0.0.1", 18317, "/", 200, MARKER, {"Host": HOST})
        jobs["public-portal"] = lambda: http_check(HOST, PORT, "/", 200, MARKER, secure=True)
    def webhook_ok():
        try:
            load_webhook(directory)
            return True
        except (OSError, ValueError, UnicodeError):
            return False
    jobs["discord-config"] = webhook_ok
    for service in SERVICES:
        jobs["service-" + service] = lambda service=service: service_status(service)
    checks, statuses = {}, {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(jobs)) as executor:
        futures = {executor.submit(job): name for name, job in jobs.items()}
        for future in concurrent.futures.as_completed(futures):
            name = futures[future]
            try:
                result = future.result()
            except Exception:
                result = "unknown" if name.startswith("service-") else False
            if name.startswith("service-"):
                statuses[name[8:]] = result
                checks[name] = result == "running"
            else:
                checks[name] = result is True
    return checks, statuses


def initial_state():
    return {"version": 1, "checks": {}, "incidentOpen": False, "lastAlertAt": 0,
            "recoveryAttempts": {}, "nextDeliveryAt": 0, "pending": []}


def read_state(directory):
    file = directory / "watchdog-state.json"
    try:
        state = json.loads(file.read_text(encoding="utf-8"))
        if (state.get("version") != 1 or not isinstance(state.get("checks"), dict)
                or not isinstance(state.get("pending"), list)
                or not isinstance(state.get("recoveryAttempts"), dict)):
            raise ValueError("invalid watchdog state")
        return state
    except FileNotFoundError:
        return initial_state()


def save_state(directory, state):
    descriptor, temporary = tempfile.mkstemp(prefix=".watchdog-", dir=directory)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as file:
            json.dump(state, file, separators=(",", ":"))
            file.write("\n")
        os.replace(temporary, directory / "watchdog-state.json")
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def queue_event(state, content):
    state["pending"].append({"content": content, "attempts": 0, "nextAttemptAt": 0})


def update_incidents(state, checks, now):
    """Require repeated probe failures and successes; service exits alert promptly."""
    before = {name for name, value in state["checks"].items() if value.get("active")}
    for name, ok in checks.items():
        current = state["checks"].setdefault(name, {"failures": 0, "successes": 0, "active": False})
        if ok:
            current["failures"] = 0
            current["successes"] = min(current["successes"] + 1, 2)
            if current["successes"] >= 2:
                current["active"] = False
        else:
            current["successes"] = 0
            current["failures"] = min(current["failures"] + 1, 2)
            if current["failures"] >= (1 if name.startswith("service-") else 2):
                current["active"] = True
    active = {name for name, value in state["checks"].items() if value.get("active")}
    additions = active - before
    if active and (not state["incidentOpen"] or additions or now - state["lastAlertAt"] >= REMINDER_SECONDS):
        description = ", ".join(NAMES[name] for name in sorted(active) if name in NAMES)
        queue_event(state, "🚨 Multi-Account Hub availability problem\nAffected: " + description +
                    "\nThe watchdog attempts to start stopped services; running services are not interrupted.\n" + URL)
        state["incidentOpen"] = True
        state["lastAlertAt"] = now
        return "problem"
    if not active and state["incidentOpen"]:
        queue_event(state, "✅ Multi-Account Hub availability checks have recovered.\n" + URL)
        state["incidentOpen"] = False
        return "recovered"
    return None


def attempt_delivery(directory, state, now, deliver=deliver_discord):
    if not state["pending"] or now < state.get("nextDeliveryAt", 0):
        return None
    event = state["pending"][0]
    if now < event.get("nextAttemptAt", 0):
        return None
    result = deliver(directory, event["content"])
    status = result["status"]
    if 200 <= status < 300:
        state["pending"].pop(0)
        state["nextDeliveryAt"] = now + result.get("reset", 0)
        return "delivered"
    event["attempts"] = min(event.get("attempts", 0) + 1, 1000000)
    backoff = min(3600, 5 * 2 ** min(event["attempts"] - 1, 10))
    if status == 429 and result.get("retry", 0) > 0:
        backoff = max(1, min(MAX_RETRY_SECONDS, result["retry"]))
    event["nextAttemptAt"] = now + backoff
    if status == 429:
        state["nextDeliveryAt"] = event["nextAttemptAt"]
    return "failed"


def run_once(directory=DIRECTORY, auth_dir=AUTH_DIR, now=None, collect=collect_checks,
             start=start_service, deliver=deliver_discord):
    now = time.time() if now is None else now
    state = read_state(directory)
    last_run = state.get("lastRunAt")
    if isinstance(last_run, (int, float)) and now - last_run > MISSED_CHECK_SECONDS:
        minutes = int((now - last_run) // 60)
        queue_event(state, f"⚠️ Multi-Account Hub watchdog resumed after about {minutes} minutes without a check."
                    "\nHub availability during that time could not be verified.\n" + URL)
    checks, statuses = collect(directory, auth_dir)
    for service, status in statuses.items():
        previous = state["recoveryAttempts"].get(service, 0)
        if status in ("stopped", "missing") and now - previous >= RECOVERY_RETRY_SECONDS:
            started = start(service, status)
            state["recoveryAttempts"][service] = now
            log(f"Start {'requested' if started else 'failed'} for {service} service.")
    transition = update_incidents(state, checks, now)
    state["lastRunAt"] = now
    # Persist the incident before sending, so a process crash cannot lose it.
    save_state(directory, state)
    result = attempt_delivery(directory, state, now, deliver)
    save_state(directory, state)
    if transition:
        log("Availability " + transition + ".")
    if result == "failed":
        log("Discord notification unavailable; delivery will be retried.")
    return state


def main():
    os.umask(0o077)
    lock_file = DIRECTORY / "watchdog.lock"
    with lock_file.open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        try:
            configure()
            state = run_once()
            if "--verbose" in sys.argv[1:]:
                failures = [NAMES.get(name, name) for name, result in state["checks"].items() if result["failures"]]
                print("Checks: " + (", ".join(sorted(failures)) if failures else "healthy"))
                print("Queued notifications: " + str(len(state["pending"])))
            return 0
        except Exception:
            # Do not print exception text; it may contain private configuration.
            log("Watchdog failed; see configuration and file permissions.")
            return 1


if __name__ == "__main__":
    sys.exit(main())
