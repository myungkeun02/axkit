// Apple Reminders through EventKit, one command per run. It never deletes a reminder and never adds alarms: ax-kit
// keeps reminder times itself, so the owner is not notified twice.
// Usage:
//   ax-reminders status
//   ax-reminders request
//   ax-reminders lists
//   ax-reminders reminders [--list ID] [--since ISO] [--done-since ISO]
//   ax-reminders create    [--list ID] --title T [--due YYYY-MM-DD|ISO]
//   ax-reminders complete  --id ID
//   ax-reminders update    --id ID [--title T] [--due D] [--clear-due 1] [--done 1|0]
// Output: one JSON document on stdout, {"ok":true,...} or {"ok":false,"error":CODE[,"status":S]}.
import EventKit
import Foundation

func emit(_ obj: [String: Any]) -> Never {
  let data = (try? JSONSerialization.data(withJSONObject: obj, options: [])) ?? Data("{\"ok\":false,\"error\":\"json\"}".utf8)
  FileHandle.standardOutput.write(data)
  exit(0)
}

func fail(_ code: String, _ extra: [String: Any] = [:]) -> Never {
  emit(extra.merging(["ok": false, "error": code]) { _, new in new })
}

var args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { fail("usage") }
args.removeFirst()
var opts: [String: String] = [:]
var i = 0
while i + 1 < args.count {
  if args[i].hasPrefix("--") { opts[String(args[i].dropFirst(2))] = args[i + 1] }
  i += 2
}

let store = EKEventStore()

func status() -> String {
  switch EKEventStore.authorizationStatus(for: .reminder).rawValue {
  case 0: return "not-determined"
  case 1: return "restricted"
  case 2: return "denied"
  case 3: return "authorized"
  case 4: return "write-only"
  default: return "unknown"
  }
}

if command == "status" { emit(["ok": true, "status": status()]) }
if command == "request" {
  let done = DispatchSemaphore(value: 0)
  var granted = false
  if #available(macOS 14.0, *) {
    store.requestFullAccessToReminders { ok, _ in granted = ok; done.signal() }
  } else {
    store.requestAccess(to: .reminder) { ok, _ in granted = ok; done.signal() }
  }
  _ = done.wait(timeout: .now() + 120)
  emit(["ok": true, "granted": granted, "status": status()])
}
guard ["lists", "reminders", "create", "complete", "update"].contains(command) else { fail("usage") }
guard status() == "authorized" else { fail("permission", ["status": status()]) }

let stamp: ISO8601DateFormatter = {
  let f = ISO8601DateFormatter()
  f.formatOptions = [.withInternetDateTime]
  f.timeZone = TimeZone.current
  return f
}()

func parseDate(_ s: String) -> Date? {
  if let d = stamp.date(from: s) { return d }
  let fractional = ISO8601DateFormatter()
  fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return fractional.date(from: s)
}

func dueString(_ c: DateComponents?) -> String? {
  guard let c, let y = c.year, let m = c.month, let d = c.day else { return nil }
  if c.hour != nil, let date = Calendar.current.date(from: c) { return stamp.string(from: date) }
  return String(format: "%04d-%02d-%02d", y, m, d)
}

func dueComponents(_ s: String) -> DateComponents? {
  let parts = s.split(separator: "-").compactMap { Int($0) }
  if s.count == 10, parts.count == 3 { return DateComponents(year: parts[0], month: parts[1], day: parts[2]) }
  guard let date = parseDate(s) else { return nil }
  return Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: date)
}

func row(_ r: EKReminder) -> [String: Any] {
  var out: [String: Any] = [
    "id": r.calendarItemIdentifier, "list": r.calendar?.calendarIdentifier ?? "", "title": r.title ?? "",
    "done": r.isCompleted,
  ]
  if let due = dueString(r.dueDateComponents) { out["due"] = due }
  if let d = r.completionDate { out["completedAt"] = stamp.string(from: d) }
  if let d = r.creationDate { out["createdAt"] = stamp.string(from: d) }
  if let d = r.lastModifiedDate ?? r.creationDate { out["modifiedAt"] = stamp.string(from: d) }
  return out
}

func calendar(_ id: String?) -> EKCalendar {
  if let id, !id.isEmpty {
    guard let cal = store.calendar(withIdentifier: id), cal.allowedEntityTypes.contains(.reminder) else { fail("no-list") }
    return cal
  }
  guard let cal = store.defaultCalendarForNewReminders() else { fail("no-list") }
  return cal
}

func save(_ r: EKReminder) -> Never {
  do { try store.save(r, commit: true) } catch { fail("save-failed") }
  emit(["ok": true, "reminder": row(r)])
}

func reminder(_ id: String?) -> EKReminder {
  guard let id, !id.isEmpty else { fail("usage") }
  guard let r = store.calendarItem(withIdentifier: id) as? EKReminder else { fail("not-found") }
  return r
}

switch command {
case "lists":
  let fallback = store.defaultCalendarForNewReminders()?.calendarIdentifier
  emit(["ok": true, "lists": store.calendars(for: .reminder).map {
    ["id": $0.calendarIdentifier, "title": $0.title, "default": $0.calendarIdentifier == fallback, "writable": $0.allowsContentModifications]
  }])
case "reminders":
  let cals = opts["list"].map { [calendar($0)] }
  let since = opts["since"].flatMap(parseDate)
  let doneSince = opts["done-since"].flatMap(parseDate)
  let done = DispatchSemaphore(value: 0)
  var rows: [[String: Any]] = []
  store.fetchReminders(matching: store.predicateForReminders(in: cals)) { found in
    for r in found ?? [] {
      if r.isCompleted, let doneSince, (r.completionDate ?? .distantPast) < doneSince { continue }
      if let since, (r.lastModifiedDate ?? r.creationDate ?? .distantPast) < since { continue }
      rows.append(row(r))
      if rows.count >= 2000 { break }
    }
    done.signal()
  }
  if done.wait(timeout: .now() + 60) == .timedOut { fail("timeout") }
  emit(["ok": true, "reminders": rows])
case "create":
  guard let title = opts["title"], !title.isEmpty else { fail("usage") }
  let r = EKReminder(eventStore: store)
  r.calendar = calendar(opts["list"])
  r.title = title
  if let due = opts["due"] {
    guard let c = dueComponents(due) else { fail("bad-date") }
    r.dueDateComponents = c
  }
  save(r)
case "complete":
  let r = reminder(opts["id"])
  r.isCompleted = true
  save(r)
default:
  let r = reminder(opts["id"])
  if let title = opts["title"], !title.isEmpty { r.title = title }
  if opts["clear-due"] == "1" { r.dueDateComponents = nil }
  if let due = opts["due"] {
    guard let c = dueComponents(due) else { fail("bad-date") }
    r.dueDateComponents = c
  }
  if let doneFlag = opts["done"] { r.isCompleted = doneFlag == "1" }
  save(r)
}
