import CryptoKit
import Darwin
import Foundation
import UniformTypeIdentifiers

enum ShareRepresentationKind: Equatable {
  case file
  case fileURL
  case text
  case webURL
}

struct ShareRepresentation: Equatable {
  let identifier: String
  let mediaType: String
  let kind: ShareRepresentationKind
}

enum ShareRepresentationSelector {
  static func select(_ registeredTypeIdentifiers: [String]) -> ShareRepresentation? {
    let types = registeredTypeIdentifiers.compactMap { identifier -> (String, UTType)? in
      UTType(identifier).map { (identifier, $0) }
    }
    // File-backed text providers commonly advertise both public.file-url and
    // public.plain-text. Prefer the actual text representation so a temporary
    // provider file URL is never persisted as if it were a web URL.
    let candidates: [(UTType, ShareRepresentationKind, String)] = [
      (.image, .file, "image/*"),
      (.pdf, .file, "application/pdf"),
      (.plainText, .text, "text/plain"),
      (.fileURL, .fileURL, "application/octet-stream"),
      (.url, .webURL, "text/uri-list"),
      (.data, .file, "application/octet-stream"),
    ]
    for candidate in candidates {
      if let match = types.first(where: { $0.1.conforms(to: candidate.0) }) {
        return ShareRepresentation(
          identifier: match.0,
          mediaType: boundedMediaType(match.1.preferredMIMEType, fallback: candidate.2),
          kind: candidate.1
        )
      }
    }
    return nil
  }

  private static func boundedMediaType(_ value: String?, fallback: String) -> String {
    guard let value, value.utf8.count <= ShareIngestionSession.maximumMediaTypeLength else {
      return fallback
    }
    return value
  }
}

enum ShareProviderLoadError: Error, Equatable {
  case permissionExpired

  var stableCode: String { "IMPORT_PROVIDER_PERMISSION_EXPIRED" }
}

/** Requests only file-backed provider representations so extension memory stays bounded. */
enum ShareProviderFileLoader {
  static func load(
    provider: NSItemProvider,
    representation: ShareRepresentation,
    completion: @escaping (Result<URL, ShareProviderLoadError>) -> Void
  ) {
    if representation.kind == .fileURL {
      provider.loadObject(ofClass: NSURL.self) { value, _ in
        guard let source = value as? URL, source.isFileURL else {
          completion(.failure(.permissionExpired))
          return
        }
        completion(.success(source))
      }
      return
    }
    provider.loadFileRepresentation(forTypeIdentifier: representation.identifier) { source, _ in
      guard let source else {
        completion(.failure(.permissionExpired))
        return
      }
      completion(.success(source))
    }
  }
}

struct ShareIngestionSummary {
  let ingestionId: String
  let status: String
  let copied: Int
  let rejected: Int
  let failed: Int
  let replayed: Bool
  let manifest: [String: Any]
}

enum ShareIngestionFatalError: Error, Equatable {
  case invalidInput
  case recoveryRequired
  case storageWriteFailed
  case interrupted
}

/**
 Streams provider representations into App Group staging and publishes one ImportManifestV1.
 Provider paths and display filenames never cross the durable boundary.
 */
final class ShareIngestionSession {
  static let maximumItemCount = 20
  static let maximumReportedItemCount = InboxManifestValidator.maximumItemCount
  static let maximumBinaryBytes = 52_428_800
  static let maximumTextBytes = 1_048_576
  static let maximumMediaTypeLength = 127

  enum Point {
    case beforeSharedDirectoryCreate
    case beforeSharedDirectoryParentSync
    case afterLockedReplayManifestCheck
    case afterFirstChunk
    case beforeItemPublish
    case beforeManifestPublish
    case beforeDirectoryPublish
    case afterDirectoryPublish
  }

  private let container: URL
  private let ingestionId: String
  private let staging: URL
  private let published: URL
  private let now: () -> Date
  private let operationHook: (Point) throws -> Void
  private var ownership: InboxWriterOwnership?
  private var items: [[String: Any]] = []
  private var replayedSummary: ShareIngestionSummary?
  private var committed = false

  init(
    container: URL,
    ingestionId: String,
    now: @escaping () -> Date = Date.init,
    operationHook: @escaping (Point) throws -> Void = { _ in }
  ) throws {
    guard Self.canonicalUUID(ingestionId) else {
      throw ShareIngestionFatalError.invalidInput
    }
    self.container = container
    self.ingestionId = ingestionId
    self.staging = container.appendingPathComponent("InboxStaging/\(ingestionId)", isDirectory: true)
    self.published = container.appendingPathComponent("Inbox/\(ingestionId)", isDirectory: true)
    self.now = now
    self.operationHook = operationHook
    let manifest = published.appendingPathComponent("manifest.json")
    ownership = try Self.acquireOwnership(container: container, ingestionId: ingestionId)
    if FileManager.default.fileExists(atPath: manifest.path) {
      defer {
        ownership?.release()
        ownership = nil
      }
      // Replay detection and validation must remain inside per-ingestion ownership.
      // Otherwise handoff/ACK can remove the directory between the check and read.
      try operationHook(.afterLockedReplayManifestCheck)
      let validated = try InboxManifestValidator.readPublished(
        inbox: container.appendingPathComponent("Inbox", isDirectory: true),
        ingestionId: ingestionId
      )
      replayedSummary = try Self.summary(validated, ingestionId: ingestionId, replayed: true)
      return
    }
    guard !FileManager.default.fileExists(atPath: published.path),
          !FileManager.default.fileExists(atPath: staging.path) else {
      ownership?.release()
      ownership = nil
      throw ShareIngestionFatalError.recoveryRequired
    }
    do {
      let stagingRoot = staging.deletingLastPathComponent()
      try Self.ensureDurableDirectory(
        stagingRoot,
        beforeCreate: { try operationHook(.beforeSharedDirectoryCreate) },
        beforeParentSync: { try operationHook(.beforeSharedDirectoryParentSync) }
      )
      try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: false)
      try Self.synchronizeDirectory(stagingRoot)
    } catch {
      ownership?.release()
      ownership = nil
      throw ShareIngestionFatalError.storageWriteFailed
    }
  }

  deinit {
    if !committed && replayedSummary == nil && ownership != nil {
      try? FileManager.default.removeItem(at: staging)
    }
    ownership?.release()
  }

  private static func acquireOwnership(
    container: URL,
    ingestionId: String
  ) throws -> InboxWriterOwnership {
    let deadline = Date().addingTimeInterval(5)
    while true {
      do {
        return try InboxWriterOwnership.acquire(
          container: container,
          ingestionId: ingestionId
        )
      } catch InboxWriterOwnershipError.ownershipUnavailable {
        guard Date() < deadline else {
          throw InboxWriterOwnershipError.ownershipUnavailable
        }
        Thread.sleep(forTimeInterval: 0.01)
      }
    }
  }

  func recordFile(
    id: String,
    order: Int,
    declaredMediaType: String?,
    source: URL
  ) throws {
    try requireNext(id: id, order: order)
    guard replayedSummary == nil else { return }
    let accessed = source.startAccessingSecurityScopedResource()
    defer { if accessed { source.stopAccessingSecurityScopedResource() } }
    do {
      guard let input = InputStream(url: source) else {
        throw ShareInputFailure("IMPORT_COPY_FAILED")
      }
      let bufferSize = 64 * 1024
      var buffer = [UInt8](repeating: 0, count: bufferSize)
      input.open()
      defer { input.close() }
      try copyAndRecord(
        id: id,
        order: order,
        declaredMediaType: declaredMediaType,
        read: {
          let count = input.read(&buffer, maxLength: bufferSize)
          if count < 0 {
            throw input.streamError ?? ShareInputFailure("IMPORT_COPY_FAILED")
          }
          guard count > 0 else { return Data() }
          return Data(bytes: buffer, count: count)
        }
      )
    } catch let error as ShareIngestionFatalError {
      throw error
    } catch let failure as ShareInputFailure {
      appendFailure(
        id: id,
        order: order,
        mediaType: failure.detectedMediaType ?? declaredMediaType,
        code: failure.code
      )
    } catch {
      appendFailure(id: id, order: order, mediaType: declaredMediaType, code: "IMPORT_COPY_FAILED")
    }
  }

  func recordData(
    id: String,
    order: Int,
    declaredMediaType: String?,
    data: Data
  ) throws {
    try requireNext(id: id, order: order)
    guard replayedSummary == nil else { return }
    var offset = 0
    do {
      try copyAndRecord(
        id: id,
        order: order,
        declaredMediaType: declaredMediaType,
        read: {
          guard offset < data.count else { return Data() }
          let end = min(offset + 64 * 1024, data.count)
          defer { offset = end }
          return data.subdata(in: offset..<end)
        }
      )
    } catch let error as ShareIngestionFatalError {
      throw error
    } catch let failure as ShareInputFailure {
      appendFailure(
        id: id,
        order: order,
        mediaType: failure.detectedMediaType ?? declaredMediaType,
        code: failure.code
      )
    } catch {
      appendFailure(id: id, order: order, mediaType: declaredMediaType, code: "IMPORT_COPY_FAILED")
    }
  }

  func recordFailure(
    id: String,
    order: Int,
    declaredMediaType: String?,
    code: String
  ) throws {
    try requireNext(id: id, order: order)
    guard Self.failedItemCodes.contains(code) else {
      throw ShareIngestionFatalError.invalidInput
    }
    guard replayedSummary == nil else { return }
    appendFailure(id: id, order: order, mediaType: declaredMediaType, code: code)
  }

  func finish() throws -> ShareIngestionSummary {
    if let replayedSummary { return replayedSummary }
    guard !items.isEmpty else { throw ShareIngestionFatalError.invalidInput }
    let copied = items.filter { $0["status"] as? String == "copied" }.count
    let status = copied == items.count ? "complete" : (copied > 0 ? "partial" : "failed")
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let manifest: [String: Any] = [
      "schemaVersion": 1,
      "ingestionId": ingestionId,
      "createdAt": formatter.string(from: now()),
      "source": "ios-share-extension",
      "status": status,
      "items": items,
    ]
    do {
      let data = try JSONSerialization.data(withJSONObject: manifest, options: [.sortedKeys])
      let partial = staging.appendingPathComponent("manifest.partial")
      let final = staging.appendingPathComponent("manifest.json")
      try Self.writeDurably(data, to: partial)
      try operationHook(.beforeManifestPublish)
      try Self.atomicRename(partial, final)
      try Self.synchronizeDirectory(staging)
      let inbox = published.deletingLastPathComponent()
      try Self.ensureDurableDirectory(
        inbox,
        beforeCreate: { try operationHook(.beforeSharedDirectoryCreate) },
        beforeParentSync: { try operationHook(.beforeSharedDirectoryParentSync) }
      )
      try operationHook(.beforeDirectoryPublish)
      try Self.atomicRename(staging, published)
      committed = true
      // Rename is the visibility commit point. Do not report a failed import after
      // a complete manifest has become visible merely because the follow-up parent
      // fsync (or its fault-injection hook) fails.
      try? operationHook(.afterDirectoryPublish)
      try? Self.synchronizeDirectory(inbox)
      let validated = try InboxManifestValidator.readPublished(
        inbox: inbox,
        ingestionId: ingestionId
      )
      ownership?.release()
      ownership = nil
      return try Self.summary(
        validated,
        ingestionId: ingestionId,
        replayed: false
      )
    } catch ShareIngestionFatalError.interrupted {
      throw ShareIngestionFatalError.interrupted
    } catch {
      throw ShareIngestionFatalError.storageWriteFailed
    }
  }

  private func copyAndRecord(
    id: String,
    order: Int,
    declaredMediaType: String?,
    read: () throws -> Data
  ) throws {
    let partial = staging.appendingPathComponent("\(id).partial")
    let destination = staging.appendingPathComponent("\(id).bin")
    guard FileManager.default.createFile(atPath: partial.path, contents: nil) else {
      throw ShareInputFailure("IMPORT_COPY_FAILED")
    }
    defer { try? FileManager.default.removeItem(at: partial) }
    let output = try FileHandle(forWritingTo: partial)
    defer { try? output.close() }
    var hasher = SHA256()
    var byteCount = 0
    var firstChunk = true
    while true {
      let chunk = try autoreleasepool { try read() }
      if chunk.isEmpty { break }
      byteCount += chunk.count
      guard byteCount <= Self.maximumBinaryBytes else {
        throw ShareInputFailure("IMPORT_SIZE_LIMIT_EXCEEDED")
      }
      try output.write(contentsOf: chunk)
      hasher.update(data: chunk)
      if firstChunk {
        firstChunk = false
        try operationHook(.afterFirstChunk)
      }
    }
    try output.synchronize()
    let detectedMediaType = try Self.detectMediaType(partial)
    guard Self.declaredTypeAllows(declaredMediaType, detected: detectedMediaType) else {
      throw ShareInputFailure("IMPORT_TYPE_UNSUPPORTED", detectedMediaType: detectedMediaType)
    }
    try operationHook(.beforeItemPublish)
    try Self.atomicRename(partial, destination)
    try Self.synchronizeDirectory(staging)
    items.append([
      "id": id,
      "order": order,
      "mediaType": detectedMediaType,
      "status": "copied",
      "byteCount": byteCount,
      "relativePath": destination.lastPathComponent,
      "sha256": hasher.finalize().map { String(format: "%02x", $0) }.joined(),
    ])
  }

  private func requireNext(id: String, order: Int) throws {
    guard replayedSummary != nil || (
      Self.canonicalUUID(id) && order == items.count && order < Self.maximumReportedItemCount
    ) else {
      throw ShareIngestionFatalError.invalidInput
    }
  }

  private func appendFailure(
    id: String,
    order: Int,
    mediaType: String?,
    code: String
  ) {
    items.append([
      "id": id,
      "order": order,
      "mediaType": Self.concreteOrFallbackMediaType(mediaType),
      "status": "failed",
      "byteCount": 0,
      "errorCode": code,
    ])
  }

  private static func summary(
    _ manifest: [String: Any],
    ingestionId: String,
    replayed: Bool
  ) throws -> ShareIngestionSummary {
    guard manifest["schemaVersion"] as? Int == 1,
          manifest["ingestionId"] as? String == ingestionId,
          let status = manifest["status"] as? String,
          let items = manifest["items"] as? [[String: Any]],
          !items.isEmpty else {
      throw ShareIngestionFatalError.invalidInput
    }
    let copied = items.filter { $0["status"] as? String == "copied" }.count
    let codes = items.compactMap { item -> String? in
      item["status"] as? String == "failed" ? item["errorCode"] as? String : nil
    }
    return ShareIngestionSummary(
      ingestionId: ingestionId,
      status: status,
      copied: copied,
      rejected: codes.filter {
        $0 == "IMPORT_TYPE_UNSUPPORTED" || $0 == "IMPORT_SIZE_LIMIT_EXCEEDED"
      }.count,
      failed: codes.filter {
        $0 != "IMPORT_TYPE_UNSUPPORTED" && $0 != "IMPORT_SIZE_LIMIT_EXCEEDED"
      }.count,
      replayed: replayed,
      manifest: manifest
    )
  }

  private static func detectMediaType(_ file: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: file)
    let prefix = try handle.read(upToCount: 4_096) ?? Data()
    try handle.close()
    let bytes = [UInt8](prefix)
    if starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) { return "image/png" }
    if starts(bytes, [0xff, 0xd8, 0xff]) { return "image/jpeg" }
    if ascii(bytes, 0, min(6, bytes.count)) == "GIF87a" || ascii(bytes, 0, min(6, bytes.count)) == "GIF89a" { return "image/gif" }
    if starts(bytes, [0x42, 0x4d]) { return "image/bmp" }
    if starts(bytes, [0x49, 0x49, 0x2a, 0x00]) || starts(bytes, [0x4d, 0x4d, 0x00, 0x2a]) { return "image/tiff" }
    if bytes.count >= 12 && ascii(bytes, 0, 4) == "RIFF" && ascii(bytes, 8, 12) == "WEBP" { return "image/webp" }
    if bytes.count >= 12 && ascii(bytes, 4, 8) == "ftyp" {
      switch ascii(bytes, 8, 12) {
      case "heic", "heix", "hevc", "hevx", "mif1", "msf1": return "image/heic"
      case "avif", "avis": return "image/avif"
      default: break
      }
    }
    let pdf = [UInt8]("%PDF-".utf8)
    if index(of: pdf, in: bytes, maximumStart: 1_024) != nil { return "application/pdf" }
    let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
    guard size <= maximumTextBytes else {
      throw ShareInputFailure("IMPORT_SIZE_LIMIT_EXCEEDED")
    }
    let data = try Data(contentsOf: file)
    guard let text = String(data: data, encoding: .utf8),
          !text.unicodeScalars.contains(where: disallowedTextControl) else {
      throw ShareInputFailure("IMPORT_TYPE_UNSUPPORTED")
    }
    return validWebURL(text.trimmingCharacters(in: .whitespacesAndNewlines))
      ? "text/uri-list" : "text/plain"
  }

  private static func declaredTypeAllows(_ declared: String?, detected: String) -> Bool {
    guard let normalized = declared?.split(separator: ";", maxSplits: 1).first?
      .trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
      !normalized.isEmpty else { return true }
    if normalized == "*/*" ||
      normalized.utf8.count > maximumMediaTypeLength ||
      normalized.range(
        of: "^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$",
        options: .regularExpression
      ) == nil ||
      normalized == "application/octet-stream" ||
      normalized == detected {
      return true
    }
    if normalized == "image/*" && detected.hasPrefix("image/") { return true }
    if normalized == "text/*" && detected.hasPrefix("text/") { return true }
    return normalized == "text/plain" && detected == "text/uri-list"
  }

  private static func concreteOrFallbackMediaType(_ value: String?) -> String {
    guard let normalized = value?.split(separator: ";", maxSplits: 1).first?
      .trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
      normalized.utf8.count <= maximumMediaTypeLength,
      normalized.range(
        of: "^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$",
        options: .regularExpression
      ) != nil else { return "application/octet-stream" }
    return normalized
  }

  private static func validWebURL(_ value: String) -> Bool {
    guard let components = URLComponents(string: value),
          let scheme = components.scheme?.lowercased(),
          scheme == "http" || scheme == "https",
          components.host?.isEmpty == false else { return false }
    return true
  }

  private static func disallowedTextControl(_ value: Unicode.Scalar) -> Bool {
    (value.value < 0x20 && value.value != 0x09 && value.value != 0x0a && value.value != 0x0d)
      || value.value == 0x7f
  }

  private static func writeDurably(_ data: Data, to destination: URL) throws {
    guard FileManager.default.createFile(atPath: destination.path, contents: nil) else {
      throw ShareIngestionFatalError.storageWriteFailed
    }
    let output = try FileHandle(forWritingTo: destination)
    defer { try? output.close() }
    try output.write(contentsOf: data)
    try output.synchronize()
  }

  private static func atomicRename(_ source: URL, _ destination: URL) throws {
    guard Darwin.rename(source.path, destination.path) == 0 else {
      throw ShareIngestionFatalError.storageWriteFailed
    }
  }

  private static func synchronizeDirectory(_ directory: URL) throws {
    let descriptor = Darwin.open(directory.path, O_RDONLY)
    guard descriptor >= 0 else { throw ShareIngestionFatalError.storageWriteFailed }
    defer { Darwin.close(descriptor) }
    guard Darwin.fsync(descriptor) == 0 else {
      throw ShareIngestionFatalError.storageWriteFailed
    }
  }

  private static func ensureDurableDirectory(
    _ directory: URL,
    beforeCreate: () throws -> Void = {},
    beforeParentSync: () throws -> Void = {}
  ) throws {
    var isDirectory: ObjCBool = false
    if FileManager.default.fileExists(atPath: directory.path, isDirectory: &isDirectory) {
      try requireSafeDirectory(directory, isDirectory: isDirectory)
    } else {
      try beforeCreate()
      do {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
      } catch {
        // Different ingestion IDs do not share an ownership lock. A concurrent first
        // import may therefore create this shared directory after our existence check.
        var racedIsDirectory: ObjCBool = false
        guard FileManager.default.fileExists(
          atPath: directory.path,
          isDirectory: &racedIsDirectory
        ) else {
          throw ShareIngestionFatalError.storageWriteFailed
        }
        try requireSafeDirectory(directory, isDirectory: racedIsDirectory)
      }
    }
    try beforeParentSync()
    try synchronizeDirectory(directory.deletingLastPathComponent())
  }

  private static func requireSafeDirectory(
    _ directory: URL,
    isDirectory: ObjCBool
  ) throws {
    let values = try directory.resourceValues(forKeys: [.isSymbolicLinkKey])
    guard isDirectory.boolValue, values.isSymbolicLink != true else {
      throw ShareIngestionFatalError.storageWriteFailed
    }
  }

  private static func canonicalUUID(_ value: String) -> Bool {
    guard let uuid = UUID(uuidString: value) else { return false }
    return uuid.uuidString.lowercased() == value
  }

  private static func starts(_ bytes: [UInt8], _ expected: [UInt8]) -> Bool {
    bytes.count >= expected.count && Array(bytes.prefix(expected.count)) == expected
  }

  private static func ascii(_ bytes: [UInt8], _ start: Int, _ end: Int) -> String {
    guard start <= end, end <= bytes.count else { return "" }
    return String(bytes: bytes[start..<end], encoding: .ascii) ?? ""
  }

  private static func index(
    of needle: [UInt8],
    in bytes: [UInt8],
    maximumStart: Int
  ) -> Int? {
    let last = min(bytes.count - needle.count, maximumStart)
    guard last >= 0 else { return nil }
    for start in 0...last where Array(bytes[start..<(start + needle.count)]) == needle {
      return start
    }
    return nil
  }

  private static let failedItemCodes: Set<String> = [
    "IMPORT_PROVIDER_PERMISSION_EXPIRED",
    "IMPORT_TYPE_UNSUPPORTED",
    "IMPORT_COPY_FAILED",
    "IMPORT_SIZE_LIMIT_EXCEEDED",
  ]
}

private struct ShareInputFailure: Error {
  let code: String
  let detectedMediaType: String?

  init(_ code: String, detectedMediaType: String? = nil) {
    self.code = code
    self.detectedMediaType = detectedMediaType
  }
}
