#!/usr/bin/env python3
import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import socket
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request

BASE = Path(__file__).resolve().parent.parent
KEY = 'a' * 64
DEVICE_KEY = 'd' * 64
calls = []
portal_calls = []


class Upstream(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.headers.get('Upgrade', '').lower() == 'websocket':
            accept = base64.b64encode(hashlib.sha1((self.headers['Sec-WebSocket-Key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
            self.send_response(101)
            self.send_header('Upgrade', 'websocket')
            self.send_header('Connection', 'Upgrade')
            self.send_header('Sec-WebSocket-Accept', accept)
            self.end_headers()
            frame = self.connection.recv(128)
            self.connection.sendall(frame)
            self.close_connection = True
            return
        calls.append((self.path, dict(self.headers)))
        self.send_response(200); self.end_headers(); self.wfile.write(b'models')

    def do_POST(self):
        calls.append((self.path, dict(self.headers)))
        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
        self.wfile.write(b'data: ' + body + b'\n\n')

    def log_message(self, *args):
        pass


class Portal(BaseHTTPRequestHandler):
    def do_GET(self):
        portal_calls.append((self.path, dict(self.headers)))
        self.send_response(200); self.end_headers(); self.wfile.write(b'portal')

    def log_message(self, *args):
        pass


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def req(port, target, key=KEY, data=None, extra=None):
    h = {'Authorization': 'Bearer ' + key}
    h.update(extra or {})
    q = urllib.request.Request(f'http://127.0.0.1:{port}{target}', headers=h, data=data)
    try:
        with urllib.request.urlopen(q, timeout=4) as r: return r.status, r.read()
    except urllib.error.HTTPError as e: return e.code, e.read()


def main():
    gateway_port, upstream_port, portal_port = free_port(), free_port(), free_port()
    backend = ThreadingHTTPServer(('127.0.0.1', upstream_port), Upstream)
    portal = ThreadingHTTPServer(('127.0.0.1', portal_port), Portal)
    threading.Thread(target=backend.serve_forever, daemon=True).start()
    threading.Thread(target=portal.serve_forever, daemon=True).start()
    with tempfile.TemporaryDirectory(prefix='hub-gateway-test-') as tmp:
        p = Path(tmp) / 'gateway-users.json'
        p.write_text(json.dumps({'users': [{'name': 'jordan', 'email': 'jordan@example.org', 'enabled': True, 'keyHash': hashlib.sha256(KEY.encode()).hexdigest()}]}))
        (Path(tmp) / 'onboarding').mkdir()
        (Path(tmp) / 'scripts').mkdir()
        (Path(tmp) / 'scripts/configure-t3-usage.cjs').write_text('// synthetic usage setup\n')
        (Path(tmp) / 'team-keys').mkdir()
        (Path(tmp) / 'team-keys/jordan.key').write_text(KEY)
        (Path(tmp) / 'devices').mkdir()
        device_path = Path(tmp) / 'devices' / (hashlib.sha256(DEVICE_KEY.encode()).hexdigest() + '.json')
        device_path.write_text(json.dumps({'name': 'jordan', 'email': 'jordan@example.org', 'enabled': True}))
        (Path(tmp) / 'onboarding/setup-codex-team-hub.sh').write_text('# synthetic setup script\n')
        (Path(tmp) / 'onboarding/setup-google-hub.sh').write_text('# synthetic google setup\n')
        (Path(tmp) / 'onboarding/setup-provider-hub.sh').write_text('# synthetic provider setup for __HUB_ORIGIN__\n')
        (Path(tmp) / 'hub.json').write_text(json.dumps({'hubUrl': 'https://hub.example.com', 'alternateUrls': ['https://old-hub.example.com'],
                                                         'portal': {'workspaceDomain': 'example.org'}}))
        env = os.environ.copy(); env.update({'HUB_GATEWAY_DIR': tmp, 'HUB_GATEWAY_PORT': str(gateway_port), 'HUB_BACKEND_PORT': str(upstream_port), 'HUB_PORTAL_PORT': str(portal_port)})
        proc = subprocess.Popen([shutil.which('node') or 'node', str(BASE / 'team-gateway.cjs')], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            for _ in range(50):
                try:
                    if req(gateway_port, '/v1/models')[0] == 200: break
                except (OSError, urllib.error.URLError): time.sleep(.1)
            else: raise RuntimeError('gateway failed to start')
            before = len(calls)
            with urllib.request.urlopen(f'http://127.0.0.1:{gateway_port}/setup-codex-hub.sh', timeout=4) as setup:
                assert setup.status == 200 and setup.read() == b'# synthetic setup script\n'
            with urllib.request.urlopen(f'http://127.0.0.1:{gateway_port}/setup-google-hub.sh', timeout=4) as setup:
                assert setup.status == 200 and setup.read() == b'# synthetic google setup\n'
            with urllib.request.urlopen(f'http://127.0.0.1:{gateway_port}/setup-provider-hub.sh', timeout=4) as setup:
                assert setup.status == 200 and setup.read() == b'# synthetic provider setup for https://hub.example.com\n'
            with urllib.request.urlopen(f'http://127.0.0.1:{gateway_port}/setup-hub-usage.cjs', timeout=4) as setup:
                assert setup.status == 200 and setup.read() == b'// synthetic usage setup\n'
            assert req(gateway_port, '/', extra={'Host': 'hub.example.com', 'Cookie': 'portal_session=test', 'X-Api-Key': 'spoofed'}) == (200, b'portal')
            portal_headers = {k.lower(): v for k, v in portal_calls[-1][1].items()}
            assert portal_headers['host'] == 'hub.example.com'
            assert portal_headers['cookie'] == 'portal_session=test'
            assert 'authorization' not in portal_headers and 'x-api-key' not in portal_headers
            assert req(gateway_port, '/', extra={'Host': 'hub.example.com', 'CF-Connecting-IP': '198.51.100.12', 'X-Hub-Client-IP': '192.0.2.1', 'X-Forwarded-For': '192.0.2.2'}) == (200, b'portal')
            portal_headers = {k.lower(): v for k, v in portal_calls[-1][1].items()}
            assert portal_headers.get('x-hub-client-ip') == '198.51.100.12' and 'x-forwarded-for' not in portal_headers
            assert req(gateway_port, '/portal/anything-else')[0] == 404
            assert req(gateway_port, '/v1/models', 'b' * 64)[0] == 401
            assert req(gateway_port, '/v1/usage', 'b' * 64)[0] == 401
            assert req(gateway_port, '/usage/v0/management/auth-files', 'b' * 64)[0] == 401
            assert req(gateway_port, '/usage/v0/management/api-call', 'b' * 64, data=b'{}')[0] == 401
            assert req(gateway_port, '/usage/v0/management/reset-quota', 'b' * 64, data=b'{}')[0] == 401
            assert req(gateway_port, '/usage/v0/management/config')[0] == 404
            assert req(gateway_port, '/usage/v0/management/auth-files?api_key=bad')[0] == 404
            assert req(gateway_port, '/v1/models', DEVICE_KEY)[0] == 200
            assert calls[-1][1].get('authorization') == 'Bearer ' + KEY or calls[-1][1].get('Authorization') == 'Bearer ' + KEY
            device_path.unlink()
            assert req(gateway_port, '/v1/models', DEVICE_KEY)[0] == 401
            assert req(gateway_port, '/v1/usage', DEVICE_KEY)[0] == 401
            assert req(gateway_port, '/usage/v0/management/auth-files', DEVICE_KEY)[0] == 401
            assert req(gateway_port, '/v0/management/auth-files')[0] == 404
            assert req(gateway_port, '/v1/models?api_key=sensitive')[0] == 404
            assert len(calls) == before + 1
            status, body = req(gateway_port, '/v1/responses', data=b'stream-test', extra={'X-Api-Key': 'spoofed', 'Session-Id': 'thread-1'})
            assert status == 200 and b'stream-test' in body
            headers = {k.lower(): v for k, v in calls[-1][1].items()}
            assert 'x-api-key' not in headers and headers.get('session-id') == 'thread-1'
            status, body = req(gateway_port, '/v1/messages?beta=true', data=b'provider-stream')
            assert status == 200 and b'provider-stream' in body
            assert req(gateway_port, '/v1/messages', 'b' * 64, data=b'test')[0] == 401
            with socket.create_connection(('127.0.0.1', gateway_port), timeout=4) as s:
                handshake = (f'GET /v1/responses HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {KEY}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n').encode()
                s.sendall(handshake); reply = b''
                while b'\r\n\r\n' not in reply: reply += s.recv(1024)
                assert b' 101 ' in reply
                s.sendall(b'\x81\x01x'); assert s.recv(128) == b'\x81\x01x'
            p.write_text('{invalid')
            assert req(gateway_port, '/v1/models')[0] == 401
            print('PASS: identity checks, management isolation, credential query rejection, streamed HTTP, WebSocket, and malformed-config denial')
        finally:
            proc.terminate(); proc.wait(timeout=5); backend.shutdown(); portal.shutdown()


if __name__ == '__main__': main()
