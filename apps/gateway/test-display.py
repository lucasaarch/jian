#!/usr/bin/python3
"""Real image smoke: python3 test-display.py (requires jian-display and jian-sandbox).

Fails, rather than skips, when Landlock or graphics dependencies are unavailable.
The outer harness creates synthetic profiles, using the production filesystem grants.
For a prebuilt Lemon counter: test-display.py --lemon BINARY ARTIFACT_DIRECTORY.
Compile outside the sandbox/display deadline; this mode never downloads or builds.
"""

import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest

LEMON_BINARY = None
LEMON_ARTIFACTS = None

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


def lemon_pixel_counts(pixels):
    assert len(pixels) == 520 * 320 * 3
    bright = sum(min(pixels[(y * 520 + x) * 3:(y * 520 + x) * 3 + 3]) > 180
                 for y in range(24, 146) for x in range(24, 496))
    black = sum(max(pixels[i:i + 3]) < 16 for i in range(0, len(pixels), 3))
    return bright, black


def lemon_render():
    home = Path.home()
    env = dict(os.environ, WINIT_X11_SCALE_FACTOR="1", WGPU_BACKEND="vulkan",
               WGPU_ADAPTER_NAME="llvmpipe", LEMON_DEBUG="layout,paint", RUST_BACKTRACE="1")
    for key in ("WAYLAND_DISPLAY", "WAYLAND_SOCKET"):
        env.pop(key, None)
    # The wrapper already selects the installed lavapipe ICD and private runtime/cache.
    with (home / "lemon.log").open("w") as log:
        app = subprocess.Popen([str(home / "counter")], env=env, stdout=log, stderr=log)
    try:
        deadline = time.monotonic() + 60  # First-use lavapipe shader warmup.
        while True:
            assert app.poll() is None, "Lemon exited unexpectedly; see lemon.log"
            tree = checked(["xwininfo", "-root", "-tree"], stdout=subprocess.PIPE).stdout.decode()
            window = re.search(r'(0x[0-9a-fA-F]+) "Lemon — counter"', tree)
            if window:
                window_id = window.group(1)
                info = checked(["xwininfo", "-id", window_id], stdout=subprocess.PIPE).stdout.decode()
                assert re.search(r"Width: 520\b", info) and re.search(r"Height: 320\b", info), info
                pixels = screenshot(window_id, 520, 320, "lemon")
                # Preserve the last captured frame even if layout/pixel assertions time out.
                checked(["ffmpeg", "-v", "error", "-y", "-i", str(home / "lemon.xwd"),
                         "-frames:v", "1", str(home / "lemon.png")])
                bright, black = lemon_pixel_counts(pixels)
                trace = (home / "lemon.log").read_text()
                if (bright > 100 and black > 1000 and "layout_pass ok" in trace
                        and re.search(r"paint_pass[^\n]*glyphs=[1-9][0-9]*\b", trace)):
                    assert app.poll() is None, "Lemon exited during capture"
                    print(f"Lemon 520x320 Vulkan/X11 render: {bright} bright text pixels, "
                          f"{black} black background pixels; layout and glyph paint passed", flush=True)
                    return
            assert time.monotonic() < deadline, "Lemon render timed out; see lemon.log/lemon.png"
            time.sleep(0.25)
    finally:
        # Expected TERM is cleanup, not evidence of successful application completion.
        if app.poll() is None:
            app.terminate()
        try:
            app.wait(timeout=5)
        except subprocess.TimeoutExpired:
            app.kill()
            app.wait(timeout=5)


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
    if mode == "lemon":
        (home / "server.json").write_text(json.dumps({"server": server, "display": os.environ["DISPLAY"]}))
        lemon_render()
        return
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

    def test_lemon_counter(self):
        if LEMON_BINARY is None:
            self.skipTest("Use --lemon BINARY ARTIFACT_DIRECTORY for pinned Lemon proof")
        home = self.profile("lemon")
        shutil.copy2(LEMON_BINARY, home / "counter")
        try:
            process = self.start(home, ["jian-display", "--", "python3", str(home / "test.py"),
                                        "--inside", "lemon"], {"JIAN_DISPLAY_TIMEOUT_SECONDS": "110"})
            print(self.wait(process, home, timeout=115), flush=True)
            self.assertGreater((home / "lemon.png").stat().st_size, 1000)
            details = json.loads((home / "server.json").read_text())
            self.assertFalse(Path(f"/proc/{details['server']}").exists(), "Xvfb survived wrapper")
            with socket.socket(socket.AF_UNIX) as client:
                self.assertNotEqual(client.connect_ex("\0/tmp/.X11-unix/X" +
                                                     details["display"][1:]), 0)
        finally:
            # Outside Landlock: export only diagnostic files, never the Xauthority cookie.
            LEMON_ARTIFACTS.mkdir(parents=True, exist_ok=True)
            for pattern in ("lemon.*", "log-*.txt", "server.json"):
                for path in home.glob(pattern):
                    shutil.copy2(path, LEMON_ARTIFACTS / path.name)

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
    elif len(sys.argv) == 4 and sys.argv[1] == "--lemon":
        LEMON_BINARY = Path(sys.argv[2]).resolve(strict=True)
        LEMON_ARTIFACTS = Path(sys.argv[3]).resolve()
        unittest.main(argv=[sys.argv[0], "DisplaySmoke.test_lemon_counter"], verbosity=2)
    else:
        unittest.main(verbosity=2)
