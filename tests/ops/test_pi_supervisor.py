"""Exercise Pi supervisor lifecycle with isolated processes and no network.

Run with: python3 -m unittest discover -s tests/ops -p 'test_pi_supervisor.py'
The fake runner execs a child, matching the production launcher's ownership.
"""

import os
from pathlib import Path
import shlex
import signal
import stat
import subprocess
import sys
import tempfile
import time
import unittest


SUPERVISOR = Path(__file__).resolve().parents[2] / "ops" / "run-pi-supervised.sh"


class PiSupervisorTests(unittest.TestCase):
    """Verify exit, graceful rotation, PID ownership, and startup signal races."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="pi supervisor ")
        self.directory = Path(self.temporary.name)
        self.pid_file = self.directory / "supervisor.pid"
        self.started = self.directory / "started"
        self.terminated = self.directory / "terminated"
        self.stopped = self.directory / "stopped"
        self.processes = []
        child = self.directory / "child.py"
        child.write_text(
            "import os, pathlib, signal, sys, time\n"
            "root = pathlib.Path(os.environ['FAKE_ROOT'])\n"
            "def stop(signum, frame):\n"
            "    with (root / 'terminated').open('a') as output: output.write('TERM\\n')\n"
            "    time.sleep(0.3)\n"
            "    (root / 'stopped').write_text('stopped')\n"
            "    sys.exit(0)\n"
            "signal.signal(signal.SIGTERM, stop)\n"
            "(root / 'started').write_text(str(os.getpid()))\n"
            "if os.environ.get('FAKE_NORMAL_EXIT'):\n"
            "    time.sleep(0.1)\n"
            "    sys.exit(int(os.environ['FAKE_NORMAL_EXIT']))\n"
            "while True: time.sleep(0.05)\n"
        )
        self.runner = self.directory / "original runner.sh"
        self.runner.write_text(
            "#!/bin/bash\nexec " + shlex.quote(sys.executable) + " " + shlex.quote(str(child)) + "\n"
        )

    def tearDown(self):
        # Only reap processes created by this test, including a failed assertion.
        for process in self.processes:
            if process.poll() is None:
                process.terminate()
                try:
                    process.communicate(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.communicate(timeout=3)
            else:
                process.communicate()
        if self.started.exists():
            child_pid = int(self.started.read_text())
            try:
                os.kill(child_pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        self.temporary.cleanup()

    def launch(self, **overrides):
        """Launch the supervisor with only a private PID file and fake runner."""
        env = dict(os.environ, PI_SUPERVISOR_PID_FILE=str(self.pid_file), FAKE_ROOT=str(self.directory))
        env.update(overrides)
        process = subprocess.Popen(
            ["/bin/bash", str(SUPERVISOR), str(self.runner)],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.processes.append(process)
        return process

    def await_file(self, path, timeout=5):
        """Wait for a child's explicit lifecycle marker rather than fixed sleeps."""
        deadline = time.monotonic() + timeout
        while not path.exists() or not path.read_text():
            if time.monotonic() >= deadline:
                self.fail(f"Timed out waiting for {path.name}")
            time.sleep(0.01)

    def assert_reaped(self, child_pid):
        """A stopped supervisor must not leave its child running or a PID file."""
        with self.assertRaises(ProcessLookupError):
            os.kill(child_pid, 0)
        self.assertFalse(self.pid_file.exists())
        self.assertEqual(list(self.directory.glob("supervisor.pid.tmp.*")), [])

    def test_usr2_drains_once_and_reaps_child(self):
        process = self.launch()
        self.await_file(self.started)
        child_pid = int(self.started.read_text())
        self.assertEqual(int(self.pid_file.read_text()), process.pid)
        self.assertEqual(stat.S_IMODE(self.pid_file.stat().st_mode), 0o600)
        process.send_signal(signal.SIGUSR2)
        self.await_file(self.terminated)
        self.assertIsNone(process.poll(), "supervisor exited before its child drained")
        stdout, stderr = process.communicate(timeout=5)
        self.assertEqual(process.returncode, 0, (stdout, stderr))
        self.assertEqual(self.terminated.read_text(), "TERM\n")
        self.assertTrue(self.stopped.exists())
        self.assert_reaped(child_pid)

    def test_duplicate_shutdown_signals_do_not_orphan_child(self):
        process = self.launch()
        self.await_file(self.started)
        child_pid = int(self.started.read_text())
        process.send_signal(signal.SIGUSR2)
        self.await_file(self.terminated)
        for signum in (signal.SIGUSR2, signal.SIGTERM, signal.SIGINT, signal.SIGUSR2):
            process.send_signal(signum)
            time.sleep(0.02)
        self.assertIsNone(process.poll())
        process.communicate(timeout=5)
        self.assertEqual(process.returncode, 0)
        self.assertEqual(self.terminated.read_text(), "TERM\n")
        self.assertTrue(self.stopped.exists())
        self.assert_reaped(child_pid)

    def test_term_and_int_each_drain_child(self):
        for signum in (signal.SIGTERM, signal.SIGINT):
            with self.subTest(signal=signum):
                for marker in (self.started, self.terminated, self.stopped):
                    marker.unlink(missing_ok=True)
                process = self.launch()
                self.await_file(self.started)
                child_pid = int(self.started.read_text())
                process.send_signal(signum)
                process.communicate(timeout=5)
                self.assertEqual(process.returncode, 0)
                self.assertEqual(self.terminated.read_text(), "TERM\n")
                self.assert_reaped(child_pid)

    def test_normal_exit_code_is_propagated_and_pid_removed(self):
        process = self.launch(FAKE_NORMAL_EXIT="23")
        self.await_file(self.started)
        child_pid = int(self.started.read_text())
        process.communicate(timeout=5)
        self.assertEqual(process.returncode, 23)
        self.assertFalse(self.terminated.exists())
        self.assert_reaped(child_pid)

    def test_existing_live_pid_is_preserved_and_not_signalled(self):
        self.pid_file.write_text(f"{os.getpid()}\n")
        process = self.launch()
        _, stderr = process.communicate(timeout=5)
        self.assertNotEqual(process.returncode, 0)
        self.assertIn("still alive", stderr)
        self.assertEqual(self.pid_file.read_text(), f"{os.getpid()}\n")
        self.assertFalse(self.started.exists())

    def test_dead_pid_is_reclaimed(self):
        stopped_process = subprocess.Popen([sys.executable, "-c", "pass"])
        stopped_process.wait(timeout=5)
        self.pid_file.write_text(f"{stopped_process.pid}\n")
        process = self.launch(FAKE_NORMAL_EXIT="7")
        self.await_file(self.started)
        child_pid = int(self.started.read_text())
        process.communicate(timeout=5)
        self.assertEqual(process.returncode, 7)
        self.assert_reaped(child_pid)

    def test_replacement_pid_file_is_not_removed(self):
        process = self.launch()
        self.await_file(self.started)
        replacement = self.directory / "replacement.pid"
        replacement.write_text(f"{os.getpid()}\n")
        replacement.replace(self.pid_file)
        process.send_signal(signal.SIGTERM)
        process.communicate(timeout=5)
        self.assertEqual(process.returncode, 0)
        self.assertEqual(self.pid_file.read_text(), f"{os.getpid()}\n")
        self.assertEqual(list(self.directory.glob("supervisor.pid.tmp.*")), [])

    def test_malformed_paths_and_pid_contents_are_refused(self):
        for value in ("relative.pid", "", str(self.directory / "missing" / "pid"), str(self.directory) + "/../pid", str(self.directory) + "/bad\npid"):
            with self.subTest(path=value):
                process = self.launch(PI_SUPERVISOR_PID_FILE=value)
                process.communicate(timeout=5)
                self.assertNotEqual(process.returncode, 0)
                self.assertFalse(self.started.exists())
        for value in ("", "0\n", "1\n", "-2\n", "not-a-pid\n", "99999999999999999999\n"):
            with self.subTest(pid=value):
                self.pid_file.write_text(value)
                process = self.launch()
                process.communicate(timeout=5)
                self.assertNotEqual(process.returncode, 0)
                self.assertEqual(self.pid_file.read_text(), value)
                self.assertFalse(self.started.exists())
        self.pid_file.unlink()
        self.pid_file.symlink_to(self.runner)
        process = self.launch()
        process.communicate(timeout=5)
        self.assertNotEqual(process.returncode, 0)
        self.assertTrue(self.pid_file.is_symlink())

    def test_shutdown_during_pid_publication_never_starts_child(self):
        # Pause atomic publication to deterministically signal before child spawn.
        # The shim still calls the real ln and does not alter supervisor source.
        published = self.directory / "published"
        release = self.directory / "release"
        commands = self.directory / "commands"
        commands.mkdir()
        shim = commands / "ln"
        shim.write_text(
            "#!/bin/bash\n/bin/ln \"$@\" || exit $?\n"
            "printf ready > " + shlex.quote(str(published)) + "\n"
            "while [[ ! -e " + shlex.quote(str(release)) + " ]]; do /bin/sleep 0.01; done\n"
        )
        shim.chmod(0o700)
        process = self.launch(PATH=str(commands) + os.pathsep + os.environ.get("PATH", "/usr/bin:/bin"))
        try:
            self.await_file(published)
            process.send_signal(signal.SIGUSR2)
        finally:
            release.write_text("release")
        process.communicate(timeout=5)
        self.assertEqual(process.returncode, 0)
        self.assertFalse(self.started.exists())
        self.assertFalse(self.pid_file.exists())
        self.assertEqual(list(self.directory.glob("supervisor.pid.tmp.*")), [])


if __name__ == "__main__":
    unittest.main()
