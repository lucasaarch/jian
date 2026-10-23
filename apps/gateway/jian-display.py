#!/usr/bin/python3
"""One authenticated, software-rendered X server for one sandboxed command.

Run *inside* jian-sandbox, never as a gateway-side display broker: abstract Unix
sockets inherit the caller's Landlock domain. No filesystem socket or /tmp grant.
"""

from contextlib import ExitStack
import ctypes
import glob
import os
from pathlib import Path
import secrets
import selectors
import signal
import struct
import subprocess
import sys
import tempfile
import time

MAX_SECONDS = 110
STARTUP_SECONDS = 10


def authority(path, cookie, display):
    # FamilyWild avoids hostname/address dependencies; possession of the random
    # cookie is still required. The empty display field supports dynamic allocation.
    # Keep this file unchanged while Xvfb may load authorization lazily.
    fields = (b"", str(display).encode(), b"MIT-MAGIC-COOKIE-1", cookie)
    data = struct.pack("!H", 65535)
    for field in fields:
        data += struct.pack("!H", len(field)) + field
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)


def parent_death_signal(parent):
    # No orphan X server if the outer tool has to SIGKILL this supervisor.
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:  # PR_SET_PDEATHSIG
        raise OSError(ctypes.get_errno(), "PR_SET_PDEATHSIG")
    if os.getppid() != parent:
        os._exit(125)


def stop(process):
    if process is None:
        return
    # Kill the group even if its leader already exited (background children).
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=0.5)
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait()


def main(argv):
    if len(argv) < 2 or argv[0] != "--":
        print("usage: jian-display -- COMMAND [ARG ...]", file=sys.stderr)
        return 125
    try:
        seconds = float(os.environ.get("JIAN_DISPLAY_TIMEOUT_SECONDS", MAX_SECONDS))
        if not 0 < seconds <= MAX_SECONDS:
            raise ValueError()
    except ValueError:
        print("jian-display: timeout must be greater than 0 and at most 110 seconds", file=sys.stderr)
        return 125

    interrupted = 0

    def interrupt(signum, _frame):
        nonlocal interrupted
        interrupted = signum

    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, interrupt)

    server = command = None
    parent = os.getpid()
    deadline = time.monotonic() + seconds
    try:
        # HOME is already the profile workspace. Never fall back to shared /tmp.
        with tempfile.TemporaryDirectory(prefix=".jian-display-", dir=Path.home()) as directory, ExitStack() as cleanup:
            # Stop children before deleting their authority/runtime directory, including
            # startup failures and signals before the command has been launched.
            cleanup.callback(lambda: stop(server))
            cleanup.callback(lambda: stop(command))
            auth = os.path.join(directory, "Xauthority")
            cookie = secrets.token_bytes(16)
            authority(auth, cookie, "")
            env = dict(os.environ)
            for key in ("DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY", "WAYLAND_SOCKET"):
                env.pop(key, None)
            drivers = sorted(glob.glob("/usr/share/vulkan/icd.d/lvp_icd*.json"))
            if not drivers:
                raise RuntimeError("Mesa lavapipe ICD is not installed")
            env.update({
                "XAUTHORITY": auth,
                "XDG_RUNTIME_DIR": directory,
                "TMPDIR": directory,
                "LIBGL_ALWAYS_SOFTWARE": "1",
                "GALLIUM_DRIVER": "llvmpipe",
                "VK_ICD_FILENAMES": ":".join(drivers),
                "VK_DRIVER_FILES": ":".join(drivers),
                "QT_X11_NO_MITSHM": "1",
                "MESA_SHADER_CACHE_DIR": os.path.join(directory, "mesa-cache"),
            })
            read_fd, write_fd = os.pipe()
            try:
                server = subprocess.Popen([
                    "Xvfb", "-screen", "0", "1280x720x24",
                    "-nolisten", "tcp", "-nolisten", "unix", "-listen", "local",
                    "-nolock", "-noreset", "-extension", "MIT-SHM",
                    "-auth", auth, "-displayfd", str(write_fd),
                ], env=env, cwd=directory, pass_fds=(write_fd,), start_new_session=True,
                    preexec_fn=lambda: parent_death_signal(parent), stdout=subprocess.DEVNULL)
            except BaseException:
                os.close(read_fd)
                raise
            finally:
                os.close(write_fd)
            try:
                with selectors.DefaultSelector() as selector:
                    selector.register(read_fd, selectors.EVENT_READ)
                    number = b""
                    startup = min(deadline, time.monotonic() + STARTUP_SECONDS)
                    while b"\n" not in number:
                        if interrupted:
                            return 128 + interrupted
                        if server.poll() is not None:
                            raise RuntimeError("Xvfb exited before becoming ready")
                        if time.monotonic() >= startup:
                            raise RuntimeError("Xvfb readiness timed out")
                        if selector.select(0.05):
                            chunk = os.read(read_fd, 32)
                            if not chunk:
                                raise RuntimeError("Xvfb closed its readiness pipe")
                            number += chunk
                            if len(number) > 16:
                                raise RuntimeError("invalid Xvfb display number")
                    if not number.strip().isdigit():
                        raise RuntimeError("invalid Xvfb display number")
            finally:
                os.close(read_fd)
            display = str(int(number.strip()))
            env["DISPLAY"] = ":" + display
            try:
                command = subprocess.Popen(argv[1:], env=env, start_new_session=True,
                                           preexec_fn=lambda: parent_death_signal(parent))
                while True:
                    if interrupted:
                        return 128 + interrupted
                    if server.poll() is not None:
                        raise RuntimeError("Xvfb exited while command was running")
                    result = command.poll()
                    if result is not None:
                        return result if result >= 0 else 128 - result
                    if time.monotonic() >= deadline:
                        print("jian-display: command timed out", file=sys.stderr)
                        return 124
                    time.sleep(0.05)
            finally:
                stop(command)
                command = None
                stop(server)
                server = None
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"jian-display: {error}", file=sys.stderr)
        return 125
    finally:
        stop(server)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
