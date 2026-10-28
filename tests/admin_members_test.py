#!/usr/bin/env python3
"""add-member, add-device and share: the commands a hub without a website relies on."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

script = Path(__file__).resolve().parent.parent / 'hub-admin.py'
spec = importlib.util.spec_from_file_location('hub_admin_members', script)
hub = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hub)


class MembersTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='hub-members-')
        root = Path(self.tmp.name)
        hub.BASE = root / 'hub'; hub.BASE.mkdir()
        hub.AUTH_DIR = root / 'auth'; hub.AUTH_DIR.mkdir()
        hub.GATEWAY = hub.BASE / 'gateway-users.json'
        for name, record in {'codex-team.json': {'type': 'codex', 'email': 'team@example.com'},
                             'claude-private.json': {'type': 'claude', 'email': 'private@example.com'}}.items():
            (hub.AUTH_DIR / name).write_text(json.dumps(record))
        (hub.BASE / 'account-ownership.json').write_text(json.dumps({'version': 1, 'accounts': {
            'codex-team.json': {'owner': 'sam', 'visibility': 'team'}}}))
        sam_key = 's' * 43
        (hub.BASE / 'team-keys').mkdir(mode=0o700)
        (hub.BASE / 'team-keys' / 'sam.key').write_text(sam_key + '\n')
        self.gateway = {'users': [{'name': 'sam', 'email': 'sam@example.org', 'role': 'admin', 'owner': True,
                                   'enabled': True, 'keyHash': hashlib.sha256(sam_key.encode()).hexdigest()}]}
        hub.write_gateway(self.gateway)
        self.state = {'api-keys': [sam_key], 'router': {'enabled': True, 'users': [
            {'name': 'sam', 'api-keys': [sam_key], 'primary': ['id=codex-team.json'], 'access': []}]}}
        self.fail_router = False

        def management(path, method='GET', payload=None):
            if path == '/api-keys':
                if method == 'PUT':
                    self.state['api-keys'] = list(payload)
                return {'api-keys': list(self.state['api-keys'])}
            if method == 'PATCH':
                if self.fail_router:
                    raise OSError('router unavailable')
                self.state['router']['users'] = json.loads(json.dumps(payload['users']))
            return json.loads(json.dumps(self.state['router']))
        hub.management = management

    def tearDown(self):
        self.tmp.cleanup()

    def test_add_member_gets_shared_accounts_and_a_private_routing_key(self):
        self.assertEqual(hub.add_member(self.gateway, 'alex', 'Alex@Example.org', admin=False), 1)
        key = (hub.BASE / 'team-keys' / 'alex.key').read_text().strip()
        self.assertEqual((hub.BASE / 'team-keys' / 'alex.key').stat().st_mode & 0o777, 0o600)
        self.assertIn(key, self.state['api-keys'])
        alex = next(u for u in self.state['router']['users'] if u['name'] == 'alex')
        self.assertEqual(alex['primary'], ['id=codex-team.json'])
        saved = next(u for u in json.loads(hub.GATEWAY.read_text())['users'] if u['name'] == 'alex')
        self.assertEqual(saved, {'name': 'alex', 'email': 'alex@example.org', 'role': 'member', 'enabled': True,
                                 'keyHash': hashlib.sha256(key.encode()).hexdigest()})
        for name, email in (('alex', 'other@example.org'), ('other', 'alex@example.org'), ('Bad Name', 'x@example.org')):
            with self.assertRaises(ValueError):
                hub.add_member(json.loads(hub.GATEWAY.read_text()), name, email, admin=False)

    def test_failed_add_member_leaves_nothing_behind(self):
        self.fail_router = True
        before = list(self.state['api-keys'])
        with self.assertRaises(OSError):
            hub.add_member(self.gateway, 'alex', 'alex@example.org', admin=False)
        self.assertEqual(self.state['api-keys'], before)
        self.assertFalse((hub.BASE / 'team-keys' / 'alex.key').exists())
        self.assertEqual([u['name'] for u in json.loads(hub.GATEWAY.read_text())['users']], ['sam'])

    def test_add_device_issues_a_key_the_hub_stores_only_as_a_hash(self):
        key = hub.add_device(self.gateway, 'sam', "Sam's laptop\n")
        self.assertRegex(key, r'^[A-Za-z0-9_-]{43}$')
        record_file = hub.BASE / 'devices' / (hashlib.sha256(key.encode()).hexdigest() + '.json')
        record = json.loads(record_file.read_text())
        self.assertEqual((record['name'], record['email'], record['enabled'], record['deviceName']),
                         ('sam', 'sam@example.org', True, "Sam's laptop"))
        self.assertNotIn(key, record_file.read_text())
        self.gateway['users'][0]['keyHash'] = '0' * 64
        with self.assertRaises(ValueError):
            hub.add_device(self.gateway, 'sam', 'Other')

    def test_share_records_ownership_and_routes_like_the_website(self):
        hub.add_member(self.gateway, 'alex', 'alex@example.org', admin=False)
        gateway = json.loads(hub.GATEWAY.read_text())
        lookup = hub.accounts()
        hub.share(gateway, hub.plugin_config(), lookup, 'claude:private@example.com', 'alex', 'personal')
        routes = {u['name']: u['primary'] for u in self.state['router']['users']}
        self.assertIn('id=claude-private.json', routes['alex'])
        self.assertNotIn('id=claude-private.json', routes['sam'])
        ownership = json.loads((hub.BASE / 'account-ownership.json').read_text())['accounts']
        self.assertEqual(ownership['claude-private.json'], {'owner': 'alex', 'visibility': 'personal'})
        hub.share(gateway, hub.plugin_config(), lookup, 'claude:private@example.com', 'alex', 'team')
        self.assertTrue(all('id=claude-private.json' in u['primary'] for u in self.state['router']['users']))
        with self.assertRaises(ValueError):
            hub.share(gateway, hub.plugin_config(), lookup, 'claude:private@example.com', 'sam', 'personal')


if __name__ == '__main__':
    unittest.main()
