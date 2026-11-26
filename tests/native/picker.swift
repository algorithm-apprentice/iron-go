import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

struct Failure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

func attribute<T>(_ element: AXUIElement, _ name: String) -> T? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value as? T
}

func button(_ names: [String], in root: AXUIElement, depth: Int = 0) -> AXUIElement? {
    guard depth < 16 else { return nil }
    let role: String = attribute(root, "AXRole") ?? ""
    if ["AXButton", "AXToggleButton", "AXCheckBox"].contains(role) {
        for key in ["AXTitle", "AXDescription", "AXHelp"] {
            if let label: String = attribute(root, key), names.contains(label) { return root }
        }
    }
    for child in attribute(root, "AXChildren") ?? [] as [AXUIElement] {
        if let result = button(names, in: child, depth: depth + 1) { return result }
    }
    return nil
}

func eventually<T>(_ label: String, _ query: () -> T?) throws -> T {
    let deadline = Date().addingTimeInterval(10)
    repeat {
        if let value = query() { return value }
        RunLoop.current.run(until: Date().addingTimeInterval(0.08))
    } while Date() < deadline
    throw Failure(message: label)
}

func frame(_ element: AXUIElement) -> CGRect? {
    guard let position: AXValue = attribute(element, "AXPosition"),
          let size: AXValue = attribute(element, "AXSize") else { return nil }
    var origin = CGPoint.zero
    var dimensions = CGSize.zero
    guard AXValueGetValue(position, .cgPoint, &origin), AXValueGetValue(size, .cgSize, &dimensions) else { return nil }
    return CGRect(origin: origin, size: dimensions)
}

func screenFrame(_ screen: NSScreen) -> CGRect {
    let top = NSScreen.screens.first?.frame.maxY ?? 0
    return CGRect(x: screen.frame.minX, y: top - screen.frame.maxY, width: screen.frame.width, height: screen.frame.height)
}

func scale(at rectangle: CGRect) -> CGFloat? {
    NSScreen.screens.first { screenFrame($0).contains(CGPoint(x: rectangle.midX, y: rectangle.midY)) }?.backingScaleFactor
}

func reportPickerRaster(_ rectangle: CGRect, owner: pid_t, directory: URL) {
    guard CGPreflightScreenCaptureAccess() else {
        print("Picker bitmap probe skipped: Screen Recording permission is unavailable")
        return
    }
    let windows = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] ?? []
    let matching = windows.first { item in
        guard item[kCGWindowOwnerPID as String] as? Int32 == owner,
              let details = item[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: details as CFDictionary) else { return false }
        return abs(rectangle.minX - bounds.minX) <= 2 && abs(rectangle.minY - bounds.minY) <= 2
            && abs(rectangle.width - bounds.width) <= 2 && abs(rectangle.height - bounds.height) <= 2
    }
    guard let window = matching?[kCGWindowNumber as String] as? Int else {
        print("Picker bitmap probe skipped: no matching on-screen window")
        return
    }
    let image = directory.appendingPathComponent("picker-probe.png")
    let capture = Process()
    capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    capture.arguments = ["-x", "-o", "-l", String(window), "-t", "png", image.path]
    guard (try? capture.run()) != nil else { return }
    capture.waitUntilExit()
    guard capture.terminationStatus == 0, let data = try? Data(contentsOf: image), let bitmap = NSBitmapImageRep(data: data) else { return }
    print("Picker screenshot: \(bitmap.pixelsWide) × \(bitmap.pixelsHigh) pixels for \(rectangle.width) × \(rectangle.height) points")
}

func verifyTitleBar(_ window: AXUIElement) throws {
    var measured = "Accessibility frames are unavailable"
    do { _ = try eventually("Native title bar geometry is not centered or overlaps window controls") { () -> Bool? in
        let bounds = frame(window)
        let command = button(["Search commands", "Search commands (⌘P)"], in: window).flatMap(frame)
        let side = button(["Toggle Side Bar", "Toggle Side Bar (⌘B)"], in: window).flatMap(frame)
        let bottom = button(["Toggle Bottom Panel", "Toggle Bottom Panel (⌘J)"], in: window).flatMap(frame)
        measured = "window=\(String(describing: bounds)), command=\(String(describing: command)), sidebar=\(String(describing: side)), panel=\(String(describing: bottom))"
        guard let bounds, let command, let side, let bottom else { return nil }
        let lights = ["AXCloseButton", "AXMinimizeButton", "AXZoomButton"].compactMap { key -> CGRect? in
            guard let control: AXUIElement = attribute(window, key) else { return nil }
            return frame(control)
        }
        measured = "window=\(bounds), command=\(command), sidebar=\(side), panel=\(bottom), traffic lights=\(lights)"
        guard lights.count == 3, abs(command.midX - bounds.midX) <= 2,
              command.minY >= bounds.minY, command.maxY <= bounds.minY + 36,
              side.minX >= command.maxX, abs(bottom.minX - side.maxX - 1) <= 1,
              lights.allSatisfy({ $0.maxX + 12 < command.minX && $0.maxY <= bounds.minY + 36 }) else { return nil }
        return true
    } } catch { throw Failure(message: "\(error.localizedDescription): \(measured)") }
}

func checkPicker() throws {
    guard AXIsProcessTrusted() else {
        throw Failure(message: "Picker smoke requires macOS Accessibility permission for the calling terminal.")
    }
    let home = FileManager.default.temporaryDirectory.appendingPathComponent("iron-go-picker-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: home, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: home) }
    let child = Process()
    let args = CommandLine.arguments.dropFirst()
    let retinaProbe = args.contains("--retina-probe")
    let executable = args.first { !$0.hasPrefix("--") } ?? "src-tauri/target/release/bundle/macos/Iron Go.app/Contents/MacOS/iron-go"
    child.executableURL = URL(fileURLWithPath: executable)
    child.currentDirectoryURL = home
    child.environment = ProcessInfo.processInfo.environment.merging(["HOME": home.path, "CFFIXED_USER_HOME": home.path]) { _, new in new }
    try child.run()
    defer {
        NSRunningApplication(processIdentifier: child.processIdentifier)?.terminate()
        let deadline = Date().addingTimeInterval(2)
        while child.isRunning && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
        if child.isRunning { child.terminate() }
    }
    let app = AXUIElementCreateApplication(child.processIdentifier)
    let window = try eventually("Main window did not appear") { (attribute(app, "AXWindows") as [AXUIElement]?)?.first }
    try verifyTitleBar(window)
    if let bounds = frame(window) {
        var minimum = CGSize(width: 760, height: bounds.height)
        if let size = AXValueCreate(.cgSize, &minimum), AXUIElementSetAttributeValue(window, "AXSize" as CFString, size) == .success {
            _ = try eventually("Could not resize the test window to 760 px") { frame(window).flatMap { abs($0.width - 760) <= 1 ? $0 : nil } }
        } else {
            throw Failure(message: "Main window size is not settable")
        }
        try verifyTitleBar(window)
    }
    print("PASS: native title bar stays centered at default and minimum widths")
    if retinaProbe, let retina = NSScreen.screens.first(where: { $0.backingScaleFactor > 1 }) {
        let screen = screenFrame(retina)
        var target = CGPoint(x: screen.minX + 30, y: screen.minY + 45)
        var dimensions = CGSize(width: min(950, screen.width - 80), height: min(620, screen.height - 100))
        if let position = AXValueCreate(.cgPoint, &target), let size = AXValueCreate(.cgSize, &dimensions) {
            AXUIElementSetAttributeValue(window, "AXSize" as CFString, size)
            AXUIElementSetAttributeValue(window, "AXPosition" as CFString, position)
        }
        _ = try eventually("Could not move the disposable app to a Retina display") {
            frame(window).flatMap { scale(at: $0) == retina.backingScaleFactor ? $0 : nil }
        }
    }
    let open = try eventually("Open Project control did not appear") {
        button(["Open Project", "Open Folder", "Open Folder (⌘O)"], in: app)
    }
    guard AXUIElementPerformAction(open, kAXPressAction as CFString) == .success else {
        throw Failure(message: "Open Project button could not be activated")
    }
    let cancel = try eventually("The macOS folder picker did not appear as a focused standalone window") { () -> AXUIElement? in
        let windows: [AXUIElement] = attribute(app, "AXWindows") ?? []
        for window in windows {
            let sheets: [AXUIElement] = attribute(window, "AXSheets") ?? []
            if !sheets.isEmpty { return nil }
        }
        guard windows.count >= 2, let focused: AXUIElement = attribute(app, "AXFocusedWindow") else { return nil }
        return button(["Cancel"], in: focused)
    }
    let focused: AXUIElement? = attribute(app, "AXFocusedWindow")
    if retinaProbe, let openerFrame = frame(window), let panelFrame = focused.flatMap(frame) {
        print("Opener: \(openerFrame), scale \(scale(at: openerFrame).map(String.init(describing:)) ?? "unknown")")
        print("Picker: \(panelFrame), scale \(scale(at: panelFrame).map(String.init(describing:)) ?? "unknown")")
        reportPickerRaster(panelFrame, owner: child.processIdentifier, directory: home)
    }
    guard AXUIElementPerformAction(cancel, kAXPressAction as CFString) == .success else {
        throw Failure(message: "The standalone picker could not be cancelled")
    }
    _ = try eventually("Cancel did not return to the window") { () -> Bool? in
        let windows: [AXUIElement] = attribute(app, "AXWindows") ?? []
        return windows.count == 1 && button(["Open Project"], in: app) != nil && button(["New Project"], in: app) != nil ? true : nil
    }
    print("PASS: standalone macOS project picker takes focus and Cancel returns to welcome")
}

do { try checkPicker() }
catch { fputs("\(error.localizedDescription)\n", stderr); exit(1) }
