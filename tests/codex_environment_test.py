"""Optional real-Codex startup regression; all homes, credentials and HTTP are fixtures.

Run with HUB_TEST_CODEX_BINARY=/absolute/path/to/codex python3 tests/codex_environment_test.py.
No T3 process or user state is accessed.
"""
import http.server
import json
import os
from pathlib import Path
import queue
import shlex
import shutil
import subprocess
import tempfile
import threading
import unittest

REPO = Path(__file__).resolve().parents[1]


@unittest.skipUnless(os.environ.get('HUB_TEST_CODEX_BINARY'), 'Set HUB_TEST_CODEX_BINARY for real CLI verification')
class CodexEnvironmentTest(unittest.TestCase):
    def test_effective_fresh_start_uses_hub_route_and_private_auth(self):
        with tempfile.TemporaryDirectory(prefix='hub-codex-process-test-') as temporary:
            home = Path(temporary)
            personal = home / '.codex'
            hub = home / '.dittodub-provider-hub/codex'
            personal.mkdir()
            hub.mkdir(parents=True)
            received = queue.Queue()
            class Handler(http.server.BaseHTTPRequestHandler):
                def do_GET(self):
                    if self.path.startswith('/v1/responses'):
                        received.put((self.path, self.headers.get('Authorization')))
                    body = b'{"data":[],"models":[]}'
                    self.send_response(200)
                    self.send_header('Content-Length', str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                def do_POST(self):
                    received.put((self.path, self.headers.get('Authorization')))
                    self.send_response(503)
                    self.send_header('Content-Length', '0')
                    self.end_headers()
                def log_message(self, *args):
                    pass
            server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)
            base = 'http://127.0.0.1:%d/v1' % server.server_port
            # The shared table deliberately contains an auth method which must
            # disappear when the entire provider table is overridden.
            config = '''model_provider = "personal"
cli_auth_credentials_store = "keyring"
forced_login_method = "chatgpt"
check_for_update_on_startup = false
[model_providers.personal]
name = "Personal"
base_url = "http://127.0.0.1:1/personal"
wire_api = "responses"
[model_providers.dittodub-provider-hub]
name = "Wrong inherited provider"
base_url = "http://127.0.0.1:1/wrong"
wire_api = "responses"
env_key = "PERSONAL_KEY_MUST_NOT_BE_USED"
experimental_bearer_token = "personal-token-must-not-be-used"
[mcp_servers.fixture]
command = "/usr/bin/false"
enabled = false
[analytics]
enabled = false
[feedback]
enabled = false
'''
            (personal / 'config.toml').write_text(config)
            (personal / 'auth.json').write_text('{"OPENAI_API_KEY":"PERSONAL"}')
            (personal / 'AGENTS.md').write_text('Fixture shared instructions')
            (personal / 'plugins').mkdir()
            (personal / 'skills').mkdir()
            key = 'h' * 43
            (hub / 'auth.json').write_text(json.dumps({'OPENAI_API_KEY': key}))
            (hub / 'auth.json').chmod(0o600)
            for name in ('config.toml', 'AGENTS.md', 'plugins', 'skills'):
                (hub / name).symlink_to(personal / name)
            # Use exactly the production settings generation; shlex has the
            # same quoting behavior as T3 for this generated argument subset.
            launch_args = subprocess.check_output([
                shutil.which('node'), '-e',
                'process.stdout.write(require(process.argv[1]).withRoutingArgs(process.argv[4], process.argv[2], process.argv[3]))',
                str(REPO / 'scripts/configure-t3-usage.cjs'), base, str(hub),
                '-c \'model_provider="personal"\' -c \'model_reasoning_effort="high"\''], text=True)
            self.assertNotIn(key, launch_args)
            env = {'PATH': os.environ['PATH'], 'HOME': str(home), 'CODEX_HOME': str(hub),
                   'XDG_CONFIG_HOME': str(home / '.config'), 'RUST_LOG': 'off',
                   'HTTP_PROXY': 'http://127.0.0.1:1', 'HTTPS_PROXY': 'http://127.0.0.1:1',
                   'NO_PROXY': '127.0.0.1,localhost'}
            proc = subprocess.Popen([os.environ['HUB_TEST_CODEX_BINARY'], 'app-server', *shlex.split(launch_args)],
                                    cwd=home, env=env, text=True, stdin=subprocess.PIPE,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            messages = queue.Queue()
            def read():
                for line in proc.stdout:
                    try: messages.put(json.loads(line))
                    except ValueError: pass
            reader = threading.Thread(target=read, daemon=True)
            reader.start()
            sequence = 0
            def request(method, params):
                nonlocal sequence
                sequence += 1
                proc.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': sequence, 'method': method, 'params': params}) + '\n')
                proc.stdin.flush()
                while True:
                    try: reply = messages.get(timeout=15)
                    except queue.Empty:
                        proc.terminate()
                        _, error = proc.communicate(timeout=5)
                        self.fail('Codex startup timed out: ' + error)
                    if reply.get('id') == sequence:
                        self.assertNotIn('error', reply, reply)
                        return reply['result']
            try:
                request('initialize', {'clientInfo': {'name': 'hub_environment_test', 'version': '1'},
                                       'capabilities': {'experimentalApi': True}})
                proc.stdin.write('{"jsonrpc":"2.0","method":"initialized","params":{}}\n')
                proc.stdin.flush()
                result = request('config/read', {'includeLayers': False})
                effective = result['config']
                self.assertRegex(effective['model_provider'], r'^dittodub-provider-hub-[a-f0-9]{16}$')
                self.assertEqual(effective['cli_auth_credentials_store'], 'file')
                self.assertEqual(effective['forced_login_method'], 'api')
                self.assertEqual(effective['model_reasoning_effort'], 'high')
                provider = effective['model_providers'][effective['model_provider']]
                self.assertEqual(provider['base_url'], base)
                self.assertTrue(provider['requires_openai_auth'])
                self.assertIsNone(provider.get('env_key'))
                self.assertIsNone(provider.get('experimental_bearer_token'))
                self.assertEqual(effective['mcp_servers']['fixture']['command'], '/usr/bin/false')
                account = request('account/read', {'refreshToken': False})
                self.assertEqual(account['account']['type'], 'apiKey')
                thread = request('thread/start', {'model': 'gpt-5.1-codex', 'cwd': str(home),
                    'approvalPolicy': 'never', 'sandbox': 'read-only', 'ephemeral': True})
                request('turn/start', {'threadId': thread['thread']['id'],
                    'input': [{'type': 'text', 'text': 'Synthetic transport test', 'text_elements': []}]})
                route, authorization = received.get(timeout=15)
                self.assertTrue(route.startswith('/v1/responses'), route)
                self.assertEqual(authorization, 'Bearer ' + key)
                self.assertEqual((personal / 'config.toml').read_text(), config)
                self.assertEqual((personal / 'auth.json').read_text(), '{"OPENAI_API_KEY":"PERSONAL"}')
                self.assertEqual(json.loads((hub / 'auth.json').read_text())['OPENAI_API_KEY'], key)
            finally:
                if proc.poll() is None: proc.terminate()
                proc.communicate(timeout=5)


if __name__ == '__main__':
    unittest.main()
