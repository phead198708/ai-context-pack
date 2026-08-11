import CryptoKit
import Darwin
import Foundation

enum OwnedArtifactStoreError: Error, Equatable {
  case invalidInput
  case immutableConflict
  case integrityFailed
  case writeFailed

  var stableCode: String {
    switch self {
    case .invalidInput: "SCHEMA_INVALID"
    case .immutableConflict: "STORAGE_ARTIFACT_IMMUTABLE"
    case .integrityFailed: "ARTIFACT_INTEGRITY_FAILED"
    case .writeFailed: "STORAGE_WRITE_FAILED"
    }
  }
}

enum OwnedArtifactStore {
  private static let areas = Set(["originals", "derived", "exports", "previews"])
  private static let extensions = Set([
    "bin", "heic", "jpeg", "jpg", "json", "md", "pdf", "png", "txt", "zip",
  ])
  private static let maximumSafeInteger: Int64 = 9_007_199_254_740_991
  private static let maximumTextBytes = 16_777_216
  private static let processLockRegistry = NSLock()
  private final class ProcessLockEntry {
    let lock = NSLock()
    var users = 0
  }
  private nonisolated(unsafe) static var processLocks: [String: ProcessLockEntry] = [:]

  static func publish(
    root: URL,
    source: URL,
    relativePath: String,
    expectedByteCount: Int64?,
    expectedSha256: String?
  ) throws -> [String: Any] {
    let components = try validate(relativePath)
    guard source.isFileURL,
          expectedByteCount.map({ $0 >= 0 && $0 <= maximumSafeInteger }) ?? true,
          expectedSha256.map(validSha256) ?? true else {
      throw OwnedArtifactStoreError.invalidInput
    }
    let sourceValues = try resourceValues(source)
    guard sourceValues.isRegularFile == true,
          sourceValues.isSymbolicLink != true,
          let sourceSize = sourceValues.fileSize,
          sourceSize >= 0 else {
      throw OwnedArtifactStoreError.integrityFailed
    }
    let byteCount = Int64(sourceSize)
    guard byteCount <= maximumSafeInteger,
          expectedByteCount.map({ $0 == byteCount }) ?? true else {
      throw OwnedArtifactStoreError.integrityFailed
    }
    let sourceHash = try hash(source)
    guard expectedSha256.map({ $0 == sourceHash }) ?? true else {
      throw OwnedArtifactStoreError.integrityFailed
    }
    let destination = root.appendingPathComponent(relativePath)
    return try withArtifactLock(root: root, artifactId: components.artifactId) {
      try ensureDirectoryChain(destination.deletingLastPathComponent())
      if FileManager.default.fileExists(atPath: destination.path) {
        let existing = try inspect(destination)
        guard existing.byteCount == byteCount, existing.sha256 == sourceHash else {
          throw OwnedArtifactStoreError.immutableConflict
        }
        return [
          "relativePath": relativePath,
          "byteCount": byteCount,
          "sha256": sourceHash,
          "created": false,
        ]
      }
      let partial = destination.appendingPathExtension("partial")
      if FileManager.default.fileExists(atPath: partial.path) {
        do {
          try FileManager.default.removeItem(at: partial)
          try synchronizeDirectory(partial.deletingLastPathComponent())
        } catch {
          throw OwnedArtifactStoreError.writeFailed
        }
      }
      do {
        guard FileManager.default.createFile(atPath: partial.path, contents: nil) else {
          throw OwnedArtifactStoreError.writeFailed
        }
        let input = try FileHandle(forReadingFrom: source)
        let output = try FileHandle(forWritingTo: partial)
        do {
          while let data = try input.read(upToCount: 64 * 1024), !data.isEmpty {
            try output.write(contentsOf: data)
          }
          try output.synchronize()
          try input.close()
          try output.close()
        } catch {
          try? input.close()
          try? output.close()
          throw error
        }
        let copied = try inspect(partial)
        guard copied.byteCount == byteCount, copied.sha256 == sourceHash else {
          throw OwnedArtifactStoreError.integrityFailed
        }
        guard Darwin.rename(partial.path, destination.path) == 0 else {
          throw OwnedArtifactStoreError.writeFailed
        }
        try synchronizeDirectory(destination.deletingLastPathComponent())
      } catch let error as OwnedArtifactStoreError {
        throw error
      } catch {
        throw OwnedArtifactStoreError.writeFailed
      }
      return [
        "relativePath": relativePath,
        "byteCount": byteCount,
        "sha256": sourceHash,
        "created": true,
      ]
    }
  }

  static func verify(
    root: URL,
    relativePath: String,
    expectedByteCount: Int64,
    expectedSha256: String
  ) throws -> [String: Any] {
    _ = try validate(relativePath)
    guard expectedByteCount >= 0,
          expectedByteCount <= maximumSafeInteger,
          validSha256(expectedSha256) else {
      throw OwnedArtifactStoreError.invalidInput
    }
    let destination = root.appendingPathComponent(relativePath)
    guard FileManager.default.fileExists(atPath: destination.path) else {
      return ["relativePath": relativePath, "status": "missing"]
    }
    try validateExistingDirectoryChain(
      root: root,
      target: destination.deletingLastPathComponent()
    )
    let actual = try inspect(destination)
    return [
      "relativePath": relativePath,
      "status": actual.byteCount == expectedByteCount && actual.sha256 == expectedSha256
        ? "verified" : "mismatch",
      "byteCount": actual.byteCount,
      "sha256": actual.sha256,
    ]
  }

  static func resolveFileUri(root: URL, relativePath: String) throws -> String {
    _ = try validate(relativePath)
    let destination = root.appendingPathComponent(relativePath)
    try validateExistingDirectoryChain(
      root: root,
      target: destination.deletingLastPathComponent()
    )
    _ = try inspect(destination)
    return destination.absoluteURL.absoluteString
  }

  static func writeText(
    root: URL,
    relativePath: String,
    text: String,
    partialWriter: ((URL, Data) throws -> Void)? = nil
  ) throws -> [String: Any] {
    let components = try validate(relativePath)
    guard relativePath.hasSuffix(".txt"),
          let data = text.data(using: .utf8),
          data.count <= maximumTextBytes else {
      throw OwnedArtifactStoreError.invalidInput
    }
    let expectedHash = SHA256.hash(data: data)
      .map { String(format: "%02x", $0) }
      .joined()
    let destination = root.appendingPathComponent(relativePath)
    return try withArtifactLock(root: root, artifactId: components.artifactId) {
      try ensureDirectoryChain(destination.deletingLastPathComponent())
      let expectedByteCount = Int64(data.count)
      if FileManager.default.fileExists(atPath: destination.path) {
        let existing = try inspect(destination)
        guard existing.byteCount == expectedByteCount,
              existing.sha256 == expectedHash else {
          throw OwnedArtifactStoreError.immutableConflict
        }
        return [
          "relativePath": relativePath,
          "byteCount": expectedByteCount,
          "sha256": expectedHash,
          "created": false,
        ]
      }
      let partial = destination.appendingPathExtension("partial")
      do {
        if FileManager.default.fileExists(atPath: partial.path) {
          try FileManager.default.removeItem(at: partial)
          try synchronizeDirectory(partial.deletingLastPathComponent())
        }
        if let partialWriter {
          try partialWriter(partial, data)
        } else {
          guard FileManager.default.createFile(atPath: partial.path, contents: data) else {
            throw OwnedArtifactStoreError.writeFailed
          }
        }
        try synchronizeFile(partial)
        let inspected = try inspect(partial)
        guard inspected.byteCount == expectedByteCount,
              inspected.sha256 == expectedHash else {
          throw OwnedArtifactStoreError.integrityFailed
        }
        guard Darwin.rename(partial.path, destination.path) == 0 else {
          throw OwnedArtifactStoreError.writeFailed
        }
        try synchronizeDirectory(destination.deletingLastPathComponent())
        return [
          "relativePath": relativePath,
          "byteCount": inspected.byteCount,
          "sha256": expectedHash,
          "created": true,
        ]
      } catch let error as OwnedArtifactStoreError {
        throw error
      } catch {
        throw OwnedArtifactStoreError.writeFailed
      }
    }
  }

  static func list(root: URL) throws -> [[String: Any]] {
    guard FileManager.default.fileExists(atPath: root.path) else { return [] }
    let packs = root.appendingPathComponent("Packs", isDirectory: true)
    guard FileManager.default.fileExists(atPath: packs.path) else { return [] }
    try requireDirectory(packs)
    var artifacts: [[String: Any]] = []
    for pack in try directories(packs) {
      guard canonicalUUID(pack.lastPathComponent) else {
        throw OwnedArtifactStoreError.integrityFailed
      }
      for area in try directories(pack) {
        guard areas.contains(area.lastPathComponent) else { continue }
        for file in try FileManager.default.contentsOfDirectory(
          at: area,
          includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]
        ).sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
          let relativePath = "Packs/\(pack.lastPathComponent)/\(area.lastPathComponent)/\(file.lastPathComponent)"
          _ = try validate(relativePath, allowPartial: true)
          let values = try resourceValues(file)
          guard values.isRegularFile == true,
                values.isSymbolicLink != true,
                let size = values.fileSize,
                size >= 0 else {
            throw OwnedArtifactStoreError.integrityFailed
          }
          artifacts.append(["relativePath": relativePath, "byteCount": Int64(size)])
        }
      }
    }
    return artifacts
  }

  static func remove(root: URL, relativePath: String) throws -> Bool {
    let components = try validate(relativePath, allowPartial: true)
    let destination = root.appendingPathComponent(relativePath)
    return try withArtifactLock(root: root, artifactId: components.artifactId) {
      guard FileManager.default.fileExists(atPath: destination.path) else { return true }
      try validateExistingDirectoryChain(
        root: root,
        target: destination.deletingLastPathComponent()
      )
      _ = try inspect(destination)
      do {
        try FileManager.default.removeItem(at: destination)
        try synchronizeDirectory(destination.deletingLastPathComponent())
        return true
      } catch {
        throw OwnedArtifactStoreError.writeFailed
      }
    }
  }

  static func quarantine(root: URL, relativePath: String) throws -> [String: Any] {
    let components = try validate(relativePath, allowPartial: true)
    let source = root.appendingPathComponent(relativePath)
    return try withArtifactLock(root: root, artifactId: components.artifactId) {
      guard FileManager.default.fileExists(atPath: source.path) else {
        return ["quarantined": false]
      }
      try validateExistingDirectoryChain(
        root: root,
        target: source.deletingLastPathComponent()
      )
      let inspected = try inspect(source)
      return try withArtifactLock(root: root, artifactId: "quarantine-retention") {
        let quarantine = root.appendingPathComponent("ArtifactQuarantine", isDirectory: true)
        try ensureDirectoryChain(quarantine)
        let quarantineId = UUID().uuidString.lowercased()
        let target = quarantine.appendingPathComponent(
          "\(components.artifactId)-\(quarantineId).quarantine"
        )
        guard Darwin.rename(source.path, target.path) == 0 else {
          throw OwnedArtifactStoreError.writeFailed
        }
        do {
          try FileManager.default.setAttributes(
            [.modificationDate: Date()],
            ofItemAtPath: target.path
          )
          try synchronizeFile(target)
        } catch let error as OwnedArtifactStoreError {
          throw error
        } catch {
          throw OwnedArtifactStoreError.writeFailed
        }
        try synchronizeDirectory(source.deletingLastPathComponent())
        try synchronizeDirectory(quarantine)
        return [
          "quarantined": true,
          "quarantineId": quarantineId,
          "anonymousId": components.artifactId,
          "byteCount": inspected.byteCount,
        ]
      }
    }
  }

  static func purgeQuarantine(root: URL, olderThanEpochMs: Int64) throws -> [String: Any] {
    guard olderThanEpochMs >= 0, olderThanEpochMs <= maximumSafeInteger else {
      throw OwnedArtifactStoreError.invalidInput
    }
    return try withArtifactLock(root: root, artifactId: "quarantine-retention") {
      let quarantine = root.appendingPathComponent("ArtifactQuarantine", isDirectory: true)
      guard FileManager.default.fileExists(atPath: quarantine.path) else {
        return ["purgedCount": 0, "purgedBytes": Int64(0)]
      }
      try requireDirectory(quarantine)
      let cutoff = Date(timeIntervalSince1970: Double(olderThanEpochMs) / 1_000)
      var count = 0
      var bytes = Int64(0)
      for file in try regularFiles(quarantine) {
        try validateQuarantineLeaf(file.lastPathComponent)
        let values = try resourceValues(file)
        guard values.isRegularFile == true,
              values.isSymbolicLink != true,
              let size = values.fileSize,
              size >= 0,
              let modifiedAt = values.contentModificationDate else {
          throw OwnedArtifactStoreError.integrityFailed
        }
        guard modifiedAt <= cutoff else { continue }
        guard bytes <= maximumSafeInteger - Int64(size) else {
          throw OwnedArtifactStoreError.integrityFailed
        }
        do { try FileManager.default.removeItem(at: file) }
        catch { throw OwnedArtifactStoreError.writeFailed }
        bytes += Int64(size)
        count += 1
      }
      if count > 0 { try synchronizeDirectory(quarantine) }
      return ["purgedCount": count, "purgedBytes": bytes]
    }
  }

  static func usage(root: URL) throws -> [String: Any] {
    let artifacts = try list(root: root)
    let artifactBytes = try artifacts.reduce(Int64(0)) { total, value in
      guard let bytes = value["byteCount"] as? Int64,
            total <= maximumSafeInteger - bytes else {
        throw OwnedArtifactStoreError.integrityFailed
      }
      return total + bytes
    }
    let quarantine = root.appendingPathComponent("ArtifactQuarantine", isDirectory: true)
    let quarantined = try regularFiles(quarantine)
    let quarantineBytes = try quarantined.reduce(Int64(0)) { total, url in
      let values = try resourceValues(url)
      guard values.isRegularFile == true,
            values.isSymbolicLink != true,
            let size = values.fileSize,
            size >= 0,
            total <= maximumSafeInteger - Int64(size) else {
        throw OwnedArtifactStoreError.integrityFailed
      }
      return total + Int64(size)
    }
    return [
      "artifactCount": artifacts.count,
      "artifactBytes": artifactBytes,
      "quarantineCount": quarantined.count,
      "quarantineBytes": quarantineBytes,
    ]
  }

  private static func validate(
    _ value: String,
    allowPartial: Bool = false
  ) throws -> (packId: String, area: String, artifactId: String) {
    guard !value.isEmpty,
          !value.hasPrefix("/"),
          !value.contains("\\"),
          !value.contains("%"),
          !value.contains("\0") else {
      throw OwnedArtifactStoreError.invalidInput
    }
    let components = value.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    guard components.count == 4,
          components[0] == "Packs",
          canonicalUUID(components[1]),
          areas.contains(components[2]) else {
      throw OwnedArtifactStoreError.invalidInput
    }
    let leaf = components[3]
    let partial = leaf.hasSuffix(".partial")
    guard !partial || allowPartial else { throw OwnedArtifactStoreError.invalidInput }
    let publishedLeaf = partial ? String(leaf.dropLast(".partial".count)) : leaf
    let extensionValue = URL(fileURLWithPath: publishedLeaf).pathExtension
    let identifier = String(publishedLeaf.dropLast(extensionValue.count + 1))
    guard canonicalUUID(identifier), extensions.contains(extensionValue) else {
      throw OwnedArtifactStoreError.invalidInput
    }
    return (components[1], components[2], identifier)
  }

  private static func inspect(_ url: URL) throws -> (byteCount: Int64, sha256: String) {
    let values = try resourceValues(url)
    guard values.isRegularFile == true,
          values.isSymbolicLink != true,
          let size = values.fileSize,
          size >= 0,
          Int64(size) <= maximumSafeInteger else {
      throw OwnedArtifactStoreError.integrityFailed
    }
    return (Int64(size), try hash(url))
  }

  private static func hash(_ url: URL) throws -> String {
    let input: FileHandle
    do { input = try FileHandle(forReadingFrom: url) }
    catch { throw OwnedArtifactStoreError.integrityFailed }
    var digest = SHA256()
    do {
      while let data = try input.read(upToCount: 64 * 1024), !data.isEmpty {
        digest.update(data: data)
      }
      try input.close()
    } catch {
      try? input.close()
      throw OwnedArtifactStoreError.integrityFailed
    }
    return digest.finalize().map { String(format: "%02x", $0) }.joined()
  }

  private static func withArtifactLock<T>(
    root: URL,
    artifactId: String,
    operation: () throws -> T
  ) throws -> T {
    processLockRegistry.lock()
    let entry = processLocks[artifactId] ?? ProcessLockEntry()
    entry.users += 1
    processLocks[artifactId] = entry
    processLockRegistry.unlock()
    defer {
      processLockRegistry.lock()
      entry.users -= 1
      if entry.users == 0, processLocks[artifactId] === entry {
        processLocks.removeValue(forKey: artifactId)
      }
      processLockRegistry.unlock()
    }
    entry.lock.lock()
    defer { entry.lock.unlock() }
    let locks = root.appendingPathComponent("ArtifactStoreLocks", isDirectory: true)
    try ensureDirectoryChain(locks)
    let lock = locks.appendingPathComponent("\(artifactId).lock")
    let descriptor = Darwin.open(lock.path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
    guard descriptor >= 0 else { throw OwnedArtifactStoreError.writeFailed }
    defer { Darwin.close(descriptor) }
    guard Darwin.lockf(descriptor, F_LOCK, 0) == 0 else {
      throw OwnedArtifactStoreError.writeFailed
    }
    defer { Darwin.lockf(descriptor, F_ULOCK, 0) }
    return try operation()
  }

  private static func ensureDirectoryChain(_ target: URL) throws {
    var missing: [URL] = []
    var candidate = target.standardizedFileURL
    while true {
      var isDirectory: ObjCBool = false
      if FileManager.default.fileExists(atPath: candidate.path, isDirectory: &isDirectory) {
        let values = try resourceValues(candidate)
        guard isDirectory.boolValue, values.isSymbolicLink != true else {
          throw OwnedArtifactStoreError.writeFailed
        }
        break
      }
      missing.append(candidate)
      let parent = candidate.deletingLastPathComponent()
      guard parent.path != candidate.path else { throw OwnedArtifactStoreError.writeFailed }
      candidate = parent
    }
    for directory in missing.reversed() {
      do {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        try synchronizeDirectory(directory)
        try synchronizeDirectory(directory.deletingLastPathComponent())
      } catch {
        throw OwnedArtifactStoreError.writeFailed
      }
    }
  }

  private static func directories(_ root: URL) throws -> [URL] {
    try FileManager.default.contentsOfDirectory(
      at: root,
      includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey]
    ).filter { url in
      let values = try resourceValues(url)
      guard values.isSymbolicLink != true else { throw OwnedArtifactStoreError.integrityFailed }
      return values.isDirectory == true
    }.sorted(by: { $0.lastPathComponent < $1.lastPathComponent })
  }

  private static func regularFiles(_ root: URL) throws -> [URL] {
    guard FileManager.default.fileExists(atPath: root.path) else { return [] }
    try requireDirectory(root)
    return try FileManager.default.contentsOfDirectory(
      at: root,
      includingPropertiesForKeys: [
        .isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey,
        .contentModificationDateKey,
      ]
    ).sorted(by: { $0.lastPathComponent < $1.lastPathComponent })
  }

  private static func resourceValues(_ url: URL) throws -> URLResourceValues {
    do {
      return try url.resourceValues(forKeys: [
        .isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey,
        .contentModificationDateKey,
      ])
    } catch {
      throw OwnedArtifactStoreError.writeFailed
    }
  }

  private static func requireDirectory(_ url: URL) throws {
    let values = try resourceValues(url)
    guard values.isDirectory == true, values.isSymbolicLink != true else {
      throw OwnedArtifactStoreError.integrityFailed
    }
  }

  private static func validateExistingDirectoryChain(root: URL, target: URL) throws {
    let ownedRoot = root.standardizedFileURL
    var candidate = target.standardizedFileURL
    guard candidate.path == ownedRoot.path || candidate.path.hasPrefix(ownedRoot.path + "/") else {
      throw OwnedArtifactStoreError.invalidInput
    }
    while true {
      try requireDirectory(candidate)
      if candidate.path == ownedRoot.path { return }
      let parent = candidate.deletingLastPathComponent().standardizedFileURL
      guard parent.path != candidate.path else {
        throw OwnedArtifactStoreError.integrityFailed
      }
      candidate = parent
    }
  }

  private static func synchronizeDirectory(_ directory: URL) throws {
    let descriptor = Darwin.open(directory.path, O_RDONLY)
    guard descriptor >= 0 else { throw OwnedArtifactStoreError.writeFailed }
    defer { Darwin.close(descriptor) }
    guard Darwin.fsync(descriptor) == 0 else { throw OwnedArtifactStoreError.writeFailed }
  }

  private static func synchronizeFile(_ file: URL) throws {
    let descriptor = Darwin.open(file.path, O_RDONLY)
    guard descriptor >= 0 else { throw OwnedArtifactStoreError.writeFailed }
    defer { Darwin.close(descriptor) }
    guard Darwin.fsync(descriptor) == 0 else { throw OwnedArtifactStoreError.writeFailed }
  }

  private static func validateQuarantineLeaf(_ value: String) throws {
    guard value.hasSuffix(".quarantine") else {
      throw OwnedArtifactStoreError.integrityFailed
    }
    let stem = String(value.dropLast(".quarantine".count))
    guard stem.count == 73,
          stem[stem.index(stem.startIndex, offsetBy: 36)] == "-" else {
      throw OwnedArtifactStoreError.integrityFailed
    }
    let artifactId = String(stem.prefix(36))
    let quarantineId = String(stem.suffix(36))
    guard canonicalUUID(artifactId), canonicalUUID(quarantineId) else {
      throw OwnedArtifactStoreError.integrityFailed
    }
  }

  private static func validSha256(_ value: String) -> Bool {
    value.utf8.count == 64 && value.utf8.allSatisfy {
      ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66)
    }
  }

  private static func canonicalUUID(_ value: String) -> Bool {
    guard let identifier = UUID(uuidString: value) else { return false }
    return identifier.uuidString.lowercased() == value
  }
}
