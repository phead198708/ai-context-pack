import ExpoModulesCore
import Foundation
import ImageIO
import PDFKit
import Vision

private let appGroupIdentifier = "group.com.example.aicontextpack"

public final class ContextNativeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ContextNative")

    AsyncFunction("scanInbox") { () -> [[String: Any]] in
      guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier) else {
        return []
      }
      let inbox = container.appendingPathComponent("Inbox", isDirectory: true)
      guard let enumerator = FileManager.default.enumerator(at: inbox, includingPropertiesForKeys: nil) else { return [] }
      let files = enumerator.compactMap { $0 as? URL }
      return files.filter { $0.lastPathComponent == "manifest.json" }.compactMap { url in
        guard let data = try? Data(contentsOf: url),
              let value = try? JSONSerialization.jsonObject(with: data),
              let manifest = value as? [String: Any] else { return nil }
        return manifest
      }
    }

    AsyncFunction("recognizeText") { (fileUri: String, script: String) async throws -> [String: Any] in
      let started = ContinuousClock.now
      let url = try controlledFileURL(fileUri)
      guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
            let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw NativeError("OCR_IMAGE_DECODE_FAILED")
      }
      let request = VNRecognizeTextRequest()
      request.recognitionLevel = .accurate
      request.usesLanguageCorrection = true
      request.recognitionLanguages = script == "chinese" ? ["zh-Hans", "en-US"] : ["en-US"]
      try VNImageRequestHandler(cgImage: image).perform([request])
      let observations = request.results ?? []
      let blocks: [[String: Any]] = observations.compactMap { observation in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        let bounds = observation.boundingBox
        return ["text": candidate.string,
                "confidence": Double(candidate.confidence),
                "bounds": ["x": bounds.minX, "y": 1 - bounds.maxY, "width": bounds.width, "height": bounds.height]]
      }
      return ["schemaVersion": 1,
              "text": blocks.compactMap { $0["text"] as? String }.joined(separator: "\n"),
              "blocks": blocks,
              "durationMs": durationMilliseconds(since: started),
              "engine": "apple-vision",
              "revision": String(VNRecognizeTextRequestRevision3)]
    }

    AsyncFunction("probePdf") { (fileUri: String) throws -> [String: Any] in
      let url = try controlledFileURL(fileUri)
      let values = try url.resourceValues(forKeys: [.fileSizeKey])
      guard (values.fileSize ?? 0) <= 52_428_800 else { throw NativeError("PDF_TOO_LARGE") }
      guard let document = PDFDocument(url: url), document.pageCount <= 25 else { throw NativeError("PDF_INVALID_OR_TOO_MANY_PAGES") }
      var embedded = 0
      for index in 0..<document.pageCount where !(document.page(at: index)?.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { embedded += 1 }
      return ["pageCount": document.pageCount, "embeddedTextPages": embedded,
              "renderedFallbackPages": document.pageCount - embedded, "engine": "pdfkit",
              "limit": ["pages": 25, "bytes": 52_428_800]]
    }
  }
}

private func controlledFileURL(_ value: String) throws -> URL {
  guard let url = URL(string: value), url.isFileURL else { throw NativeError("INVALID_LOCAL_FILE_URI") }
  return url.standardizedFileURL
}

private func durationMilliseconds(since start: ContinuousClock.Instant) -> Double {
  let duration = start.duration(to: .now)
  return Double(duration.components.seconds) * 1_000 + Double(duration.components.attoseconds) / 1_000_000_000_000_000
}

private struct NativeError: Error, CustomStringConvertible {
  let description: String
  init(_ code: String) { description = code }
}
