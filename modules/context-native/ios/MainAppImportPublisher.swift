import Foundation

enum MainAppImportError: Error, Equatable {
  case invalidInput
  case stagingFailed
  case cleanupFailed
  case committedCleanupRequired
  case artifactIntegrityFailed

  var stableCode: String {
    switch self {
    case .invalidInput: return "MAIN_APP_IMPORT_INPUT_INVALID"
    case .stagingFailed: return "MAIN_APP_PICKER_STAGING_FAILED"
    case .cleanupFailed: return "MAIN_APP_IMPORT_CLEANUP_FAILED"
    case .committedCleanupRequired:
      return "MAIN_APP_IMPORT_COMMITTED_CLEANUP_REQUIRED"
    case .artifactIntegrityFailed: return "ARTIFACT_INTEGRITY_FAILED"
    }
  }
}

/**
 Converts controlled picker-cache URLs and inline UTF-8 entries into the same atomic Inbox
 session used by the iOS Share Extension. Provider paths and display filenames are never durable.
 */
enum MainAppImportPublisher {
  private static let stagedDirectoryName = "AIContextPackMainAppPicker"
  private static let transientDirectoryNames = ["DocumentPicker", "ImagePicker"]
  private static let cacheLock = NSLock()

  static func stagePickerFiles(cacheRoot: URL, fileUris: [String]) throws -> [String] {
    cacheLock.lock()
    defer { cacheLock.unlock() }
    guard !fileUris.isEmpty,
          fileUris.count <= ShareIngestionSession.maximumItemCount,
          Set(fileUris).count == fileUris.count else {
      throw MainAppImportError.invalidInput
    }
    let sources = try fileUris.map { try controlledTransientFile($0, cacheRoot: cacheRoot) }
    let stageRoot = cacheRoot.resolvingSymlinksInPath().standardizedFileURL
      .appendingPathComponent(stagedDirectoryName, isDirectory: true)
    let transactionId = UUID().uuidString.lowercased()
    let partialRoot = stageRoot.appendingPathComponent("\(transactionId).partial", isDirectory: true)
    let committedRoot = stageRoot.appendingPathComponent(transactionId, isDirectory: true)
    do {
      if FileManager.default.fileExists(atPath: stageRoot.path) {
        let values = try stageRoot.resourceValues(forKeys: [.isSymbolicLinkKey, .isDirectoryKey])
        guard values.isSymbolicLink != true, values.isDirectory == true else {
          throw MainAppImportError.cleanupFailed
        }
      } else {
        try FileManager.default.createDirectory(at: stageRoot, withIntermediateDirectories: true)
      }
      try FileManager.default.createDirectory(at: partialRoot, withIntermediateDirectories: false)
    } catch let error as MainAppImportError {
      throw error
    } catch {
      throw MainAppImportError.stagingFailed
    }
    var staged: [URL] = []
    do {
      for source in sources {
        let destination = partialRoot.appendingPathComponent(
          "\(UUID().uuidString.lowercased()).bin",
          isDirectory: false
        )
        try FileManager.default.moveItem(at: source, to: destination)
        staged.append(destination)
      }
      try FileManager.default.moveItem(at: partialRoot, to: committedRoot)
      return staged.map {
        committedRoot.appendingPathComponent($0.lastPathComponent, isDirectory: false).absoluteString
      }
    } catch {
      var cleanupFailed = false
      for file in [partialRoot, committedRoot] + sources
        where FileManager.default.fileExists(atPath: file.path) {
        do { try FileManager.default.removeItem(at: file) }
        catch { cleanupFailed = true }
      }
      do { try cleanupPickerTransientsUnlocked(cacheRoot: cacheRoot) }
      catch { cleanupFailed = true }
      throw cleanupFailed ? MainAppImportError.cleanupFailed : MainAppImportError.stagingFailed
    }
  }

  static func cleanupPickerTransients(cacheRoot: URL) throws -> Bool {
    cacheLock.lock()
    defer { cacheLock.unlock() }
    try cleanupPickerTransientsUnlocked(cacheRoot: cacheRoot)
    return true
  }

  static func recoverPickerCache(cacheRoot: URL) throws -> Bool {
    cacheLock.lock()
    defer { cacheLock.unlock() }
    try removeCacheDirectories(
      cacheRoot: cacheRoot,
      names: transientDirectoryNames + [stagedDirectoryName]
    )
    return true
  }

  static func publish(
    container: URL,
    cacheRoot: URL,
    ownedRoot: URL? = nil,
    ingestionId: String,
    source: String,
    rawInputs: [[String: Any]],
    removeCacheFile: @escaping (URL) throws -> Void = {
      try FileManager.default.removeItem(at: $0)
    },
    operationHook: @escaping (ShareIngestionSession.Point) throws -> Void = { _ in }
  ) throws -> [String: Any] {
    cacheLock.lock()
    defer { cacheLock.unlock() }
    guard ["main-app-picker", "main-app-text"].contains(source),
          !rawInputs.isEmpty,
          rawInputs.count <= ShareIngestionSession.maximumItemCount else {
      throw MainAppImportError.invalidInput
    }
    let decoded = try rawInputs.enumerated().map { index, raw in
      try decode(
        raw,
        expectedOrder: index,
        cacheRoot: cacheRoot,
        ownedRoot: ownedRoot
      )
    }
    guard Set(decoded.map(\.id)).count == decoded.count else {
      throw MainAppImportError.invalidInput
    }
    let pickerFiles = decoded.compactMap(\.transientFile)
    guard (source == "main-app-picker") == decoded.contains(where: { $0.file != nil }) else {
      throw MainAppImportError.invalidInput
    }
    let session = try ShareIngestionSession(
      container: container,
      ingestionId: ingestionId,
      source: source,
      operationHook: operationHook
    )
    for item in decoded {
      switch item.value {
      case .file(let file, let mediaType, _, let expectedByteCount, let expectedSha256):
        if FileManager.default.fileExists(atPath: file.path) {
          try session.recordFile(
            id: item.id,
            order: item.order,
            declaredMediaType: mediaType,
            source: file,
            retainFailedSource: true,
            expectedByteCount: expectedByteCount,
            expectedSha256: expectedSha256
          )
        } else {
          try session.recordFailure(
            id: item.id,
            order: item.order,
            declaredMediaType: mediaType,
            code: "IMPORT_PROVIDER_PERMISSION_EXPIRED"
          )
        }
      case .text(let text, let mediaType):
        try session.recordData(
          id: item.id,
          order: item.order,
          declaredMediaType: mediaType,
          data: Data(text.utf8)
        )
      }
    }
    let manifest = try session.finish().manifest
    // Only a committed/replayed Inbox owns immutable bytes. A failed attempt keeps picker
    // cache files so the visible draft can retry or explicitly discard them.
    for file in Set(pickerFiles) where FileManager.default.fileExists(atPath: file.path) {
      do { try removeCacheFile(file) }
      // The Inbox is already durable. This distinct state prevents the UI from exposing the
      // normal draft cancellation path and requires an idempotent replay to retry cleanup.
      catch { throw MainAppImportError.committedCleanupRequired }
    }
    return manifest
  }

  static func discard(cacheRoot: URL, fileUris: [String]) throws -> Bool {
    cacheLock.lock()
    defer { cacheLock.unlock() }
    for value in fileUris {
      let file = try controlledCacheFile(value, cacheRoot: cacheRoot)
      if FileManager.default.fileExists(atPath: file.path) {
        do { try FileManager.default.removeItem(at: file) }
        catch { throw MainAppImportError.cleanupFailed }
      }
    }
    return true
  }

  private enum Value {
    case file(URL, String, Bool, Int64?, String?)
    case text(String, String)
  }

  private struct Input {
    let id: String
    let order: Int
    let value: Value

    var file: URL? {
      if case .file(let file, _, _, _, _) = value { return file }
      return nil
    }

    var transientFile: URL? {
      if case .file(let file, _, let removeAfterCommit, _, _) = value,
        removeAfterCommit { return file }
      return nil
    }
  }

  private static func decode(
    _ raw: [String: Any],
    expectedOrder: Int,
    cacheRoot: URL,
    ownedRoot: URL?
  ) throws -> Input {
    guard let kind = raw["kind"] as? String,
          Set(raw.keys) == (kind == "file" ? fileKeys :
            (kind == "owned-file" ? ownedFileKeys : textKeys)),
          let id = raw["id"] as? String,
          canonicalUUID(id),
          try exactNonNegativeInteger(raw["order"]) == expectedOrder,
          (try exactNonNegativeInteger(raw["byteCount"])) <= 9_007_199_254_740_991,
          let mediaType = raw["declaredMediaType"] as? String,
          mediaType.utf8.count <= 127,
          mediaType.range(of: mediaTypePattern, options: .regularExpression) != nil else {
      throw MainAppImportError.invalidInput
    }

    if kind == "file" {
      guard let value = raw["fileUri"] as? String else {
        throw MainAppImportError.invalidInput
      }
      let file = try controlledCacheFile(value, cacheRoot: cacheRoot)
      return Input(
        id: id,
        order: expectedOrder,
        value: .file(file, mediaType, true, nil, nil)
      )
    }

    if kind == "owned-file" {
      guard let ownedRoot,
            let relativePath = raw["ownedRelativePath"] as? String,
            let sha256 = raw["sha256"] as? String else {
        throw MainAppImportError.invalidInput
      }
      let byteCount = try exactNonNegativeInteger(raw["byteCount"])
      let verification: [String: Any]
      do {
        verification = try OwnedArtifactStore.verify(
          root: ownedRoot,
          relativePath: relativePath,
          expectedByteCount: byteCount,
          expectedSha256: sha256
        )
      } catch {
        throw MainAppImportError.artifactIntegrityFailed
      }
      guard verification["status"] as? String == "verified" else {
        throw MainAppImportError.artifactIntegrityFailed
      }
      return Input(
        id: id,
        order: expectedOrder,
        value: .file(
          ownedRoot.appendingPathComponent(relativePath),
          mediaType,
          false,
          byteCount,
          sha256
        )
      )
    }

    let exactByteCount = try exactNonNegativeInteger(raw["byteCount"])
    guard ["text", "url"].contains(kind),
          let text = raw["text"] as? String,
          !text.isEmpty,
          exactByteCount <= Int64(ShareIngestionSession.maximumTextBytes),
          mediaType == (kind == "url" ? "text/uri-list" : "text/plain"),
          Int64(Data(text.utf8).count) == exactByteCount,
          kind != "url" || supportedWebURL(text) else {
      throw MainAppImportError.invalidInput
    }
    return Input(id: id, order: expectedOrder, value: .text(text, mediaType))
  }

  private static func controlledCacheFile(_ value: String, cacheRoot: URL) throws -> URL {
    guard let unresolved = URL(string: value), unresolved.isFileURL else {
      throw MainAppImportError.invalidInput
    }
    if FileManager.default.fileExists(atPath: unresolved.path) {
      let values = try unresolved.resourceValues(forKeys: [.isSymbolicLinkKey, .isDirectoryKey])
      guard values.isSymbolicLink != true, values.isDirectory != true else {
        throw MainAppImportError.invalidInput
      }
    }
    let root = cacheRoot.resolvingSymlinksInPath().standardizedFileURL
    let file = unresolved.resolvingSymlinksInPath().standardizedFileURL
    guard file.path.hasPrefix(root.path + "/") else {
      throw MainAppImportError.invalidInput
    }
    return file
  }

  private static func controlledTransientFile(_ value: String, cacheRoot: URL) throws -> URL {
    let file = try controlledCacheFile(value, cacheRoot: cacheRoot)
    let roots = transientDirectoryNames.map {
      cacheRoot.appendingPathComponent($0, isDirectory: true)
        .resolvingSymlinksInPath().standardizedFileURL.path + "/"
    }
    guard roots.contains(where: { file.path.hasPrefix($0) }),
          FileManager.default.fileExists(atPath: file.path) else {
      throw MainAppImportError.invalidInput
    }
    return file
  }

  private static func removeCacheDirectories(cacheRoot: URL, names: [String]) throws {
    let root = cacheRoot.resolvingSymlinksInPath().standardizedFileURL
    var cleanupFailed = false
    for name in names {
      let directory = root.appendingPathComponent(name, isDirectory: true)
      guard directory.standardizedFileURL.path.hasPrefix(root.path + "/") else {
        throw MainAppImportError.invalidInput
      }
      if FileManager.default.fileExists(atPath: directory.path) {
        do { try FileManager.default.removeItem(at: directory) }
        catch { cleanupFailed = true }
      }
    }
    if cleanupFailed { throw MainAppImportError.cleanupFailed }
  }

  private static func cleanupPickerTransientsUnlocked(cacheRoot: URL) throws {
    var cleanupFailed = false
    do { try removeCacheDirectories(cacheRoot: cacheRoot, names: transientDirectoryNames) }
    catch { cleanupFailed = true }
    let stageRoot = cacheRoot.resolvingSymlinksInPath().standardizedFileURL
      .appendingPathComponent(stagedDirectoryName, isDirectory: true)
    if FileManager.default.fileExists(atPath: stageRoot.path) {
      do {
        let values = try stageRoot.resourceValues(
          forKeys: [.isSymbolicLinkKey, .isDirectoryKey]
        )
        if values.isSymbolicLink == true || values.isDirectory != true {
          try FileManager.default.removeItem(at: stageRoot)
        } else {
          for child in try FileManager.default.contentsOfDirectory(
            at: stageRoot,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
          ) where child.lastPathComponent.hasSuffix(".partial") {
            do { try FileManager.default.removeItem(at: child) }
            catch { cleanupFailed = true }
          }
        }
      } catch {
        cleanupFailed = true
      }
    }
    if cleanupFailed { throw MainAppImportError.cleanupFailed }
  }

  private static func exactNonNegativeInteger(_ value: Any?) throws -> Int64 {
    guard let number = value as? NSNumber,
          CFGetTypeID(number) != CFBooleanGetTypeID(),
          number.doubleValue.isFinite,
          number.doubleValue >= 0,
          number.doubleValue.rounded(.towardZero) == number.doubleValue,
          number.doubleValue <= 9_007_199_254_740_991 else {
      throw MainAppImportError.invalidInput
    }
    return number.int64Value
  }

  private static func canonicalUUID(_ value: String) -> Bool {
    guard let uuid = UUID(uuidString: value) else { return false }
    return uuid.uuidString.lowercased() == value
  }

  private static func supportedWebURL(_ value: String) -> Bool {
    guard let components = URLComponents(string: value),
          let scheme = components.scheme?.lowercased(),
          ["http", "https"].contains(scheme),
          components.host?.isEmpty == false else {
      return false
    }
    return true
  }

  private static let mediaTypePattern =
    "^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$"
  private static let fileKeys: Set<String> = [
    "id", "order", "kind", "declaredMediaType", "byteCount", "fileUri",
  ]
  private static let ownedFileKeys: Set<String> = [
    "id", "order", "kind", "declaredMediaType", "byteCount",
    "ownedRelativePath", "sha256",
  ]
  private static let textKeys: Set<String> = [
    "id", "order", "kind", "declaredMediaType", "byteCount", "text",
  ]
}
