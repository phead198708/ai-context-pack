import Darwin
import Foundation

enum InboxAcknowledgementStoreError: Error, Equatable {
  case invalidIdentifier
  case integrityFailed
  case writeFailed
  case recoveryRequired

  var stableCode: String {
    switch self {
    case .invalidIdentifier: "SCHEMA_INVALID"
    case .integrityFailed: "ARTIFACT_INTEGRITY_FAILED"
    case .writeFailed: "STORAGE_WRITE_FAILED"
    case .recoveryRequired: "PIPELINE_RECOVERY_REQUIRED"
    }
  }
}

/**
 Durable, metadata-only evidence that an ingestion ID was already handed off and ACKed.

 The receipt is published before the scanner-visible Inbox directory is removed. It preserves
 the already-validated manifest, but never provider URLs, display filenames, or artifact bytes.
 */
enum InboxAcknowledgementStore {
  private static let directoryName = "InboxAcknowledgements"
  private static let tombstoneDirectoryName = "InboxAckTombstones"
  private static let maximumReceiptBytes = 262_144

  static func read(
    container: URL,
    ingestionId: String
  ) throws -> [String: Any]? {
    guard canonicalUUID(ingestionId) else {
      throw InboxAcknowledgementStoreError.invalidIdentifier
    }
    let root = container.appendingPathComponent(directoryName, isDirectory: true)
    guard FileManager.default.fileExists(atPath: root.path) else { return nil }
    try requireSafeDirectory(root, expectedParent: container)
    let receipt = root.appendingPathComponent("\(ingestionId).json")
    guard FileManager.default.fileExists(atPath: receipt.path) else { return nil }
    try requireReceiptPath(receipt, root: root)
    do {
      return try InboxManifestValidator.readAcknowledgementReceipt(
        receipt,
        ingestionId: ingestionId
      )
    } catch let error as InboxManifestValidationError {
      if error == .unsupportedVersion { throw error }
      throw InboxAcknowledgementStoreError.integrityFailed
    } catch {
      throw InboxAcknowledgementStoreError.integrityFailed
    }
  }

  static func publish(
    container: URL,
    ingestionId: String,
    manifestData: Data,
    directorySynchronizer: (URL) throws -> Void
  ) throws -> [String: Any] {
    guard canonicalUUID(ingestionId) else {
      throw InboxAcknowledgementStoreError.invalidIdentifier
    }
    guard !manifestData.isEmpty, manifestData.count <= maximumReceiptBytes else {
      throw InboxAcknowledgementStoreError.integrityFailed
    }
    let root = container.appendingPathComponent(directoryName, isDirectory: true)
    try ensureDurableDirectory(
      root,
      expectedParent: container,
      directorySynchronizer: directorySynchronizer
    )
    let receipt = root.appendingPathComponent("\(ingestionId).json")
    if FileManager.default.fileExists(atPath: receipt.path) {
      try requireReceiptPath(receipt, root: root)
      let existing: Data
      do { existing = try Data(contentsOf: receipt, options: [.mappedIfSafe]) }
      catch { throw InboxAcknowledgementStoreError.integrityFailed }
      guard existing == manifestData else {
        throw InboxAcknowledgementStoreError.integrityFailed
      }
      guard let manifest = try read(container: container, ingestionId: ingestionId) else {
        throw InboxAcknowledgementStoreError.integrityFailed
      }
      return manifest
    }

    let partial = root.appendingPathComponent(
      ".\(ingestionId)-\(UUID().uuidString.lowercased()).partial"
    )
    defer { try? FileManager.default.removeItem(at: partial) }
    do {
      guard FileManager.default.createFile(atPath: partial.path, contents: nil) else {
        throw InboxAcknowledgementStoreError.writeFailed
      }
      let output = try FileHandle(forWritingTo: partial)
      do {
        try output.write(contentsOf: manifestData)
        try output.synchronize()
        try output.close()
      } catch {
        try? output.close()
        throw error
      }
      guard Darwin.rename(partial.path, receipt.path) == 0 else {
        throw InboxAcknowledgementStoreError.writeFailed
      }
      try directorySynchronizer(root)
      guard let manifest = try read(container: container, ingestionId: ingestionId) else {
        throw InboxAcknowledgementStoreError.integrityFailed
      }
      return manifest
    } catch let error as InboxAcknowledgementStoreError {
      throw error
    } catch {
      throw InboxAcknowledgementStoreError.writeFailed
    }
  }

  static func matchingTombstones(
    container: URL,
    ingestionId: String
  ) throws -> [URL] {
    guard canonicalUUID(ingestionId) else {
      throw InboxAcknowledgementStoreError.invalidIdentifier
    }
    let root = container.appendingPathComponent(tombstoneDirectoryName, isDirectory: true)
    guard FileManager.default.fileExists(atPath: root.path) else { return [] }
    try requireSafeDirectory(root, expectedParent: container)
    do {
      return try FileManager.default.contentsOfDirectory(
        at: root,
        includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey]
      ).filter { tombstoneIngestionId($0, root: root) == ingestionId }
        .sorted { $0.lastPathComponent < $1.lastPathComponent }
    } catch let error as InboxAcknowledgementStoreError {
      throw error
    } catch {
      throw InboxAcknowledgementStoreError.writeFailed
    }
  }

  static func tombstoneIngestionId(_ candidate: URL, root: URL) -> String? {
    guard candidate.pathExtension == "ack",
          candidate.deletingLastPathComponent().standardizedFileURL == root.standardizedFileURL,
          let values = try? candidate.resourceValues(
            forKeys: [.isDirectoryKey, .isSymbolicLinkKey]
          ),
          values.isDirectory == true,
          values.isSymbolicLink != true else { return nil }
    let stem = candidate.deletingPathExtension().lastPathComponent
    guard stem.count == 73 else { return nil }
    let separator = stem.index(stem.startIndex, offsetBy: 36)
    guard stem[separator] == "-" else { return nil }
    let suffixStart = stem.index(after: separator)
    let ingestionId = String(stem[..<separator])
    return canonicalUUID(ingestionId) && canonicalUUID(String(stem[suffixStart...]))
      ? ingestionId
      : nil
  }

  private static func ensureDurableDirectory(
    _ root: URL,
    expectedParent: URL,
    directorySynchronizer: (URL) throws -> Void
  ) throws {
    if FileManager.default.fileExists(atPath: root.path) {
      try requireSafeDirectory(root, expectedParent: expectedParent)
    } else {
      do {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
      } catch {
        throw InboxAcknowledgementStoreError.writeFailed
      }
      try requireSafeDirectory(root, expectedParent: expectedParent)
    }
    do {
      try directorySynchronizer(root)
      try directorySynchronizer(expectedParent)
    } catch {
      throw InboxAcknowledgementStoreError.writeFailed
    }
  }

  private static func requireSafeDirectory(
    _ directory: URL,
    expectedParent: URL
  ) throws {
    guard directory.deletingLastPathComponent().standardizedFileURL
            == expectedParent.standardizedFileURL,
          let values = try? directory.resourceValues(
            forKeys: [.isDirectoryKey, .isSymbolicLinkKey]
          ),
          values.isDirectory == true,
          values.isSymbolicLink != true else {
      throw InboxAcknowledgementStoreError.writeFailed
    }
  }

  private static func requireReceiptPath(_ receipt: URL, root: URL) throws {
    guard receipt.deletingLastPathComponent().standardizedFileURL == root.standardizedFileURL,
          let values = try? receipt.resourceValues(
            forKeys: [.isRegularFileKey, .isSymbolicLinkKey]
          ),
          values.isRegularFile == true,
          values.isSymbolicLink != true else {
      throw InboxAcknowledgementStoreError.integrityFailed
    }
  }

  private static func canonicalUUID(_ value: String) -> Bool {
    guard let identifier = UUID(uuidString: value) else { return false }
    return identifier.uuidString.lowercased() == value
  }
}
