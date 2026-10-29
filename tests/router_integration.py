#!/usr/bin/env python3
"""Exercise the guarded proxy with synthetic credentials and a local upstream."""
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request

BASE = Path(__file__).resolve().parent.parent


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class FakeUpstream(BaseHTTPRequestHandler):
    def do_POST(self):
        authorization = self.headers.get("Authorization", "")
        self.server.seen.append(authorization)
        self.rfile.read(int(self.headers.get("Content-Length", "0")))
        if self.server.mode == "quota-first" and authorization == "Bearer synthetic-work":
            self.send_response(429)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"error":{"type":"usage_limit_reached","message":"Usage exhausted","resets_in_seconds":3600}}')
            return
        if self.server.mode != "reject":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            self.wfile.write(b'data: {"type":"response.completed","response":{"id":"synthetic-response","object":"response","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n')
            return
        self.send_response(400)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"error":{"message":"synthetic upstream"}}')

    def log_message(self, *args):
        pass


def credential_id(key, base_url):
    parts = ["codex:apikey", key, base_url, "", "", ""]
    return "codex:apikey:" + hashlib.sha256("\0".join(parts).encode()).hexdigest()[:12]


def request(port, key, path, data=None, headers=None):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data,
                                 headers={"Authorization": "Bearer " + key, "Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            return res.status, res.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def main():
    port, upstream_port = free_port(), free_port()
    upstream = HTTPServer(("127.0.0.1", upstream_port), FakeUpstream)
    upstream.seen = []
    upstream.mode = "reject"
    threading.Thread(target=upstream.serve_forever, daemon=True).start()
    base_url = f"http://127.0.0.1:{upstream_port}"
    work_id = credential_id("synthetic-work", base_url)
    private_id = credential_id("synthetic-private", base_url)
    owner_private_id = credential_id("synthetic-owner-private", base_url)
    second_work_id = credential_id("synthetic-second-work", base_url)
    with tempfile.TemporaryDirectory(prefix="hub-security-test-") as directory:
        root = Path(directory)
        (root / "auth").mkdir()
        (root / "plugins").mkdir()
        shutil.copy2(BASE / "key-router-source/out/key-router.dylib", root / "plugins/key-router.dylib")
        config = root / "config.yaml"
        log = (root / "server.log").open("w+")

        def start(enabled, work_allowed, quota_test=False):
            work = work_id if work_allowed else "nonexistent"
            primary = ["id=" + work] + (["id=" + second_work_id] if quota_test else [])
            config.write_text(f'''config-version: 8
server:
  host: "127.0.0.1"
  port: {port}
  commercial-mode: true
management:
  secret-key: "synthetic-management"
access:
  api-keys: ["synthetic-team", "synthetic-admin", "synthetic-owner", "synthetic-unmapped"]
oauth:
  auth-dir: "{root}/auth"
api-keys:
  codex:
    - name: "mock"
      base-url: "{base_url}"
      models:
        - name: "gpt-6.1-sol"
      keys:
        - api-key: "synthetic-work"
        - api-key: "synthetic-private"
        - api-key: "synthetic-owner-private"
        - api-key: "synthetic-second-work"
plugins:
  enabled: {str(enabled).lower()}
  dir: "{root}/plugins"
  configs:
    key-router:
      enabled: true
      usage-file: "{root}/routing-usage.json"
      users:
        - name: "team"
          api-keys: ["synthetic-team"]
          primary: {json.dumps(primary)}
        - name: "admin"
          api-keys: ["synthetic-admin"]
          primary: ["id={private_id}"]
        - name: "owner"
          api-keys: ["synthetic-owner"]
          primary: ["id={owner_private_id}"]
''')
            proc = subprocess.Popen([str(BASE / "cliproxyapi-guarded"), "-config", str(config), "-local-model"],
                                    stdout=log, stderr=log)
            for _ in range(100):
                if proc.poll() is not None:
                    raise RuntimeError("synthetic proxy terminated during startup")
                try:
                    status, body = request(port, "synthetic-admin", "/v1/models")
                    if status == 200 and b"gpt-6.1-sol" in body:
                        return proc
                except (OSError, urllib.error.URLError):
                    pass
                time.sleep(.1)
            raise RuntimeError("synthetic proxy did not become ready")

        def stop(proc):
            proc.terminate()
            proc.wait(timeout=10)

        data = json.dumps({"model": "gpt-6.1-sol", "input": "synthetic test"}).encode()
        proc = None
        try:
            proc = start(True, True)
            upstream.seen.clear()
            result = request(port, "synthetic-team", "/v1/responses", data)
            if not upstream.seen:
                log.flush(); log.seek(0)
                print("Synthetic proxy diagnostics:", log.read()[-5000:])
            assert upstream.seen and all(x == "Bearer synthetic-work" for x in upstream.seen), ("team", upstream.seen, result)
            upstream.seen.clear()
            request(port, "synthetic-admin", "/v1/responses", data)
            assert upstream.seen and all(x == "Bearer synthetic-private" for x in upstream.seen), ("admin", upstream.seen)
            upstream.seen.clear()
            request(port, "synthetic-owner", "/v1/responses", data)
            assert upstream.seen and all(x == "Bearer synthetic-owner-private" for x in upstream.seen), ("owner", upstream.seen)
            upstream.seen.clear()
            request(port, "synthetic-unmapped", "/v1/responses", data)
            assert not upstream.seen, ("unknown caller reached upstream", upstream.seen)
            anthropic = json.dumps({"model": "claude-sonnet-unavailable", "messages": [{"role": "user", "content": "synthetic"}], "max_tokens": 8}).encode()
            request(port, "synthetic-team", "/v1/messages", anthropic)
            assert not upstream.seen, ("unassigned provider reached an upstream", upstream.seen)
            update = {'users': [
                {'name': 'team', 'api-keys': ['synthetic-team'], 'primary': []},
                {'name': 'admin', 'api-keys': ['synthetic-admin'], 'primary': ['id=' + private_id]},
                {'name': 'owner', 'api-keys': ['synthetic-owner'], 'primary': ['id=' + owner_private_id]},
            ]}
            patch = urllib.request.Request(f'http://127.0.0.1:{port}/v0/management/plugins/key-router/config',
                data=json.dumps(update).encode(), method='PATCH', headers={'Authorization': 'Bearer synthetic-management', 'Content-Type': 'application/json'})
            with urllib.request.urlopen(patch, timeout=5) as reply: assert reply.status == 200
            time.sleep(.5)
            upstream.seen.clear()
            request(port, "synthetic-team", "/v1/responses", data)
            assert not upstream.seen, ("removed permission still routed", upstream.seen)
            # An administrator with no assigned accounts cannot fall back to
            # another owner's personal credential. Granting and removing the
            # exact rule takes effect for subsequent requests.
            update['users'][1]['primary'] = []
            with urllib.request.urlopen(urllib.request.Request(
                    f'http://127.0.0.1:{port}/v0/management/plugins/key-router/config',
                    data=json.dumps(update).encode(), method='PATCH', headers={'Authorization': 'Bearer synthetic-management', 'Content-Type': 'application/json'}), timeout=5) as reply: assert reply.status == 200
            time.sleep(.5)
            upstream.seen.clear()
            request(port, "synthetic-admin", "/v1/responses", data)
            assert not upstream.seen, ("admin fell back to another personal account", upstream.seen)
            update['users'][1]['primary'] = ['id=' + owner_private_id]
            with urllib.request.urlopen(urllib.request.Request(
                    f'http://127.0.0.1:{port}/v0/management/plugins/key-router/config',
                    data=json.dumps(update).encode(), method='PATCH', headers={'Authorization': 'Bearer synthetic-management', 'Content-Type': 'application/json'}), timeout=5) as reply: assert reply.status == 200
            time.sleep(.5)
            upstream.seen.clear()
            request(port, "synthetic-admin", "/v1/responses", data)
            assert upstream.seen and all(x == "Bearer synthetic-owner-private" for x in upstream.seen), ("owner shared account", upstream.seen)
            update['users'][1]['primary'] = []
            with urllib.request.urlopen(urllib.request.Request(
                    f'http://127.0.0.1:{port}/v0/management/plugins/key-router/config',
                    data=json.dumps(update).encode(), method='PATCH', headers={'Authorization': 'Bearer synthetic-management', 'Content-Type': 'application/json'}), timeout=5) as reply: assert reply.status == 200
            time.sleep(.5)
            upstream.seen.clear()
            request(port, "synthetic-admin", "/v1/responses", data)
            assert not upstream.seen, ("admin retained access after sharing was removed", upstream.seen)
            request(port, "synthetic-owner", "/v1/responses", data)
            assert upstream.seen and all(x == "Bearer synthetic-owner-private" for x in upstream.seen), ("owner lost personal access", upstream.seen)
            stop(proc); proc = None

            proc = start(True, False)
            upstream.seen.clear()
            request(port, "synthetic-team", "/v1/responses", data)
            assert not upstream.seen, ("unavailable work account leaked to private", upstream.seen)
            stop(proc); proc = None

            # A warm session moves immediately at zero, and an upstream 429
            # retries another permitted credential within the same request.
            def quotas(first, second):
                checked = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
                (root / 'routing-usage.json').write_text(json.dumps({'version': 1, 'accounts': {
                    id: {'provider': 'codex', 'checkedAt': checked,
                         'windows': [{'label': '1w', 'remaining': value}]}
                    for id, value in [(work_id, first), (second_work_id, second)]
                }}))
                time.sleep(1.05)  # Scheduler snapshot cache is bounded to one second.

            quotas(80, 0)
            upstream.mode = 'success'
            proc = start(True, True, quota_test=True)
            headers = {'Session-Id': 'synthetic-quota-session'}
            upstream.seen.clear()
            status, body = request(port, 'synthetic-team', '/v1/responses', data, headers)
            assert status == 200 and upstream.seen == ['Bearer synthetic-work'], ('initial quota session', status, body, upstream.seen)
            quotas(0, 65)
            upstream.seen.clear()
            status, body = request(port, 'synthetic-team', '/v1/responses', data, headers)
            assert status == 200 and upstream.seen == ['Bearer synthetic-second-work'], ('zero quota failover', status, body, upstream.seen)
            quotas(80, 65)
            upstream.seen.clear()
            status, body = request(port, 'synthetic-team', '/v1/responses', data, headers)
            assert status == 200 and upstream.seen == ['Bearer synthetic-second-work'], ('preserve new warm session', status, body, upstream.seen)

            quotas(80, 0)
            status, body = request(port, 'synthetic-team', '/v1/responses', data, headers)
            assert status == 200, ('pin first for provider failover', status, body)
            quotas(80, 65)
            upstream.mode = 'quota-first'
            upstream.seen.clear()
            stream_data = json.dumps({'model': 'gpt-6.1-sol', 'input': 'synthetic test', 'stream': True}).encode()
            status, body = request(port, 'synthetic-team', '/v1/responses', stream_data, headers)
            assert status == 200 and b'response.completed' in body, ('provider quota failover response', status, body)
            assert upstream.seen == ['Bearer synthetic-work', 'Bearer synthetic-second-work'], ('provider quota retry accounts', upstream.seen)
            stop(proc); proc = None

            upstream.mode = 'reject'
            proc = start(False, True)
            upstream.seen.clear()
            request(port, "synthetic-team", "/v1/responses", data)
            assert not upstream.seen, ("disabled plugin bypassed guard", upstream.seen)
            print("PASS: permission isolation, sharing/revocation, zero-quota failover, warm-session preservation, same-request provider 429 retry, and disabled-plugin guard")
        finally:
            if proc and proc.poll() is None:
                stop(proc)
            log.close()
            upstream.shutdown()


if __name__ == "__main__":
    main()
