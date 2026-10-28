import fcntl
import hashlib
import http.server
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("hub_watchdog", ROOT / "watchdog.py")
watchdog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watchdog)


class WatchdogTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)

    def test_probes_debounce_alert_and_recovery_and_do_not_repeat(self):
        checks = {"public-portal": True}
        sent = []
        collect = lambda directory, auth_dir: (dict(checks), {})
        deliver = lambda directory, content: (sent.append(content) or {"status": 204, "reset": 0})

        def run(at):
            return watchdog.run_once(self.directory, self.directory, at, collect, lambda *_: False, deliver)

        run(1800000000)
        checks["public-portal"] = False
        run(1800000060)
        self.assertEqual(sent, [])
        checks["public-portal"] = True
        run(1800000120)
        checks["public-portal"] = False
        run(1800000180)
        state = run(1800000240)
        self.assertTrue(state["incidentOpen"])
        self.assertEqual(len(sent), 1)
        self.assertIn("hub website", sent[0])
        run(1800000300)
        self.assertEqual(len(sent), 1)
        checks["public-portal"] = True
        run(1800000360)
        self.assertEqual(len(sent), 1)
        state = run(1800000420)
        self.assertFalse(state["incidentOpen"])
        self.assertEqual(len(sent), 2)
        self.assertIn("recovered", sent[1])
        self.assertEqual(os.stat(self.directory / "watchdog-state.json").st_mode & 0o077, 0)

    def test_stopped_service_is_started_once_and_alerted(self):
        starts, sent = [], []
        checks = {"service-gateway": False}
        statuses = {"gateway": "stopped"}
        collect = lambda directory, auth_dir: (dict(checks), dict(statuses))
        start = lambda service, status: (starts.append((service, status)) or True)
        deliver = lambda directory, content: (sent.append(content) or {"status": 204, "reset": 0})
        run = lambda at: watchdog.run_once(self.directory, self.directory, at, collect, start, deliver)
        run(1800000000)
        run(1800000060)
        self.assertEqual(starts, [("gateway", "stopped")])
        self.assertEqual(len(sent), 1)
        checks["service-gateway"] = True
        statuses["gateway"] = "running"
        run(1800000120)
        run(1800000180)
        self.assertEqual(len(sent), 2)
        self.assertIn("recovered", sent[1])
        self.assertEqual(starts, [("gateway", "stopped")])

    def test_missed_cron_checks_are_reported_once_after_the_watchdog_resumes(self):
        sent = []
        collect = lambda directory, auth_dir: ({"public-portal": True}, {})
        deliver = lambda directory, content: (sent.append(content) or {"status": 204, "reset": 0})
        run = lambda at: watchdog.run_once(self.directory, self.directory, at, collect, lambda *_: False, deliver)
        run(1800000000)
        run(1800000360)
        self.assertEqual(len(sent), 1)
        self.assertIn("resumed after about 6 minutes", sent[0])
        self.assertIn("could not be verified", sent[0])
        run(1800000420)
        self.assertEqual(len(sent), 1)

    def test_launchd_actions_never_restart_a_running_or_unknown_service(self):
        commands = []
        runner = lambda command, **kwargs: (commands.append(command) or mock.Mock(returncode=0))
        self.assertFalse(watchdog.start_service("gateway", "running", runner))
        self.assertFalse(watchdog.start_service("gateway", "unknown", runner))
        self.assertFalse(watchdog.start_service("not-a-hub-service", "stopped", runner))
        self.assertTrue(watchdog.start_service("gateway", "stopped", runner))
        self.assertEqual(commands[0][1], "kickstart")
        self.assertNotIn("-k", commands[0])
        home = self.directory / "home"
        agents = home / "Library" / "LaunchAgents"
        agents.mkdir(parents=True)
        (agents / "com.dittodub.multi-account-hub.portal.plist").write_text("fixture")
        with mock.patch.object(watchdog.Path, "home", return_value=home):
            self.assertTrue(watchdog.start_service("portal", "missing", runner))
        self.assertEqual(commands[1][1], "bootstrap")
        self.assertEqual(len(commands), 2)

    def test_configuration_selects_website_or_tailscale_checks(self):
        saved = (watchdog.HOST, watchdog.PORT, watchdog.URL, watchdog.LABEL_PREFIX, watchdog.WEBSITE, watchdog.SERVICES)
        try:
            (self.directory / "hub.json").write_text(json.dumps({"hubUrl": "https://hub.tail1234.ts.net:8443"}))
            watchdog.configure(self.directory)
            self.assertEqual((watchdog.HOST, watchdog.PORT, watchdog.WEBSITE), ("hub.tail1234.ts.net", 8443, False))
            self.assertEqual(watchdog.SERVICES, ("proxy", "gateway", "monitor"))
            (self.directory / "hub.json").write_text(json.dumps({"hubUrl": "https://hub.example.com",
                "launchdLabelPrefix": "com.example.hub-", "portal": {"workspaceDomain": "example.org"}}))
            watchdog.configure(self.directory)
            self.assertEqual((watchdog.HOST, watchdog.PORT, watchdog.WEBSITE, watchdog.LABEL_PREFIX),
                             ("hub.example.com", 443, True, "com.example.hub-"))
            self.assertIn("tunnel", watchdog.SERVICES)
            (self.directory / "hub.json").write_text(json.dumps({"hubUrl": "http://hub.example.com"}))
            with self.assertRaises(ValueError):
                watchdog.configure(self.directory)
        finally:
            (watchdog.HOST, watchdog.PORT, watchdog.URL, watchdog.LABEL_PREFIX, watchdog.WEBSITE, watchdog.SERVICES) = saved

    def test_discord_delivery_retries_rate_limit_and_keeps_events_in_order(self):
        state = watchdog.initial_state()
        watchdog.queue_event(state, "problem")
        watchdog.queue_event(state, "recovered")
        calls = []
        def deliver(directory, content):
            calls.append(content)
            if len(calls) == 1:
                return {"status": 429, "retry": 120, "reset": 0}
            return {"status": 204, "retry": 0, "reset": 0}
        self.assertEqual(watchdog.attempt_delivery(self.directory, state, 1000, deliver), "failed")
        self.assertIsNone(watchdog.attempt_delivery(self.directory, state, 1119, deliver))
        self.assertEqual(watchdog.attempt_delivery(self.directory, state, 1120, deliver), "delivered")
        self.assertEqual(watchdog.attempt_delivery(self.directory, state, 1180, deliver), "delivered")
        self.assertEqual(calls, ["problem", "problem", "recovered"])
        self.assertEqual(state["pending"], [])

    def test_same_private_webhook_is_used_without_mentions(self):
        file = self.directory / "discord-webhook-url"
        file.write_text("https://discord.com/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz\n")
        file.chmod(0o600)
        recorded = {}
        class Response:
            status = 200
            def read(self, size): return b"{}"
            def getheader(self, name): return None
        class Connection:
            def __init__(self, host, timeout): recorded["host"] = host
            def request(self, method, path, body, headers):
                recorded.update(method=method, path=path, payload=json.loads(body), headers=headers)
            def getresponse(self): return Response()
            def close(self): pass
        result = watchdog.deliver_discord(self.directory, "problem @everyone", Connection)
        self.assertEqual(result["status"], 200)
        self.assertEqual(recorded["host"], "discord.com")
        self.assertTrue(recorded["path"].endswith("?wait=true"))
        self.assertEqual(recorded["payload"]["allowed_mentions"], {"parse": []})
        self.assertEqual(recorded["payload"]["content"], "problem @everyone")
        file.chmod(0o644)
        self.assertEqual(watchdog.deliver_discord(self.directory, "problem", Connection)["status"], 0)
        file.unlink()
        file.symlink_to(self.directory / "elsewhere")
        self.assertEqual(watchdog.deliver_discord(self.directory, "problem", Connection)["status"], 0)

    def test_http_probes_require_expected_status_and_page_content(self):
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                body = b"Multi-Account Hub" if self.path == "/" else b"Unauthorized"
                self.send_response(200 if self.path == "/" else 401)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            def log_message(self, *args): pass
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        port = server.server_address[1]
        self.assertTrue(watchdog.http_check("127.0.0.1", port, "/", 200, b"Multi-Account Hub"))
        self.assertFalse(watchdog.http_check("127.0.0.1", port, "/", 200, b"different site"))
        self.assertTrue(watchdog.http_check("127.0.0.1", port, "/v1/models", 401))
        self.assertFalse(watchdog.http_check("127.0.0.1", port, "/v1/models", 200))

    def test_authenticated_model_check_uses_an_enabled_key_only_on_loopback(self):
        key = "synthetic_test_key_" + "x" * 40
        (self.directory / "team-keys").mkdir()
        (self.directory / "team-keys" / "riley.key").write_text(key)
        config = {"users": [{"name": "riley", "enabled": True,
                              "keyHash": hashlib.sha256(key.encode()).hexdigest()}]}
        (self.directory / "gateway-users.json").write_text(json.dumps(config))
        with mock.patch.object(watchdog, "http_check", return_value=True) as request:
            self.assertTrue(watchdog.proxy_models_check(self.directory))
        args, kwargs = request.call_args
        self.assertEqual(args, ("127.0.0.1", 8317, "/v1/models", 200))
        self.assertEqual(kwargs["headers"]["Authorization"], "Bearer " + key)
        config["users"][0]["enabled"] = False
        (self.directory / "gateway-users.json").write_text(json.dumps(config))
        with mock.patch.object(watchdog, "http_check") as request:
            self.assertFalse(watchdog.proxy_models_check(self.directory))
            request.assert_not_called()

    def test_lock_prevents_overlapping_cron_runs(self):
        script = self.directory / "watchdog.py"
        shutil.copy(ROOT / "watchdog.py", script)
        with (self.directory / "watchdog.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = subprocess.run([sys.executable, str(script), "--verbose"], capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0)
        self.assertFalse((self.directory / "watchdog-state.json").exists())
        self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
