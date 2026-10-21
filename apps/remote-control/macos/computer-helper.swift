/*
  Jian Remote Control — macOS computer-use helper

  Long-lived AppKit process: Jian overlay pointer + synthetic mouse/keyboard via CoreGraphics.
  Protocol: newline-delimited JSON on stdin → newline-delimited JSON on stdout (flush each).
  Errors go to stderr in English only.

  Pointer UX (Lucas / v0.8.2 polish):
  - Geometric white arrow (anathema-white style) with a soft brand-blue glow underneath.
  - Agent actions save the user’s cursor, hide it briefly, drive HID at the target, then
    restore — so clicks do not leave the physical mouse stranded at the Jian position.
  - Overlay tip animates (ease-out) between positions; system cursor is not the visible UX.

  Published npm packages ship a prebuilt universal binary (Publish CI). From source on a Mac:
    ./build-helper.sh
    # or: swiftc -O -framework AppKit -framework Carbon -o computer-helper computer-helper.swift

  Run as a child of the Node worker; keep stdin/stdout pipes open for the session.
*/

import AppKit
import Carbon.HIToolbox
import CoreGraphics
import Foundation

// MARK: - JSON I/O

private func writeResponse(_ object: [String: Any]) {
  guard JSONSerialization.isValidJSONObject(object),
    let data = try? JSONSerialization.data(withJSONObject: object, options: []),
    var line = String(data: data, encoding: .utf8)
  else {
    fputs("computer-helper: failed to encode response JSON\n", stderr)
    fflush(stderr)
    return
  }
  line.append("\n")
  FileHandle.standardOutput.write(Data(line.utf8))
  fflush(stdout)
}

private func writeOk(_ extra: [String: Any] = [:]) {
  var body: [String: Any] = ["ok": true]
  for (key, value) in extra {
    body[key] = value
  }
  writeResponse(body)
}

private func writeError(_ message: String) {
  writeResponse(["ok": false, "error": message])
}

private func logError(_ message: String) {
  fputs("computer-helper: \(message)\n", stderr)
  fflush(stderr)
}

private func parseJSONLine(_ line: String) -> [String: Any]? {
  let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty, let data = trimmed.data(using: .utf8) else { return nil }
  guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
    return nil
  }
  return object
}

private func doubleValue(_ object: [String: Any], _ key: String) -> Double? {
  if let n = object[key] as? Double { return n }
  if let n = object[key] as? Int { return Double(n) }
  if let n = object[key] as? NSNumber { return n.doubleValue }
  return nil
}

private func intValue(_ object: [String: Any], _ key: String) -> Int? {
  if let n = object[key] as? Int { return n }
  if let n = object[key] as? Double { return Int(n) }
  if let n = object[key] as? NSNumber { return n.intValue }
  return nil
}

// MARK: - Colors (Jian + geometric white pointer)

private let jianInk = NSColor(srgbRed: 0x17 / 255, green: 0x17 / 255, blue: 0x16 / 255, alpha: 1)
/// Soft brand blue under the pointer — visible, not neon.
private let jianGlow = NSColor(srgbRed: 0x3A / 255, green: 0x7A / 255, blue: 0xD6 / 255, alpha: 1)
private let pointerWhite = NSColor(srgbRed: 0xFA / 255, green: 0xFA / 255, blue: 0xF8 / 255, alpha: 1)

private let sessionAlpha: CGFloat = 0.94
private let idleAlpha: CGFloat = 0.18
private let pointerSize: CGFloat = 36
/// Tip of the geometric arrow (hotspot) near the view's top-left.
private let hotspot = CGPoint(x: 2, y: 2)

// MARK: - Overlay view

private final class JianPointerView: NSView {
  private var rippleProgress: CGFloat = 0
  private var rippleVisible = false
  private var fillPulse: CGFloat = 0
  private var rippleTimer: Timer?

  override var isFlipped: Bool { true }

  override func draw(_ dirtyRect: NSRect) {
    guard let ctx = NSGraphicsContext.current?.cgContext else { return }

    if rippleVisible {
      let maxRadius = pointerSize * 0.9
      let radius = 3 + maxRadius * rippleProgress
      let alpha = max(0, 1 - rippleProgress)
      ctx.saveGState()
      ctx.setStrokeColor(jianGlow.withAlphaComponent(0.45 * alpha).cgColor)
      ctx.setLineWidth(1.5)
      ctx.strokeEllipse(in: CGRect(
        x: hotspot.x - radius,
        y: hotspot.y - radius,
        width: radius * 2,
        height: radius * 2
      ))
      ctx.restoreGState()
    }

    let path = Self.arrowPath(in: bounds)

    // Soft blue glow under the white blade (brand cue without neon spam).
    ctx.saveGState()
    ctx.setShadow(
      offset: CGSize(width: 0, height: 2),
      blur: 10,
      color: jianGlow.withAlphaComponent(0.55).cgColor
    )
    jianGlow.withAlphaComponent(0.35).setFill()
    path.fill()
    ctx.restoreGState()

    ctx.saveGState()
    ctx.setShadow(
      offset: CGSize(width: 0.5, height: 1.2),
      blur: 2.5,
      color: NSColor.black.withAlphaComponent(0.22).cgColor
    )
    let fillAlpha = 1 - fillPulse * 0.28
    pointerWhite.withAlphaComponent(fillAlpha).setFill()
    path.fill()
    ctx.restoreGState()

    jianInk.withAlphaComponent(0.85).setStroke()
    path.lineWidth = 1.15
    path.lineJoinStyle = .miter
    path.lineCapStyle = .butt
    path.miterLimit = 8
    path.stroke()
  }

  /// Sharp geometric pointer (anathema-white style): tip → shaft → barb.
  private static func arrowPath(in bounds: NSRect) -> NSBezierPath {
    let s = min(bounds.width, bounds.height)
    let path = NSBezierPath()
    // Coordinates in view space (flipped Y): tip near top-left hotspot.
    path.move(to: CGPoint(x: s * 0.06, y: s * 0.06))
    path.line(to: CGPoint(x: s * 0.06, y: s * 0.72))
    path.line(to: CGPoint(x: s * 0.28, y: s * 0.55))
    path.line(to: CGPoint(x: s * 0.42, y: s * 0.88))
    path.line(to: CGPoint(x: s * 0.55, y: s * 0.82))
    path.line(to: CGPoint(x: s * 0.36, y: s * 0.48))
    path.line(to: CGPoint(x: s * 0.62, y: s * 0.48))
    path.close()
    return path
  }

  func flashClick(duration: TimeInterval = 0.16) {
    rippleTimer?.invalidate()
    rippleVisible = true
    rippleProgress = 0
    fillPulse = 1
    needsDisplay = true

    let start = Date()
    rippleTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { [weak self] timer in
      guard let self else {
        timer.invalidate()
        return
      }
      let t = min(1, Date().timeIntervalSince(start) / duration)
      self.rippleProgress = CGFloat(t)
      self.fillPulse = CGFloat(1 - t)
      self.needsDisplay = true
      if t >= 1 {
        timer.invalidate()
        self.rippleVisible = false
        self.fillPulse = 0
        self.needsDisplay = true
      }
    }
    if let rippleTimer {
      RunLoop.main.add(rippleTimer, forMode: .common)
    }
  }
}

// MARK: - Overlay window

private final class NonActivatingWindow: NSWindow {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

private final class OverlayController {
  static let shared = OverlayController()

  private var window: NonActivatingWindow?
  private var pointerView: JianPointerView?
  /// Current tip/hotspot in global top-left Quartz coordinates.
  private var tipPoint = CGPoint.zero
  private var hasTip = false

  private init() {}

  private func ensureWindow() {
    if window != nil { return }

    let view = JianPointerView(frame: NSRect(x: 0, y: 0, width: pointerSize, height: pointerSize))
    view.wantsLayer = true

    let win = NonActivatingWindow(
      contentRect: NSRect(x: 0, y: 0, width: pointerSize, height: pointerSize),
      styleMask: .borderless,
      backing: .buffered,
      defer: false
    )
    win.isOpaque = false
    win.backgroundColor = .clear
    win.hasShadow = false
    win.level = .statusBar
    win.ignoresMouseEvents = true
    win.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
    win.isReleasedWhenClosed = false
    win.contentView = view
    win.alphaValue = 0
    win.orderOut(nil)

    pointerView = view
    window = win
  }

  func ensureSession() {
    ensureWindow()
    guard let window else { return }
    window.alphaValue = sessionAlpha
    if !hasTip {
      tipPoint = quartzMouseLocation()
      hasTip = true
    }
    positionWindow()
    window.orderFrontRegardless()
  }

  func setIdle() {
    ensureWindow()
    guard let window else { return }
    window.alphaValue = idleAlpha
    positionWindow()
    window.orderFrontRegardless()
  }

  func endSession() {
    guard let window else { return }
    window.orderOut(nil)
    window.alphaValue = 0
    hasTip = false
  }

  func moveTip(to globalTopLeft: CGPoint) {
    tipPoint = globalTopLeft
    hasTip = true
    ensureWindow()
    positionWindow()
  }

  func flashClick() {
    ensureWindow()
    pointerView?.flashClick()
  }

  func currentTip() -> CGPoint { tipPoint }

  private func positionWindow() {
    guard let window else { return }
    // Quartz global: origin top-left of primary, Y down. Cocoa: origin bottom-left, Y up.
    let mainHeight = NSScreen.screens.first?.frame.height ?? NSScreen.main?.frame.height ?? 0
    let tipCocoaY = mainHeight - tipPoint.y
    let origin = NSPoint(
      x: tipPoint.x - hotspot.x,
      y: tipCocoaY - (pointerSize - hotspot.y)
    )
    window.setFrameOrigin(origin)
  }
}

// MARK: - Cursor location / preserve

/// Quartz global top-left coordinates for the live system cursor.
private func quartzMouseLocation() -> CGPoint {
  let cocoa = NSEvent.mouseLocation
  let mainHeight = NSScreen.screens.first?.frame.height ?? NSScreen.main?.frame.height ?? 0
  return CGPoint(x: cocoa.x, y: mainHeight - cocoa.y)
}

/// Warp HID cursor without moving the Jian overlay tip.
private func warpSystemCursor(to point: CGPoint) {
  guard let event = CGEvent(
    mouseEventSource: nil,
    mouseType: .mouseMoved,
    mouseCursorPosition: point,
    mouseButton: .left
  ) else {
    logError("could not create mouseMoved event for warp")
    return
  }
  event.post(tap: .cghidEventTap)
}

/**
  Save → hide → act → restore → show.

  HID clicks must be posted at the target (macOS delivers them at the event location),
  but we restore immediately so Lucas’s physical mouse is not left at the Jian point.
*/
private func withPreservedUserCursor(_ body: () -> Void) {
  let saved = quartzMouseLocation()
  CGDisplayHideCursor(CGMainDisplayID())
  body()
  warpSystemCursor(to: saved)
  // Tiny yield so the restore event lands before unhide.
  Thread.sleep(forTimeInterval: 0.008)
  CGDisplayShowCursor(CGMainDisplayID())
}

// MARK: - Smooth overlay motion

private func easeOutCubic(_ t: Double) -> Double {
  let x = min(1, max(0, t))
  return 1 - pow(1 - x, 3)
}

private func animateOverlay(to target: CGPoint) {
  OverlayController.shared.ensureSession()
  let start = OverlayController.shared.currentTip()
  let distance = hypot(target.x - start.x, target.y - start.y)
  if distance < 1.5 {
    OverlayController.shared.moveTip(to: target)
    return
  }
  // ~0.25 ms/px, clamped — snappy for agent loops.
  let duration = min(0.11, max(0.028, distance * 0.00025))
  let steps = max(1, Int(ceil(duration * 60)))
  let stepSleep = duration / Double(steps)
  for i in 1...steps {
    let t = easeOutCubic(Double(i) / Double(steps))
    let p = CGPoint(
      x: start.x + (target.x - start.x) * t,
      y: start.y + (target.y - start.y) * t
    )
    OverlayController.shared.moveTip(to: p)
    if i < steps {
      RunLoop.current.run(until: Date(timeIntervalSinceNow: stepSleep))
    }
  }
  OverlayController.shared.moveTip(to: target)
}

// MARK: - Mouse / keyboard

private func postOverlayMove(to point: CGPoint) {
  animateOverlay(to: point)
}

private func postMouseClick(button: CGMouseButton, count: Int64) {
  OverlayController.shared.flashClick()
  let point = OverlayController.shared.currentTip()
  let downType: CGEventType = button == .right ? .rightMouseDown : .leftMouseDown
  let upType: CGEventType = button == .right ? .rightMouseUp : .leftMouseUp

  withPreservedUserCursor {
    warpSystemCursor(to: point)
    for clickIndex in 1...max(1, count) {
      if let down = CGEvent(
        mouseEventSource: nil,
        mouseType: downType,
        mouseCursorPosition: point,
        mouseButton: button
      ) {
        down.setIntegerValueField(.mouseEventClickState, value: clickIndex)
        down.post(tap: .cghidEventTap)
      }
      if let up = CGEvent(
        mouseEventSource: nil,
        mouseType: upType,
        mouseCursorPosition: point,
        mouseButton: button
      ) {
        up.setIntegerValueField(.mouseEventClickState, value: clickIndex)
        up.post(tap: .cghidEventTap)
      }
      if clickIndex < count {
        Thread.sleep(forTimeInterval: 0.04)
      }
    }
  }
}

private func postClickAt(point: CGPoint, button: CGMouseButton, count: Int64) {
  animateOverlay(to: point)
  postMouseClick(button: button, count: count)
}

private func postDrag(from: CGPoint, to: CGPoint) {
  OverlayController.shared.ensureSession()
  animateOverlay(to: from)
  OverlayController.shared.flashClick()

  withPreservedUserCursor {
    warpSystemCursor(to: from)
    Thread.sleep(forTimeInterval: 0.012)

    if let down = CGEvent(
      mouseEventSource: nil,
      mouseType: .leftMouseDown,
      mouseCursorPosition: from,
      mouseButton: .left
    ) {
      down.post(tap: .cghidEventTap)
    }

    let distance = hypot(to.x - from.x, to.y - from.y)
    let steps = max(6, min(14, Int(distance / 40) + 6))
    for i in 1...steps {
      let t = easeOutCubic(Double(i) / Double(steps))
      let p = CGPoint(
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t
      )
      OverlayController.shared.moveTip(to: p)
      if let drag = CGEvent(
        mouseEventSource: nil,
        mouseType: .leftMouseDragged,
        mouseCursorPosition: p,
        mouseButton: .left
      ) {
        drag.post(tap: .cghidEventTap)
      }
      Thread.sleep(forTimeInterval: 0.006)
    }

    if let up = CGEvent(
      mouseEventSource: nil,
      mouseType: .leftMouseUp,
      mouseCursorPosition: to,
      mouseButton: .left
    ) {
      up.post(tap: .cghidEventTap)
    }
  }
  OverlayController.shared.moveTip(to: to)
}

private func postScroll(at point: CGPoint, direction: String, amount: Int) {
  animateOverlay(to: point)
  let n = max(1, amount)
  var dx = 0
  var dy = 0
  switch direction {
  case "up": dy = 1
  case "down": dy = -1
  case "left": dx = 1
  case "right": dx = -1
  default:
    logError("unknown scroll direction: \(direction)")
    return
  }
  withPreservedUserCursor {
    warpSystemCursor(to: point)
    for _ in 0..<n {
      if let event = CGEvent(
        scrollWheelEvent2Source: nil,
        units: .line,
        wheelCount: 2,
        wheel1: Int32(dy),
        wheel2: Int32(dx),
        wheel3: 0
      ) {
        event.post(tap: .cghidEventTap)
      }
      Thread.sleep(forTimeInterval: 0.012)
    }
  }
}

// MARK: - Keycodes (US ANSI)

private let letterKeyCodes: [Character: CGKeyCode] = [
  "a": CGKeyCode(kVK_ANSI_A), "b": CGKeyCode(kVK_ANSI_B), "c": CGKeyCode(kVK_ANSI_C),
  "d": CGKeyCode(kVK_ANSI_D), "e": CGKeyCode(kVK_ANSI_E), "f": CGKeyCode(kVK_ANSI_F),
  "g": CGKeyCode(kVK_ANSI_G), "h": CGKeyCode(kVK_ANSI_H), "i": CGKeyCode(kVK_ANSI_I),
  "j": CGKeyCode(kVK_ANSI_J), "k": CGKeyCode(kVK_ANSI_K), "l": CGKeyCode(kVK_ANSI_L),
  "m": CGKeyCode(kVK_ANSI_M), "n": CGKeyCode(kVK_ANSI_N), "o": CGKeyCode(kVK_ANSI_O),
  "p": CGKeyCode(kVK_ANSI_P), "q": CGKeyCode(kVK_ANSI_Q), "r": CGKeyCode(kVK_ANSI_R),
  "s": CGKeyCode(kVK_ANSI_S), "t": CGKeyCode(kVK_ANSI_T), "u": CGKeyCode(kVK_ANSI_U),
  "v": CGKeyCode(kVK_ANSI_V), "w": CGKeyCode(kVK_ANSI_W), "x": CGKeyCode(kVK_ANSI_X),
  "y": CGKeyCode(kVK_ANSI_Y), "z": CGKeyCode(kVK_ANSI_Z),
]

private let digitKeyCodes: [Character: CGKeyCode] = [
  "0": CGKeyCode(kVK_ANSI_0), "1": CGKeyCode(kVK_ANSI_1), "2": CGKeyCode(kVK_ANSI_2),
  "3": CGKeyCode(kVK_ANSI_3), "4": CGKeyCode(kVK_ANSI_4), "5": CGKeyCode(kVK_ANSI_5),
  "6": CGKeyCode(kVK_ANSI_6), "7": CGKeyCode(kVK_ANSI_7), "8": CGKeyCode(kVK_ANSI_8),
  "9": CGKeyCode(kVK_ANSI_9),
]

private let namedKeyCodes: [String: CGKeyCode] = [
  "return": CGKeyCode(kVK_Return),
  "enter": CGKeyCode(kVK_Return),
  "tab": CGKeyCode(kVK_Tab),
  "escape": CGKeyCode(kVK_Escape),
  "esc": CGKeyCode(kVK_Escape),
  "delete": CGKeyCode(kVK_ForwardDelete),
  "backspace": CGKeyCode(kVK_Delete),
  "space": CGKeyCode(kVK_Space),
  "up": CGKeyCode(kVK_UpArrow),
  "down": CGKeyCode(kVK_DownArrow),
  "left": CGKeyCode(kVK_LeftArrow),
  "right": CGKeyCode(kVK_RightArrow),
  "home": CGKeyCode(kVK_Home),
  "end": CGKeyCode(kVK_End),
  "pageup": CGKeyCode(kVK_PageUp),
  "pagedown": CGKeyCode(kVK_PageDown),
]

private func postKeyCode(_ keyCode: CGKeyCode, flags: CGEventFlags = []) {
  guard let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
    let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false)
  else {
    logError("could not create keyboard event for keyCode \(keyCode)")
    return
  }
  down.flags = flags
  up.flags = flags
  down.post(tap: .cghidEventTap)
  up.post(tap: .cghidEventTap)
}

private func postUnicodeChar(_ scalar: UniChar) {
  var chars = [scalar]
  guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
    let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
  else {
    logError("could not create unicode keyboard event")
    return
  }
  down.keyboardSetUnicodeString(stringLength: 1, unicodeString: &chars)
  up.keyboardSetUnicodeString(stringLength: 1, unicodeString: &chars)
  down.post(tap: .cghidEventTap)
  up.post(tap: .cghidEventTap)
}

private func typeText(_ text: String) {
  let utf16 = Array(text.utf16)
  var i = 0
  while i < utf16.count {
    let unit = utf16[i]
    if unit == 0x000A || unit == 0x000D {
      postKeyCode(CGKeyCode(kVK_Return))
      if unit == 0x000D, i + 1 < utf16.count, utf16[i + 1] == 0x000A {
        i += 1
      }
    } else if unit == 0x0009 {
      postKeyCode(CGKeyCode(kVK_Tab))
    } else {
      postUnicodeChar(unit)
    }
    i += 1
    Thread.sleep(forTimeInterval: 0.002)
  }
}

private func parseAndPostKey(_ keySpec: String) -> Bool {
  let parts = keySpec.split(separator: "+").map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
  guard !parts.isEmpty else { return false }

  var flags: CGEventFlags = []
  var keyToken: String?

  for part in parts {
    switch part {
    case "cmd", "command", "meta", "super":
      flags.insert(.maskCommand)
    case "ctrl", "control":
      flags.insert(.maskControl)
    case "alt", "option", "opt":
      flags.insert(.maskAlternate)
    case "shift":
      flags.insert(.maskShift)
    default:
      if keyToken != nil {
        logError("ambiguous key chord: \(keySpec)")
        return false
      }
      keyToken = part
    }
  }

  guard let token = keyToken else {
    logError("key chord has no key: \(keySpec)")
    return false
  }

  if let named = namedKeyCodes[token] {
    postKeyCode(named, flags: flags)
    return true
  }

  if token.count == 1, let ch = token.first {
    if let code = letterKeyCodes[ch] {
      postKeyCode(code, flags: flags)
      return true
    }
    if let code = digitKeyCodes[ch] {
      postKeyCode(code, flags: flags)
      return true
    }
  }

  if token.hasPrefix("f"), let n = Int(token.dropFirst()), (1...12).contains(n) {
    let base = kVK_F1
    postKeyCode(CGKeyCode(base + (n - 1)), flags: flags)
    return true
  }

  logError("unknown key: \(keySpec)")
  return false
}

// MARK: - Geometry

private func geometryResponse() -> [String: Any] {
  let screen = NSScreen.screens.first ?? NSScreen.main
  guard let screen else {
    return ["ok": false, "error": "no display available"]
  }
  let frame = screen.frame
  let scale = screen.backingScaleFactor
  return [
    "ok": true,
    "originX": 0,
    "originY": 0,
    "pointWidth": frame.width,
    "pointHeight": frame.height,
    "pixelWidth": frame.width * scale,
    "pixelHeight": frame.height * scale,
    "scaleFactor": scale,
  ]
}

// MARK: - Command dispatch

private func handleCommand(_ object: [String: Any]) {
  guard let cmd = object["cmd"] as? String else {
    writeError("missing cmd")
    return
  }

  switch cmd {
  case "ping":
    writeOk()

  case "sessionStatus":
    var locked = false
    if let raw = CGSessionCopyCurrentDictionary() {
      let dict = raw as NSDictionary
      if let number = dict["CGSSessionScreenIsLocked"] as? NSNumber {
        locked = number.boolValue
      } else if let flag = dict["CGSSessionScreenIsLocked"] as? Bool {
        locked = flag
      }
    }
    // CGDisplayIsAsleep returns boolean_t (Int32); Swift will not coerce it in `if`.
    let displayAsleep = CGDisplayIsAsleep(CGMainDisplayID()) != 0
    let state: String
    if locked {
      state = "locked"
    } else if displayAsleep {
      state = "display_asleep"
    } else {
      state = "unlocked"
    }
    writeResponse([
      "ok": true,
      "state": state,
      "locked": locked,
      "displayAsleep": displayAsleep,
    ])

  case "geometry":
    writeResponse(geometryResponse())

  case "ensureSession":
    OverlayController.shared.ensureSession()
    writeOk()

  case "setIdle":
    OverlayController.shared.setIdle()
    writeOk()

  case "endSession":
    OverlayController.shared.endSession()
    writeOk()

  case "move":
    guard let x = doubleValue(object, "pointX"), let y = doubleValue(object, "pointY") else {
      writeError("move requires pointX and pointY")
      return
    }
    // Overlay-only: do not warp the user’s system cursor.
    postOverlayMove(to: CGPoint(x: x, y: y))
    writeOk()

  case "click":
    let buttonName = (object["button"] as? String ?? "left").lowercased()
    let count = Int64(intValue(object, "count") ?? 1)
    let button: CGMouseButton
    switch buttonName {
    case "left": button = .left
    case "right": button = .right
    default:
      writeError("button must be left or right")
      return
    }
    if count != 1 && count != 2 {
      writeError("count must be 1 or 2")
      return
    }
    postMouseClick(button: button, count: count)
    writeOk()

  case "clickAt":
    guard let x = doubleValue(object, "pointX"), let y = doubleValue(object, "pointY") else {
      writeError("clickAt requires pointX and pointY")
      return
    }
    let buttonName = (object["button"] as? String ?? "left").lowercased()
    let count = Int64(intValue(object, "count") ?? 1)
    let button: CGMouseButton
    switch buttonName {
    case "left": button = .left
    case "right": button = .right
    default:
      writeError("button must be left or right")
      return
    }
    if count != 1 && count != 2 {
      writeError("count must be 1 or 2")
      return
    }
    postClickAt(point: CGPoint(x: x, y: y), button: button, count: count)
    writeOk()

  case "drag":
    guard let fromX = doubleValue(object, "fromX"),
      let fromY = doubleValue(object, "fromY"),
      let toX = doubleValue(object, "toX"),
      let toY = doubleValue(object, "toY")
    else {
      writeError("drag requires fromX, fromY, toX, toY")
      return
    }
    postDrag(from: CGPoint(x: fromX, y: fromY), to: CGPoint(x: toX, y: toY))
    writeOk()

  case "type":
    guard let text = object["text"] as? String else {
      writeError("type requires text")
      return
    }
    typeText(text)
    writeOk()

  case "key":
    guard let key = object["key"] as? String else {
      writeError("key requires key")
      return
    }
    if parseAndPostKey(key) {
      writeOk()
    } else {
      writeError("unrecognized key: \(key)")
    }

  case "scroll":
    guard let x = doubleValue(object, "pointX"),
      let y = doubleValue(object, "pointY"),
      let direction = object["direction"] as? String,
      let amount = intValue(object, "amount")
    else {
      writeError("scroll requires pointX, pointY, direction, amount")
      return
    }
    let dir = direction.lowercased()
    guard ["up", "down", "left", "right"].contains(dir) else {
      writeError("direction must be up, down, left, or right")
      return
    }
    postScroll(at: CGPoint(x: x, y: y), direction: dir, amount: amount)
    writeOk()

  default:
    writeError("unknown cmd: \(cmd)")
  }
}

// MARK: - Stdin reader + main

private final class StdinReader {
  private let queue = DispatchQueue(label: "com.jian.computer-helper.stdin")

  func start() {
    queue.async {
      let handle = FileHandle.standardInput
      var buffer = Data()
      while true {
        let chunk = handle.availableData
        if chunk.isEmpty {
          DispatchQueue.main.async {
            NSApp.terminate(nil)
          }
          return
        }
        buffer.append(chunk)
        while let range = buffer.range(of: Data([0x0A])) {
          let lineData = buffer.subdata(in: buffer.startIndex..<range.lowerBound)
          buffer.removeSubrange(buffer.startIndex...range.lowerBound)
          if let line = String(data: lineData, encoding: .utf8) {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { continue }
            DispatchQueue.main.async {
              if let object = parseJSONLine(trimmed) {
                handleCommand(object)
              } else {
                logError("invalid JSON line")
                writeError("invalid JSON")
              }
            }
          }
        }
      }
    }
  }
}

// MARK: - Session status (one-shot, no AppKit run loop)

/// Reports lock / display-asleep without starting the overlay. Used by the Node worker poll
/// so a locked Mac stays "online" with an explicit uiState instead of looking dead.
private func printSessionStatusAndExit() -> Never {
  var locked = false
  if let raw = CGSessionCopyCurrentDictionary() {
    let dict = raw as NSDictionary
    if let number = dict["CGSSessionScreenIsLocked"] as? NSNumber {
      locked = number.boolValue
    } else if let flag = dict["CGSSessionScreenIsLocked"] as? Bool {
      locked = flag
    }
  }
  // CGDisplayIsAsleep returns boolean_t (Int32); Swift will not coerce it in `if`.
  let displayAsleep = CGDisplayIsAsleep(CGMainDisplayID()) != 0
  let state: String
  if locked {
    state = "locked"
  } else if displayAsleep {
    state = "display_asleep"
  } else {
    state = "unlocked"
  }
  writeResponse([
    "ok": true,
    "state": state,
    "locked": locked,
    "displayAsleep": displayAsleep,
  ])
  exit(0)
}

private let stdinReader = StdinReader()

if CommandLine.arguments.contains("--session-status") {
  printSessionStatusAndExit()
}

autoreleasepool {
  let app = NSApplication.shared
  app.setActivationPolicy(.accessory)
  stdinReader.start()
  app.run()
}
