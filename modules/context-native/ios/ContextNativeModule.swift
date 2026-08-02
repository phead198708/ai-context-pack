import ExpoModulesCore
import Foundation
import ImageIO
import PDFKit
import Vision
import Darwin

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
      if try !MetadataEventStore.read(container: container, folder: "RecoveryEvents").isEmpty {
        throw NativeError("INBOX_RECOVERY_REQUIRED")
      }
      let recovered: Bool
      do { recovered = try recoverIncompleteTransactions(inbox: inbox, staging: staging, container: container) }
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

    AsyncFunction("getPendingShareEvents") { () -> [[String: Any]] in [] }
    AsyncFunction("ackPendingShareEvent") { (_: String) -> Bool in true }
    AsyncFunction("getPendingRecoveryEvent") { () throws -> [String: Any]? in
      guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier) else {
        throw NativeError("APP_GROUP_UNAVAILABLE")
      }
      return try MetadataEventStore.read(container: container, folder: "RecoveryEvents").first
    }
    AsyncFunction("ackRecoveryEvent") { (id: String) throws -> Bool in
      guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier) else {
        throw NativeError("APP_GROUP_UNAVAILABLE")
      }
      return try MetadataEventStore.ack(container: container, folder: "RecoveryEvents", id: id)
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

private func recoverIncompleteTransactions(inbox: URL, staging: URL, container: URL) throws -> Bool {
  var recovered = try recoverCandidates(root: staging, container: container) { _ in true }
  recovered = try recoverCandidates(root: inbox, container: container) { child in
    !FileManager.default.fileExists(atPath: child.appendingPathComponent("manifest.json").path)
  } || recovered
  return recovered
}

private func recoverCandidates(
  root: URL,
  container: URL,
  isIncomplete: (URL) -> Bool
) throws -> Bool {
  var isDirectory: ObjCBool = false
  guard FileManager.default.fileExists(atPath: root.path, isDirectory: &isDirectory) else { return false }
  guard isDirectory.boolValue else { throw NativeError("INBOX_SCAN_FAILED") }
  let children = try FileManager.default.contentsOfDirectory(
    at: root,
    includingPropertiesForKeys: [.isDirectoryKey],
    options: [.skipsHiddenFiles]
  )
  var recovered = false
  for child in children {
    let values = try child.resourceValues(forKeys: [.isDirectoryKey])
    guard values.isDirectory == true,
          isIncomplete(child),
          let lock = try TransactionRecoveryLock.acquire(directory: child) else { continue }
    defer { lock.release() }
    try MetadataEventStore.persistRecovery(container: container)
    try FileManager.default.removeItem(at: child)
    recovered = true
  }
  return recovered
}

private final class TransactionRecoveryLock {
  private var descriptor: Int32
  private init(descriptor: Int32) { self.descriptor = descriptor }

  static func acquire(directory: URL) throws -> TransactionRecoveryLock? {
    let lockURL = directory.appendingPathComponent(".writer.lock")
    guard FileManager.default.fileExists(atPath: lockURL.path) else {
      return TransactionRecoveryLock(descriptor: -1)
    }
    let descriptor = Darwin.open(lockURL.path, O_RDWR)
    guard descriptor >= 0 else { throw NativeError("INBOX_SCAN_FAILED") }
    guard Darwin.lockf(descriptor, F_TLOCK, 0) == 0 else {
      let lockError = errno
      Darwin.close(descriptor)
      if lockError == EWOULDBLOCK || lockError == EAGAIN { return nil }
      throw NativeError("INBOX_SCAN_FAILED")
    }
    return TransactionRecoveryLock(descriptor: descriptor)
  }

  func release() {
    guard descriptor >= 0 else { return }
    Darwin.lockf(descriptor, F_ULOCK, 0)
    Darwin.close(descriptor)
    descriptor = -1
  }

  deinit { release() }
}

private enum MetadataEventStore {
  static func persistRecovery(container: URL) throws {
    let id = UUID().uuidString.lowercased()
    let event: [String: Any] = [
      "schemaVersion": 1,
      "id": id,
      "code": "INBOX_RECOVERY_REQUIRED",
      "createdAtMs": Int64(Date().timeIntervalSince1970 * 1_000)
    ]
    let directory = container.appendingPathComponent("RecoveryEvents", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let data = try JSONSerialization.data(withJSONObject: event, options: [.sortedKeys])
    try data.write(to: directory.appendingPathComponent("\(id).json"), options: [.atomic])
  }

  static func read(container: URL, folder: String) throws -> [[String: Any]] {
    let directory = container.appendingPathComponent(folder, isDirectory: true)
    guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
    return try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
      .filter { $0.pathExtension == "json" }
      .compactMap { url in
        let data = try Data(contentsOf: url)
        return try JSONSerialization.jsonObject(with: data) as? [String: Any]
      }
      .sorted { ($0["createdAtMs"] as? NSNumber)?.int64Value ?? 0 < ($1["createdAtMs"] as? NSNumber)?.int64Value ?? 0 }
  }

  static func ack(container: URL, folder: String, id: String) throws -> Bool {
    guard UUID(uuidString: id) != nil else { throw NativeError("METADATA_EVENT_ID_INVALID") }
    let url = container.appendingPathComponent(folder, isDirectory: true).appendingPathComponent("\(id.lowercased()).json")
    guard FileManager.default.fileExists(atPath: url.path) else { return true }
    try FileManager.default.removeItem(at: url)
    return true
  }
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
