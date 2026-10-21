#!/usr/bin/env python3
"""
Jian Remote Control — Linux computer-use helper (X11).

Newline-delimited JSON on stdin → JSON lines on stdout (same cmds as macOS helper).
Overlay: override-redirect window with white pointer + #2880F8 stroke/glow (parity with macOS sprite).
Input: xdotool when available (save/restore cursor around clicks so the user's
pointer is not left at the Jian position). Wayland: best-effort; overlay may be
unavailable — input still works when ydotool/wtype/xdotool can reach the session.

English-only stderr. No third-party Python packages (ctypes + libX11).
"""

from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import sys
import threading
import time
from ctypes import (
    POINTER,
    Structure,
    byref,
    c_char,
    c_char_p,
    c_int,
    c_long,
    c_short,
    c_uint,
    c_ulong,
    c_ushort,
    c_void_p,
    cdll,
    create_string_buffer,
)

# --- X11 bindings (minimal) -------------------------------------------------

X11 = cdll.LoadLibrary("libX11.so.6")

Bool = c_int
Status = c_int
Window = c_ulong
Display = c_void_p
Atom = c_ulong
Colormap = c_ulong
Pixmap = c_ulong
GC = c_void_p
Visual = c_void_p


class XPoint(Structure):
    _fields_ = [("x", c_short), ("y", c_short)]


class XColor(Structure):
    _fields_ = [
        ("pixel", c_ulong),
        ("red", c_ushort),
        ("green", c_ushort),
        ("blue", c_ushort),
        ("flags", c_char),
        ("pad", c_char),
    ]


class XSetWindowAttributes(Structure):
    _fields_ = [
        ("background_pixmap", Pixmap),
        ("background_pixel", c_ulong),
        ("border_pixmap", Pixmap),
        ("border_pixel", c_ulong),
        ("bit_gravity", c_int),
        ("win_gravity", c_int),
        ("backing_store", c_int),
        ("backing_planes", c_ulong),
        ("backing_pixel", c_ulong),
        ("save_under", Bool),
        ("event_mask", c_long),
        ("do_not_propagate_mask", c_long),
        ("override_redirect", Bool),
        ("colormap", Colormap),
        ("cursor", c_ulong),
    ]


X11.XOpenDisplay.argtypes = [c_char_p]
X11.XOpenDisplay.restype = Display
X11.XDefaultScreen.argtypes = [Display]
X11.XDefaultScreen.restype = c_int
X11.XRootWindow.argtypes = [Display, c_int]
X11.XRootWindow.restype = Window
X11.XDefaultColormap.argtypes = [Display, c_int]
X11.XDefaultColormap.restype = Colormap
X11.XDefaultDepth.argtypes = [Display, c_int]
X11.XDefaultDepth.restype = c_int
X11.XDefaultVisual.argtypes = [Display, c_int]
X11.XDefaultVisual.restype = Visual
X11.XDisplayWidth.argtypes = [Display, c_int]
X11.XDisplayWidth.restype = c_int
X11.XDisplayHeight.argtypes = [Display, c_int]
X11.XDisplayHeight.restype = c_int
X11.XCreateWindow.argtypes = [
    Display,
    Window,
    c_int,
    c_int,
    c_uint,
    c_uint,
    c_uint,
    c_int,
    c_uint,
    Visual,
    c_ulong,
    POINTER(XSetWindowAttributes),
]
X11.XCreateWindow.restype = Window
X11.XMapRaised.argtypes = [Display, Window]
X11.XUnmapWindow.argtypes = [Display, Window]
X11.XMoveWindow.argtypes = [Display, Window, c_int, c_int]
X11.XClearWindow.argtypes = [Display, Window]
X11.XFlush.argtypes = [Display]
X11.XSync.argtypes = [Display, Bool]
X11.XCreateGC.argtypes = [Display, Window, c_ulong, c_void_p]
X11.XCreateGC.restype = GC
X11.XSetForeground.argtypes = [Display, GC, c_ulong]
X11.XFillPolygon.argtypes = [Display, Window, GC, POINTER(XPoint), c_int, c_int, c_int]
X11.XDrawLines.argtypes = [Display, Window, GC, POINTER(XPoint), c_int, c_int]
X11.XAllocNamedColor.argtypes = [Display, Colormap, c_char_p, POINTER(XColor), POINTER(XColor)]
X11.XAllocNamedColor.restype = Status
X11.XStoreName.argtypes = [Display, Window, c_char_p]
X11.XSelectInput.argtypes = [Display, Window, c_long]
X11.XPending.argtypes = [Display]
X11.XPending.restype = c_int
X11.XNextEvent.argtypes = [Display, c_void_p]
X11.XInternAtom.argtypes = [Display, c_char_p, Bool]
X11.XInternAtom.restype = Atom
X11.XChangeProperty.argtypes = [
    Display,
    Window,
    Atom,
    Atom,
    c_int,
    c_int,
    c_void_p,
    c_int,
]
X11.XCloseDisplay.argtypes = [Display]

CWOverrideRedirect = 1 << 9
CWBackPixel = 1 << 1
CWBorderPixel = 1 << 3
CWEventMask = 1 << 11
InputOutput = 1
ExposureMask = 1 << 15
StructureNotifyMask = 1 << 17
Complex = 0
CoordModeOrigin = 0
PropModeReplace = 0

POINTER_SIZE = 36
HOTSPOT = (2, 2)
SESSION_ALPHA_NOTE = 0.94  # X11 solid window; translucency is best-effort via shape glow only


def log_err(msg: str) -> None:
    sys.stderr.write(f"computer-helper: {msg}\n")
    sys.stderr.flush()


def write_response(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def write_ok(extra: dict | None = None) -> None:
    body = {"ok": True}
    if extra:
        body.update(extra)
    write_response(body)


def write_error(message: str) -> None:
    write_response({"ok": False, "error": message})


def which(name: str) -> str | None:
    return shutil.which(name)


# Arrow polygon in local window coords (tip near hotspot).
ARROW = [
    (2, 2),
    (2, 26),
    (10, 20),
    (15, 32),
    (20, 30),
    (13, 17),
    (22, 17),
]


class Overlay:
    def __init__(self) -> None:
        self.dpy: Display | None = None
        self.screen = 0
        self.root = 0
        self.win = 0
        self.gc = None
        self.gc_glow = None
        self.gc_ink = None
        self.mapped = False
        self.tip = (0.0, 0.0)
        self.has_tip = False
        self.width_px = 0
        self.height_px = 0
        self._lock = threading.Lock()
        self.available = False

    def open(self) -> bool:
        display_name = os.environ.get("DISPLAY")
        if not display_name:
            log_err("DISPLAY is not set; overlay unavailable")
            return False
        self.dpy = X11.XOpenDisplay(display_name.encode())
        if not self.dpy:
            log_err(f"could not open X display {display_name}")
            return False
        self.screen = X11.XDefaultScreen(self.dpy)
        self.root = X11.XRootWindow(self.dpy, self.screen)
        self.width_px = X11.XDisplayWidth(self.dpy, self.screen)
        self.height_px = X11.XDisplayHeight(self.dpy, self.screen)
        depth = X11.XDefaultDepth(self.dpy, self.screen)
        visual = X11.XDefaultVisual(self.dpy, self.screen)
        attrs = XSetWindowAttributes()
        attrs.override_redirect = 1
        attrs.background_pixel = 0
        attrs.border_pixel = 0
        attrs.event_mask = ExposureMask | StructureNotifyMask
        mask = CWOverrideRedirect | CWBackPixel | CWBorderPixel | CWEventMask
        self.win = X11.XCreateWindow(
            self.dpy,
            self.root,
            0,
            0,
            POINTER_SIZE,
            POINTER_SIZE,
            0,
            depth,
            InputOutput,
            visual,
            mask,
            byref(attrs),
        )
        X11.XStoreName(self.dpy, self.win, b"Jian")
        # _NET_WM_WINDOW_TYPE_NOTIFICATION keeps it above most clients.
        try:
            type_atom = X11.XInternAtom(self.dpy, b"_NET_WM_WINDOW_TYPE", 0)
            notif = X11.XInternAtom(self.dpy, b"_NET_WM_WINDOW_TYPE_NOTIFICATION", 0)
            X11.XChangeProperty(
                self.dpy,
                self.win,
                type_atom,
                X11.XInternAtom(self.dpy, b"ATOM", 0),
                32,
                PropModeReplace,
                byref(c_ulong(notif)),
                1,
            )
        except Exception:
            pass
        self.gc = X11.XCreateGC(self.dpy, self.win, 0, None)
        self.gc_glow = X11.XCreateGC(self.dpy, self.win, 0, None)
        self.gc_ink = X11.XCreateGC(self.dpy, self.win, 0, None)
        cmap = X11.XDefaultColormap(self.dpy, self.screen)
        white = XColor()
        exact = XColor()
        if X11.XAllocNamedColor(self.dpy, cmap, b"#FFFFFF", byref(white), byref(exact)):
            X11.XSetForeground(self.dpy, self.gc, white.pixel)
        glow = XColor()
        # Match macOS ship sprite stroke #2880F8 (geometric stand-in; bitmap is macOS-only).
        if X11.XAllocNamedColor(self.dpy, cmap, b"#2880F8", byref(glow), byref(exact)):
            X11.XSetForeground(self.dpy, self.gc_glow, glow.pixel)
        ink = XColor()
        if X11.XAllocNamedColor(self.dpy, cmap, b"#2880F8", byref(ink), byref(exact)):
            X11.XSetForeground(self.dpy, self.gc_ink, ink.pixel)
        self.available = True
        return True

    def _points(self, offset=(0, 0)) -> list[XPoint]:
        ox, oy = offset
        return [XPoint(x=int(x + ox), y=int(y + oy)) for x, y in ARROW]

    def paint(self) -> None:
        if not self.available or not self.mapped:
            return
        X11.XClearWindow(self.dpy, self.win)
        # Soft “glow”: fill the arrow slightly offset in brand blue, then white on top.
        glow_pts = (XPoint * len(ARROW))(*self._points((1, 2)))
        X11.XFillPolygon(self.dpy, self.win, self.gc_glow, glow_pts, len(ARROW), Complex, CoordModeOrigin)
        pts = (XPoint * len(ARROW))(*self._points())
        X11.XFillPolygon(self.dpy, self.win, self.gc, pts, len(ARROW), Complex, CoordModeOrigin)
        X11.XDrawLines(self.dpy, self.win, self.gc_ink, pts, len(ARROW), CoordModeOrigin)
        # Close the polygon stroke.
        close = (XPoint * 2)(pts[len(ARROW) - 1], pts[0])
        X11.XDrawLines(self.dpy, self.win, self.gc_ink, close, 2, CoordModeOrigin)
        X11.XFlush(self.dpy)

    def ensure_session(self) -> None:
        if not self.available:
            return
        with self._lock:
            if not self.has_tip:
                self.tip = (self.width_px / 2, self.height_px / 2)
                self.has_tip = True
            if not self.mapped:
                X11.XMapRaised(self.dpy, self.win)
                self.mapped = True
            self._position()
            self.paint()

    def set_idle(self) -> None:
        # X11 has no cheap per-window alpha here; keep mapped (visible) as session idle.
        self.ensure_session()

    def end_session(self) -> None:
        if not self.available:
            return
        with self._lock:
            if self.mapped:
                X11.XUnmapWindow(self.dpy, self.win)
                X11.XFlush(self.dpy)
                self.mapped = False
            self.has_tip = False

    def _position(self) -> None:
        x = int(self.tip[0] - HOTSPOT[0])
        y = int(self.tip[1] - HOTSPOT[1])
        X11.XMoveWindow(self.dpy, self.win, x, y)
        X11.XFlush(self.dpy)

    def move_tip(self, x: float, y: float) -> None:
        if not self.available:
            self.tip = (x, y)
            self.has_tip = True
            return
        with self._lock:
            self.tip = (x, y)
            self.has_tip = True
            if not self.mapped:
                X11.XMapRaised(self.dpy, self.win)
                self.mapped = True
            self._position()
            self.paint()

    def flash_click(self) -> None:
        # Brief re-paint pulse (glow only — no separate ripple timer in this helper).
        self.paint()

    def geometry(self) -> dict:
        if not self.available:
            # Fallback via xdotool / xdpyinfo when overlay never opened.
            return probe_geometry_fallback()
        return {
            "ok": True,
            "originX": 0,
            "originY": 0,
            "pointWidth": float(self.width_px),
            "pointHeight": float(self.height_px),
            "pixelWidth": float(self.width_px),
            "pixelHeight": float(self.height_px),
            "scaleFactor": 1.0,
        }

    def pump(self) -> None:
        if not self.available or not self.dpy:
            return
        # Drain expose events so the pointer redraws after obscure.
        ev = create_string_buffer(192)
        while X11.XPending(self.dpy) > 0:
            X11.XNextEvent(self.dpy, ev)
            self.paint()


def probe_geometry_fallback() -> dict:
    if which("xdotool"):
        try:
            out = subprocess.check_output(
                ["xdotool", "getdisplaygeometry"], text=True, stderr=subprocess.DEVNULL
            ).strip()
            parts = out.split()
            if len(parts) >= 2:
                w, h = float(parts[0]), float(parts[1])
                return {
                    "ok": True,
                    "originX": 0,
                    "originY": 0,
                    "pointWidth": w,
                    "pointHeight": h,
                    "pixelWidth": w,
                    "pixelHeight": h,
                    "scaleFactor": 1.0,
                }
        except (subprocess.CalledProcessError, ValueError):
            pass
    return {"ok": False, "error": "no display geometry available"}


def ease_out_cubic(t: float) -> float:
    t = min(1.0, max(0.0, t))
    return 1.0 - (1.0 - t) ** 3


def animate_overlay(overlay: Overlay, target: tuple[float, float]) -> None:
    overlay.ensure_session()
    start = overlay.tip if overlay.has_tip else target
    dx = target[0] - start[0]
    dy = target[1] - start[1]
    distance = math.hypot(dx, dy)
    if distance < 1.5:
        overlay.move_tip(*target)
        return
    duration = min(0.11, max(0.028, distance * 0.00025))
    steps = max(1, int(math.ceil(duration * 60)))
    step_sleep = duration / steps
    for i in range(1, steps + 1):
        t = ease_out_cubic(i / steps)
        overlay.move_tip(start[0] + dx * t, start[1] + dy * t)
        overlay.pump()
        if i < steps:
            time.sleep(step_sleep)
    overlay.move_tip(*target)


def run_xdotool(args: list[str]) -> None:
    if not which("xdotool"):
        raise RuntimeError(
            "xdotool is required for computer use on X11. Install xdotool, or use a Wayland tool path."
        )
    subprocess.check_call(["xdotool", *args], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def cursor_position() -> tuple[int, int]:
    out = subprocess.check_output(
        ["xdotool", "getmouselocation", "--shell"], text=True, stderr=subprocess.DEVNULL
    )
    vals = {}
    for line in out.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            vals[k] = int(v)
    return vals.get("X", 0), vals.get("Y", 0)


def with_preserved_cursor(body) -> None:
    """Save → act → restore so agent clicks do not strand the user pointer."""
    if not which("xdotool"):
        body()
        return
    sx, sy = cursor_position()
    try:
        body()
    finally:
        run_xdotool(["mousemove", "--sync", str(sx), str(sy)])


def click_at(overlay: Overlay, x: float, y: float, button: str, count: int) -> None:
    animate_overlay(overlay, (x, y))
    overlay.flash_click()
    btn = "3" if button == "right" else "1"

    def act() -> None:
        run_xdotool(["mousemove", "--sync", str(int(x)), str(int(y))])
        for _ in range(count):
            run_xdotool(["click", btn])
            if count > 1:
                time.sleep(0.04)

    with_preserved_cursor(act)


def drag(overlay: Overlay, fx: float, fy: float, tx: float, ty: float) -> None:
    animate_overlay(overlay, (fx, fy))
    overlay.flash_click()

    def act() -> None:
        run_xdotool(["mousemove", "--sync", str(int(fx)), str(int(fy))])
        run_xdotool(["mousedown", "1"])
        distance = math.hypot(tx - fx, ty - fy)
        steps = max(6, min(14, int(distance / 40) + 6))
        for i in range(1, steps + 1):
            t = ease_out_cubic(i / steps)
            px = fx + (tx - fx) * t
            py = fy + (ty - fy) * t
            overlay.move_tip(px, py)
            run_xdotool(["mousemove", "--sync", str(int(px)), str(int(py))])
            time.sleep(0.006)
        run_xdotool(["mouseup", "1"])

    with_preserved_cursor(act)
    overlay.move_tip(tx, ty)


def scroll_at(overlay: Overlay, x: float, y: float, direction: str, amount: int) -> None:
    animate_overlay(overlay, (x, y))
    # xdotool: 4=up 5=down 6=left 7=right
    mapping = {"up": "4", "down": "5", "left": "6", "right": "7"}
    btn = mapping[direction]

    def act() -> None:
        run_xdotool(["mousemove", "--sync", str(int(x)), str(int(y))])
        for _ in range(max(1, amount)):
            run_xdotool(["click", btn])
            time.sleep(0.012)

    with_preserved_cursor(act)


def type_text(text: str) -> None:
    if which("xdotool"):
        # --clearmodifiers avoids sticky Meta from the agent chord path.
        subprocess.check_call(
            ["xdotool", "type", "--clearmodifiers", "--delay", "2", "--", text],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        return
    raise RuntimeError("xdotool is required to type text on this Linux session.")


def parse_and_post_key(key_spec: str) -> bool:
    parts = [p.strip().lower() for p in key_spec.split("+") if p.strip()]
    if not parts:
        return False
    mods = []
    key = None
    for part in parts:
        if part in ("cmd", "command", "meta", "super"):
            mods.append("super")
        elif part in ("ctrl", "control"):
            mods.append("ctrl")
        elif part in ("alt", "option", "opt"):
            mods.append("alt")
        elif part == "shift":
            mods.append("shift")
        else:
            if key is not None:
                return False
            key = part
    if key is None:
        return False
    named = {
        "return": "Return",
        "enter": "Return",
        "tab": "Tab",
        "escape": "Escape",
        "esc": "Escape",
        "delete": "Delete",
        "backspace": "BackSpace",
        "space": "space",
        "up": "Up",
        "down": "Down",
        "left": "Left",
        "right": "Right",
        "home": "Home",
        "end": "End",
        "pageup": "Page_Up",
        "pagedown": "Page_Down",
    }
    if key in named:
        keysym = named[key]
    elif len(key) == 1:
        keysym = key
    elif key.startswith("f") and key[1:].isdigit() and 1 <= int(key[1:]) <= 12:
        keysym = f"F{int(key[1:])}"
    else:
        return False
    chord = "+".join([*mods, keysym])
    run_xdotool(["key", "--clearmodifiers", chord])
    return True


def handle(overlay: Overlay, obj: dict) -> None:
    cmd = obj.get("cmd")
    if not isinstance(cmd, str):
        write_error("missing cmd")
        return
    try:
        if cmd == "ping":
            write_ok()
        elif cmd == "geometry":
            write_response(overlay.geometry())
        elif cmd == "ensureSession":
            overlay.ensure_session()
            write_ok()
        elif cmd == "setIdle":
            overlay.set_idle()
            write_ok()
        elif cmd == "endSession":
            overlay.end_session()
            write_ok()
        elif cmd == "move":
            x, y = float(obj["pointX"]), float(obj["pointY"])
            animate_overlay(overlay, (x, y))
            write_ok()
        elif cmd == "click":
            button = str(obj.get("button", "left")).lower()
            count = int(obj.get("count", 1))
            tip = overlay.tip
            click_at(overlay, tip[0], tip[1], button, count)
            write_ok()
        elif cmd == "clickAt":
            x, y = float(obj["pointX"]), float(obj["pointY"])
            button = str(obj.get("button", "left")).lower()
            count = int(obj.get("count", 1))
            if button not in ("left", "right") or count not in (1, 2):
                write_error("invalid button/count")
                return
            click_at(overlay, x, y, button, count)
            write_ok()
        elif cmd == "drag":
            drag(
                overlay,
                float(obj["fromX"]),
                float(obj["fromY"]),
                float(obj["toX"]),
                float(obj["toY"]),
            )
            write_ok()
        elif cmd == "type":
            text = obj.get("text")
            if not isinstance(text, str):
                write_error("type requires text")
                return
            type_text(text)
            write_ok()
        elif cmd == "key":
            key = obj.get("key")
            if not isinstance(key, str):
                write_error("key requires key")
                return
            if parse_and_post_key(key):
                write_ok()
            else:
                write_error(f"unrecognized key: {key}")
        elif cmd == "scroll":
            scroll_at(
                overlay,
                float(obj["pointX"]),
                float(obj["pointY"]),
                str(obj["direction"]).lower(),
                int(obj["amount"]),
            )
            write_ok()
        else:
            write_error(f"unknown cmd: {cmd}")
    except KeyError as exc:
        write_error(f"missing field: {exc}")
    except Exception as exc:  # noqa: BLE001 — surface to worker as JSON error
        log_err(str(exc))
        write_error(str(exc))


def main() -> int:
    overlay = Overlay()
    overlay.open()  # may fail on Wayland — input can still work via xdotool if XWayland
    # Stdin loop on main thread; pump X events between lines.
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            log_err("invalid JSON line")
            write_error("invalid JSON")
            continue
        if not isinstance(obj, dict):
            write_error("invalid JSON")
            continue
        handle(overlay, obj)
        overlay.pump()
    overlay.end_session()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(0)
