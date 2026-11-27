import AppKit

guard CommandLine.arguments.count == 2,
      let pid = Int32(CommandLine.arguments[1]), pid > 0,
      let application = NSRunningApplication(processIdentifier: pid),
      application.terminate() else {
    fputs("Could not send system Quit to the acceptance app.\n", stderr)
    exit(EXIT_FAILURE)
}
