// Read-only view of a running app's windows through the macOS Accessibility API.
// It never launches, activates, presses, types or scrolls: reading a chat list this way leaves every room unread.
// Secure text fields are skipped, so a password box is never read.
// Usage: ax-read trusted | ax-read dump --bundle id1,id2 [--max-nodes N]
// Output: one JSON document on stdout.
import AppKit
import ApplicationServices
import Foundation

func emit(_ obj: [String: Any]) -> Never {
  let data = (try? JSONSerialization.data(withJSONObject: obj, options: [])) ?? Data("{\"ok\":false,\"error\":\"json\"}".utf8)
  FileHandle.standardOutput.write(data)
  exit(0)
}

func attr(_ e: AXUIElement, _ name: String) -> AnyObject? {
  var v: AnyObject?
  return AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success ? v : nil
}

func text(_ e: AXUIElement, _ name: String, _ limit: Int) -> String {
  guard let s = attr(e, name) as? String else { return "" }
  let t = s.replacingOccurrences(of: "\u{feff}", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
  return t.count > limit ? String(t.prefix(limit)) : t
}

func children(_ e: AXUIElement) -> [AXUIElement] { (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }

var args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { emit(["ok": false, "error": "usage"]) }
args.removeFirst()
var opts: [String: String] = [:]
var i = 0
while i + 1 < args.count {
  if args[i].hasPrefix("--") { opts[String(args[i].dropFirst(2))] = args[i + 1] }
  i += 2
}

let trusted = AXIsProcessTrusted()
if command == "trusted" { emit(["ok": true, "trusted": trusted]) }
guard command == "dump" else { emit(["ok": false, "error": "usage"]) }
guard trusted else { emit(["ok": false, "error": "accessibility"]) }

let bundles = (opts["bundle"] ?? "").split(separator: ",").map(String.init)
let maxNodes = max(50, min(20000, Int(opts["max-nodes"] ?? "4000") ?? 4000))
guard let app = bundles.lazy.compactMap({ NSRunningApplication.runningApplications(withBundleIdentifier: $0).first }).first else {
  emit(["ok": true, "running": false])
}

let axApp = AXUIElementCreateApplication(app.processIdentifier)
let windows = (attr(axApp, kAXWindowsAttribute) as? [AXUIElement]) ?? []
var rows: [[Any]] = []
var titles: [String] = []
for (index, window) in windows.enumerated() {
  titles.append(text(window, kAXTitleAttribute, 200))
  var stack: [(AXUIElement, Int)] = [(window, 0)]
  while let (element, depth) = stack.popLast(), rows.count < maxNodes {
    let role = text(element, kAXRoleAttribute, 60)
    let subrole = text(element, kAXSubroleAttribute, 60)
    let secure = role == "AXSecureTextField" || subrole == "AXSecureTextField"
    let label = text(element, kAXTitleAttribute, 300)
    let description = text(element, kAXDescriptionAttribute, 300)
    rows.append([
      index, depth, role, subrole, text(element, kAXIdentifierAttribute, 80),
      label.isEmpty ? description : label, secure ? "" : text(element, kAXValueAttribute, 500),
    ])
    if depth < 40 { stack.append(contentsOf: children(element).reversed().map { ($0, depth + 1) }) }
  }
}
emit([
  "ok": true, "running": true, "frontmost": app.isActive,
  "windows": titles, "truncated": rows.count >= maxNodes, "nodes": rows,
])
