import CryptoKit
import Darwin
import Foundation

enum InboxArtifactHandoffError: Error, Equatable {
  case invalidIdentifier
  case unsupportedVersion
  case manifestMissing
  case lowDisk
  case integrityFailed
  case writeFailed
  case acknowledgementBlocked

  var stableCode: String {
    switch self {
    case .invalidIdentifier, .manifestMissing: "SCHEMA_INVALID"
    case .unsupportedVersion: "SCHEMA_VERSION_UNSUPPORTED"
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

enum InboxAcknowledgementPoint {
  case afterReceiptPublish
  case afterTombstoneRename
  case duringTombstoneDeletion
}

enum InboxTombstoneSweepPoint {
  case afterRemoval
}

struct InboxTombstoneSweepResult: Equatable {
  let scanned: Int
  let removed: Int
  let failed: Int
}

enum InboxArtifactHandoff {
  static func handoff(
    container: URL,
    applicationSupport: URL,
    ingestionId: String,
    packId: String,
    requiredHeadroomBytes: Int64,
    availableBytes: (URL) throws -> Int64 = availableCapacity,
    operationHook: (InboxArtifactHandoffPoint) throws -> Void = { _ in },
    directorySynchronizer: (URL) throws -> Void = synchronizeDirectory,
    snapshotHook: () throws -> Void = {}
  ) throws -> [String: Any] {
    try requireCanonicalUUID(ingestionId)
    try requireCanonicalUUID(packId)
    guard requiredHeadroomBytes >= 0 else { throw InboxArtifactHandoffError.lowDisk }
    let inbox = container.appendingPathComponent("Inbox", isDirectory: true)
    let sourceDirectory = inbox.appendingPathComponent(ingestionId, isDirectory: true)
    let manifestURL = sourceDirectory.appendingPathComponent("manifest.json")
    let snapshot: (Data, [String: Any])
    do {
      snapshot = try InboxWriterRegistry.withLock(container: container) { _ in
        try snapshotHook()
        let data = try Data(contentsOf: manifestURL, options: [.mappedIfSafe])
        let manifest = try InboxManifestValidator.readPublished(
          inbox: inbox,
          ingestionId: ingestionId
        )
        return (data, manifest)
      }
    } catch let error as InboxManifestValidationError {
      if error == .artifactIntegrityFailed { throw InboxArtifactHandoffError.integrityFailed }
      throw error
    } catch let error as InboxWriterOwnershipError {
      throw error
    } catch let error as InboxArtifactHandoffError {
      throw error
    } catch {
      throw InboxArtifactHandoffError.manifestMissing
    }
    let originalManifestData = snapshot.0
    let manifest = snapshot.1
    let fingerprint = SHA256.hash(data: originalManifestData)
      .map { String(format: "%02x", $0) }.joined()
    guard let items = manifest["items"] as? [[String: Any]] else {
      throw InboxArtifactHandoffError.manifestMissing
    }
    let destinationDirectory = applicationSupport
      .appendingPathComponent("Packs", isDirectory: true)
      .appendingPathComponent(packId, isDirectory: true)
      .appendingPathComponent("originals", isDirectory: true)
    func sourceDescriptor(
      _ item: [String: Any]
    ) throws -> (name: String, byteCount: Int64, sha256: String?)? {
      guard let itemId = item["id"] as? String else {
        throw InboxArtifactHandoffError.integrityFailed
      }
      try requireCanonicalUUID(itemId)
      if item["status"] as? String == "copied" {
        guard let name = item["relativePath"] as? String,
              name == "\(itemId).bin",
              let byteCount = (item["byteCount"] as? NSNumber)?.int64Value,
              byteCount >= 0 else {
          throw InboxArtifactHandoffError.integrityFailed
        }
        return (name, byteCount, item["sha256"] as? String)
      }
      guard item["status"] as? String == "failed" else {
        throw InboxArtifactHandoffError.integrityFailed
      }
      let name = "\(itemId).retry"
      let source = sourceDirectory.appendingPathComponent(name)
      let values = try? source.resourceValues(
        forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]
      )
      let retryByteCount = (item["retryByteCount"] as? NSNumber)?.int64Value
      let retrySha256 = item["retrySha256"] as? String
      if retryByteCount == nil && retrySha256 == nil && values == nil { return nil }
      guard values?.isRegularFile == true, values?.isSymbolicLink != true,
            let size = values?.fileSize,
            let retryByteCount,
            retryByteCount >= 0,
            retryByteCount <= Int64(ShareIngestionSession.maximumBinaryBytes),
            Int64(size) == retryByteCount,
            let retrySha256,
            retrySha256.range(
              of: "^[0-9a-f]{64}$",
              options: .regularExpression
            ) != nil else {
        throw InboxArtifactHandoffError.integrityFailed
      }
      return (name, retryByteCount, retrySha256)
    }
    var requiredFreeBytes = requiredHeadroomBytes
    for item in items {
      guard let itemId = item["id"] as? String else {
        throw InboxArtifactHandoffError.integrityFailed
      }
      guard let descriptor = try sourceDescriptor(item) else { continue }
      try requireCanonicalUUID(itemId)
      let destination = destinationDirectory.appendingPathComponent("\(itemId).bin")
      if FileManager.default.fileExists(atPath: destination.path) { continue }
      guard requiredFreeBytes <= Int64.max - descriptor.byteCount else {
        throw InboxArtifactHandoffError.integrityFailed
      }
      requiredFreeBytes += descriptor.byteCount
    }
    if try availableBytes(existingDirectory(atOrAbove: applicationSupport)) < requiredFreeBytes {
      throw InboxArtifactHandoffError.lowDisk
    }
    try ensureDestinationHierarchy(
      applicationSupport: applicationSupport,
      packId: packId,
      directorySynchronizer: directorySynchronizer
    )
    let destinationDescriptor = try openDestinationDirectory(destinationDirectory)
    defer { Darwin.close(destinationDescriptor) }

    let artifacts: [[String: Any]] = try items.compactMap { item -> [String: Any]? in
      guard let itemId = item["id"] as? String,
            let mediaType = item["mediaType"] as? String else {
        throw InboxArtifactHandoffError.integrityFailed
      }
      guard let descriptor = try sourceDescriptor(item) else { return nil }
      try requireCanonicalUUID(itemId)
      let source = sourceDirectory.appendingPathComponent(descriptor.name)
      let actualHash = try publish(
        source: source,
        destinationDirectory: destinationDirectory,
        destinationDescriptor: destinationDescriptor,
        itemId: itemId,
        byteCount: descriptor.byteCount,
        sha256: descriptor.sha256,
        operationHook: operationHook,
        directorySynchronizer: directorySynchronizer
      )
      var result: [String: Any] = [
        "id": itemId,
        "itemId": itemId,
        "relativePath": "Packs/\(packId)/originals/\(itemId).bin",
        "mediaType": mediaType,
        "byteCount": descriptor.byteCount,
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

  static func acknowledge(
    container: URL,
    ingestionId: String,
    operationHook: (InboxAcknowledgementPoint) throws -> Void = { _ in },
    directorySynchronizer: (URL) throws -> Void = synchronizeDirectory,
    tombstoneRemover: (URL) throws -> Void = { try FileManager.default.removeItem(at: $0) }
  ) throws -> Bool {
    try requireCanonicalUUID(ingestionId)
    let inbox = container.appendingPathComponent("Inbox", isDirectory: true)
    let directory = inbox.appendingPathComponent(ingestionId, isDirectory: true)
    let tombstoneRoot = container.appendingPathComponent(
      "InboxAckTombstones",
      isDirectory: true
    )
    return try InboxWriterRegistry.withLock(container: container) { locks in
      if InboxWriterRegistry.isLocallyOwned(ingestionId) {
        throw InboxArtifactHandoffError.acknowledgementBlocked
      }
      let lock = locks.appendingPathComponent("\(ingestionId).lock")
      if FileManager.default.fileExists(atPath: lock.path) {
        throw InboxArtifactHandoffError.acknowledgementBlocked
      }
      var receipt: [String: Any]?
      do {
        receipt = try InboxAcknowledgementStore.read(
          container: container,
          ingestionId: ingestionId
        )
      } catch let error as InboxAcknowledgementStoreError {
        throw handoffError(error)
      }
      guard FileManager.default.fileExists(atPath: directory.path) else {
        if receipt == nil {
          let tombstones: [URL]
          do {
            tombstones = try InboxAcknowledgementStore.matchingTombstones(
              container: container,
              ingestionId: ingestionId
            )
          } catch let error as InboxAcknowledgementStoreError {
            throw handoffError(error)
          }
          for tombstone in tombstones {
            do {
              let manifestURL = tombstone.appendingPathComponent("manifest.json")
              let manifestData = try Data(
                contentsOf: manifestURL,
                options: [.mappedIfSafe]
              )
              _ = try InboxManifestValidator.readOwnedDirectory(
                tombstone,
                ingestionId: ingestionId
              )
              guard try Data(contentsOf: manifestURL, options: [.mappedIfSafe])
                      == manifestData else {
                throw InboxArtifactHandoffError.integrityFailed
              }
              receipt = try InboxAcknowledgementStore.publish(
                container: container,
                ingestionId: ingestionId,
                manifestData: manifestData,
                directorySynchronizer: directorySynchronizer
              )
            } catch let error as InboxAcknowledgementStoreError {
              throw handoffError(error)
            } catch let error as InboxManifestValidationError {
              throw handoffError(error)
            } catch {
              throw InboxArtifactHandoffError.integrityFailed
            }
          }
          if receipt != nil { try operationHook(.afterReceiptPublish) }
        }
        // Acknowledging a never-published ID remains an idempotent no-op. A
        // matching tombstone must first produce a durable receipt or fail closed.
        guard receipt != nil else { return true }
        cleanupTombstones(
          root: tombstoneRoot,
          ingestionId: ingestionId,
          operationHook: operationHook,
          directorySynchronizer: directorySynchronizer,
          tombstoneRemover: tombstoneRemover
        )
        return true
      }
      let manifestData: Data
      do {
        let manifestURL = directory.appendingPathComponent("manifest.json")
        let snapshot = try Data(contentsOf: manifestURL, options: [.mappedIfSafe])
        _ = try InboxManifestValidator.readPublished(
          inbox: inbox,
          ingestionId: ingestionId
        )
        guard try Data(contentsOf: manifestURL, options: [.mappedIfSafe]) == snapshot else {
          throw InboxArtifactHandoffError.integrityFailed
        }
        manifestData = snapshot
      } catch let error as InboxManifestValidationError {
        throw handoffError(error)
      } catch {
        throw InboxArtifactHandoffError.integrityFailed
      }
      do {
        receipt = try InboxAcknowledgementStore.publish(
          container: container,
          ingestionId: ingestionId,
          manifestData: manifestData,
          directorySynchronizer: directorySynchronizer
        )
      } catch let error as InboxAcknowledgementStoreError {
        throw handoffError(error)
      }
      try operationHook(.afterReceiptPublish)
      try ensureDurableDirectory(
        tombstoneRoot,
        directorySynchronizer: directorySynchronizer
      )
      let tombstone = tombstoneRoot.appendingPathComponent(
        "\(ingestionId)-\(UUID().uuidString.lowercased()).ack",
        isDirectory: true
      )
      try atomicMove(from: directory, to: tombstone)
      try directorySynchronizer(inbox)
      try directorySynchronizer(tombstoneRoot)
      try operationHook(.afterTombstoneRename)
      cleanupTombstone(
        tombstone,
        operationHook: operationHook,
        directorySynchronizer: directorySynchronizer,
        tombstoneRemover: tombstoneRemover
      )
      return true
    }
  }

  static func runStartupMaintenance(container: URL) {
    _ = try? sweepAcknowledgementTombstones(container: container)
  }

  static func sweepAcknowledgementTombstones(
    container: URL,
    operationHook: (InboxTombstoneSweepPoint) throws -> Void = { _ in },
    directorySynchronizer: (URL) throws -> Void = synchronizeDirectory,
    tombstoneRemover: (URL) throws -> Void = { try FileManager.default.removeItem(at: $0) }
  ) throws -> InboxTombstoneSweepResult {
    let root = container.appendingPathComponent("InboxAckTombstones", isDirectory: true)
    return try InboxWriterRegistry.withLock(container: container) { _ in
      var isDirectory: ObjCBool = false
      guard FileManager.default.fileExists(atPath: root.path, isDirectory: &isDirectory) else {
        return InboxTombstoneSweepResult(scanned: 0, removed: 0, failed: 0)
      }
      guard isDirectory.boolValue else { throw InboxArtifactHandoffError.writeFailed }
      let candidates = try FileManager.default.contentsOfDirectory(
        at: root,
        includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey]
      ).filter { validAcknowledgementTombstone($0, root: root) }
        .sorted { $0.lastPathComponent < $1.lastPathComponent }
      var removed = 0
      var failed = 0
      for tombstone in candidates {
        do {
          guard let ingestionId = InboxAcknowledgementStore.tombstoneIngestionId(
            tombstone,
            root: root
          ) else {
            throw InboxArtifactHandoffError.integrityFailed
          }
          if try InboxAcknowledgementStore.read(
            container: container,
            ingestionId: ingestionId
          ) == nil {
            let manifestURL = tombstone.appendingPathComponent("manifest.json")
            let manifestData = try Data(
              contentsOf: manifestURL,
              options: [.mappedIfSafe]
            )
            _ = try InboxManifestValidator.readOwnedDirectory(
              tombstone,
              ingestionId: ingestionId
            )
            guard try Data(contentsOf: manifestURL, options: [.mappedIfSafe])
                    == manifestData else {
              throw InboxArtifactHandoffError.integrityFailed
            }
            _ = try InboxAcknowledgementStore.publish(
              container: container,
              ingestionId: ingestionId,
              manifestData: manifestData,
              directorySynchronizer: directorySynchronizer
            )
          }
          try tombstoneRemover(tombstone)
          guard !FileManager.default.fileExists(atPath: tombstone.path) else {
            throw InboxArtifactHandoffError.writeFailed
          }
          try directorySynchronizer(root)
          removed += 1
        } catch {
          failed += 1
          continue
        }
        try operationHook(.afterRemoval)
      }
      return InboxTombstoneSweepResult(
        scanned: candidates.count,
        removed: removed,
        failed: failed
      )
    }
  }

  private static func publish(
    source: URL,
    destinationDirectory: URL,
    destinationDescriptor: Int32,
    itemId: String,
    byteCount: Int64,
    sha256: String?,
    operationHook: (InboxArtifactHandoffPoint) throws -> Void,
    directorySynchronizer: (URL) throws -> Void
  ) throws -> String {
    let destinationName = "\(itemId).bin"
    let partialName = "\(destinationName).partial"
    try requireDestinationIdentity(destinationDirectory, descriptor: destinationDescriptor)
    if Darwin.faccessat(destinationDescriptor, destinationName, F_OK, AT_SYMLINK_NOFOLLOW) == 0 {
      let sourceHash = try verify(url: source, byteCount: byteCount, sha256: sha256)
      let existingHash = try verify(
        directoryDescriptor: destinationDescriptor,
        name: destinationName,
        byteCount: byteCount,
        sha256: sourceHash
      )
      try requireDestinationIdentity(destinationDirectory, descriptor: destinationDescriptor)
      return existingHash
    }
    if Darwin.unlinkat(destinationDescriptor, partialName, 0) != 0 && errno != ENOENT {
      throw InboxArtifactHandoffError.writeFailed
    }
    try operationHook(.beforeCopy)
    try requireDestinationIdentity(destinationDirectory, descriptor: destinationDescriptor)
    let outputDescriptor = Darwin.openat(
      destinationDescriptor,
      partialName,
      O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW,
      mode_t(S_IRUSR | S_IWUSR)
    )
    guard outputDescriptor >= 0 else {
      throw InboxArtifactHandoffError.writeFailed
    }
    var published = false
    do {
      let output = FileHandle(fileDescriptor: outputDescriptor, closeOnDealloc: true)
      let input: FileHandle
      do {
        input = try openRegularFile(source, byteCount: byteCount)
      } catch {
        try? output.close()
        throw error
      }
      var firstChunk = true
      var total: Int64 = 0
      do {
        while let data = try input.read(upToCount: 64 * 1024), !data.isEmpty {
          total += Int64(data.count)
          guard total <= byteCount else {
            throw InboxArtifactHandoffError.integrityFailed
          }
          try output.write(contentsOf: data)
          if firstChunk {
            firstChunk = false
            try operationHook(.duringCopy)
            try requireDestinationIdentity(
              destinationDirectory,
              descriptor: destinationDescriptor
            )
          }
        }
        guard total == byteCount else {
          throw InboxArtifactHandoffError.integrityFailed
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
      try requireDestinationIdentity(destinationDirectory, descriptor: destinationDescriptor)
      let actualHash = try verify(
        directoryDescriptor: destinationDescriptor,
        name: partialName,
        byteCount: byteCount,
        sha256: sha256
      )
      try operationHook(.beforePublishRename)
      try requireDestinationIdentity(destinationDirectory, descriptor: destinationDescriptor)
      guard Darwin.renameat(
        destinationDescriptor,
        partialName,
        destinationDescriptor,
        destinationName
      ) == 0 else {
        throw InboxArtifactHandoffError.writeFailed
      }
      published = true
      guard Darwin.fsync(destinationDescriptor) == 0 else {
        throw InboxArtifactHandoffError.writeFailed
      }
      try requireDestinationIdentity(destinationDirectory, descriptor: destinationDescriptor)
      try directorySynchronizer(destinationDirectory)
      try requireDestinationIdentity(destinationDirectory, descriptor: destinationDescriptor)
      return actualHash
    } catch let error as InboxArtifactHandoffError {
      _ = Darwin.unlinkat(
        destinationDescriptor,
        published ? destinationName : partialName,
        0
      )
      throw error
    } catch {
      _ = Darwin.unlinkat(
        destinationDescriptor,
        published ? destinationName : partialName,
        0
      )
      throw InboxArtifactHandoffError.writeFailed
    }
  }

  private static func ensureDestinationHierarchy(
    applicationSupport: URL,
    packId: String,
    directorySynchronizer: (URL) throws -> Void
  ) throws {
    try ensureDurableDirectory(
      applicationSupport.deletingLastPathComponent(),
      directorySynchronizer: directorySynchronizer
    )
    try ensureDurableDirectory(applicationSupport, directorySynchronizer: directorySynchronizer)
    let packs = applicationSupport.appendingPathComponent("Packs", isDirectory: true)
    try ensureDurableDirectory(packs, directorySynchronizer: directorySynchronizer)
    let pack = packs.appendingPathComponent(packId, isDirectory: true)
    try ensureDurableDirectory(pack, directorySynchronizer: directorySynchronizer)
    try ensureDurableDirectory(
      pack.appendingPathComponent("originals", isDirectory: true),
      directorySynchronizer: directorySynchronizer
    )
  }

  private static func atomicMove(from source: URL, to destination: URL) throws {
    guard Darwin.rename(source.path, destination.path) == 0 else {
      throw InboxArtifactHandoffError.writeFailed
    }
  }

  private static func existingDirectory(atOrAbove url: URL) throws -> URL {
    var candidate = url.standardizedFileURL
    while true {
      var isDirectory: ObjCBool = false
      if FileManager.default.fileExists(atPath: candidate.path, isDirectory: &isDirectory) {
        guard isDirectory.boolValue else { throw InboxArtifactHandoffError.writeFailed }
        return candidate
      }
      let parent = candidate.deletingLastPathComponent()
      guard parent.path != candidate.path else {
        throw InboxArtifactHandoffError.writeFailed
      }
      candidate = parent
    }
  }

  private static func ensureDurableDirectory(
    _ directory: URL,
    directorySynchronizer: (URL) throws -> Void
  ) throws {
    var isDirectory: ObjCBool = false
    if FileManager.default.fileExists(atPath: directory.path, isDirectory: &isDirectory) {
      guard isDirectory.boolValue else { throw InboxArtifactHandoffError.integrityFailed }
      try requireSafeDestinationDirectory(directory)
    } else {
      do {
        try FileManager.default.createDirectory(
          at: directory,
          withIntermediateDirectories: false
        )
      } catch {
        // A concurrent creator can win after the existence check. Accept only
        // the intended directory; a symlink at any owned ancestor fails closed.
        var racedIsDirectory: ObjCBool = false
        guard FileManager.default.fileExists(
          atPath: directory.path,
          isDirectory: &racedIsDirectory
        ), racedIsDirectory.boolValue else {
          throw InboxArtifactHandoffError.writeFailed
        }
      }
      try requireSafeDestinationDirectory(directory)
    }
    do {
      try directorySynchronizer(directory)
      try directorySynchronizer(directory.deletingLastPathComponent())
    } catch let error as InboxArtifactHandoffError {
      throw error
    } catch {
      throw InboxArtifactHandoffError.writeFailed
    }
  }

  private static func requireSafeDestinationDirectory(_ directory: URL) throws {
    let descriptor = Darwin.open(directory.path, O_RDONLY | O_NOFOLLOW)
    guard descriptor >= 0 else { throw InboxArtifactHandoffError.integrityFailed }
    defer { Darwin.close(descriptor) }
    var metadata = stat()
    guard Darwin.fstat(descriptor, &metadata) == 0,
          (metadata.st_mode & mode_t(S_IFMT)) == mode_t(S_IFDIR) else {
      throw InboxArtifactHandoffError.integrityFailed
    }
  }

  private static func openDestinationDirectory(_ directory: URL) throws -> Int32 {
    let descriptor = Darwin.open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    guard descriptor >= 0 else { throw InboxArtifactHandoffError.integrityFailed }
    do {
      try requireDestinationIdentity(directory, descriptor: descriptor)
      return descriptor
    } catch {
      Darwin.close(descriptor)
      throw error
    }
  }

  private static func requireDestinationIdentity(
    _ directory: URL,
    descriptor: Int32
  ) throws {
    var held = stat()
    guard Darwin.fstat(descriptor, &held) == 0,
          (held.st_mode & mode_t(S_IFMT)) == mode_t(S_IFDIR) else {
      throw InboxArtifactHandoffError.integrityFailed
    }
    let currentDescriptor = Darwin.open(
      directory.path,
      O_RDONLY | O_DIRECTORY | O_NOFOLLOW
    )
    guard currentDescriptor >= 0 else {
      throw InboxArtifactHandoffError.integrityFailed
    }
    defer { Darwin.close(currentDescriptor) }
    var current = stat()
    guard Darwin.fstat(currentDescriptor, &current) == 0,
          current.st_dev == held.st_dev,
          current.st_ino == held.st_ino else {
      throw InboxArtifactHandoffError.integrityFailed
    }
  }

  private static func cleanupTombstones(
    root: URL,
    ingestionId: String,
    operationHook: (InboxAcknowledgementPoint) throws -> Void,
    directorySynchronizer: (URL) throws -> Void,
    tombstoneRemover: (URL) throws -> Void
  ) {
    let container = root.deletingLastPathComponent()
    guard let children = try? InboxAcknowledgementStore.matchingTombstones(
      container: container,
      ingestionId: ingestionId
    ) else { return }
    for child in children {
      cleanupTombstone(
        child,
        operationHook: operationHook,
        directorySynchronizer: directorySynchronizer,
        tombstoneRemover: tombstoneRemover
      )
    }
  }

  private static func validAcknowledgementTombstone(_ url: URL, root: URL) -> Bool {
    InboxAcknowledgementStore.tombstoneIngestionId(url, root: root) != nil
  }

  private static func cleanupTombstone(
    _ tombstone: URL,
    operationHook: (InboxAcknowledgementPoint) throws -> Void,
    directorySynchronizer: (URL) throws -> Void,
    tombstoneRemover: (URL) throws -> Void
  ) {
    do {
      try operationHook(.duringTombstoneDeletion)
      try tombstoneRemover(tombstone)
      try directorySynchronizer(tombstone.deletingLastPathComponent())
    } catch {
      // The atomic rename already removed the scanner-visible Inbox entry.
      // Tombstone removal is intentionally retryable best-effort cleanup.
    }
  }

  private static func verify(url: URL, byteCount: Int64, sha256 expected: String?) throws -> String {
    let input = try openRegularFile(url, byteCount: byteCount)
    return try verify(input: input, byteCount: byteCount, sha256: expected)
  }

  private static func verify(
    directoryDescriptor: Int32,
    name: String,
    byteCount: Int64,
    sha256 expected: String?
  ) throws -> String {
    let input = try openRegularFile(
      directoryDescriptor: directoryDescriptor,
      name: name,
      byteCount: byteCount
    )
    return try verify(input: input, byteCount: byteCount, sha256: expected)
  }

  private static func verify(
    input: FileHandle,
    byteCount: Int64,
    sha256 expected: String?
  ) throws -> String {
    var digest = SHA256()
    var total: Int64 = 0
    do {
      while let data = try input.read(upToCount: 64 * 1024), !data.isEmpty {
        total += Int64(data.count)
        guard total <= byteCount else {
          throw InboxArtifactHandoffError.integrityFailed
        }
        digest.update(data: data)
      }
      guard total == byteCount else {
        throw InboxArtifactHandoffError.integrityFailed
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

  private static func openRegularFile(_ url: URL, byteCount: Int64) throws -> FileHandle {
    let descriptor = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW)
    guard descriptor >= 0 else { throw InboxArtifactHandoffError.integrityFailed }
    var metadata = stat()
    guard Darwin.fstat(descriptor, &metadata) == 0,
          (metadata.st_mode & S_IFMT) == S_IFREG,
          metadata.st_size == byteCount else {
      Darwin.close(descriptor)
      throw InboxArtifactHandoffError.integrityFailed
    }
    return FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
  }

  private static func openRegularFile(
    directoryDescriptor: Int32,
    name: String,
    byteCount: Int64
  ) throws -> FileHandle {
    let descriptor = Darwin.openat(directoryDescriptor, name, O_RDONLY | O_NOFOLLOW)
    guard descriptor >= 0 else { throw InboxArtifactHandoffError.integrityFailed }
    var metadata = stat()
    guard Darwin.fstat(descriptor, &metadata) == 0,
          (metadata.st_mode & S_IFMT) == S_IFREG,
          metadata.st_size == byteCount else {
      Darwin.close(descriptor)
      throw InboxArtifactHandoffError.integrityFailed
    }
    return FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
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
    guard canonicalUUID(value) else {
      throw InboxArtifactHandoffError.invalidIdentifier
    }
  }

  private static func handoffError(
    _ error: InboxAcknowledgementStoreError
  ) -> InboxArtifactHandoffError {
    switch error {
    case .invalidIdentifier: .invalidIdentifier
    case .unsupportedVersion: .unsupportedVersion
    case .integrityFailed: .integrityFailed
    case .writeFailed: .writeFailed
    case .recoveryRequired: .acknowledgementBlocked
    }
  }

  private static func handoffError(
    _ error: InboxManifestValidationError
  ) -> InboxArtifactHandoffError {
    switch error {
    case .unsupportedVersion: .unsupportedVersion
    case .artifactIntegrityFailed: .integrityFailed
    case .invalidManifest: .manifestMissing
    case .quarantineFailed: .writeFailed
    }
  }

  private static func canonicalUUID(_ value: String) -> Bool {
    guard let identifier = UUID(uuidString: value) else { return false }
    return identifier.uuidString.lowercased() == value
  }
}
