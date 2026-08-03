import CryptoKit
import Darwin
import Foundation

enum InboxArtifactHandoffError: Error, Equatable {
  case invalidIdentifier
  case manifestMissing
  case lowDisk
  case integrityFailed
  case writeFailed
  case acknowledgementBlocked

  var stableCode: String {
    switch self {
    case .invalidIdentifier, .manifestMissing: "SCHEMA_INVALID"
    case .lowDisk: "RESOURCE_LOW_DISK"
    case .integrityFailed: "ARTIFACT_INTEGRITY_FAILED"
    case .writeFailed: "STORAGE_WRITE_FAILED"
    case .acknowledgementBlocked: "PIPELINE_RECOVERY_REQUIRED"
    }
  }
}

enum InboxArtifactHandoffPoint {
  case beforeCopy
  case duringCopy
  case afterFileClose
  case beforePublishRename
}

enum InboxArtifactHandoff {
  static func handoff(
    container: URL,
    applicationSupport: URL,
    ingestionId: String,
    packId: String,
    requiredHeadroomBytes: Int64,
    availableBytes: (URL) throws -> Int64 = availableCapacity,
    operationHook: (InboxArtifactHandoffPoint) throws -> Void = { _ in }
  ) throws -> [String: Any] {
    try requireCanonicalUUID(ingestionId)
    try requireCanonicalUUID(packId)
    guard requiredHeadroomBytes >= 0 else { throw InboxArtifactHandoffError.lowDisk }
    let inbox = container.appendingPathComponent("Inbox", isDirectory: true)
    let sourceDirectory = inbox.appendingPathComponent(ingestionId, isDirectory: true)
    let manifestURL = sourceDirectory.appendingPathComponent("manifest.json")
    let originalManifestData: Data
    do { originalManifestData = try Data(contentsOf: manifestURL, options: [.mappedIfSafe]) }
    catch { throw InboxArtifactHandoffError.manifestMissing }
    let fingerprint = SHA256.hash(data: originalManifestData)
      .map { String(format: "%02x", $0) }.joined()
    let manifests: [[String: Any]]
    do { manifests = try InboxManifestValidator.read(inbox: inbox) }
    catch let error as InboxManifestValidationError {
      if error == .artifactIntegrityFailed { throw InboxArtifactHandoffError.integrityFailed }
      throw error
    }
    guard let manifest = manifests.first(where: { $0["ingestionId"] as? String == ingestionId }),
          let items = manifest["items"] as? [[String: Any]] else {
      throw InboxArtifactHandoffError.manifestMissing
    }
    var requiredFreeBytes = requiredHeadroomBytes
    for item in items where item["status"] as? String == "copied" {
      guard let byteCount = (item["byteCount"] as? NSNumber)?.int64Value,
            byteCount >= 0,
            requiredFreeBytes <= Int64.max - byteCount else {
        throw InboxArtifactHandoffError.integrityFailed
      }
      requiredFreeBytes += byteCount
    }
    if try availableBytes(applicationSupport) < requiredFreeBytes {
      throw InboxArtifactHandoffError.lowDisk
    }
    let destinationDirectory = applicationSupport
      .appendingPathComponent("Packs", isDirectory: true)
      .appendingPathComponent(packId, isDirectory: true)
      .appendingPathComponent("originals", isDirectory: true)
    do {
      try FileManager.default.createDirectory(
        at: destinationDirectory,
        withIntermediateDirectories: true
      )
    } catch {
      throw InboxArtifactHandoffError.writeFailed
    }

    let artifacts: [[String: Any]] = try items.compactMap { item -> [String: Any]? in
      guard item["status"] as? String == "copied" else { return nil }
      guard let itemId = item["id"] as? String,
            let mediaType = item["mediaType"] as? String,
            let sourceName = item["relativePath"] as? String,
            let byteCount = (item["byteCount"] as? NSNumber)?.int64Value else {
        throw InboxArtifactHandoffError.integrityFailed
      }
      try requireCanonicalUUID(itemId)
      guard sourceName == "\(itemId).bin", byteCount >= 0 else {
        throw InboxArtifactHandoffError.integrityFailed
      }
      let sha256 = item["sha256"] as? String
      let source = sourceDirectory.appendingPathComponent(sourceName)
      let destination = destinationDirectory.appendingPathComponent("\(itemId).bin")
      let partial = destinationDirectory.appendingPathComponent("\(itemId).bin.partial")
      let actualHash = try publish(
        source: source,
        partial: partial,
        destination: destination,
        byteCount: byteCount,
        sha256: sha256,
        operationHook: operationHook
      )
      var result: [String: Any] = [
        "id": itemId,
        "itemId": itemId,
        "relativePath": "Packs/\(packId)/originals/\(itemId).bin",
        "mediaType": mediaType,
        "byteCount": byteCount,
      ]
      result["sha256"] = actualHash
      return result
    }
    let finalManifestData: Data
    do { finalManifestData = try Data(contentsOf: manifestURL, options: [.mappedIfSafe]) }
    catch { throw InboxArtifactHandoffError.integrityFailed }
    guard finalManifestData == originalManifestData else {
      throw InboxArtifactHandoffError.integrityFailed
    }
    return [
      "manifest": manifest,
      "manifestFingerprint": fingerprint,
      "artifacts": artifacts,
    ]
  }

  static func acknowledge(container: URL, ingestionId: String) throws -> Bool {
    try requireCanonicalUUID(ingestionId)
    let directory = container.appendingPathComponent("Inbox/\(ingestionId)", isDirectory: true)
    return try InboxWriterRegistry.withLock(container: container) { locks in
      if InboxWriterRegistry.isLocallyOwned(ingestionId) {
        throw InboxArtifactHandoffError.acknowledgementBlocked
      }
      let lock = locks.appendingPathComponent("\(ingestionId).lock")
      if FileManager.default.fileExists(atPath: lock.path) {
        throw InboxArtifactHandoffError.acknowledgementBlocked
      }
      guard FileManager.default.fileExists(atPath: directory.path) else { return true }
      do {
        try FileManager.default.removeItem(at: directory)
        return true
      } catch {
        throw InboxArtifactHandoffError.writeFailed
      }
    }
  }

  private static func publish(
    source: URL,
    partial: URL,
    destination: URL,
    byteCount: Int64,
    sha256: String?,
    operationHook: (InboxArtifactHandoffPoint) throws -> Void
  ) throws -> String {
    if FileManager.default.fileExists(atPath: destination.path) {
      let sourceHash = try verify(url: source, byteCount: byteCount, sha256: sha256)
      return try verify(url: destination, byteCount: byteCount, sha256: sourceHash)
    }
    if FileManager.default.fileExists(atPath: partial.path) {
      do { try FileManager.default.removeItem(at: partial) }
      catch { throw InboxArtifactHandoffError.writeFailed }
    }
    try operationHook(.beforeCopy)
    guard FileManager.default.createFile(atPath: partial.path, contents: nil) else {
      throw InboxArtifactHandoffError.writeFailed
    }
    do {
      let input = try FileHandle(forReadingFrom: source)
      let output = try FileHandle(forWritingTo: partial)
      var firstChunk = true
      do {
        while let data = try input.read(upToCount: 64 * 1024), !data.isEmpty {
          try output.write(contentsOf: data)
          if firstChunk {
            firstChunk = false
            try operationHook(.duringCopy)
          }
        }
        try output.synchronize()
        try input.close()
        try output.close()
      } catch {
        try? input.close()
        try? output.close()
        throw error
      }
      try operationHook(.afterFileClose)
      let actualHash = try verify(url: partial, byteCount: byteCount, sha256: sha256)
      try operationHook(.beforePublishRename)
      try FileManager.default.moveItem(at: partial, to: destination)
      try synchronizeDirectory(destination.deletingLastPathComponent())
      return actualHash
    } catch let error as InboxArtifactHandoffError {
      throw error
    } catch {
      throw InboxArtifactHandoffError.writeFailed
    }
  }

  private static func verify(url: URL, byteCount: Int64, sha256 expected: String?) throws -> String {
    let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
    guard values?.isRegularFile == true, Int64(values?.fileSize ?? -1) == byteCount else {
      throw InboxArtifactHandoffError.integrityFailed
    }
    let input: FileHandle
    do { input = try FileHandle(forReadingFrom: url) }
    catch { throw InboxArtifactHandoffError.integrityFailed }
    var digest = SHA256()
    do {
      while let data = try input.read(upToCount: 64 * 1024), !data.isEmpty {
        digest.update(data: data)
      }
      try input.close()
    } catch {
      try? input.close()
      throw InboxArtifactHandoffError.integrityFailed
    }
    let actual = digest.finalize().map { String(format: "%02x", $0) }.joined()
    if let expected, actual != expected {
      throw InboxArtifactHandoffError.integrityFailed
    }
    return actual
  }

  private static func synchronizeDirectory(_ directory: URL) throws {
    let descriptor = Darwin.open(directory.path, O_RDONLY)
    guard descriptor >= 0 else { throw InboxArtifactHandoffError.writeFailed }
    defer { Darwin.close(descriptor) }
    guard Darwin.fsync(descriptor) == 0 else { throw InboxArtifactHandoffError.writeFailed }
  }

  private static func availableCapacity(_ url: URL) throws -> Int64 {
    let values = try url.resourceValues(forKeys: [
      .volumeAvailableCapacityForImportantUsageKey,
      .volumeAvailableCapacityKey,
    ])
    if let importantCapacity = values.volumeAvailableCapacityForImportantUsage {
      return importantCapacity
    }
    return Int64(values.volumeAvailableCapacity ?? 0)
  }

  private static func requireCanonicalUUID(_ value: String) throws {
    guard let identifier = UUID(uuidString: value),
          identifier.uuidString.lowercased() == value else {
      throw InboxArtifactHandoffError.invalidIdentifier
    }
  }
}
