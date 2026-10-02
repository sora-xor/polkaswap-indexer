"""Verify route preservation, ambiguity rejection, and atomic file metadata."""

import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('configure_nginx', Path(__file__).with_name('configure-nginx.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

FIXTURE = 'server {\n  listen 443 ssl;\n  server_name pi.soramitsu.io;\n  location = /graphql { proxy_pass http://polkaswap_indexer_api; }\n  location ^~ /ipfs/ { proxy_pass http://127.0.0.1:5182; }\n' + module.ANCHOR + '}\n'


class NginxConfigurationTest(unittest.TestCase):
    def test_add_is_idempotent_and_removal_recovers_all_existing_bytes(self):
        candidate = module.patched_config(FIXTURE)
        self.assertEqual(candidate.count(module.INCLUDE), 1)
        self.assertEqual(module.patched_config(candidate), candidate)
        restored = module.patched_config(candidate, remove=True)
        self.assertEqual(restored, FIXTURE)
        self.assertIn('location = /graphql { proxy_pass http://polkaswap_indexer_api; }', candidate)
        self.assertIn('location ^~ /ipfs/ { proxy_pass http://127.0.0.1:5182; }', candidate)

    def test_ambiguous_or_wrong_server_is_rejected(self):
        for fixture in [FIXTURE + module.ANCHOR, FIXTURE.replace('listen 443 ssl;', 'listen 80;'), module.INCLUDE * 2 + FIXTURE]:
            with self.assertRaises(ValueError):
                module.patched_config(fixture)

    def test_atomic_replace_preserves_mode_and_does_not_follow_symlink(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'pi.conf'
            path.write_bytes(b'previous')
            path.chmod(0o640)
            module.replace_preserving_metadata(path, b'candidate')
            self.assertEqual(path.read_bytes(), b'candidate')
            self.assertEqual(path.stat().st_mode & 0o777, 0o640)
            link = Path(temporary) / 'link.conf'
            link.symlink_to(path)
            with self.assertRaises(ValueError):
                module.replace_preserving_metadata(link, b'unsafe')
            self.assertEqual(path.read_bytes(), b'candidate')

    def test_include_upgrade_is_applied_when_server_include_line_is_unchanged(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = Path(temporary) / 'pi.conf'
            include = Path(temporary) / 'route.inc'
            config.write_bytes(module.patched_config(FIXTURE).encode())
            include.write_bytes(b'old upstream')
            prior_config = config.read_bytes()
            checked = []
            module.apply_changes(config, include, prior_config, b'new upstream', lambda: checked.append(include.read_bytes()))
            self.assertEqual(checked, [b'new upstream'])
            self.assertEqual(config.read_bytes(), prior_config)
            self.assertEqual(include.read_bytes(), b'new upstream')

    def test_failed_reload_restores_both_config_and_existing_or_new_include(self):
        for old_include in [None, b'old route']:
            with self.subTest(old_include=old_include), tempfile.TemporaryDirectory() as temporary:
                config = Path(temporary) / 'pi.conf'
                include = Path(temporary) / 'route.inc'
                config.write_bytes(FIXTURE.encode())
                if old_include is not None:
                    include.write_bytes(old_include)
                checks = []
                def reload():
                    checks.append(config.read_bytes())
                    if len(checks) == 1:
                        raise OSError('simulated reload failure')
                with self.assertRaises(OSError):
                    module.apply_changes(config, include, module.patched_config(FIXTURE).encode(), b'new route', reload)
                self.assertEqual(config.read_bytes(), FIXTURE.encode())
                self.assertEqual(include.read_bytes() if include.exists() else None, old_include)
                self.assertEqual(checks[-1], FIXTURE.encode())


if __name__ == '__main__':
    unittest.main()
