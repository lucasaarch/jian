/*
  Jian Remote Control — macOS computer-use helper

  Long-lived AppKit process: Jian overlay pointer + synthetic mouse/keyboard via CoreGraphics.
  Protocol: newline-delimited JSON on stdin → newline-delimited JSON on stdout (flush each).
  Errors go to stderr in English only.

  Pointer UX (Lucas / v0.8.3):
  - Bitmap sprite: white fill + thick #2880F8 stroke + soft blue glow (embedded PNG).
    Prefer sprite over live CGPath so AA/glow match the approved preview.
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

// MARK: - Pointer sprite (embedded PNG)

/// Soft click-ripple blue (matches ship stroke #2880F8).
private let jianGlow = NSColor(srgbRed: 0x28 / 255, green: 0x80 / 255, blue: 0xF8 / 255, alpha: 1)

private let sessionAlpha: CGFloat = 0.94
private let idleAlpha: CGFloat = 0.18
/// Padded sprite canvas (40 pt blade + 10 pt glow pad each side).
private let pointerSize: CGFloat = 60
/// Tip hotspot in the padded 60 pt view (content tip was (2,2) in the 40 pt box).
private let hotspot = CGPoint(x: 12, y: 12)

/// Ship asset `macos/jian-pointer.png` (@3x master) as base64 — single-file helper stays
/// reliable when only the binary is copied into Application Support (no sidecar PNG).
private let jianPointerPngBase64 = """
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
"""

private let jianPointerImage: NSImage? = {
  guard let data = Data(base64Encoded: jianPointerPngBase64, options: .ignoreUnknownCharacters)
  else {
    fputs("computer-helper: embedded pointer PNG base64 decode failed\n", stderr)
    fflush(stderr)
    return nil
  }
  return NSImage(data: data)
}()

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
      let maxRadius = pointerSize * 0.55
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

    // Bitmap blade (white + #2880F8 stroke + baked glow). Pulse alpha on click flash.
    let alpha = 1 - fillPulse * 0.28
    if let image = jianPointerImage {
      image.draw(
        in: bounds,
        from: .zero,
        operation: .sourceOver,
        fraction: alpha,
        respectFlipped: true,
        hints: nil
      )
    } else {
      // Last-resort fallback if decode failed — still a visible tip, not ink/cream geometry.
      jianGlow.withAlphaComponent(0.9 * alpha).setFill()
      let tip = NSBezierPath(
        ovalIn: CGRect(x: hotspot.x - 3, y: hotspot.y - 3, width: 6, height: 6)
      )
      tip.fill()
    }
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
