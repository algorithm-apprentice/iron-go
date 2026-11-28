import AppKit
import ApplicationServices
import Foundation

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func attribute(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success ? value : nil
}

guard AXIsProcessTrusted(), CommandLine.arguments.count == 2,
      let pid = Int32(CommandLine.arguments[1]),
      let running = NSRunningApplication(processIdentifier: pid),
      running.executableURL?.lastPathComponent == "iron-go-acceptance",
      !running.isTerminated else { fail("The accessibility driver needs a trusted, disposable Iron Go process.") }

let application = AXUIElementCreateApplication(pid)
let raw = FileHandle.standardInput.readDataToEndOfFile()
guard let request = try JSONSerialization.jsonObject(with: raw) as? [String: Any],
      let action = request["action"] as? String else { fail("Provide a valid accessibility driver action.") }

func output(_ value: Any) throws {
    let data = try JSONSerialization.data(withJSONObject: value)
    FileHandle.standardOutput.write(data)
}

func foreground() -> Bool {
    NSWorkspace.shared.frontmostApplication?.processIdentifier == pid && attribute(application, kAXFocusedWindowAttribute) != nil
}

if action == "activate" {
    _ = running.activate()
    _ = AXUIElementSetAttributeValue(application, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
    if let window = (attribute(application, kAXWindowsAttribute) as? [AXUIElement])?.first {
        _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
    }
    let deadline = Date().addingTimeInterval(2)
    while !foreground() && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.02)) }
    guard foreground() else {
        let front = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
        fail("The disposable app did not become the focused native window (wanted PID \(pid), foreground PID \(front)).")
    }
    try output(["ready": true])
} else if action == "tree" {
    let manual = AXUIElementSetAttributeValue(application, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    let enhanced = AXUIElementSetAttributeValue(application, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    var nodes: [[String: String]] = []
    func visit(_ element: AXUIElement, depth: Int) {
        guard depth < 22 && nodes.count < 1500 else { return }
        var node: [String: String] = [:]
        for key in [kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute,
                    kAXValueAttribute, kAXHelpAttribute, kAXFocusedAttribute, kAXSelectedAttribute] {
            if let value = attribute(element, key) as? String { node[key] = String(value.prefix(300)) }
            else if let value = attribute(element, key) as? NSNumber { node[key] = value.stringValue }
        }
        nodes.append(node)
        for key in [kAXChildrenAttribute, kAXContentsAttribute] {
            for child in (attribute(element, key) as? [AXUIElement] ?? []).prefix(200) { visit(child, depth: depth + 1) }
        }
    }
    let windows = attribute(application, kAXWindowsAttribute) as? [AXUIElement] ?? []
    for window in windows { visit(window, depth: 0) }
    if let focused = attribute(application, kAXFocusedUIElementAttribute), CFGetTypeID(focused) == AXUIElementGetTypeID() {
        visit(focused as! AXUIElement, depth: 0)
    }
    try output(["nodes": nodes, "manualResult": manual.rawValue, "enhancedResult": enhanced.rawValue])
} else if action == "keys" {
    guard foreground(), let keys = request["keys"] as? [[String: Any]], keys.count <= 100 else {
        fail("The keystroke batch requires the disposable Iron Go window in the foreground.")
    }
    let source = CGEventSource(stateID: .hidSystemState)
    for key in keys {
        guard foreground(), let code = key["code"] as? UInt16 else { fail("The target changed during a native key batch.") }
        var flags: CGEventFlags = []
        for modifier in key["modifiers"] as? [String] ?? [] {
            switch modifier {
            case "command": flags.insert(.maskCommand)
            case "shift": flags.insert(.maskShift)
            case "control": flags.insert(.maskControl)
            case "option": flags.insert(.maskAlternate)
            default: fail("Unsupported modifier.")
            }
        }
        for pressed in [true, false] {
            guard let event = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(code), keyDown: pressed) else { fail("Could not construct a native keystroke.") }
            event.flags = flags
            if let text = key["text"] as? String {
                let characters = Array(text.utf16)
                characters.withUnsafeBufferPointer { event.keyboardSetUnicodeString(stringLength: $0.count, unicodeString: $0.baseAddress) }
            }
            event.postToPid(pid)
            RunLoop.current.run(until: Date().addingTimeInterval(0.018))
        }
    }
    try output(["sent": keys.count])
} else { fail("Unknown accessibility test action.") }
