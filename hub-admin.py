#!/usr/bin/env python3
"""Manage Multi-Account Hub members, computers, and account access.

Works with or without the sign-in website, so a Tailscale-only hub can be run
entirely from here.

Usage:
  python3 hub-admin.py add-member alex alex@example.com [--admin]
  python3 hub-admin.py add-device alex "Alex's laptop"
  python3 hub-admin.py share codex:team@example.com alex team|personal
  python3 hub-admin.py list
  python3 hub-admin.py accounts
  python3 hub-admin.py set alex codex:team@example.com claude:team@example.com
  python3 hub-admin.py grant alex claude:work@example.com
  python3 hub-admin.py revoke alex claude:work@example.com
  python3 hub-admin.py disable alex
  python3 hub-admin.py enable alex
  python3 hub-admin.py devices [alex]
  python3 hub-admin.py revoke-device DEVICE_ID

Management credentials and member keys are never printed. add-device prints
the new computer's key once; the hub keeps only its hash.
"""
import argparse
import datetime
import hashlib
import hmac
import json
import os
import re
import secrets
from pathlib import Path
import tempfile
import urllib.error
import urllib.request

HOME = Path.home()
BASE = HOME / '.local/share/cliproxy-hub'
GATEWAY = BASE / 'gateway-users.json'
AUTH_DIR = HOME / '.cli-proxy-api'
MANAGEMENT = 'http://127.0.0.1:8317/v0/management'
NAME = re.compile(r'[a-z][a-z0-9_-]{0,40}')
KEY = re.compile(r'[A-Za-z0-9_-]{40,128}')
os.umask(0o077)


def management(path, method='GET', payload=None):
    key = (AUTH_DIR / 'management-key').read_text().strip()
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(MANAGEMENT + path, data=data, method=method,
                                 headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=15) as response:
        return json.load(response)


def plugin_config(method='GET', payload=None):
    return management('/plugins/key-router/config', method, payload)


def sha256(value):
    return hashlib.sha256(value.encode()).hexdigest()


def write_private(path, text):
    """Create a new private file; never replace an existing one."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    with os.fdopen(fd, 'w') as out:
        out.write(text)


def accounts():
    result = []
    for file in sorted(AUTH_DIR.glob('*.json')):
        record = json.loads(file.read_text())
        email = str(record.get('email', '')).strip().lower()
        provider = str(record.get('type', '')).strip().lower()
        if not email or not re.fullmatch(r'[a-z][a-z0-9_-]*', provider):
            continue
        result.append({'id': file.name, 'email': email, 'provider': provider,
                       'disabled': record.get('disabled') is True})
    return result


def resolve_account(selector, records, allow_disabled=False):
    requested = selector.strip()
    if requested.startswith('id='):
        matches = [r for r in records if r['id'] == requested[3:]]
    elif ':' in requested:
        provider, email = requested.lower().split(':', 1)
        matches = [r for r in records if r['provider'] == provider and r['email'] == email]
    else:
        matches = [r for r in records if r['email'] == requested.lower()]
    if not matches:
        raise ValueError('Unknown account: ' + selector)
    if len(matches) != 1:
        raise ValueError('Account is ambiguous; use provider:email or the id from accounts: ' + selector)
    if matches[0]['disabled'] and not allow_disabled:
        raise ValueError('Account is disabled: ' + selector)
    return matches[0]


def update_permissions(user, command, selected):
    # Legacy fallback rules can become active when the last primary/access
    # rule is removed. Refuse edits until those rules have been reviewed.
    legacy = user.get('auths', [])
    if not isinstance(legacy, list) or legacy:
        raise ValueError('Legacy account rules need review before changing access.')
    for field in ('primary', 'access'):
        existing = user.get(field, [])
        if not isinstance(existing, list) or any(not isinstance(rule, str) or not rule.startswith('id=') or len(rule) <= 3 for rule in existing):
            raise ValueError('Account rules need review before changing access.')
    rules = list(dict.fromkeys('id=' + record['id'] for record in selected))
    if command == 'set':
        user['primary'] = rules
        user['access'] = []
    elif command == 'grant':
        user['primary'] = list(dict.fromkeys(user.get('primary', []) + rules))
    elif command == 'revoke':
        user['primary'] = [rule for rule in user.get('primary', []) if rule not in rules]
        user['access'] = [rule for rule in user.get('access', []) if rule not in rules]
    else:
        raise ValueError('Unknown permission operation.')


def check_ownership(user, command, selected):
    if command == 'revoke':
        return
    ownership = json.loads((BASE / 'account-ownership.json').read_text())
    if ownership.get('version') != 1 or not isinstance(ownership.get('accounts'), dict):
        raise ValueError('Account ownership is unavailable.')
    for record in selected:
        policy = ownership['accounts'].get(record['id'])
        if not isinstance(policy, dict) or policy.get('visibility') not in ('personal', 'team', 'custom'):
            raise ValueError('Account ownership must be established before granting access.')
        if policy['visibility'] == 'personal' and policy.get('owner') != user['name']:
            raise ValueError('Personal accounts can only be used by their owners.')


def user_record(users, name):
    matches = [u for u in users if u.get('name', '').lower() == name.lower()]
    if len(matches) != 1:
        raise ValueError('Unknown or ambiguous user: ' + name)
    return matches[0]


def write_gateway(document):
    fd, tmp = tempfile.mkstemp(prefix='.gateway-users-', dir=BASE)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as out:
            json.dump(document, out, indent=2); out.write('\n')
        os.replace(tmp, GATEWAY)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)


def rules_ok(user):
    legacy = user.get('auths', [])
    if not isinstance(legacy, list) or legacy:
        return False
    return all(isinstance(user.get(field, []), list) and all(isinstance(rule, str) and rule.startswith('id=') and len(rule) > 3
               for rule in user.get(field, [])) for field in ('primary', 'access'))


def read_ownership():
    try:
        ownership = json.loads((BASE / 'account-ownership.json').read_text())
    except FileNotFoundError:
        return {'version': 1, 'accounts': {}}
    if ownership.get('version') != 1 or not isinstance(ownership.get('accounts'), dict):
        raise ValueError('Account ownership is unavailable.')
    return ownership


def write_ownership(ownership):
    fd, tmp = tempfile.mkstemp(prefix='.account-ownership-', dir=BASE)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as out:
            json.dump(ownership, out, indent=2); out.write('\n')
        os.replace(tmp, BASE / 'account-ownership.json')
    finally:
        if os.path.exists(tmp): os.unlink(tmp)


def add_member(gateway, name, email, admin):
    """Create a member with a private routing key; team-shared accounts are granted automatically."""
    email = email.strip().lower()
    if not NAME.fullmatch(name):
        raise ValueError('Member names use lowercase letters, numbers, - and _, starting with a letter.')
    if not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', email) or len(email) > 254:
        raise ValueError('Invalid email address.')
    if any(u.get('name') == name or str(u.get('email', '')).lower() == email for u in gateway['users']):
        raise ValueError('That member already exists.')
    config = plugin_config()
    if not config.get('enabled') or not isinstance(config.get('users'), list):
        raise ValueError('Account router is not enabled; refusing to change access.')
    if any(u.get('name') == name for u in config['users']):
        raise ValueError('The router already has a member with that name; review it first.')
    shared = sorted(account_id for account_id, policy in read_ownership()['accounts'].items()
                    if isinstance(policy, dict) and policy.get('visibility') == 'team' and (AUTH_DIR / account_id).is_file())
    keys_dir = BASE / 'team-keys'
    keys_dir.mkdir(mode=0o700, exist_ok=True)
    key = secrets.token_urlsafe(32)
    key_file = keys_dir / f'{name}.key'
    write_private(key_file, key + '\n')
    # The key stays on this computer: the gateway swaps each device key for it.
    try:
        keys = management('/api-keys').get('api-keys', [])
        if not isinstance(keys, list):
            raise ValueError('Proxy access keys are unavailable.')
        management('/api-keys', 'PUT', keys + [key])
        try:
            config['users'].append({'name': name, 'api-keys': [key], 'primary': ['id=' + i for i in shared], 'access': []})
            plugin_config('PATCH', {'users': config['users']})
        except Exception:
            try: management('/api-keys', 'PUT', keys)
            except Exception: pass
            raise
    except Exception:
        key_file.unlink(missing_ok=True)
        raise
    gateway['users'].append({'name': name, 'email': email, 'role': 'admin' if admin else 'member',
                             'enabled': bool(shared), 'keyHash': sha256(key)})
    write_gateway(gateway)
    return len(shared)


def add_device(gateway, member, device_name):
    """Issue a key for one computer. Returns the key, which is not stored."""
    gw = user_record(gateway['users'], member)
    if gw.get('enabled') is not True:
        raise ValueError('Enable this member before adding a computer.')
    internal = (BASE / 'team-keys' / f"{gw['name']}.key").read_text().strip()
    if not KEY.fullmatch(internal) or not hmac.compare_digest(sha256(internal), str(gw.get('keyHash', ''))):
        raise ValueError("The member's routing key does not match gateway-users.json.")
    label = re.sub(r'[\x00-\x1f\x7f]', '', device_name).strip()[:80]
    key = secrets.token_urlsafe(32)
    devices = BASE / 'devices'
    devices.mkdir(mode=0o700, exist_ok=True)
    created = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    record = {'name': gw['name'], 'email': gw['email'], 'enabled': True, 'createdAt': created,
              'deviceName': label, 'platform': ''}
    write_private(devices / f'{sha256(key)}.json', json.dumps(record) + '\n')
    return key


def share(gateway, config, lookup, selector, owner, visibility):
    """Record who owns an account and who may use it, as the website does."""
    if visibility not in ('team', 'personal'):
        raise ValueError('Choose team or personal.')
    record = resolve_account(selector, lookup)
    gw = user_record(gateway['users'], owner)
    ownership = read_ownership()
    current = ownership['accounts'].get(record['id'])
    if isinstance(current, dict) and current.get('owner') not in (None, '', gw['name']):
        raise ValueError(f"This account belongs to {current['owner']}; only its owner can change its sharing.")
    names = [u.get('name') for u in gateway['users']]
    routed = [u.get('name') for u in config['users']]
    if sorted(names) != sorted(routed) or len(set(names)) != len(names) or not all(rules_ok(u) for u in config['users']):
        raise ValueError('Router members or rules need review before sharing.')
    rule = 'id=' + record['id']
    for u in config['users']:
        u['primary'] = [r for r in u.get('primary', []) if r != rule]
        u['access'] = [r for r in u.get('access', []) if r != rule]
        if u['name'] == gw['name'] or visibility == 'team':
            u['primary'].append(rule)
    ownership['accounts'][record['id']] = {'owner': gw['name'], 'visibility': visibility}
    # Never let the records claim an account is more private than its routing.
    if visibility == 'team':
        write_ownership(ownership)
        plugin_config('PATCH', {'users': config['users']})
    else:
        plugin_config('PATCH', {'users': config['users']})
        write_ownership(ownership)
    return record


def hub_url():
    try:
        return json.loads((BASE / 'hub.json').read_text())['hubUrl']
    except (OSError, ValueError, KeyError, TypeError):
        return 'https://YOUR-HUB'


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('list')
    sub.add_parser('accounts')
    member = sub.add_parser('add-member'); member.add_argument('user'); member.add_argument('email')
    member.add_argument('--admin', action='store_true')
    device = sub.add_parser('add-device'); device.add_argument('user'); device.add_argument('device_name', nargs='?', default='')
    sharing = sub.add_parser('share'); sharing.add_argument('account'); sharing.add_argument('owner')
    sharing.add_argument('visibility', choices=('team', 'personal'))
    for name in ('set', 'grant', 'revoke'):
        change = sub.add_parser(name)
        change.add_argument('user')
        change.add_argument('accounts', nargs='+')
    for name in ('disable', 'enable'):
        part = sub.add_parser(name); part.add_argument('user')
    devices = sub.add_parser('devices'); devices.add_argument('user', nargs='?')
    revoke = sub.add_parser('revoke-device'); revoke.add_argument('device_id')
    args = parser.parse_args()
    gateway = json.loads(GATEWAY.read_text())
    if args.command == 'add-member':
        granted = add_member(gateway, args.user, args.email, args.admin)
        if granted:
            print(f"Added {args.user} with {granted} shared account{'s' if granted != 1 else ''}. Next: add-device {args.user}.")
        else:
            print(f"Added {args.user}, disabled until an account is shared or granted. Then run enable {args.user}.")
        return
    if args.command == 'add-device':
        key = add_device(gateway, args.user, args.device_name)
        print(f"Device key for {args.user} (shown once, works on one computer):\n\n  {key}\n")
        print('On that computer, run this and paste the key when asked:\n')
        print(f'  setup_dir="$(mktemp -d)" && curl -fsS {hub_url()}/setup-provider-hub.sh -o "$setup_dir/setup.sh" && bash "$setup_dir/setup.sh" --key')
        return
    if args.command in ('devices', 'revoke-device'):
        device_dir = BASE / 'devices'
        if args.command == 'devices':
            if args.user:
                user_record(gateway['users'], args.user)
            for file in sorted(device_dir.glob('*.json')):
                if not re.fullmatch(r'[a-f0-9]{64}\.json', file.name):
                    continue
                record = json.loads(file.read_text())
                if args.user and str(record.get('name', '')).lower() != args.user.lower():
                    continue
                print(f"{file.stem[:16]}  {record.get('name', '?')}  {record.get('createdAt', '?')}")
            return
        prefix = args.device_id.lower()
        if not re.fullmatch(r'[a-f0-9]{12,64}', prefix):
            raise ValueError('Use the device ID shown by the devices command.')
        matches = [file for file in device_dir.glob(prefix + '*.json') if re.fullmatch(r'[a-f0-9]{64}\.json', file.name)]
        if len(matches) != 1:
            raise ValueError('Device ID is unknown or ambiguous.')
        record = json.loads(matches[0].read_text())
        matches[0].unlink()
        print(f"Revoked device {prefix} for {record.get('name', '?')}.")
        return
    if args.command == 'disable':
        gw = user_record(gateway['users'], args.user)
        gw['enabled'] = False
        write_gateway(gateway)
        print(f"{gw['name']} access disabled.")
        return
    config = plugin_config()
    if not config.get('enabled') or not isinstance(config.get('users'), list):
        raise ValueError('Account router is not enabled; refusing to change access.')
    lookup = accounts()
    if args.command == 'share':
        record = share(gateway, config, lookup, args.account, args.owner, args.visibility)
        print(f"{record['provider']}:{record['email']} is now {'shared with the team' if args.visibility == 'team' else 'personal to ' + args.owner}.")
        return
    if args.command == 'accounts':
        for record in lookup:
            suffix = ' (disabled)' if record['disabled'] else ''
            print(f"{record['provider']}:{record['email']}{suffix}  id={record['id']}")
        return
    if args.command == 'list':
        reverse = {record['id']: f"{record['provider']}:{record['email']}" + (' (disabled)' if record['disabled'] else '') for record in lookup}
        for gw in gateway['users']:
            u = user_record(config['users'], gw['name'])
            names = [reverse.get(rule[3:], '(unknown account)') for rule in u.get('primary', []) if rule.startswith('id=')]
            print(f"{gw['name']} ({'enabled' if gw.get('enabled') else 'disabled'}): {', '.join(names) if names else 'no accounts'}")
        return
    gw = user_record(gateway['users'], args.user)
    u = user_record(config['users'], args.user)
    if args.command == 'enable':
        if not u.get('primary'):
            raise ValueError('Assign at least one account before enabling this user.')
        gw['enabled'] = True
        write_gateway(gateway)
        print(f"{gw['name']} access enabled.")
        return
    selected = [resolve_account(value, lookup, allow_disabled=args.command == 'revoke') for value in args.accounts]
    check_ownership(gw, args.command, selected)
    update_permissions(u, args.command, selected)
    # The proxy atomically persists and reloads its own configuration. Its
    # guarded scheduler rejects requests if the router is unavailable.
    plugin_config('PATCH', {'users': config['users']})
    print(f"Updated allowed accounts for {gw['name']}.")


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, urllib.error.HTTPError) as exc:
        print('Hub administration failed:', type(exc).__name__, str(exc))
        raise SystemExit(1)
