"""Offline safety and capacity tests; all deletion targets are temporary fixtures."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import types
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location('storage_guard', Path(__file__).resolve().parents[2] / 'ops/host-storage-guard.py')
guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(guard)


class StorageGuardTests(unittest.TestCase):
    """Exercise deletion deny cases as well as a complete allowed cleanup."""

    def setUp(self):
        """Create isolated config, active database, retained backup and state."""
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.owner = mock.patch.object(guard, 'ROOT_UID', os.getuid())
        self.owner.start()
        self.addCleanup(self.owner.stop)
        self.addCleanup(self.temporary.cleanup)
        original_trusted = guard.trusted
        def fixture_trusted(path, **kwargs):
            # Model root-owned system ancestors outside the isolated fixture.
            if path not in self.root.parents:
                original_trusted(path, **kwargs)
        self.ancestry = mock.patch.object(guard, 'trusted', side_effect=fixture_trusted)
        self.ancestry.start()
        self.addCleanup(self.ancestry.stop)
        self.active = self.root / 'active-db'
        self.backup = self.root / 'protected-backup'
        self.state = self.root / 'state'
        self.intake = self.root / 'retired'
        for path in (self.active, self.backup, self.state, self.intake):
            path.mkdir(mode=0o700)
        self.env = self.root / 'service.env'
        self.env.write_text(f'UNRELATED=value\nROCKSDB_PATH="{self.active}"\n')
        self.filename = self.root / 'config.json'
        self.config = {'version': 1, 'filesystem_path': str(self.root), 'state_dir': str(self.state),
                       'protected_paths': [str(self.backup)], 'env_files': [str(self.env)], 'retired_artifacts': [],
                       'retirement_root': str(self.intake)}
        self.now = 1792195200

    def load(self):
        """Serialize and validate through the actual configuration entry point."""
        self.filename.write_text(json.dumps(self.config))
        self.filename.chmod(0o600)
        return guard.load_config(str(self.filename))

    def artifact(self, name='retired.tar.gz', directory=False):
        """Register one exact temporary artifact with a verified file identity."""
        path = self.intake / name
        if directory:
            path.mkdir()
            (path / 'data').write_text('obsolete')
        else:
            path.write_bytes(b'old release artifact')
        info = path.stat()
        entry = {'path': str(path), 'device': info.st_dev, 'inode': info.st_ino, 'expires_at': '2026-10-01T00:00:00Z'}
        if not directory:
            entry['sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
        self.config['retired_artifacts'].append(entry)
        return path, entry

    def test_exact_expired_file_is_deleted_and_other_data_preserved(self):
        path, entry = self.artifact()
        entry['sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
        sibling = self.root / 'not-approved.tar.gz'
        sibling.write_text('keep')
        with mock.patch.object(guard, 'no_open_handles') as handles:
            self.assertTrue(guard.remove_artifact(self.load(), entry, self.now))
        handles.assert_called_once_with(path)
        self.assertFalse(path.exists())
        self.assertTrue(sibling.exists())
        self.assertTrue(self.active.exists())
        self.assertTrue(self.backup.exists())

    def test_future_expiry_does_not_delete_or_check_handles(self):
        path, entry = self.artifact()
        entry['expires_at'] = '2099-10-01T00:00:00Z'
        with mock.patch.object(guard, 'no_open_handles') as handles:
            self.assertFalse(guard.remove_artifact(self.load(), entry, self.now))
        handles.assert_not_called()
        self.assertTrue(path.exists())

    def test_directory_cleanup_is_always_refused(self):
        path, entry = self.artifact(directory=True)
        with self.assertRaisesRegex(guard.GuardError, 'cleanup is disabled'):
            guard.remove_artifact(self.load(), entry, self.now)
        self.assertTrue(path.exists())
        self.config['allow_directory_cleanup'] = True
        with self.assertRaisesRegex(guard.GuardError, 'unknown configuration'):
            self.load()

    def test_regular_file_requires_sha256(self):
        path, entry = self.artifact()
        del entry['sha256']
        with self.assertRaisesRegex(guard.GuardError, 'requires SHA-256'):
            guard.remove_artifact(self.load(), entry, self.now)
        self.assertTrue(path.exists())

    def test_parent_substitution_before_open_is_refused(self):
        parent = self.intake
        path, entry = self.artifact()
        config = self.load()
        saved = self.root / 'saved-artifacts'
        original_open = os.open
        def replace_parent(candidate, flags, *args, **kwargs):
            if Path(candidate) == parent:
                parent.rename(saved)
                parent.mkdir()
                os.link(saved / path.name, path)
            return original_open(candidate, flags, *args, **kwargs)
        with mock.patch.object(guard, 'no_open_handles'), mock.patch.object(os, 'open', side_effect=replace_parent):
            with self.assertRaisesRegex(guard.GuardError, 'parent identity changed'):
                guard.remove_artifact(config, entry, self.now)
        self.assertTrue(path.exists())
        self.assertTrue((saved / path.name).exists())

    def test_artifact_modified_during_lsof_is_preserved(self):
        path, entry = self.artifact()
        config = self.load()
        with mock.patch.object(guard, 'no_open_handles', side_effect=lambda candidate: candidate.write_text('changed artifact')):
            with self.assertRaisesRegex(guard.GuardError, 'changed during'):
                guard.remove_artifact(config, entry, self.now)
        self.assertTrue(path.exists())

    def test_protected_descendant_and_ancestor_both_refused(self):
        for candidate in (self.backup, self.root):
            with self.subTest(candidate=candidate):
                info = candidate.stat()
                entry = {'path': str(candidate), 'device': info.st_dev, 'inode': info.st_ino, 'expires_at': '2026-10-01T00:00:00Z'}
                with self.assertRaisesRegex(guard.GuardError, 'overlaps'):
                    guard.validate_artifact(self.load(), entry, self.now)
        child = self.backup / 'old'
        child.write_text('keep')
        info = child.stat()
        entry = {'path': str(child), 'device': info.st_dev, 'inode': info.st_ino, 'expires_at': '2026-10-01T00:00:00Z'}
        with self.assertRaisesRegex(guard.GuardError, 'overlaps'):
            guard.validate_artifact(self.load(), entry, self.now)

    def test_env_database_protection_is_reloaded_before_cleanup(self):
        path, entry = self.artifact(directory=True)
        config = self.load()
        self.env.write_text(f'export ROCKSDB_PATH={path}\n')
        with self.assertRaisesRegex(guard.GuardError, 'overlaps'):
            guard.remove_artifact(config, entry, self.now)
        self.assertTrue(path.exists())

    def test_missing_or_dynamic_or_duplicate_env_paths_fail_closed(self):
        for content in ('OTHER=value\n', 'ROCKSDB_PATH=$(echo /tmp)\n', f'ROCKSDB_PATH={self.active}\nROCKSDB_PATH={self.backup}\n', 'ROCKSDB_PATH=/definitely-not-present\n'):
            with self.subTest(content=content):
                self.env.write_text(content)
                with self.assertRaises(guard.GuardError):
                    self.load()

    def test_symlink_artifact_and_ancestor_refused(self):
        symlink = self.root / 'alias'
        symlink.symlink_to(self.active, target_is_directory=True)
        for path in (symlink, symlink / 'child'):
            with self.subTest(path=path), self.assertRaisesRegex(guard.GuardError, 'Symbolic link'):
                guard.checked_path(str(path), missing=True)

    def test_inode_and_device_mismatches_refused(self):
        path, entry = self.artifact()
        config = self.load()
        for key in ('inode', 'device'):
            altered = {**entry, key: entry[key] + 1}
            with self.subTest(key=key), self.assertRaisesRegex(guard.GuardError, 'mismatch'):
                guard.remove_artifact(config, altered, self.now)
        self.assertTrue(path.exists())

    def test_retirement_requires_private_intake_and_trusted_ancestors(self):
        path, entry = self.artifact()
        config = self.load()
        for directory in (self.intake, self.root):
            with self.subTest(directory=directory):
                directory.chmod(0o770)
                with self.assertRaisesRegex(guard.GuardError, 'Unsafe ownership'):
                    guard.remove_artifact(config, entry, self.now)
                directory.chmod(0o700)
        self.assertTrue(path.exists())

    def test_retirement_file_must_be_root_owned_and_not_writable_by_others(self):
        path, entry = self.artifact()
        config = self.load()
        path.chmod(0o666)
        with self.assertRaisesRegex(guard.GuardError, 'Unsafe ownership'):
            guard.remove_artifact(config, entry, self.now)
        path.chmod(0o600)
        original = Path.stat
        def wrong_owner(candidate, *args, **kwargs):
            info = original(candidate, *args, **kwargs)
            if candidate == path:
                changed = {name: getattr(info, name) for name in dir(info) if name.startswith('st_')}
                changed['st_uid'] = guard.ROOT_UID + 1
                return types.SimpleNamespace(**changed)
            return info
        with mock.patch.object(Path, 'stat', wrong_owner), self.assertRaisesRegex(guard.GuardError, 'Unsafe ownership'):
            guard.remove_artifact(config, entry, self.now)
        self.assertTrue(path.exists())

    def test_hard_links_and_files_outside_intake_are_preserved(self):
        path, entry = self.artifact()
        config = self.load()
        alias = self.root / 'alias.tar.gz'
        os.link(path, alias)
        with self.assertRaisesRegex(guard.GuardError, 'one hard link'):
            guard.remove_artifact(config, entry, self.now)
        alias.unlink()
        path.rename(alias)
        entry['path'] = str(alias)
        with self.assertRaisesRegex(guard.GuardError, 'direct children'):
            guard.remove_artifact(config, entry, self.now)
        self.assertTrue(alias.exists())

    def test_leaf_substitution_at_final_identity_check_is_refused(self):
        path, entry = self.artifact()
        config = self.load()
        saved = self.intake / 'saved.tar.gz'
        original = os.stat
        def replace_leaf(candidate, *args, **kwargs):
            if candidate == path.name and kwargs.get('dir_fd') is not None:
                path.rename(saved)
                path.write_bytes(b'replacement')
            return original(candidate, *args, **kwargs)
        with mock.patch.object(guard, 'no_open_handles'), mock.patch.object(os, 'stat', side_effect=replace_leaf):
            with self.assertRaisesRegex(guard.GuardError, 'Artifact identity changed'):
                guard.remove_artifact(config, entry, self.now)
        self.assertTrue(path.exists())
        self.assertTrue(saved.exists())

    def test_lsof_only_clean_no_match_is_accepted(self):
        path, _ = self.artifact()
        outcomes = [(0, b'p123\n', b''), (1, b'', b'warning'), (2, b'', b''), (0, b'', b'')]
        with mock.patch.object(Path, 'is_file', return_value=True):
            for code, stdout, stderr in outcomes:
                with self.subTest(code=code, stdout=stdout, stderr=stderr):
                    with mock.patch.object(subprocess, 'run', return_value=subprocess.CompletedProcess([], code, stdout, stderr)), self.assertRaises(guard.GuardError):
                        guard.no_open_handles(path)
            with mock.patch.object(subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, b'', b'')):
                guard.no_open_handles(path)
            with mock.patch.object(subprocess, 'run', side_effect=subprocess.TimeoutExpired('lsof', 45)), self.assertRaises(guard.GuardError):
                guard.no_open_handles(path)

    def test_hash_mismatch_refused(self):
        path, entry = self.artifact()
        entry['sha256'] = '0' * 64
        with self.assertRaisesRegex(guard.GuardError, 'SHA-256 mismatch'):
            guard.validate_artifact(self.load(), entry, self.now)
        self.assertTrue(path.exists())

    def test_configuration_permissions_and_missing_protection_fail_closed(self):
        self.load()
        self.filename.chmod(0o666)
        with self.assertRaisesRegex(guard.GuardError, 'Unsafe ownership'):
            guard.load_config(str(self.filename))
        self.config['protected_paths'] = []
        with self.assertRaises(guard.GuardError):
            self.load()

    def test_capacity_severity_thresholds(self):
        config = self.load()
        for free, expected in ((200, 'ok'), (150, 'warning'), (75, 'urgent')):
            samples = [{'time': self.now, 'free_bytes': free * guard.GIB, 'total_bytes': 1000 * guard.GIB}]
            self.assertEqual(guard.assess(samples, config)['severity'], expected)

    def test_forecast_requires_one_day_and_ignores_single_spike(self):
        config = self.load()
        samples = [{'time': self.now + i * 300, 'free_bytes': (400 - i * 100 / 288) * guard.GIB, 'total_bytes': 1000 * guard.GIB} for i in range(289)]
        self.assertIsNone(guard.assess(samples[:-1], config)['days_to_full'])
        samples[20]['free_bytes'] = 99999 * guard.GIB
        result = guard.assess(samples, config)
        self.assertAlmostEqual(result['days_to_full'], 3, delta=.05)
        self.assertEqual(result['severity'], 'warning')
        samples[180]['time'] += 3600
        self.assertIsNone(guard.assess(samples, config)['days_to_full'])

    def test_headroom_includes_reserve(self):
        config = self.load()
        with mock.patch.object(guard, 'disk_sample', return_value={'free_bytes': 90 * guard.GIB}):
            self.assertTrue(guard.check_space(config, 15 * guard.GIB)['sufficient'])
            self.assertFalse(guard.check_space(config, 16 * guard.GIB)['sufficient'])
            with self.assertRaises(guard.GuardError):
                guard.check_space(config, -1)

    def test_dry_run_is_read_only(self):
        path, _ = self.artifact()
        config = self.load()
        with mock.patch.object(guard, 'no_open_handles'), mock.patch.object(subprocess, 'run') as commands:
            result = guard.run(config, dry_run=True, now=self.now)
        commands.assert_not_called()
        self.assertEqual(result['artifacts'], [str(path)])
        self.assertTrue(path.exists())
        self.assertEqual(list(self.state.iterdir()), [])

    def test_cleanup_cap_dedup_public_status_and_reminder(self):
        for i in range(6):
            self.artifact(name=f'retired-{i}.tar.gz')
        self.config['public_status_path'] = str(self.root / 'public-status.json')
        config = self.load()
        sample = {'time': self.now, 'free_bytes': 100 * guard.GIB, 'total_bytes': 1000 * guard.GIB}
        with mock.patch.object(guard, 'no_open_handles'), mock.patch.object(guard, 'disk_sample', return_value=sample), mock.patch.object(subprocess, 'run') as commands:
            result = guard.run(config, now=self.now)
            self.assertEqual(len(result['artifacts']), 5)
            self.assertEqual(commands.call_count, 1)
            guard.run(config, now=self.now + 300)
            self.assertEqual(commands.call_count, 1)
            guard.run(config, now=self.now + guard.DAY)
            self.assertEqual(commands.call_count, 2)
        public = self.root / 'public-status.json'
        self.assertEqual(public.stat().st_mode & 0o777, 0o644)
        self.assertNotIn(str(self.root), public.read_text())
        self.assertEqual(json.loads(public.read_text())['severity'], 'warning')

    def test_missing_retired_artifact_is_idempotent(self):
        path, entry = self.artifact()
        config = self.load()
        path.unlink()
        self.assertFalse(guard.remove_artifact(config, entry, self.now))
        self.intake.rmdir()
        self.assertFalse(guard.remove_artifact(self.load(), entry, self.now))

    def test_logger_failure_keeps_private_and_public_status_fresh(self):
        self.config['public_status_path'] = str(self.root / 'public-status.json')
        config = self.load()
        sample = {'time': self.now, 'free_bytes': 70 * guard.GIB, 'total_bytes': 1000 * guard.GIB}
        with mock.patch.object(guard, 'disk_sample', return_value=sample), mock.patch.object(subprocess, 'run', side_effect=subprocess.CalledProcessError(1, 'logger')):
            result = guard.run(config, now=self.now)
        self.assertIn('Alert delivery failed', result['alert_delivery_error'])
        self.assertEqual(result['last_notified'], 0)
        private = json.loads((self.state / 'status.json').read_text())
        public = json.loads((self.root / 'public-status.json').read_text())
        self.assertEqual(private['time'], self.now)
        self.assertEqual(public['time'], self.now)
        self.assertEqual(public['severity'], 'urgent')
        self.assertEqual(public['cleanup_error_count'], 1)
        self.assertIn('alert_delivery_error', public)


if __name__ == '__main__':
    unittest.main()
