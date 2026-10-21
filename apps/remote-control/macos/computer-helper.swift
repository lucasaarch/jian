/*
  Jian Remote Control — macOS computer-use helper

  Long-lived AppKit process: overlay pointer + synthetic mouse/keyboard via CoreGraphics.
  Protocol: newline-delimited JSON on stdin → newline-delimited JSON on stdout (flush each).
  Errors go to stderr in English only.

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

// MARK: - Colors (Jian UI)

private let jianCream = NSColor(srgbRed: 0xF5 / 255, green: 0xF5 / 255, blue: 0xF3 / 255, alpha: 1)
private let jianInk = NSColor(srgbRed: 0x17 / 255, green: 0x17 / 255, blue: 0x16 / 255, alpha: 1)

private let sessionAlpha: CGFloat = 0.92
private let idleAlpha: CGFloat = 0.18
private let pointerSize: CGFloat = 32
/// Tip of the wing relative to the view's top-left (hotspot for cursor placement).
private let hotspot = CGPoint(x: 4, y: 4)

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
      let maxRadius = pointerSize * 0.95
      let radius = 4 + maxRadius * rippleProgress
      let alpha = max(0, 1 - rippleProgress)
      ctx.saveGState()
      ctx.setStrokeColor(jianInk.withAlphaComponent(0.55 * alpha).cgColor)
      ctx.setLineWidth(1.5)
      ctx.strokeEllipse(in: CGRect(
        x: hotspot.x - radius,
        y: hotspot.y - radius,
        width: radius * 2,
        height: radius * 2
      ))
      ctx.restoreGState()
    }

    let path = Self.wingPath(in: bounds)
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: 1.5), blur: 4, color: NSColor.black.withAlphaComponent(0.28).cgColor)
    let fillAlpha = 1 - fillPulse * 0.35
    jianCream.withAlphaComponent(fillAlpha).setFill()
    path.fill()
    ctx.restoreGState()

    jianInk.setStroke()
    path.lineWidth = 2
    path.lineJoinStyle = .round
    path.lineCapStyle = .round
    path.stroke()
  }

  /// Ascending wing mark inspired by the Jian brand path (favicon / mark.tsx).
  private static func wingPath(in bounds: NSRect) -> NSBezierPath {
    let s = min(bounds.width, bounds.height)
    let path = NSBezierPath()
    // Tip near top-left (hotspot), body sweeping down-right then curling back — one ascending wing.
    path.move(to: CGPoint(x: s * 0.12, y: s * 0.10))
    path.curve(
      to: CGPoint(x: s * 0.72, y: s * 0.18),
      controlPoint1: CGPoint(x: s * 0.28, y: s * 0.02),
      controlPoint2: CGPoint(x: s * 0.52, y: s * 0.06)
    )
    path.curve(
      to: CGPoint(x: s * 0.88, y: s * 0.55),
      controlPoint1: CGPoint(x: s * 0.88, y: s * 0.28),
      controlPoint2: CGPoint(x: s * 0.94, y: s * 0.42)
    )
    path.curve(
      to: CGPoint(x: s * 0.42, y: s * 0.88),
      controlPoint1: CGPoint(x: s * 0.80, y: s * 0.72),
      controlPoint2: CGPoint(x: s * 0.58, y: s * 0.90)
    )
    path.curve(
      to: CGPoint(x: s * 0.18, y: s * 0.48),
      controlPoint1: CGPoint(x: s * 0.26, y: s * 0.86),
      controlPoint2: CGPoint(x: s * 0.12, y: s * 0.68)
    )
    path.curve(
      to: CGPoint(x: s * 0.12, y: s * 0.10),
      controlPoint1: CGPoint(x: s * 0.22, y: s * 0.32),
      controlPoint2: CGPoint(x: s * 0.08, y: s * 0.20)
    )
    path.close()
    return path
  }

  func flashClick(duration: TimeInterval = 0.2) {
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
  }

  func moveTip(to globalTopLeft: CGPoint) {
    tipPoint = globalTopLeft
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
    // Window origin is bottom-left; hotspot is hotspot.y down from the top of the view.
    let origin = NSPoint(
      x: tipPoint.x - hotspot.x,
      y: tipCocoaY - (pointerSize - hotspot.y)
    )
    window.setFrameOrigin(origin)
  }
}

// MARK: - Coordinate helpers

private func cgPointFromTopLeft(_ x: Double, _ y: Double) -> CGPoint {
  CGPoint(x: x, y: y)
}

// MARK: - Mouse / keyboard

private func postMouseMove(to point: CGPoint) {
  OverlayController.shared.moveTip(to: point)
  guard let event = CGEvent(
    mouseEventSource: nil,
    mouseType: .mouseMoved,
    mouseCursorPosition: point,
    mouseButton: .left
  ) else {
    logError("could not create mouseMoved event")
    return
  }
  event.post(tap: .cghidEventTap)
}

private func postMouseClick(button: CGMouseButton, count: Int64) {
  OverlayController.shared.flashClick()
  let point = OverlayController.shared.currentTip()
  let downType: CGEventType = button == .right ? .rightMouseDown : .leftMouseDown
  let upType: CGEventType = button == .right ? .rightMouseUp : .leftMouseUp

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
      Thread.sleep(forTimeInterval: 0.05)
    }
  }
}

private func postDrag(from: CGPoint, to: CGPoint) {
  postMouseMove(to: from)
  OverlayController.shared.flashClick()
  Thread.sleep(forTimeInterval: 0.02)

  if let down = CGEvent(
    mouseEventSource: nil,
    mouseType: .leftMouseDown,
    mouseCursorPosition: from,
    mouseButton: .left
  ) {
    down.post(tap: .cghidEventTap)
  }

  let steps = 12
  for i in 1...steps {
    let t = CGFloat(i) / CGFloat(steps)
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
    Thread.sleep(forTimeInterval: 0.008)
  }

  if let up = CGEvent(
    mouseEventSource: nil,
    mouseType: .leftMouseUp,
    mouseCursorPosition: to,
    mouseButton: .left
  ) {
    up.post(tap: .cghidEventTap)
  }
  OverlayController.shared.moveTip(to: to)
}

private func postScroll(at point: CGPoint, direction: String, amount: Int) {
  postMouseMove(to: point)
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
    Thread.sleep(forTimeInterval: 0.02)
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
  // Iterate UTF-16 code units; map Return/Tab to virtual keys when present as characters.
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
    Thread.sleep(forTimeInterval: 0.005)
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

  // Function keys F1–F12
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
  // Primary display: Cocoa origin is bottom-left of main screen; Quartz global top-left origin is (0,0).
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
    postMouseMove(to: cgPointFromTopLeft(x, y))
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

  case "drag":
    guard let fromX = doubleValue(object, "fromX"),
      let fromY = doubleValue(object, "fromY"),
      let toX = doubleValue(object, "toX"),
      let toY = doubleValue(object, "toY")
    else {
      writeError("drag requires fromX, fromY, toX, toY")
      return
    }
    postDrag(from: cgPointFromTopLeft(fromX, fromY), to: cgPointFromTopLeft(toX, toY))
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
    postScroll(at: cgPointFromTopLeft(x, y), direction: dir, amount: amount)
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
          // EOF — exit the process cleanly.
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

private let stdinReader = StdinReader()

autoreleasepool {
  let app = NSApplication.shared
  app.setActivationPolicy(.accessory)
  stdinReader.start()
  app.run()
}
