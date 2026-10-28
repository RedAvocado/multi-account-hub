"""Exercise the served installer with isolated homes and stubbed usage/network."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / 'onboarding/setup-provider-hub.sh'


class SetupSkillsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.hub = self.home / '.dittodub-provider-hub'
        (self.hub / 'codex').mkdir(parents=True)
        self.config = self.hub / 'codex/config.toml'
        self.config.write_text('existing configuration must remain unchanged\n')
        self.bin = self.home / 'bin'
        self.bin.mkdir()
        # Never contact the real hub or T3. The skills code still uses Python.
        for name in ('curl', 'node'):
            stub = self.bin / name
            stub.write_text('#!/bin/sh\nexit 0\n')
            stub.chmod(0o700)

    def run_setup(self, success=True):
        before = self.config.read_bytes() if self.config.exists() else None
        result = subprocess.run(
            ['bash', str(SCRIPT)], input='unused-setup-code\n',
            env={**os.environ, 'HOME': str(self.home),
                 'PATH': str(self.bin) + os.pathsep + os.environ['PATH']},
            text=True, capture_output=True, timeout=10)
        if success:
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn('Paste', result.stdout)
        else:
            self.assertNotEqual(result.returncode, 0)
        if before is not None:
            self.assertEqual(self.config.read_bytes(), before)
        self.assertNotIn('unused-setup-code', result.stdout + result.stderr)
        return result

    def test_links_existing_skills_and_future_additions_and_is_idempotent(self):
        for name in ('codex', 'claude'):
            source = self.home / ('.' + name) / 'skills'
            (source / 'existing').mkdir(parents=True)
            (source / 'existing/SKILL.md').write_text('existing skill')
        self.run_setup()
        self.run_setup()
        for name in ('codex', 'claude'):
            source = self.home / ('.' + name) / 'skills'
            target = self.hub / name / 'skills'
            self.assertTrue(target.is_symlink())
            self.assertTrue(target.samefile(source))
            (source / 'later').mkdir()
            (source / 'later/SKILL.md').write_text('later skill')
            self.assertTrue((target / 'later/SKILL.md').samefile(source / 'later/SKILL.md'))
        self.assertFalse((self.hub / 'backups').exists())

    def test_missing_sources_are_created(self):
        self.run_setup()
        for name in ('codex', 'claude'):
            self.assertTrue((self.hub / name / 'skills').samefile(
                self.home / ('.' + name) / 'skills'))

    def test_builtin_skills_are_backed_up_once(self):
        old = self.hub / 'codex/skills/.system/builtin'
        old.mkdir(parents=True)
        (old / 'SKILL.md').write_text('previous builtin')
        self.run_setup()
        self.run_setup()
        backups = list((self.hub / 'backups').glob('*/codex-skills/.system/builtin/SKILL.md'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), 'previous builtin')

    def test_custom_skills_conflict_stops_before_either_provider_is_changed(self):
        custom = self.hub / 'claude/skills/custom'
        custom.mkdir(parents=True)
        (custom / 'SKILL.md').write_text('keep me')
        result = self.run_setup(success=False)
        self.assertIn('Merge those skills', result.stderr)
        self.assertEqual((custom / 'SKILL.md').read_text(), 'keep me')
        self.assertFalse((self.hub / 'codex/skills').exists())
        self.assertNotIn('Paste', result.stdout)

    def test_unrelated_link_is_preserved(self):
        other = self.home / 'other-skills'
        other.mkdir()
        target = self.hub / 'codex/skills'
        target.symlink_to(other)
        result = self.run_setup(success=False)
        self.assertIn('already links elsewhere', result.stderr)
        self.assertTrue(target.samefile(other))

    def test_fresh_install_links_before_reading_code(self):
        self.config.unlink()
        result = self.run_setup(success=False)
        self.assertIn('Invalid setup code', result.stderr)
        self.assertTrue((self.hub / 'codex/skills').is_symlink())
        self.assertTrue((self.hub / 'claude/skills').is_symlink())
        self.assertFalse(self.config.exists())

    def test_source_pointing_back_into_hub_is_rejected(self):
        source = self.home / '.codex/skills'
        source.parent.mkdir()
        target = self.hub / 'codex/skills'
        target.mkdir()
        source.symlink_to(target)
        result = self.run_setup(success=False)
        self.assertIn('points inside the hub home', result.stderr)
        self.assertFalse(target.is_symlink())


if __name__ == '__main__':
    unittest.main()
