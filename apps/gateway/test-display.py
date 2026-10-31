#!/usr/bin/python3
"""Real image smoke: python3 test-display.py (requires jian-display and jian-sandbox).

Fails, rather than skips, when Landlock or graphics dependencies are unavailable.
The outer harness creates synthetic profiles, using the production filesystem grants.
"""

import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest

RENDERER = r'''
#include <GL/gl.h>
#include <GL/glx.h>
#include <X11/Xlib.h>
#include <stdio.h>
#include <unistd.h>
int main(void) {
    Display *d = XOpenDisplay(NULL);
    if (!d) return 1;
    int attributes[] = {GLX_RGBA, GLX_RED_SIZE, 8, GLX_GREEN_SIZE, 8,
                        GLX_BLUE_SIZE, 8, None};
    XVisualInfo *v = glXChooseVisual(d, DefaultScreen(d), attributes);
    if (!v) return 2;
    XSetWindowAttributes a = {0};
    a.colormap = XCreateColormap(d, DefaultRootWindow(d), v->visual, AllocNone);
    Window w = XCreateWindow(d, DefaultRootWindow(d), 0, 0, 256, 256, 0,
                             v->depth, InputOutput, v->visual, CWColormap, &a);
    GLXContext c = glXCreateContext(d, v, NULL, True);
    if (!c || !glXMakeCurrent(d, w, c)) return 3;
    XMapWindow(d, w);
    XSync(d, False);
    glViewport(0, 0, 256, 256);
    glClearColor(1, 0, 0, 1);
    glClear(GL_COLOR_BUFFER_BIT);
    glEnable(GL_SCISSOR_TEST);
    glScissor(128, 0, 128, 256);
    glClearColor(0, 1, 0, 1);
    glClear(GL_COLOR_BUFFER_BIT);
    glFinish();
    printf("%s\n", glGetString(GL_RENDERER));
    fflush(stdout);
    sleep(30);
    return 0;
}
'''


def checked(args, **kwargs):
    return subprocess.run(args, check=True, timeout=30, **kwargs)


def screenshot(window=None, width=1280, height=720, name="screen"):
    image = Path.home() / f"{name}.xwd"
    # xwd uses XGetImage, not MIT-SHM (which the wrapper disables).
    target = ["-id", window] if window else ["-root"]
    checked(["xwd", *target, "-silent", "-out", str(image)])
    pixels = checked(["ffmpeg", "-v", "error", "-i", str(image), "-frames:v", "1",
                      "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                     stdout=subprocess.PIPE).stdout
    assert len(pixels) == width * height * 3, "Unexpected screenshot dimensions"
    return pixels


def inside(mode):
    home = Path.home()
    assert Path(os.environ["XAUTHORITY"]).stat().st_mode & 0o777 == 0o600
    assert Path(os.environ["XDG_RUNTIME_DIR"]).stat().st_mode & 0o777 == 0o700
    # Cookie authentication must fail even inside the same Landlock domain.
    wrong = home / "wrong-authority"
    valid = Path(os.environ["XAUTHORITY"]).read_bytes()
    wrong.write_bytes(valid[:-16] + os.urandom(16))
    for bad in (str(home / "missing-authority"), "/dev/null", str(wrong)):
        env = dict(os.environ, XAUTHORITY=bad)
        assert subprocess.run(["xdpyinfo"], env=env, stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, timeout=5).returncode != 0
    info = checked(["xdpyinfo", "-queryExtensions"], stdout=subprocess.PIPE).stdout
    assert b"MIT-SHM" not in info
    # Locate the X server only from this process's own sandboxed /proc view.
    wrapper = os.getppid()
    children = Path(f"/proc/{wrapper}/task/{wrapper}/children").read_text().split()
    server = next(int(pid) for pid in children if int(pid) != os.getpid())
    if mode == "hold":
        (home / "ready.json").write_text(json.dumps({
            "display": os.environ["DISPLAY"], "auth": os.environ["XAUTHORITY"],
            "runtime": os.environ["XDG_RUNTIME_DIR"], "pid": os.getpid(), "server": server,
        }))
        while not (home / "release").exists():
            time.sleep(0.05)
        return
    (home / "render.c").write_text(RENDERER)
    checked(["gcc", str(home / "render.c"), "-o", str(home / "render"), "-lX11", "-lGL"])
    with (home / "renderer.txt").open("w") as log:
        app = subprocess.Popen([str(home / "render")], stdout=log)
    try:
        end = time.monotonic() + 10
        while not (home / "renderer.txt").read_text():
            assert app.poll() is None
            assert time.monotonic() < end
            time.sleep(0.05)
        assert "llvmpipe" in (home / "renderer.txt").read_text().lower()
        pixels = screenshot()
        for x, expected in ((64, bytes([255, 0, 0])), (192, bytes([0, 255, 0]))):
            offset = (128 * 1280 + x) * 3
            assert pixels[offset:offset + 3] == expected, "GLX screenshot pixels differ"
    finally:
        app.terminate()
        app.wait(timeout=5)
    # Actual Vulkan initialization AND presentation to X11, not just an ICD manifest.
    summary = checked(["vulkaninfo", "--summary"], stdout=subprocess.PIPE).stdout.decode()
    assert "llvmpipe" in summary.lower() and "CPU" in summary
    (home / "vulkan.txt").write_text(summary)
    before = screenshot()
    cube = subprocess.Popen(["vkcube", "--width", "256", "--height", "256"],
                            stdout=subprocess.DEVNULL)
    try:
        time.sleep(2)
        assert cube.poll() is None, "vkcube failed"
        after = screenshot()
        assert after != before and len(set(after)) > 32, "Vulkan did not render pixels"
        checked(["ffmpeg", "-v", "error", "-y", "-i", str(home / "screen.xwd"),
                 "-frames:v", "1", str(home / "vulkan.png")])
    finally:
        cube.terminate()
        cube.wait(timeout=5)
    print("Software GLX pixels, lavapipe Vulkan presentation and PNG capture passed", flush=True)


class DisplaySmoke(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.abi = int(checked(["jian-sandbox", "--abi"], stdout=subprocess.PIPE).stdout)
        if cls.abi < 1:
            raise RuntimeError("Landlock is required for the image isolation smoke test")
        print(f"Landlock ABI {cls.abi}", flush=True)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="display-smoke-", dir=Path.home())
        self.root = Path(self.temp.name)
        self.children = []

    def tearDown(self):
        for process in self.children:
            if process.poll() is None:
                process.terminate()
            process.wait(timeout=10)
        self.temp.cleanup()

    def profile(self, name):
        home = self.root / name
        home.mkdir(mode=0o700)
        (home / "tmp").mkdir()
        shutil.copyfile(__file__, home / "test.py")
        return home

    def sandbox(self, home, args, extra=None):
        command = ["jian-sandbox"]
        for path in ("/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32",
                     "/etc", "/opt", "/proc", "/sys", "/dev"):
            command += ["--ro", path]
        for path in (str(home), "/dev/null", "/dev/zero", "/dev/full", "/dev/random",
                     "/dev/urandom", "/dev/tty", "/dev/ptmx", "/dev/pts"):
            command += ["--rw", path]
        env = {"PATH": os.environ["PATH"], "HOME": str(home), "TMPDIR": str(home / "tmp"),
               "LANG": "C.UTF-8", **(extra or {})}
        return command + ["--"] + args, env

    def start(self, home, args, extra=None):
        command, env = self.sandbox(home, args, extra)
        log = (home / f"log-{len(self.children)}.txt").open("w")
        process = subprocess.Popen(command, env=env, cwd=home, stdout=log, stderr=log)
        log.close()
        self.children.append(process)
        return process

    def wait(self, process, home, expected=0, timeout=25):
        result = process.wait(timeout=timeout)
        logs = "\n".join(p.read_text() for p in home.glob("log-*.txt"))
        self.assertEqual(result, expected, logs)
        self.assertFalse(list(home.glob(".jian-display-*")), logs)
        return logs

    def hold(self, home):
        process = self.start(home, ["jian-display", "--", "python3", str(home / "test.py"),
                                    "--inside", "hold"])
        end = time.monotonic() + 15
        while not (home / "ready.json").exists():
            if process.poll() is not None or time.monotonic() >= end:
                self.fail("Display failed to start: " + "\n".join(
                    p.read_text() for p in home.glob("log-*.txt")))
            time.sleep(0.05)
        return process, json.loads((home / "ready.json").read_text())


    def test_render_and_capture(self):
        home = self.profile("render")
        process = self.start(home, ["jian-display", "--", "python3", str(home / "test.py"),
                                    "--inside", "render"])
        print(self.wait(process, home), flush=True)
        self.assertGreater((home / "vulkan.png").stat().st_size, 1000)

    def test_concurrent_and_cross_domain_isolation(self):
        a, b = self.profile("a"), self.profile("b")
        first, info = self.hold(a)
        second, other = self.hold(b)
        self.assertNotEqual(info["display"], other["display"])
        # No filesystem sockets, locks or TCP X11 listener; abstract transport only.
        number = int(info["display"][1:])
        self.assertFalse(Path(f"/tmp/.X{number}-lock").exists())
        self.assertFalse(Path(f"/tmp/.X11-unix/X{number}").exists())
        with socket.socket() as client:
            self.assertNotEqual(client.connect_ex(("127.0.0.1", 6000 + number)), 0)
        args = ["python3", "-c", "import pathlib,sys; pathlib.Path(sys.argv[1]).read_bytes()",
                info["auth"]]
        command, env = self.sandbox(b, args)
        denied = subprocess.run(command, env=env, cwd=b, capture_output=True, timeout=5)
        self.assertNotEqual(denied.returncode, 0)
        # Missing cookie fails on older ABIs too. With ABI 6 even a deliberately
        # copied valid cookie cannot cross the abstract-socket domain boundary.
        for home in (a, b):
            for valid in (False, True) if self.abi >= 6 else (False,):
                copied = home / "copied-authority"
                copied.write_bytes(Path(info["auth"]).read_bytes() if valid else b"")
                command, env = self.sandbox(home, ["xdpyinfo"], {
                    "DISPLAY": info["display"], "XAUTHORITY": str(copied)})
                result = subprocess.run(command, env=env, cwd=home, capture_output=True, timeout=5)
                self.assertNotEqual(result.returncode, 0, "cross-tool display access succeeded")
        (a / "release").touch()
        (b / "release").touch()
        self.wait(first, a)
        self.wait(second, b)
        # Neither display survives its wrapper.
        for details in (info, other):
            with socket.socket(socket.AF_UNIX) as client:
                self.assertNotEqual(client.connect_ex("\0/tmp/.X11-unix/X" +
                                                     details["display"][1:]), 0)

    def test_exit_timeout_and_signal_cleanup(self):
        home = self.profile("cleanup")
        for args, extra, expected in ((["sh", "-c", "exit 17"], {}, 17),
                                      (["sleep", "30"], {"JIAN_DISPLAY_TIMEOUT_SECONDS": "2"}, 124),
                                      (["does-not-exist-jian-display"], {}, 125)):
            process = self.start(home, ["jian-display", "--"] + args, extra)
            self.wait(process, home, expected)
        process, info = self.hold(home)
        process.send_signal(signal.SIGTERM)
        self.wait(process, home, 128 + signal.SIGTERM)
        self.assertFalse(Path(info["runtime"]).exists())
        (home / "ready.json").unlink()
        process, info = self.hold(home)
        os.kill(info["server"], signal.SIGKILL)
        self.wait(process, home, 125)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--inside":
        inside(sys.argv[2])
    else:
        unittest.main(verbosity=2)
