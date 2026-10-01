"""Run activation in an isolated filesystem with launchd/id mocked, never on host."""

import os
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest

OPS = Path(__file__).parent
COMMIT = 'a' * 40
PRIOR = 'b' * 40


class ActivationTest(unittest.TestCase):
    def test_service_can_load_in_verified_headless_user_session(self):
        plist = plistlib.loads(OPS.joinpath('org.polkaswap.chatgpt.plist').read_bytes())
        # The inspected host has user/501 with session Background and no gui/501.
        # Omitting this scope made launchd reject bootstrap with error 134.
        self.assertEqual(plist['LimitLoadToSessionType'], 'Background')
        self.assertEqual(plist['ProcessType'], 'Background')
        self.assertNotIn('UserName', plist)
        self.assertIn('service_domain=user/501', OPS.joinpath('activate-release.sh').read_text())

    def fixture(self, temporary):
        root = Path(temporary) / 'component'
        agents = Path(temporary) / 'LaunchAgents'
        root.mkdir()
        agents.mkdir()
        candidate = root / 'releases' / COMMIT
        for relative in ['dist/src/server.js', 'dist/widget.html', 'public/privacy.html', 'plugin/assets/logo.svg']:
            path = candidate / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('candidate')
        (candidate / 'ops').mkdir()
        (candidate / 'ops/run-server.sh').write_text('printf candidate')
        plist = OPS.joinpath('org.polkaswap.chatgpt.plist').read_bytes()
        (candidate / 'ops/org.polkaswap.chatgpt.plist').write_bytes(plist)
        script = Path(temporary) / 'activate.sh'
        script.write_text(OPS.joinpath('activate-release.sh').read_text().replace('/Users/administrator/apps/polkaswap-chatgpt', str(root)).replace('/Users/administrator/Library/LaunchAgents', str(agents)))
        env = os.environ.copy()
        env['TEST_ROOT'] = str(root)
        env['BASH_FUNC_id%%'] = '() { if [[ "$1" == "-u" ]]; then echo 501; else echo administrator; fi; }'
        env['BASH_FUNC_plutil%%'] = '() { return 0; }'
        env['BASH_FUNC_launchctl%%'] = '() { if [[ "$1" == "bootstrap" && ! -f "$TEST_ROOT/bootstrap_failed" ]]; then touch "$TEST_ROOT/bootstrap_failed"; return 1; fi; return 0; }'
        return root, agents, script, env, plist

    def prior_release(self, root, agents, plist):
        prior = root / 'releases' / PRIOR
        (prior / 'ops').mkdir(parents=True)
        (prior / 'ops/run-server.sh').write_text('printf prior')
        (root / 'current').symlink_to(prior)
        runner = '#!/bin/bash\nset -euo pipefail\nexec /bin/bash ' + str(root) + '/current/ops/run-server.sh\n'
        (root / 'run-server.sh').write_text(runner)
        (agents / 'org.polkaswap.chatgpt.plist').write_bytes(plist)
        return prior, runner

    def test_failed_first_bootstrap_removes_only_new_service_configuration(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, agents, script, env, _ = self.fixture(temporary)
            result = subprocess.run(['/bin/bash', str(script), COMMIT], env=env, capture_output=True)
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertFalse((root / 'current').is_symlink())
            self.assertFalse((root / 'run-server.sh').exists())
            self.assertFalse((agents / 'org.polkaswap.chatgpt.plist').exists())
            self.assertTrue((root / 'releases' / COMMIT).exists())

    def test_failed_update_restores_pointer_and_prior_executable_configuration(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, agents, script, env, plist = self.fixture(temporary)
            prior, runner = self.prior_release(root, agents, plist)
            result = subprocess.run(['/bin/bash', str(script), COMMIT], env=env, capture_output=True)
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertEqual((root / 'current').resolve(), prior.resolve())
            self.assertEqual((root / 'run-server.sh').read_text(), runner)
            self.assertEqual((agents / 'org.polkaswap.chatgpt.plist').read_bytes(), plist)
            executed = subprocess.check_output(['/bin/bash', str(root / 'run-server.sh')])
            self.assertEqual(executed, b'prior')

    def test_changed_stable_service_config_is_refused_before_switch(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, agents, script, env, plist = self.fixture(temporary)
            prior, runner = self.prior_release(root, agents, plist)
            (root / 'releases' / COMMIT / 'ops/org.polkaswap.chatgpt.plist').write_text('changed service')
            result = subprocess.run(['/bin/bash', str(script), COMMIT], env=env, capture_output=True)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertEqual((root / 'current').resolve(), prior.resolve())
            self.assertEqual((root / 'run-server.sh').read_text(), runner)
            self.assertEqual((agents / 'org.polkaswap.chatgpt.plist').read_bytes(), plist)


if __name__ == '__main__':
    unittest.main()
