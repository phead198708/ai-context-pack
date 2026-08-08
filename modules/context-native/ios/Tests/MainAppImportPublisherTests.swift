import Foundation
import XCTest
@testable import ContextNativeRecovery

final class MainAppImportPublisherTests: XCTestCase {
  private var root: URL!
  private var cache: URL!

  override func setUpWithError() throws {
    root = FileManager.default.temporaryDirectory
      .appendingPathComponent("main-app-import-\(UUID().uuidString)", isDirectory: true)
    cache = root.appendingPathComponent("Cache", isDirectory: true)
    try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: root)
  }

  func testMixedPickerInputsReuseInboxWriterPreserveOrderAndRemoveCacheCopies() throws {
    let ingestionId = id()
    let imageId = id()
    let textId = id()
    let urlId = id()
    let unsupportedId = id()
    let image = try cached("selected-image.bin", bytes: Data([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]))
    let unsupported = try cached("selected-archive.bin", bytes: Data([0x50, 0x4b, 0x03, 0x04]))
    let privateText = "English 中文 🧪\n    let indentation = true"
    let longURL = "https://example.invalid/\(String(repeating: "segment/", count: 200))"

    let manifest = try MainAppImportPublisher.publish(
      container: root,
      cacheRoot: cache,
      ingestionId: ingestionId,
      source: "main-app-picker",
      rawInputs: [
        file(imageId, 0, "application/octet-stream", image),
        text(textId, 1, "text", privateText),
        text(urlId, 2, "url", longURL),
        file(unsupportedId, 3, "application/zip", unsupported),
      ]
    )

    XCTAssertEqual(manifest["source"] as? String, "main-app-picker")
    XCTAssertEqual(manifest["status"] as? String, "partial")
    let items = try XCTUnwrap(manifest["items"] as? [[String: Any]])
    XCTAssertEqual(items.compactMap { $0["id"] as? String }, [
      imageId, textId, urlId, unsupportedId,
    ])
    XCTAssertEqual(items.compactMap { $0["order"] as? Int }, [0, 1, 2, 3])
    XCTAssertEqual(items.map { $0["status"] as? String }, ["copied", "copied", "copied", "failed"])
    XCTAssertEqual(items.last?["errorCode"] as? String, "IMPORT_TYPE_UNSUPPORTED")
    XCTAssertEqual(
      try String(
        contentsOf: root
          .appendingPathComponent("Inbox/\(ingestionId)/\(textId).bin"),
        encoding: .utf8
      ),
      privateText
    )
    XCTAssertEqual(
      try String(
        contentsOf: root
          .appendingPathComponent("Inbox/\(ingestionId)/\(urlId).bin"),
        encoding: .utf8
      ),
      longURL
    )
    XCTAssertFalse(FileManager.default.fileExists(atPath: image.path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: unsupported.path))
    XCTAssertFalse(manifest.description.contains("selected-image"))
  }

  func testStaleProviderIsVisibleWhileSuccessfulTextIsPreserved() throws {
    let ingestionId = id()
    let staleId = id()
    let textId = id()
    let stale = cache.appendingPathComponent("stale-provider.pdf")
    let value = "preserved 中文"

    let manifest = try MainAppImportPublisher.publish(
      container: root,
      cacheRoot: cache,
      ingestionId: ingestionId,
      source: "main-app-picker",
      rawInputs: [
        file(staleId, 0, "application/pdf", stale),
        text(textId, 1, "text", value),
      ]
    )

    let items = try XCTUnwrap(manifest["items"] as? [[String: Any]])
    XCTAssertEqual(items[0]["errorCode"] as? String, "IMPORT_PROVIDER_PERMISSION_EXPIRED")
    XCTAssertEqual(items[1]["status"] as? String, "copied")
    XCTAssertEqual(manifest["status"] as? String, "partial")
  }

  func testReplayOfMultipleInlineItemsDoesNotReopenOrDuplicateTheImport() throws {
    let ingestionId = id()
    let first = text(id(), 0, "text", "first")
    let second = text(id(), 1, "url", "https://example.invalid/replay")

    let initial = try MainAppImportPublisher.publish(
      container: root,
      cacheRoot: cache,
      ingestionId: ingestionId,
      source: "main-app-text",
      rawInputs: [first, second]
    )
    let replay = try MainAppImportPublisher.publish(
      container: root,
      cacheRoot: cache,
      ingestionId: ingestionId,
      source: "main-app-text",
      rawInputs: [first, second]
    )

    XCTAssertEqual(initial["ingestionId"] as? String, replay["ingestionId"] as? String)
    XCTAssertEqual(
      try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("Inbox").path),
      [ingestionId]
    )
  }

  func testFailedPublishPreservesPickerCacheForRetry() throws {
    let ingestionId = id()
    let itemId = id()
    let image = try cached("retry-image.bin", bytes: Data([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]))
    let inputs = [file(itemId, 0, "application/octet-stream", image)]
    var interrupted = false

    XCTAssertThrowsError(try MainAppImportPublisher.publish(
      container: root,
      cacheRoot: cache,
      ingestionId: ingestionId,
      source: "main-app-picker",
      rawInputs: inputs,
      operationHook: { point in
        if !interrupted, case .afterFirstChunk = point {
          interrupted = true
          throw ShareIngestionFatalError.interrupted
        }
      }
    ))
    XCTAssertTrue(interrupted)
    XCTAssertTrue(FileManager.default.fileExists(atPath: image.path))

    let manifest = try MainAppImportPublisher.publish(
      container: root,
      cacheRoot: cache,
      ingestionId: ingestionId,
      source: "main-app-picker",
      rawInputs: inputs
    )
    XCTAssertEqual(manifest["status"] as? String, "complete")
    XCTAssertFalse(FileManager.default.fileExists(atPath: image.path))
  }

  func testCommittedImportSurfacesCacheCleanupFailureAndReplaysWithoutDuplication() throws {
    let ingestionId = id()
    let itemId = id()
    let image = try cached("cleanup-retry-image.bin", bytes: Data([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]))
    let inputs = [file(itemId, 0, "application/octet-stream", image)]

    XCTAssertThrowsError(try MainAppImportPublisher.publish(
      container: root,
      cacheRoot: cache,
      ingestionId: ingestionId,
      source: "main-app-picker",
      rawInputs: inputs,
      removeCacheFile: { _ in throw MainAppImportError.cleanupFailed }
    )) { error in
      XCTAssertEqual(error as? MainAppImportError, .committedCleanupRequired)
      XCTAssertEqual(
        (error as? MainAppImportError)?.stableCode,
        "MAIN_APP_IMPORT_COMMITTED_CLEANUP_REQUIRED"
      )
    }
    XCTAssertTrue(FileManager.default.fileExists(atPath: image.path))
    XCTAssertEqual(
      try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("Inbox").path),
      [ingestionId]
    )

    let replay = try MainAppImportPublisher.publish(
      container: root,
      cacheRoot: cache,
      ingestionId: ingestionId,
      source: "main-app-picker",
      rawInputs: inputs
    )
    XCTAssertEqual(replay["status"] as? String, "complete")
    XCTAssertFalse(FileManager.default.fileExists(atPath: image.path))
    XCTAssertEqual(
      try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("Inbox").path),
      [ingestionId]
    )
  }

  func testFailedItemRetainsOwnedBytesAndRetriesAfterInboxAcknowledgement() throws {
    let firstIngestionId = id()
    let failedItemId = id()
    let bytes = Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    let replacement = Data(repeating: 0x41, count: bytes.count)
    let image = try cached("persisted-retry.bin", bytes: bytes)
    let failed = try MainAppImportPublisher.publish(
      container: root,
      cacheRoot: cache,
      ingestionId: firstIngestionId,
      source: "main-app-picker",
      rawInputs: [file(failedItemId, 0, "application/pdf", image)],
      operationHook: { point in
        if case .afterFirstChunk = point { try replacement.write(to: image) }
      }
    )
    let failedItems = try XCTUnwrap(failed["items"] as? [[String: Any]])
    XCTAssertEqual(failedItems[0]["status"] as? String, "failed")
    XCTAssertEqual(failedItems[0]["mediaType"] as? String, "image/png")
    XCTAssertEqual((failedItems[0]["retryByteCount"] as? NSNumber)?.intValue, bytes.count)
    XCTAssertEqual((failedItems[0]["retrySha256"] as? String)?.count, 64)
    let retry = root.appendingPathComponent(
      "Inbox/\(firstIngestionId)/\(failedItemId).retry"
    )
    XCTAssertEqual(try Data(contentsOf: retry), bytes)

    let ownedRoot = root.appendingPathComponent("ApplicationSupport", isDirectory: true)
    let outside = root.appendingPathComponent("outside-retry.bin")
    try bytes.write(to: outside)
    XCTAssertThrowsError(try InboxArtifactHandoff.handoff(
      container: root,
      applicationSupport: ownedRoot,
      ingestionId: firstIngestionId,
      packId: firstIngestionId,
      requiredHeadroomBytes: 0,
      availableBytes: { _ in Int64.max },
      operationHook: { point in
        if case .beforeCopy = point {
          try FileManager.default.removeItem(at: retry)
          try FileManager.default.createSymbolicLink(at: retry, withDestinationURL: outside)
        }
      }
    )) { error in
      XCTAssertEqual(error as? InboxArtifactHandoffError, .integrityFailed)
    }
    try FileManager.default.removeItem(at: retry)
    try bytes.write(to: retry)
    let handoff = try InboxArtifactHandoff.handoff(
      container: root,
      applicationSupport: ownedRoot,
      ingestionId: firstIngestionId,
      packId: firstIngestionId,
      requiredHeadroomBytes: 0,
      availableBytes: { _ in Int64.max }
    )
    let artifacts = try XCTUnwrap(handoff["artifacts"] as? [[String: Any]])
    let artifact = try XCTUnwrap(artifacts.first)
    let relativePath = try XCTUnwrap(artifact["relativePath"] as? String)
    let byteCount = try XCTUnwrap((artifact["byteCount"] as? NSNumber)?.int64Value)
    let sha256 = try XCTUnwrap(artifact["sha256"] as? String)
    XCTAssertEqual(byteCount, Int64(bytes.count))
    XCTAssertTrue(try InboxArtifactHandoff.acknowledge(
      container: root,
      ingestionId: firstIngestionId
    ))

    XCTAssertThrowsError(try MainAppImportPublisher.publish(
      container: root,
      cacheRoot: cache,
      ownedRoot: ownedRoot,
      ingestionId: id(),
      source: "main-app-picker",
      rawInputs: [[
        "id": id(),
        "order": 0,
        "kind": "owned-file",
        "declaredMediaType": "image/png",
        "byteCount": byteCount,
        "ownedRelativePath": relativePath,
        "sha256": String(repeating: "0", count: 64),
      ]]
    )) { error in
      XCTAssertEqual(error as? MainAppImportError, .artifactIntegrityFailed)
    }

    let retried = try MainAppImportPublisher.publish(
      container: root,
      cacheRoot: cache,
      ownedRoot: ownedRoot,
      ingestionId: id(),
      source: "main-app-picker",
      rawInputs: [[
        "id": id(),
        "order": 0,
        "kind": "owned-file",
        "declaredMediaType": "image/png",
        "byteCount": byteCount,
        "ownedRelativePath": relativePath,
        "sha256": sha256,
      ]]
    )
    XCTAssertEqual(retried["status"] as? String, "complete")
  }

  func testBoundaryRejectsInvalidURLByteCountAndPathsOutsideCache() throws {
    let outside = try cached("outside.bin", bytes: Data("fixture".utf8), directory: root)
    let directory = cache.appendingPathComponent("selected-directory", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let cases: [[[String: Any]]] = [
      [text(id(), 0, "url", "file:///private/value")],
      [text(id(), 0, "url", "http:example.invalid")],
      [[
        "id": id(),
        "order": 0,
        "kind": "text",
        "declaredMediaType": "text/plain",
        "byteCount": 1,
        "text": "中文",
      ]],
      [[
        "id": id(),
        "order": 0,
        "kind": "text",
        "declaredMediaType": "text/plain",
        "byteCount": ShareIngestionSession.maximumTextBytes + 1,
        "text": "x",
      ]],
      [file(id(), 0, "application/octet-stream", outside)],
      [file(id(), 0, "application/octet-stream", directory)],
    ]

    for inputs in cases {
      XCTAssertThrowsError(
        try MainAppImportPublisher.publish(
          container: root,
          cacheRoot: cache,
          ingestionId: id(),
          source: inputs[0]["kind"] as? String == "file" ? "main-app-picker" : "main-app-text",
          rawInputs: inputs
        )
      ) { error in
        XCTAssertEqual(error as? MainAppImportError, .invalidInput)
      }
    }
  }

  func testDiscardRemovesOnlyControlledCacheFiles() throws {
    let selected = try cached("cancelled.pdf", bytes: Data("fixture".utf8))
    XCTAssertTrue(
      try MainAppImportPublisher.discard(
        cacheRoot: cache,
        fileUris: [selected.absoluteString]
      )
    )
    XCTAssertFalse(FileManager.default.fileExists(atPath: selected.path))
    XCTAssertThrowsError(
      try MainAppImportPublisher.discard(
        cacheRoot: cache,
        fileUris: [root.appendingPathComponent("outside.pdf").absoluteString]
      )
    )
  }

  func testPickerStagingIsAnonymousAndRecoverySweepsOrphans() throws {
    let documentRoot = cache.appendingPathComponent("DocumentPicker", isDirectory: true)
    let imageRoot = cache.appendingPathComponent("ImagePicker", isDirectory: true)
    try FileManager.default.createDirectory(at: documentRoot, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: imageRoot, withIntermediateDirectories: true)
    let document = try cached("private-name.pdf", bytes: Data("pdf".utf8), directory: documentRoot)
    let image = try cached("private-name.png", bytes: Data("png".utf8), directory: imageRoot)

    let staged = try MainAppImportPublisher.stagePickerFiles(
      cacheRoot: cache,
      fileUris: [document.absoluteString, image.absoluteString]
    )

    XCTAssertFalse(FileManager.default.fileExists(atPath: document.path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: image.path))
    XCTAssertEqual(staged.count, 2)
    XCTAssertTrue(staged.allSatisfy { value in
      value.contains("/AIContextPackMainAppPicker/") && value.hasSuffix(".bin")
    })
    XCTAssertFalse(staged.joined().contains("private-name"))

    let orphan = try cached("orphan.pdf", bytes: Data("orphan".utf8), directory: documentRoot)
    let partial = cache.appendingPathComponent(
      "AIContextPackMainAppPicker/abandoned.partial",
      isDirectory: true
    )
    try FileManager.default.createDirectory(at: partial, withIntermediateDirectories: true)
    try Data("partial".utf8).write(to: partial.appendingPathComponent("orphan.bin"))
    XCTAssertTrue(try MainAppImportPublisher.cleanupPickerTransients(cacheRoot: cache))
    XCTAssertFalse(FileManager.default.fileExists(atPath: orphan.path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: partial.path))
    XCTAssertTrue(staged.allSatisfy { value in
      URL(string: value).map { FileManager.default.fileExists(atPath: $0.path) } == true
    })

    XCTAssertTrue(try MainAppImportPublisher.recoverPickerCache(cacheRoot: cache))
    XCTAssertTrue(staged.allSatisfy { value in
      URL(string: value).map { !FileManager.default.fileExists(atPath: $0.path) } == true
    })

    let outside = root.appendingPathComponent("outside-stage", isDirectory: true)
    try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
    let sentinel = outside.appendingPathComponent("sentinel.bin")
    try Data("sentinel".utf8).write(to: sentinel)
    let invalidStageRoot = cache.appendingPathComponent(
      "AIContextPackMainAppPicker",
      isDirectory: true
    )
    try FileManager.default.createSymbolicLink(at: invalidStageRoot, withDestinationURL: outside)
    XCTAssertTrue(try MainAppImportPublisher.cleanupPickerTransients(cacheRoot: cache))
    XCTAssertFalse(FileManager.default.fileExists(atPath: invalidStageRoot.path))
    XCTAssertTrue(FileManager.default.fileExists(atPath: sentinel.path))
  }

  private func id() -> String { UUID().uuidString.lowercased() }

  private func cached(
    _ name: String,
    bytes: Data,
    directory: URL? = nil
  ) throws -> URL {
    let url = (directory ?? cache).appendingPathComponent(name)
    try bytes.write(to: url)
    return url
  }

  private func file(
    _ id: String,
    _ order: Int,
    _ mediaType: String,
    _ url: URL
  ) -> [String: Any] {
    [
      "id": id,
      "order": order,
      "kind": "file",
      "declaredMediaType": mediaType,
      "byteCount": (try? Data(contentsOf: url).count) ?? 0,
      "fileUri": url.absoluteString,
    ]
  }

  private func text(
    _ id: String,
    _ order: Int,
    _ kind: String,
    _ value: String
  ) -> [String: Any] {
    [
      "id": id,
      "order": order,
      "kind": kind,
      "declaredMediaType": kind == "url" ? "text/uri-list" : "text/plain",
      "byteCount": Data(value.utf8).count,
      "text": value,
    ]
  }
}
