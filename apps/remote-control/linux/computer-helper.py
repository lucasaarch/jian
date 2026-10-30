#!/usr/bin/env python3
"""
Jian Remote Control — Linux computer-use helper (X11).

Newline-delimited JSON on stdin → JSON lines on stdout (same cmds as macOS helper).
Overlay: override-redirect, click-through window showing the Jian pointer sprite, the same bitmap
the macOS helper embeds (assets/jian-pointer.png): per-pixel alpha under a compositor, a shape
mask without one.
Input: xdotool when available (save/restore cursor around clicks so the user's
pointer is not left at the Jian position). Wayland: best-effort; overlay may be
unavailable — input still works when ydotool/wtype/xdotool can reach the session.

English-only stderr. No third-party Python packages (ctypes + libX11).
"""

from __future__ import annotations

import base64
import json
import math
import os
import shutil
import subprocess
import sys
import threading
import time
import zlib
from ctypes import (
    POINTER,
    Structure,
    byref,
    c_char_p,
    c_int,
    c_uint32,
    c_long,
    c_short,
    c_uint,
    c_ulong,
    c_void_p,
    cast,
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
XImagePtr = c_void_p


class XPoint(Structure):
    _fields_ = [("x", c_short), ("y", c_short)]


class XVisualInfo(Structure):
    _fields_ = [
        ("visual", Visual),
        ("visualid", c_ulong),
        ("screen", c_int),
        ("depth", c_int),
        ("c_class", c_int),
        ("red_mask", c_ulong),
        ("green_mask", c_ulong),
        ("blue_mask", c_ulong),
        ("colormap_size", c_int),
        ("bits_per_rgb", c_int),
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
X11.XMatchVisualInfo.argtypes = [Display, c_int, c_int, c_int, POINTER(XVisualInfo)]
X11.XMatchVisualInfo.restype = Status
X11.XCreateColormap.argtypes = [Display, Window, Visual, c_int]
X11.XCreateColormap.restype = Colormap
X11.XGetSelectionOwner.argtypes = [Display, Atom]
X11.XGetSelectionOwner.restype = Window
X11.XCreateImage.argtypes = [Display, Visual, c_uint, c_int, c_int, c_void_p, c_uint, c_uint, c_int, c_int]
X11.XCreateImage.restype = XImagePtr
X11.XPutImage.argtypes = [Display, Window, GC, XImagePtr, c_int, c_int, c_int, c_int, c_uint, c_uint]
X11.XCreatePixmap.argtypes = [Display, Window, c_uint, c_uint, c_uint]
X11.XCreatePixmap.restype = Pixmap
X11.XFillRectangle.argtypes = [Display, c_ulong, GC, c_int, c_int, c_uint, c_uint]
X11.XDrawPoints.argtypes = [Display, c_ulong, GC, POINTER(XPoint), c_int, c_int]
X11.XFreePixmap.argtypes = [Display, Pixmap]
X11.XFreeGC.argtypes = [Display, GC]

# The shape extension makes the window click-through, and without a compositor it is what cuts
# the sprite out of its square. Nearly every X server has it; without it there is no overlay.
try:
    XEXT = cdll.LoadLibrary("libXext.so.6")
    XEXT.XShapeCombineMask.argtypes = [Display, Window, c_int, c_int, c_int, Pixmap, c_int]
    XEXT.XShapeCombineRectangles.argtypes = [
        Display,
        Window,
        c_int,
        c_int,
        c_int,
        c_void_p,
        c_int,
        c_int,
        c_int,
    ]
except OSError:
    XEXT = None

CWOverrideRedirect = 1 << 9
CWBackPixel = 1 << 1
CWBorderPixel = 1 << 3
CWEventMask = 1 << 11
CWColormap = 1 << 13
InputOutput = 1
ExposureMask = 1 << 15
StructureNotifyMask = 1 << 17
CoordModeOrigin = 0
PropModeReplace = 0
TrueColor = 4
AllocNone = 0
ZPixmap = 2
ShapeBounding = 0
ShapeInput = 2
ShapeSet = 0
Unsorted = 0

# The macOS canvas and tip, in points; X11 coordinates here are pixels at scale 1.
POINTER_SIZE = 60
HOTSPOT = (12, 12)
SESSION_ALPHA = 0.94
IDLE_ALPHA = 0.18
# Without a compositor a pixel is shown or not: the glow's faint edge is cut, the blade kept.
SHAPE_ALPHA_CUT = 128

# assets/jian-pointer.png (@3x master), embedded so the helper copied on its own still has it.
JIAN_POINTER_PNG_BASE64 = """
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
"""


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


def decode_png_rgba(data: bytes) -> tuple[int, int, bytearray]:
    """8-bit RGBA, non-interlaced: the one form the shipped sprite takes."""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    pos = 8
    width = height = 0
    idat = bytearray()
    while pos < len(data):
        length = int.from_bytes(data[pos : pos + 4], "big")
        kind = data[pos + 4 : pos + 8]
        body = data[pos + 8 : pos + 8 + length]
        if kind == b"IHDR":
            width = int.from_bytes(body[0:4], "big")
            height = int.from_bytes(body[4:8], "big")
            if body[8] != 8 or body[9] != 6 or body[12] != 0:
                raise ValueError("pointer sprite must be 8-bit RGBA, non-interlaced")
        elif kind == b"IDAT":
            idat += body
        pos += 12 + length
    raw = zlib.decompress(bytes(idat))
    stride = width * 4
    pixels = bytearray(height * stride)
    previous = bytearray(stride)
    for y in range(height):
        kind = raw[y * (stride + 1)]
        line = bytearray(raw[y * (stride + 1) + 1 : (y + 1) * (stride + 1)])
        for i in range(stride):
            left = line[i - 4] if i >= 4 else 0
            up = previous[i]
            corner = previous[i - 4] if i >= 4 else 0
            if kind == 1:
                line[i] = (line[i] + left) & 0xFF
            elif kind == 2:
                line[i] = (line[i] + up) & 0xFF
            elif kind == 3:
                line[i] = (line[i] + ((left + up) >> 1)) & 0xFF
            elif kind == 4:
                guess = left + up - corner
                pa, pb, pc = abs(guess - left), abs(guess - up), abs(guess - corner)
                pick = left if pa <= pb and pa <= pc else up if pb <= pc else corner
                line[i] = (line[i] + pick) & 0xFF
        pixels[y * stride : (y + 1) * stride] = line
        previous = line
    return width, height, pixels


def sprite_premultiplied(size: int) -> list[tuple[int, int, int, int]]:
    """The sprite at `size` px, averaged over each source block in premultiplied space so the
    glow keeps its colour where it fades; (r, g, b, a) premultiplied, row by row."""
    width, height, pixels = decode_png_rgba(base64.b64decode(JIAN_POINTER_PNG_BASE64))
    step = max(1, width // size)
    out = []
    for oy in range(size):
        for ox in range(size):
            r = g = b = a = 0
            count = 0
            for dy in range(step):
                sy = min(height - 1, oy * step + dy)
                for dx in range(step):
                    sx = min(width - 1, ox * step + dx)
                    i = (sy * width + sx) * 4
                    alpha = pixels[i + 3]
                    r += pixels[i] * alpha
                    g += pixels[i + 1] * alpha
                    b += pixels[i + 2] * alpha
                    a += alpha
                    count += 1
            out.append(
                (r // (255 * count), g // (255 * count), b // (255 * count), a // count)
            )
    return out


def mask_shift(mask: int) -> int:
    shift = 0
    while mask and not mask & 1:
        mask >>= 1
        shift += 1
    return shift


class Overlay:
    def __init__(self) -> None:
        self.dpy: Display | None = None
        self.screen = 0
        self.root = 0
        self.win = 0
        self.gc = None
        self.image = None
        # The image reads its pixels from here: it must live as long as the image does.
        self._pixels = None
        self.translucent = False
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
        if XEXT is None:
            log_err("libXext is missing; overlay unavailable")
            return False
        self.dpy = X11.XOpenDisplay(display_name.encode())
        if not self.dpy:
            log_err(f"could not open X display {display_name}")
            return False
        self.screen = X11.XDefaultScreen(self.dpy)
        self.root = X11.XRootWindow(self.dpy, self.screen)
        self.width_px = X11.XDisplayWidth(self.dpy, self.screen)
        self.height_px = X11.XDisplayHeight(self.dpy, self.screen)

        # Per-pixel alpha needs a 32-bit visual and a compositor to blend it; without one the
        # alpha is ignored and the transparent corners would show as a black square.
        cm = X11.XInternAtom(self.dpy, f"_NET_WM_CM_S{self.screen}".encode(), 0)
        info = XVisualInfo()
        self.translucent = bool(X11.XGetSelectionOwner(self.dpy, cm)) and bool(
            X11.XMatchVisualInfo(self.dpy, self.screen, 32, TrueColor, byref(info))
        )
        # The sprite is packed as one 32-bit word a pixel, which a 24-bit visual also takes.
        if not self.translucent and (
            X11.XDefaultDepth(self.dpy, self.screen) < 24
            or not X11.XMatchVisualInfo(
                self.dpy, self.screen, X11.XDefaultDepth(self.dpy, self.screen), TrueColor, byref(info)
            )
        ):
            log_err("no 24-bit TrueColor visual; overlay unavailable")
            return False

        attrs = XSetWindowAttributes()
        attrs.override_redirect = 1
        attrs.background_pixel = 0
        attrs.border_pixel = 0
        attrs.event_mask = ExposureMask | StructureNotifyMask
        attrs.colormap = X11.XCreateColormap(self.dpy, self.root, info.visual, AllocNone)
        mask = CWOverrideRedirect | CWBackPixel | CWBorderPixel | CWEventMask | CWColormap
        self.win = X11.XCreateWindow(
            self.dpy,
            self.root,
            0,
            0,
            POINTER_SIZE,
            POINTER_SIZE,
            0,
            info.depth,
            InputOutput,
            info.visual,
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
        # An empty input shape: the agent's click lands on what is under the tip, not on us.
        XEXT.XShapeCombineRectangles(self.dpy, self.win, ShapeInput, 0, 0, None, 0, ShapeSet, Unsorted)
        self.gc = X11.XCreateGC(self.dpy, self.win, 0, None)
        self._build_image(info)
        self.available = True
        return True

    def _build_image(self, info: XVisualInfo) -> None:
        sprite = sprite_premultiplied(POINTER_SIZE)
        shifts = [mask_shift(m) for m in (info.red_mask, info.green_mask, info.blue_mask)]
        pixels = (c_uint32 * len(sprite))()
        shown = []
        for index, (r, g, b, a) in enumerate(sprite):
            if self.translucent:
                # ARGB visuals take premultiplied colour, alpha in the bits the masks leave.
                pixels[index] = (a << 24) | (r << shifts[0]) | (g << shifts[1]) | (b << shifts[2])
            elif a >= SHAPE_ALPHA_CUT:
                # Opaque on whatever is beneath: the colour itself, not premultiplied.
                pixels[index] = (
                    (min(255, r * 255 // a) << shifts[0])
                    | (min(255, g * 255 // a) << shifts[1])
                    | (min(255, b * 255 // a) << shifts[2])
                )
                shown.append(XPoint(x=index % POINTER_SIZE, y=index // POINTER_SIZE))
        self._pixels = pixels
        self.image = X11.XCreateImage(
            self.dpy,
            info.visual,
            info.depth,
            ZPixmap,
            0,
            cast(pixels, c_void_p),
            POINTER_SIZE,
            POINTER_SIZE,
            32,
            0,
        )
        if self.translucent:
            self._set_opacity(SESSION_ALPHA)
            return
        # Without a compositor, a one-bit mask cuts the sprite out of its square.
        bitmap = X11.XCreatePixmap(self.dpy, self.win, POINTER_SIZE, POINTER_SIZE, 1)
        pen = X11.XCreateGC(self.dpy, bitmap, 0, None)
        X11.XSetForeground(self.dpy, pen, 0)
        X11.XFillRectangle(self.dpy, bitmap, pen, 0, 0, POINTER_SIZE, POINTER_SIZE)
        X11.XSetForeground(self.dpy, pen, 1)
        if shown:
            X11.XDrawPoints(self.dpy, bitmap, pen, (XPoint * len(shown))(*shown), len(shown), CoordModeOrigin)
        XEXT.XShapeCombineMask(self.dpy, self.win, ShapeBounding, 0, 0, bitmap, ShapeSet)
        X11.XFreeGC(self.dpy, pen)
        X11.XFreePixmap(self.dpy, bitmap)

    def _set_opacity(self, alpha: float) -> None:
        """Compositors read the window's opacity from here, as macOS fades it when idle."""
        if not self.translucent:
            return
        atom = X11.XInternAtom(self.dpy, b"_NET_WM_WINDOW_OPACITY", 0)
        cardinal = X11.XInternAtom(self.dpy, b"CARDINAL", 0)
        value = c_ulong(int(max(0.0, min(1.0, alpha)) * 0xFFFFFFFF))
        X11.XChangeProperty(self.dpy, self.win, atom, cardinal, 32, PropModeReplace, byref(value), 1)

    def paint(self) -> None:
        if not self.available or not self.mapped:
            return
        X11.XPutImage(self.dpy, self.win, self.gc, self.image, 0, 0, 0, 0, POINTER_SIZE, POINTER_SIZE)
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
            self._set_opacity(SESSION_ALPHA)
            self._position()
            self.paint()

    def set_idle(self) -> None:
        # Faded as macOS fades it; without a compositor it simply stays as it is.
        self.ensure_session()
        if self.available:
            with self._lock:
                self._set_opacity(IDLE_ALPHA)
                X11.XFlush(self.dpy)

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
