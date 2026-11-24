// Text from a local image or PDF with Apple's Vision framework. Runs on this Mac only; nothing is uploaded.
// A PDF with a text layer is read directly; scanned pages are rendered and recognized.
// Usage: ax-ocr <path> [--languages ko-KR,en-US] [--max-pages N]
// Output: {"ok":true,"method":"pdf-text|vision","pages":N,"text":"…"} or {"ok":false,"error":"…"}.
import Foundation
import PDFKit
import Vision
import ImageIO

func emit(_ obj: [String: Any]) -> Never {
  let data = (try? JSONSerialization.data(withJSONObject: obj, options: [])) ?? Data("{\"ok\":false,\"error\":\"json\"}".utf8)
  FileHandle.standardOutput.write(data)
  exit(0)
}

var args = Array(CommandLine.arguments.dropFirst())
guard let path = args.first else { emit(["ok": false, "error": "usage"]) }
args.removeFirst()
var opts: [String: String] = [:]
var i = 0
while i + 1 < args.count {
  if args[i].hasPrefix("--") { opts[String(args[i].dropFirst(2))] = args[i + 1] }
  i += 2
}
let languages = (opts["languages"] ?? "ko-KR,en-US").split(separator: ",").map(String.init)
let maxPages = max(1, min(50, Int(opts["max-pages"] ?? "10") ?? 10))
let url = URL(fileURLWithPath: path)
guard FileManager.default.isReadableFile(atPath: path) else { emit(["ok": false, "error": "unreadable"]) }

func recognize(_ image: CGImage) -> String {
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = true
  request.recognitionLanguages = languages
  let handler = VNImageRequestHandler(cgImage: image, options: [:])
  guard (try? handler.perform([request])) != nil else { return "" }
  let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
  return lines.joined(separator: "\n")
}

func render(_ page: PDFPage) -> CGImage? {
  let box = page.bounds(for: .mediaBox)
  let scale: CGFloat = 2
  let width = Int(box.width * scale), height = Int(box.height * scale)
  guard width > 0, height > 0,
    let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
  ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
  ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
  ctx.scaleBy(x: scale, y: scale)
  page.draw(with: .mediaBox, to: ctx)
  return ctx.makeImage()
}

if url.pathExtension.lowercased() == "pdf" {
  guard let doc = PDFDocument(url: url) else { emit(["ok": false, "error": "bad_pdf"]) }
  let count = min(doc.pageCount, maxPages)
  var layer: [String] = []
  for index in 0..<count { layer.append(doc.page(at: index)?.string ?? "") }
  let joined = layer.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
  if joined.count >= 20 { emit(["ok": true, "method": "pdf-text", "pages": count, "text": joined]) }
  var texts: [String] = []
  for index in 0..<count {
    if let page = doc.page(at: index), let image = render(page) { texts.append(recognize(image)) }
  }
  emit(["ok": true, "method": "vision", "pages": count, "text": texts.joined(separator: "\n")])
}

guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
  let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { emit(["ok": false, "error": "bad_image"]) }
emit(["ok": true, "method": "vision", "pages": 1, "text": recognize(image)])
