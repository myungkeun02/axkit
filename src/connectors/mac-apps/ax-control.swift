// Controls other Mac apps through the Accessibility API, one command per run. ax-kit's policy (deny lists, approval
// cards) lives in TypeScript; this helper adds its own last line: it never reads or types into a secure text field,
// and it refuses a target that matches more than one element.
// Usage:
//   ax-control trusted
//   ax-control apps
//   ax-control window   [--bundle B] [--max-depth N] [--max-nodes N] [--redact 1]
//   ax-control selected [--bundle B]
//   ax-control activate --bundle B
//   ax-control press    --bundle B --target '[{"role":"AXButton","title":"OK"}]'
//   ax-control set      --bundle B --target '[...]' --value TEXT
//   ax-control menu     --bundle B --items '["File","New"]'
// Output: one JSON document on stdout, {"ok":true,...} or {"ok":false,"error":CODE}.
import AppKit
import ApplicationServices
import Foundation

func emit(_ obj: [String: Any]) -> Never {
  let data = (try? JSONSerialization.data(withJSONObject: obj, options: [])) ?? Data("{\"ok\":false,\"error\":\"json\"}".utf8)
  FileHandle.standardOutput.write(data)
  exit(0)
}

func fail(_ code: String, _ extra: [String: Any] = [:]) -> Never {
  emit(extra.merging(["ok": false, "error": code]) { _, new in new })
}

func attr(_ e: AXUIElement, _ name: String) -> AnyObject? {
  var v: AnyObject?
  return AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success ? v : nil
}

func element(_ value: AnyObject?) -> AXUIElement? {
  guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
  return (value as! AXUIElement)
}

func clean(_ s: String, _ limit: Int) -> String {
  let t = s.replacingOccurrences(of: "\u{feff}", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
  return t.count > limit ? String(t.prefix(limit)) : t
}

func text(_ e: AXUIElement, _ name: String, _ limit: Int) -> String {
  guard let v = attr(e, name) else { return "" }
  if let s = v as? String { return clean(s, limit) }
  if let n = v as? NSNumber { return n.stringValue }
  return ""
}

func children(_ e: AXUIElement) -> [AXUIElement] { (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
func role(_ e: AXUIElement) -> String { text(e, kAXRoleAttribute, 60) }
func isSecure(_ e: AXUIElement) -> Bool {
  role(e) == "AXSecureTextField" || text(e, kAXSubroleAttribute, 60) == "AXSecureTextField"
}
func labels(_ e: AXUIElement) -> [String] {
  [kAXTitleAttribute, kAXDescriptionAttribute, kAXPlaceholderValueAttribute, kAXIdentifierAttribute]
    .map { text(e, $0, 300) }.filter { !$0.isEmpty }
}
func label(_ e: AXUIElement) -> String { labels(e).first ?? "" }
func norm(_ s: String) -> String { s.precomposedStringWithCanonicalMapping.trimmingCharacters(in: .whitespacesAndNewlines) }
func enabled(_ e: AXUIElement) -> Bool { (attr(e, kAXEnabledAttribute) as? Bool) ?? true }

var args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { fail("usage") }
args.removeFirst()
var opts: [String: String] = [:]
var i = 0
while i + 1 < args.count {
  if args[i].hasPrefix("--") { opts[String(args[i].dropFirst(2))] = args[i + 1] }
  i += 2
}

func appInfo(_ app: NSRunningApplication) -> [String: Any] {
  ["name": app.localizedName ?? "", "bundle": app.bundleIdentifier ?? "", "pid": Int(app.processIdentifier),
   "active": app.isActive, "hidden": app.isHidden]
}

if command == "trusted" { emit(["ok": true, "trusted": AXIsProcessTrusted()]) }
if command == "apps" {
  let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
  emit(["ok": true, "apps": apps.map(appInfo)])
}
guard ["window", "selected", "activate", "press", "set", "menu"].contains(command) else { fail("usage") }
guard AXIsProcessTrusted() else { fail("accessibility") }

let app: NSRunningApplication = {
  if let bundle = opts["bundle"], !bundle.isEmpty {
    guard let found = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first else { fail("not-running") }
    return found
  }
  if command != "window" && command != "selected" { fail("usage") }
  guard let front = NSWorkspace.shared.frontmostApplication else { fail("no-frontmost") }
  return front
}()
let axApp = AXUIElementCreateApplication(app.processIdentifier)

func focusedWindow() -> AXUIElement? {
  if let w = element(attr(axApp, kAXFocusedWindowAttribute)) { return w }
  return (attr(axApp, kAXWindowsAttribute) as? [AXUIElement])?.first
}

if command == "activate" {
  if #available(macOS 14.0, *) { _ = app.activate() } else { _ = app.activate(options: []) }
  emit(["ok": true, "app": appInfo(app), "done": true])
}

if command == "selected" {
  guard let focused = element(attr(axApp, kAXFocusedUIElementAttribute)) else { emit(["ok": true, "app": appInfo(app), "text": ""]) }
  if isSecure(focused) { fail("secure") }
  emit(["ok": true, "app": appInfo(app), "role": role(focused), "text": text(focused, kAXSelectedTextAttribute, 20000)])
}

if command == "window" {
  let maxDepth = max(1, min(25, Int(opts["max-depth"] ?? "12") ?? 12))
  let maxNodes = max(20, min(1500, Int(opts["max-nodes"] ?? "400") ?? 400))
  let redact = opts["redact"] == "1"
  guard let window = focusedWindow() else { emit(["ok": true, "app": appInfo(app), "window": "", "truncated": false, "nodes": []]) }
  var rows: [[Any]] = []
  var truncated = false
  var stack: [(AXUIElement, Int)] = [(window, 0)]
  while let (e, depth) = stack.popLast() {
    if rows.count >= maxNodes { truncated = true; break }
    let secure = isSecure(e)
    var flags = ""
    if secure { flags += "s" }
    if !enabled(e) { flags += "d" }
    if (attr(e, kAXFocusedAttribute) as? Bool) == true { flags += "f" }
    let value = secure || redact ? "" : text(e, kAXValueAttribute, 300)
    rows.append([depth, role(e), text(e, kAXSubroleAttribute, 60), clean(label(e), 200), value, flags])
    if depth < maxDepth { stack.append(contentsOf: children(e).reversed().map { ($0, depth + 1) }) } else if !children(e).isEmpty { truncated = true }
  }
  emit(["ok": true, "app": appInfo(app), "window": text(window, kAXTitleAttribute, 200), "truncated": truncated, "nodes": rows])
}

func parseJson(_ key: String) -> Any? {
  guard let raw = opts[key], let data = raw.data(using: .utf8) else { return nil }
  return try? JSONSerialization.jsonObject(with: data)
}

func perform(_ e: AXUIElement) {
  if !enabled(e) { fail("disabled") }
  if AXUIElementPerformAction(e, kAXPressAction as CFString) != .success { fail("action-failed") }
}

if command == "menu" {
  guard let items = parseJson("items") as? [String], !items.isEmpty else { fail("usage") }
  guard var current = element(attr(axApp, kAXMenuBarAttribute)) else { fail("not-found") }
  for (index, wanted) in items.enumerated() {
    let roles = index == 0 ? ["AXMenuBarItem"] : ["AXMenuItem"]
    guard let item = children(current).first(where: { roles.contains(role($0)) && norm(label($0)) == norm(wanted) }) else {
      fail("not-found", ["step": index])
    }
    if index == items.count - 1 {
      perform(item)
      emit(["ok": true, "app": appInfo(app), "role": role(item), "label": label(item), "done": true])
    }
    guard let menu = children(item).first(where: { role($0) == "AXMenu" }) else { fail("not-found", ["step": index]) }
    current = menu
  }
  fail("not-found")
}

// press / set: each step matches a descendant of the previous match by role, and by title when one is given.
guard let steps = parseJson("target") as? [[String: Any]], !steps.isEmpty else { fail("usage") }
guard let window = focusedWindow() else { fail("no-window") }

func matches(_ e: AXUIElement, _ step: [String: Any]) -> Bool {
  guard let wantedRole = step["role"] as? String, role(e) == wantedRole else { return false }
  guard let title = step["title"] as? String else { return true }
  return labels(e).contains { norm($0) == norm(title) }
}

func descendants(of root: AXUIElement, matching step: [String: Any]) -> [AXUIElement] {
  var found: [AXUIElement] = []
  var visited = 0
  var stack: [(AXUIElement, Int)] = children(root).map { ($0, 1) }
  while let (e, depth) = stack.popLast(), visited < 6000 {
    visited += 1
    if matches(e, step) { found.append(e) }
    if depth < 30 { stack.append(contentsOf: children(e).map { ($0, depth + 1) }) }
  }
  return found
}

var current: [AXUIElement] = [window]
for step in steps {
  var next: [AXUIElement] = []
  for root in current {
    for e in descendants(of: root, matching: step) where !next.contains(where: { CFEqual($0, e) }) { next.append(e) }
  }
  current = next
  if current.isEmpty { fail("not-found") }
}
if current.count > 1 { fail("ambiguous", ["count": current.count]) }
let target = current[0]
if isSecure(target) { fail("secure") }

if command == "press" {
  perform(target)
  emit(["ok": true, "app": appInfo(app), "role": role(target), "label": label(target), "done": true])
}

guard let value = opts["value"] else { fail("usage") }
var settable: DarwinBoolean = false
if AXUIElementIsAttributeSettable(target, kAXValueAttribute as CFString, &settable) != .success || !settable.boolValue {
  fail("not-settable")
}
if AXUIElementSetAttributeValue(target, kAXValueAttribute as CFString, value as CFString) != .success { fail("action-failed") }
emit(["ok": true, "app": appInfo(app), "role": role(target), "label": label(target), "done": true])
