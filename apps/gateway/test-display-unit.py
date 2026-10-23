#!/usr/bin/python3
"""Supervisor regression tests without graphics dependencies; not a render proof."""

import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

WRAPPER = Path(__file__).with_name("jian-display.py").resolve()
FAKE_SERVER = '''#!/usr/bin/python3
import json, os, pathlib, sys, time
home = pathlib.Path.home()
(home / 'server.json').write_text(json.dumps({'pid': os.getpid(), 'cwd': os.getcwd(), 'args': sys.argv}))
if os.environ.get('FAIL_SERVER'):
    sys.exit(1)
fd = int(sys.argv[sys.argv.index('-displayfd') + 1])
os.write(fd, b'42\\n')
os.close(fd)
time.sleep(30)
'''
LAUNCHER = '''import importlib.util, sys
spec = importlib.util.spec_from_file_location('display', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.glob.glob = lambda _: ['/usr/share/vulkan/icd.d/lvp_icd.test.json']
sys.exit(module.main(sys.argv[2:]))
'''


def alive(pid):
    try:
        return Path(f"/proc/{pid}/stat").read_text().split()[2] != "Z"
    except (FileNotFoundError, ProcessLookupError):
        # The process may exit before open (ENOENT) or during read (ESRCH).
        return False


class ProcessLiveness(unittest.TestCase):
    def test_process_disappearing_during_stat_read(self):
        for error in (FileNotFoundError, ProcessLookupError):
            with self.subTest(error=error.__name__):
                with patch.object(Path, "read_text", side_effect=error):
                    self.assertFalse(alive(123))

    def test_other_stat_errors_are_not_hidden(self):
        with patch.object(Path, "read_text", side_effect=PermissionError):
            with self.assertRaises(PermissionError):
                alive(123)


class Supervisor(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="display-unit-", dir=Path.home())
        self.home = Path(self.directory.name)
        server = self.home / "Xvfb"
        server.write_text(FAKE_SERVER)
        server.chmod(0o700)
        self.process = None

    def tearDown(self):
        if self.process is not None and self.process.poll() is None:
            self.process.terminate()
            self.process.wait(timeout=5)
        self.directory.cleanup()

    def start(self, args, extra=None):
        env = dict(os.environ, HOME=str(self.home),
                   PATH=str(self.home) + os.pathsep + os.environ["PATH"],
                   DISPLAY=":999", XAUTHORITY="/bogus", XDG_RUNTIME_DIR="/bogus",
                   WAYLAND_DISPLAY="wayland-0", **(extra or {}))
        self.process = subprocess.Popen([sys.executable, "-c", LAUNCHER, str(WRAPPER)] + args,
                                        env=env, cwd=self.home, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, text=True)
        return self.process

    def finish(self, expected):
        out, err = self.process.communicate(timeout=5)
        self.assertEqual(self.process.returncode, expected, out + err)
        self.assertFalse(list(self.home.glob(".jian-display-*")))
        if (self.home / "server.json").exists():
            pid = json.loads((self.home / "server.json").read_text())["pid"]
            self.assertFalse(alive(pid), "X server survived wrapper")
        return out, err

    def ready(self):
        end = time.monotonic() + 3
        while not (self.home / "ready").exists():
            self.assertIsNone(self.process.poll())
            self.assertLess(time.monotonic(), end)
            time.sleep(0.02)

    def test_auth_environment_and_exit(self):
        code = '''import json, os, pathlib, struct
p = pathlib.Path(os.environ['XAUTHORITY'])
data = p.read_bytes()
assert struct.unpack('!H', data[:2])[0] == 65535
assert b'MIT-MAGIC-COOKIE-1' in data
# Empty address AND display fields must remain unchanged after readiness.
assert data[2:6] == bytes(4)
assert p.stat().st_mode & 0o777 == 0o600
assert p.parent.stat().st_mode & 0o777 == 0o700
assert os.environ['DISPLAY'] == ':42'
assert 'WAYLAND_DISPLAY' not in os.environ
assert os.environ['XDG_RUNTIME_DIR'] == str(p.parent)
assert os.environ['TMPDIR'] == str(p.parent)
assert os.environ['LIBGL_ALWAYS_SOFTWARE'] == '1'
assert os.environ['VK_DRIVER_FILES'] == os.environ['VK_ICD_FILENAMES']
pathlib.Path('cookie').write_bytes(data[-16:])
'''
        self.start(["--", sys.executable, "-c", code])
        self.finish(0)
        first = (self.home / "cookie").read_bytes()
        server = json.loads((self.home / "server.json").read_text())
        self.assertIn("-displayfd", server["args"])
        self.assertIn("MIT-SHM", server["args"])
        self.assertIn("-nolock", server["args"])
        self.assertTrue(Path(server["cwd"]).name.startswith(".jian-display-"))
        self.start(["--", sys.executable, "-c", code])
        self.finish(0)
        self.assertNotEqual(first, (self.home / "cookie").read_bytes())
        self.start(["--", "sh", "-c", "exit 17"])
        self.finish(17)

    def test_startup_and_launch_failures(self):
        self.start(["--", "true"], {"FAIL_SERVER": "1"})
        self.finish(125)
        self.start(["--", "no-such-display-command"])
        self.finish(125)

    def test_usage_and_deadline_validation(self):
        for args, value in (([], "1"), (["--"], "1"), (["--", "true"], "111"),
                            (["--", "true"], "nan"), (["--", "true"], "0")):
            self.start(args, {"JIAN_DISPLAY_TIMEOUT_SECONDS": value})
            self.finish(125)

    def test_timeout_and_term_cleanup(self):
        self.start(["--", "sleep", "30"], {"JIAN_DISPLAY_TIMEOUT_SECONDS": "0.3"})
        self.finish(124)
        self.start(["--", "sh", "-c", "touch ready; sleep 30"])
        self.ready()
        self.process.send_signal(signal.SIGTERM)
        self.finish(128 + signal.SIGTERM)

    def test_parent_death_kills_server(self):
        self.start(["--", "sh", "-c", "echo $$ > child; touch ready; exec sleep 30"])
        self.ready()
        server = json.loads((self.home / "server.json").read_text())["pid"]
        command = int((self.home / "child").read_text())
        self.process.kill()
        self.process.communicate(timeout=5)
        end = time.monotonic() + 3
        while alive(server) or alive(command):
            self.assertLess(time.monotonic(), end, "child survived supervisor SIGKILL")
            time.sleep(0.02)
        # SIGKILL cannot run Python finally blocks; leftover private files are a
        # documented limitation, not an unauthenticated live display.


if __name__ == "__main__":
    unittest.main(verbosity=2)
