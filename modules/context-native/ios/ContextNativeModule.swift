import ExpoModulesCore
import Foundation
import ImageIO
import PDFKit
import Vision

private let appGroupIdentifier = "group.com.example.aicontextpack"

public final class ContextNativeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ContextNative")

    AsyncFunction("scanInbox") { () throws -> [[String: Any]] in
      guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier) else {
        throw NativeError("APP_GROUP_UNAVAILABLE")
      }
      let inbox = container.appendingPathComponent("Inbox", isDirectory: true)
      let staging = container.appendingPathComponent("InboxStaging", isDirectory: true)
      let recovered: Bool
      do { recovered = try recoverIncompleteTransactions(inbox: inbox, staging: staging) }
      catch { throw NativeError("INBOX_SCAN_FAILED") }
      if recovered { throw NativeError("INBOX_RECOVERY_REQUIRED") }
      var isDirectory: ObjCBool = false
      guard FileManager.default.fileExists(atPath: inbox.path, isDirectory: &isDirectory) else { return [] }
      guard isDirectory.boolValue else { throw NativeError("INBOX_SCAN_FAILED") }
      var enumerationError: Error?
      guard let enumerator = FileManager.default.enumerator(
        at: inbox,
        includingPropertiesForKeys: nil,
        errorHandler: { _, error in enumerationError = error; return false }
      ) else {
        throw NativeError("INBOX_SCAN_FAILED")
      }
      let files = enumerator.compactMap { $0 as? URL }
      if enumerationError != nil { throw NativeError("INBOX_SCAN_FAILED") }
      return try files.filter { $0.lastPathComponent == "manifest.json" }.map { url in
        do {
          let data = try Data(contentsOf: url)
          guard let manifest = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NativeError("INBOX_MANIFEST_INVALID")
          }
          try validateOwnedManifest(manifest, inbox: inbox)
          return manifest
        } catch {
          throw NativeError("INBOX_MANIFEST_INVALID")
        }
      }
    }

    AsyncFunction("recognizeText") { (fileUri: String, script: String) async throws -> [String: Any] in
      let started = ContinuousClock.now
      let url = try controlledFileURL(fileUri)
      guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
            let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw NativeError("OCR_IMAGE_DECODE_FAILED")
      }
      let orientation = imageOrientation(source: source)
      let request = VNRecognizeTextRequest()
      request.recognitionLevel = .accurate
      request.usesLanguageCorrection = true
      request.recognitionLanguages = script == "chinese" ? ["zh-Hans", "en-US"] : ["en-US"]
      do {
        try VNImageRequestHandler(cgImage: image, orientation: orientation).perform([request])
      } catch {
        throw NativeError("OCR_RECOGNITION_FAILED")
      }
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
      let values: URLResourceValues
      do {
        values = try url.resourceValues(forKeys: [.fileSizeKey])
      } catch {
        throw NativeError("PDF_INVALID_OR_TOO_LARGE")
      }
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

private func recoverIncompleteTransactions(inbox: URL, staging: URL, now: Date = Date()) throws -> Bool {
  let staleBefore = now.addingTimeInterval(-24 * 60 * 60)
  var recovered = try recoverCandidates(root: staging, staleBefore: staleBefore) { _ in true }
  recovered = try recoverCandidates(root: inbox, staleBefore: staleBefore) { child in
    !FileManager.default.fileExists(atPath: child.appendingPathComponent("manifest.json").path)
  } || recovered
  return recovered
}

private func recoverCandidates(
  root: URL,
  staleBefore: Date,
  isIncomplete: (URL) -> Bool
) throws -> Bool {
  var isDirectory: ObjCBool = false
  guard FileManager.default.fileExists(atPath: root.path, isDirectory: &isDirectory) else { return false }
  guard isDirectory.boolValue else { throw NativeError("INBOX_SCAN_FAILED") }
  let children = try FileManager.default.contentsOfDirectory(
    at: root,
    includingPropertiesForKeys: [.isDirectoryKey, .contentModificationDateKey],
    options: [.skipsHiddenFiles]
  )
  var recovered = false
  for child in children {
    let values = try child.resourceValues(forKeys: [.isDirectoryKey, .contentModificationDateKey])
    guard values.isDirectory == true,
          isIncomplete(child),
          (values.contentModificationDate ?? .distantFuture) <= staleBefore else { continue }
    try FileManager.default.removeItem(at: child)
    recovered = true
  }
  return recovered
}

private func imageOrientation(source: CGImageSource) -> CGImagePropertyOrientation {
  guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
        let rawValue = properties[kCGImagePropertyOrientation] as? NSNumber else { return .up }
  return CGImagePropertyOrientation(rawValue: rawValue.uint32Value) ?? .up
}

private func validateOwnedManifest(_ manifest: [String: Any], inbox: URL) throws {
  guard let items = manifest["items"] as? [[String: Any]] else {
    throw NativeError("INBOX_MANIFEST_INVALID")
  }
  let inboxPath = inbox.resolvingSymlinksInPath().standardizedFileURL.path + "/"
  for item in items {
    guard let value = item["localUri"] as? String,
          let url = URL(string: value),
          url.isFileURL,
          url.host == nil,
          url.resolvingSymlinksInPath().standardizedFileURL.path.hasPrefix(inboxPath) else {
      throw NativeError("INBOX_MANIFEST_INVALID")
    }
    if item["status"] as? String == "copied" {
      guard let byteCount = item["byteCount"] as? NSNumber,
            FileManager.default.fileExists(atPath: url.path),
            let actualBytes = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize,
            actualBytes == byteCount.intValue else {
        throw NativeError("INBOX_MANIFEST_INVALID")
      }
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

private final class NativeError: Exception, @unchecked Sendable {
  init(_ code: String) {
    super.init(name: "ContextNativeError", description: code, code: code)
  }
}
