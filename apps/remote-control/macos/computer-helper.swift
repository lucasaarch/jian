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
private let jianPointerPngBase64 =
  "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"

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
