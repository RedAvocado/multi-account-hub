#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import tempfile

script = Path(__file__).resolve().parent.parent / 'hub-admin.py'
spec = importlib.util.spec_from_file_location('hub_admin', script)
hub = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hub)

with tempfile.TemporaryDirectory(prefix='hub-provider-admin-') as tmp:
    hub.AUTH_DIR = Path(tmp)
    records = [
        ('codex-one.json', {'type': 'codex', 'email': 'work@example.com'}),
        ('claude-one.json', {'type': 'claude', 'email': 'work@example.com'}),
        ('claude-disabled.json', {'type': 'claude', 'email': 'disabled@example.com', 'disabled': True}),
        ('unrelated.json', {'foo': 'bar'}),
    ]
    for name, record in records:
        (hub.AUTH_DIR / name).write_text(json.dumps(record))
    known = hub.accounts()
    assert len(known) == 3
    try:
        hub.resolve_account('work@example.com', known)
        raise AssertionError('Ambiguous account accepted')
    except ValueError as error:
        assert 'ambiguous' in str(error)
    codex = hub.resolve_account('codex:work@example.com', known)
    claude = hub.resolve_account('claude:work@example.com', known)
    assert hub.resolve_account('id=claude-one.json', known) == claude
    try:
        hub.resolve_account('claude:disabled@example.com', known)
        raise AssertionError('Disabled account accepted')
    except ValueError as error:
        assert 'disabled' in str(error)
    user = {'primary': ['id=existing.json'], 'access': ['id=fallback.json']}
    hub.update_permissions(user, 'grant', [codex, claude])
    assert user['primary'] == ['id=existing.json', 'id=codex-one.json', 'id=claude-one.json']
    assert user['access'] == ['id=fallback.json']
    hub.update_permissions(user, 'revoke', [codex])
    assert user['primary'] == ['id=existing.json', 'id=claude-one.json']
    hub.update_permissions(user, 'set', [codex])
    assert user['primary'] == ['id=codex-one.json'] and not user['access']
    legacy_user = {'name': 'jordan', 'primary': ['id=codex-one.json'], 'access': [], 'auths': ['id=claude-one.json']}
    try:
        hub.update_permissions(legacy_user, 'revoke', [codex])
        raise AssertionError('Legacy fallback rule was allowed to become active')
    except ValueError as error:
        assert 'Legacy account rules' in str(error)
    assert legacy_user['primary'] == ['id=codex-one.json']
    hub.BASE = Path(tmp)
    (hub.BASE / 'account-ownership.json').write_text(json.dumps({'version': 1, 'accounts': {
        'codex-one.json': {'owner': 'riley', 'visibility': 'personal'},
        'claude-one.json': {'owner': 'jordan', 'visibility': 'team'},
    }}))
    hub.check_ownership({'name': 'riley'}, 'grant', [codex])
    hub.check_ownership({'name': 'jordan'}, 'grant', [claude])
    hub.check_ownership({'name': 'jordan'}, 'revoke', [codex])
    try:
        hub.check_ownership({'name': 'jordan'}, 'grant', [codex])
        raise AssertionError('Other user was allowed a personal account')
    except ValueError as error:
        assert 'Personal accounts' in str(error)
print('PASS: provider-qualified account selection, ambiguity checks, disabled accounts, and additive access changes')
