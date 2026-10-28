#!/usr/bin/env python3
"""Build pinned hub components in isolation; never replace running binaries."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def run(args, cwd=None, env=None):
    subprocess.run([str(arg) for arg in args], cwd=cwd, env=env, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-cache', type=Path, help='Optional directory containing the original upstream Git checkouts')
    parser.add_argument('--prepare-only', action='store_true', help='Verify source revisions and apply patches without compiling')
    args = parser.parse_args()
    manifest = json.loads((ROOT / 'upstream/sources.json').read_text())
    build_root = ROOT / '.build'
    build_root.mkdir(exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix='upstream-', dir=build_root))
    sources = {}
    for name, project in manifest['projects'].items():
        target = work / project['directory']
        if args.source_cache:
            cache = args.source_cache.resolve() / project['directory']
            archive = work / (name + '.tar')
            run(['git', 'archive', '--format=tar', '--output', archive, project['commit']], cwd=cache)
            target.mkdir()
            run(['tar', '-xf', archive, '-C', target])
            archive.unlink()
            run(['git', 'init', '-q', target])
        else:
            run(['git', 'init', '-q', target])
            run(['git', 'remote', 'add', 'origin', project['url']], cwd=target)
            run(['git', 'fetch', '--depth=1', 'origin', project['commit']], cwd=target)
            run(['git', 'checkout', '--detach', 'FETCH_HEAD'], cwd=target)
            actual = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=target, text=True).strip()
            if actual != project['commit']:
                raise RuntimeError('Upstream revision mismatch')
        sources[name] = target
    helper = work / 'auth-helper-source'
    shutil.copytree(sources['proxy'], helper, ignore=shutil.ignore_patterns('.git'))
    run(['git', 'init', '-q', helper])
    for name, project in manifest['projects'].items():
        patch = ROOT / 'upstream/patches' / project['patch']
        run(['git', 'apply', '--check', patch], cwd=sources[name])
        run(['git', 'apply', patch], cwd=sources[name])
    patch = ROOT / 'upstream/patches' / manifest['authHelper']['patch']
    run(['git', 'apply', '--check', patch], cwd=helper)
    run(['git', 'apply', patch], cwd=helper)
    print('Pinned source patches verified:', work, flush=True)
    if args.prepare_only:
        return
    env = {**os.environ, 'GOTOOLCHAIN': manifest['goToolchain'], 'CGO_ENABLED': '1'}
    output = work / 'artifacts'
    output.mkdir()
    run(['go', 'test', './sdk/cliproxy/auth', '-run', '^TestHubGuard'], cwd=sources['proxy'], env=env)
    run(['go', 'test', './...'], cwd=sources['router'], env=env)
    run(['go', 'build', '-buildvcs=false', '-o', output / 'cliproxyapi-guarded', './cmd/server'], cwd=sources['proxy'], env=env)
    run(['go', 'build', '-buildvcs=false', '-o', output / 'cliproxyapi-auth-helper', './cmd/server'], cwd=helper, env=env)
    extension = 'dylib' if os.uname().sysname == 'Darwin' else 'so'
    run(['go', 'build', '-buildvcs=false', '-trimpath', '-buildmode=c-shared', '-o', output / ('key-router.' + extension), '.'], cwd=sources['router'], env=env)
    print('Built artifacts (not installed):', output)


if __name__ == '__main__':
    main()
