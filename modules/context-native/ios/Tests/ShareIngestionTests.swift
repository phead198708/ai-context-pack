import Darwin
import Foundation
import XCTest
@testable import ContextNativeRecovery

final class ShareIngestionTests: XCTestCase {
  private var root: URL!

  override func setUpWithError() throws {
    root = FileManager.default.temporaryDirectory
      .appendingPathComponent("share-ingestion-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: root)
  }

  func testFileBackedPlainTextIsPreferredOverTemporaryFileURL() throws {
    let representation = try XCTUnwrap(
      ShareRepresentationSelector.select(["public.file-url", "public.plain-text"])
    )

    XCTAssertEqual(representation.identifier, "public.plain-text")
    XCTAssertEqual(representation.mediaType, "text/plain")
    XCTAssertEqual(representation.kind, .text)
  }

  func testWebURLIsSelectedWhenNoPlainTextRepresentationExists() throws {
    let representation = try XCTUnwrap(
      ShareRepresentationSelector.select(["public.url"])
    )

    XCTAssertEqual(representation.identifier, "public.url")
    XCTAssertEqual(representation.mediaType, "text/uri-list")
    XCTAssertEqual(representation.kind, .webURL)
  }

  func testGenericDataAndFileURLProvidersUseFileBackedByteDetection() throws {
    let data = try XCTUnwrap(ShareRepresentationSelector.select(["public.data"]))
    let fileURL = try XCTUnwrap(ShareRepresentationSelector.select(["public.file-url"]))

    XCTAssertEqual(data.kind, .file)
    XCTAssertEqual(data.mediaType, "application/octet-stream")
    XCTAssertEqual(fileURL.kind, .fileURL)
    XCTAssertEqual(fileURL.mediaType, "application/octet-stream")
  }

  func testFileURLProviderLoadsTheUnderlyingBytesInsteadOfItsURLRepresentation() throws {
    let source = root.appendingPathComponent("generic-provider.png")
    let bytes = Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    try bytes.write(to: source)
    let provider = NSItemProvider(item: source as NSURL, typeIdentifier: "public.file-url")
    let representation = try XCTUnwrap(
      ShareRepresentationSelector.select(provider.registeredTypeIdentifiers)
    )
    let loaded = expectation(description: "underlying file URL loaded")

    ShareProviderFileLoader.load(provider: provider, representation: representation) { result in
      defer { loaded.fulfill() }
      switch result {
      case .success(let loadedSource):
        XCTAssertEqual(try? Data(contentsOf: loadedSource), bytes)
      case .failure(let error):
        XCTFail("unexpected provider failure: \(error)")
      }
    }

    wait(for: [loaded], timeout: 2)
  }

  func testGenericDataProviderStreamsIntoByteDetection() throws {
    let bytes = Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    let provider = NSItemProvider()
    provider.registerDataRepresentation(
      forTypeIdentifier: "public.data",
      visibility: .all
    ) { completion in
      completion(bytes, nil)
      return nil
    }
    let representation = try XCTUnwrap(
      ShareRepresentationSelector.select(provider.registeredTypeIdentifiers)
    )
    let ingestionId = UUID().uuidString.lowercased()
    let session = try ShareIngestionSession(container: root, ingestionId: ingestionId)
    let loaded = expectation(description: "generic provider copied")
    var capturedResult: Result<ShareIngestionSummary, Error>?

    ShareProviderFileLoader.load(provider: provider, representation: representation) { result in
      defer { loaded.fulfill() }
      capturedResult = Result {
        let source = try result.get()
        try session.recordFile(
          id: UUID().uuidString.lowercased(),
          order: 0,
          declaredMediaType: representation.mediaType,
          source: source
        )
        return try session.finish()
      }
    }

    wait(for: [loaded], timeout: 2)
    let summary = try XCTUnwrap(capturedResult).get()
    let items = try XCTUnwrap(summary.manifest["items"] as? [[String: Any]])
    XCTAssertEqual(items.first?["mediaType"] as? String, "image/png")
  }

  func testWebURLProviderLoadsAFileBackedRepresentation() throws {
    let expected = "https://example.invalid/path?q=synthetic"
    let provider = NSItemProvider(object: try XCTUnwrap(NSURL(string: expected)))
    let representation = try XCTUnwrap(
      ShareRepresentationSelector.select(provider.registeredTypeIdentifiers)
    )
    let loaded = expectation(description: "web URL provider file loaded")

    ShareProviderFileLoader.load(provider: provider, representation: representation) { result in
      defer { loaded.fulfill() }
      do {
        let source = try result.get()
        XCTAssertEqual(try String(contentsOf: source, encoding: .utf8), expected)
      } catch {
        XCTFail("unexpected provider failure: \(error)")
      }
    }

    wait(for: [loaded], timeout: 2)
  }

  func testPlainTextProviderLoadsAFileBackedRepresentation() throws {
    let provider = NSItemProvider(object: "synthetic text" as NSString)
    let representation = try XCTUnwrap(
      ShareRepresentationSelector.select(provider.registeredTypeIdentifiers)
    )
    let loaded = expectation(description: "provider file loaded")

    ShareProviderFileLoader.load(provider: provider, representation: representation) { result in
      defer { loaded.fulfill() }
      do {
        let source = try result.get()
        XCTAssertEqual(try Data(contentsOf: source), Data("synthetic text".utf8))
      } catch {
        XCTFail("unexpected provider failure: \(error)")
      }
    }

    wait(for: [loaded], timeout: 2)
  }

  func testProviderFileAccessFailureMapsToTheStableExpiryCode() throws {
    let provider = NSItemProvider()
    provider.registerFileRepresentation(
      forTypeIdentifier: "public.data",
      fileOptions: [],
      visibility: .all
    ) { completion in
      completion(
        nil,
        false,
        NSError(domain: "SyntheticProvider", code: 1)
      )
      return nil
    }
    let representation = try XCTUnwrap(
      ShareRepresentationSelector.select(provider.registeredTypeIdentifiers)
    )
    let failed = expectation(description: "provider access failed")

    ShareProviderFileLoader.load(provider: provider, representation: representation) { result in
      defer { failed.fulfill() }
      switch result {
      case .success:
        XCTFail("provider unexpectedly produced a file")
      case .failure(let error):
        XCTAssertEqual(error.stableCode, "IMPORT_PROVIDER_PERMISSION_EXPIRED")
      }
    }

    wait(for: [failed], timeout: 2)
  }

  func testTwentyImagesPreserveOrderAndPassProductionManifestValidation() throws {
    let ingestionId = UUID().uuidString.lowercased()
    let session = try ShareIngestionSession(container: root, ingestionId: ingestionId)
    for order in 0..<20 {
      try session.recordFile(
        id: UUID().uuidString.lowercased(),
        order: order,
        declaredMediaType: "image/png",
        source: fixture("ocr-english.png")
      )
    }

    let result = try session.finish()
    let manifest = try InboxManifestValidator.readPublished(
      inbox: root.appendingPathComponent("Inbox"),
      ingestionId: ingestionId
    )

    XCTAssertEqual(result.status, "complete")
    XCTAssertEqual(result.copied, 20)
    let items = try XCTUnwrap(manifest["items"] as? [[String: Any]])
    XCTAssertEqual(items.compactMap { $0["order"] as? Int }, Array(0..<20))
    XCTAssertTrue(items.allSatisfy { $0["mediaType"] as? String == "image/png" })
    XCTAssertTrue(items.allSatisfy { $0["sha256"] as? String != nil })
    XCTAssertTrue(items.allSatisfy { $0["providerUri"] == nil && $0["localUri"] == nil })
  }

  func testPdfTextUrlAndUnsupportedInputPublishOnePartialManifest() throws {
    let session = try ShareIngestionSession(
      container: root,
      ingestionId: UUID().uuidString.lowercased()
    )
    try session.recordFile(
      id: UUID().uuidString.lowercased(),
      order: 0,
      declaredMediaType: "application/pdf",
      source: fixture("text-one-page.pdf")
    )
    try session.recordData(
      id: UUID().uuidString.lowercased(),
      order: 1,
      declaredMediaType: "text/plain",
      data: Data("synthetic plain text".utf8)
    )
    try session.recordData(
      id: UUID().uuidString.lowercased(),
      order: 2,
      declaredMediaType: "text/plain",
      data: Data("https://example.invalid/path?token=synthetic".utf8)
    )
    try session.recordData(
      id: UUID().uuidString.lowercased(),
      order: 3,
      declaredMediaType: "application/zip",
      data: Data([0x50, 0x4b, 0x03, 0x04])
    )

    let result = try session.finish()

    XCTAssertEqual(result.status, "partial")
    XCTAssertEqual(result.copied, 3)
    XCTAssertEqual(result.rejected, 1)
    XCTAssertEqual(result.failed, 0)
    let items = try XCTUnwrap(result.manifest["items"] as? [[String: Any]])
    XCTAssertEqual(
      items.compactMap { $0["mediaType"] as? String },
      ["application/pdf", "text/plain", "text/uri-list", "application/zip"]
    )
    XCTAssertEqual(items.last?["errorCode"] as? String, "IMPORT_TYPE_UNSUPPORTED")
  }

  func testMixedCaseHttpsSchemeIsDetectedAsAWebURL() throws {
    let session = try ShareIngestionSession(
      container: root,
      ingestionId: UUID().uuidString.lowercased()
    )
    try session.recordData(
      id: UUID().uuidString.lowercased(),
      order: 0,
      declaredMediaType: "text/plain",
      data: Data("HTTPS://example.invalid/path".utf8)
    )

    let result = try session.finish()
    let item = try XCTUnwrap((result.manifest["items"] as? [[String: Any]])?.first)

    XCTAssertEqual(item["mediaType"] as? String, "text/uri-list")
  }

  func testPublishedReplayDoesNotReadTheProviderAgain() throws {
    let ingestionId = UUID().uuidString.lowercased()
    let source = try sourceCopy("replay-provider.png", from: fixture("ocr-english.png"))
    let itemId = UUID().uuidString.lowercased()
    let first = try ShareIngestionSession(container: root, ingestionId: ingestionId)
    try first.recordFile(id: itemId, order: 0, declaredMediaType: "image/png", source: source)
    _ = try first.finish()
    try FileManager.default.removeItem(at: source)

    let replay = try ShareIngestionSession(container: root, ingestionId: ingestionId)
    let result = try replay.finish()

    XCTAssertTrue(result.replayed)
    XCTAssertEqual(result.copied, 1)
    XCTAssertEqual(
      try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("Inbox").path).count,
      1
    )
  }

  func testPublishedReplayFailsClosedWhenOwnedArtifactWasModified() throws {
    let ingestionId = UUID().uuidString.lowercased()
    let itemId = UUID().uuidString.lowercased()
    let first = try ShareIngestionSession(container: root, ingestionId: ingestionId)
    try first.recordFile(
      id: itemId,
      order: 0,
      declaredMediaType: "image/png",
      source: fixture("ocr-english.png")
    )
    _ = try first.finish()
    let artifact = root.appendingPathComponent("Inbox/\(ingestionId)/\(itemId).bin")
    let handle = try FileHandle(forWritingTo: artifact)
    try handle.seekToEnd()
    try handle.write(contentsOf: Data([0x00]))
    try handle.close()

    XCTAssertThrowsError(
      try ShareIngestionSession(container: root, ingestionId: ingestionId)
    ) { error in
      XCTAssertEqual(error as? InboxManifestValidationError, .artifactIntegrityFailed)
    }
  }

  func testConcurrentDuplicatePublishReplaysAfterWriterOwnershipTransfers() throws {
    let ingestionId = UUID().uuidString.lowercased()
    let itemId = UUID().uuidString.lowercased()
    let first = try ShareIngestionSession(container: root, ingestionId: ingestionId)
    let attempted = expectation(description: "duplicate writer attempted")
    let completed = expectation(description: "duplicate writer completed")
    let resultLock = NSLock()
    var duplicateResult: Result<ShareIngestionSummary, Error>?

    DispatchQueue.global(qos: .userInitiated).async {
      attempted.fulfill()
      let result = Result {
        let duplicate = try ShareIngestionSession(container: self.root, ingestionId: ingestionId)
        return try duplicate.finish()
      }
      resultLock.lock()
      duplicateResult = result
      resultLock.unlock()
      completed.fulfill()
    }
    wait(for: [attempted], timeout: 1)
    Thread.sleep(forTimeInterval: 0.05)
    try first.recordFile(
      id: itemId,
      order: 0,
      declaredMediaType: "image/png",
      source: fixture("ocr-english.png")
    )
    _ = try first.finish()
    wait(for: [completed], timeout: 2)

    resultLock.lock()
    let result = duplicateResult
    resultLock.unlock()
    XCTAssertTrue(try XCTUnwrap(result).get().replayed)
  }

  func testReplayOwnershipBlocksAcknowledgementBetweenManifestCheckAndRead() throws {
    let ingestionId = UUID().uuidString.lowercased()
    let itemId = UUID().uuidString.lowercased()
    let first = try ShareIngestionSession(container: root, ingestionId: ingestionId)
    try first.recordFile(
      id: itemId,
      order: 0,
      declaredMediaType: "image/png",
      source: fixture("ocr-english.png")
    )
    _ = try first.finish()

    let applicationSupport = root.appendingPathComponent("ApplicationSupport", isDirectory: true)
    try FileManager.default.createDirectory(
      at: applicationSupport,
      withIntermediateDirectories: true
    )
    let manifestChecked = expectation(description: "replay checked manifest while owned")
    let replayCompleted = expectation(description: "replay completed")
    let allowManifestRead = DispatchSemaphore(value: 0)
    let resultLock = NSLock()
    var replayResult: Result<ShareIngestionSummary, Error>?

    DispatchQueue.global(qos: .userInitiated).async {
      let result = Result {
        let replay = try ShareIngestionSession(
          container: self.root,
          ingestionId: ingestionId,
          operationHook: { point in
            if case .afterLockedReplayManifestCheck = point {
              manifestChecked.fulfill()
              guard allowManifestRead.wait(timeout: .now() + 5) == .success else {
                throw ShareIngestionFatalError.interrupted
              }
            }
          }
        )
        return try replay.finish()
      }
      resultLock.lock()
      replayResult = result
      resultLock.unlock()
      replayCompleted.fulfill()
    }

    wait(for: [manifestChecked], timeout: 2)
    let packId = UUID().uuidString.lowercased()
    _ = try InboxArtifactHandoff.handoff(
      container: root,
      applicationSupport: applicationSupport,
      ingestionId: ingestionId,
      packId: packId,
      requiredHeadroomBytes: 0,
      availableBytes: { _ in Int64.max }
    )
    XCTAssertThrowsError(try InboxArtifactHandoff.acknowledge(
      container: root,
      ingestionId: ingestionId
    )) { error in
      XCTAssertEqual(error as? InboxArtifactHandoffError, .acknowledgementBlocked)
    }

    allowManifestRead.signal()
    wait(for: [replayCompleted], timeout: 2)
    resultLock.lock()
    let result = replayResult
    resultLock.unlock()
    XCTAssertTrue(try XCTUnwrap(result).get().replayed)
    XCTAssertTrue(try InboxArtifactHandoff.acknowledge(
      container: root,
      ingestionId: ingestionId
    ))
    XCTAssertTrue(FileManager.default.fileExists(
      atPath: applicationSupport
        .appendingPathComponent("Packs/\(packId)/originals/\(itemId).bin")
        .path
    ))
  }

  func testConcurrentDifferentIdsPublishFromAnEmptyContainer() throws {
    let readyToCreateSharedDirectory = expectation(description: "writers reached shared create")
    readyToCreateSharedDirectory.expectedFulfillmentCount = 2
    let completed = expectation(description: "different-ID writers completed")
    completed.expectedFulfillmentCount = 2
    let allowCreation = DispatchSemaphore(value: 0)
    let resultLock = NSLock()
    var results: [Result<ShareIngestionSummary, Error>] = []

    for _ in 0..<2 {
      let ingestionId = UUID().uuidString.lowercased()
      DispatchQueue.global(qos: .userInitiated).async {
        var interceptedFirstCreate = false
        let result = Result {
          let session = try ShareIngestionSession(
            container: self.root,
            ingestionId: ingestionId,
            operationHook: { point in
              if case .beforeSharedDirectoryCreate = point, !interceptedFirstCreate {
                interceptedFirstCreate = true
                readyToCreateSharedDirectory.fulfill()
                guard allowCreation.wait(timeout: .now() + 5) == .success else {
                  throw ShareIngestionFatalError.interrupted
                }
              }
            }
          )
          try session.recordFile(
            id: UUID().uuidString.lowercased(),
            order: 0,
            declaredMediaType: "image/png",
            source: self.fixture("ocr-english.png")
          )
          return try session.finish()
        }
        resultLock.lock()
        results.append(result)
        resultLock.unlock()
        completed.fulfill()
      }
    }

    wait(for: [readyToCreateSharedDirectory], timeout: 2)
    allowCreation.signal()
    allowCreation.signal()
    wait(for: [completed], timeout: 5)

    resultLock.lock()
    let capturedResults = results
    resultLock.unlock()
    let summaries = try capturedResults.map { try $0.get() }
    XCTAssertEqual(summaries.count, 2)
    XCTAssertTrue(summaries.allSatisfy { $0.status == "complete" && $0.copied == 1 })
    XCTAssertEqual(
      try FileManager.default.contentsOfDirectory(
        atPath: root.appendingPathComponent("Inbox").path
      ).count,
      2
    )
  }

  func testPreexistingSharedDirectoriesStillReachParentDurabilityBoundary() throws {
    let first = try ShareIngestionSession(
      container: root,
      ingestionId: UUID().uuidString.lowercased()
    )
    try first.recordFile(
      id: UUID().uuidString.lowercased(),
      order: 0,
      declaredMediaType: "image/png",
      source: fixture("ocr-english.png")
    )
    _ = try first.finish()
    var parentSyncs = 0
    let second = try ShareIngestionSession(
      container: root,
      ingestionId: UUID().uuidString.lowercased(),
      operationHook: { point in
        if case .beforeSharedDirectoryParentSync = point {
          parentSyncs += 1
        }
      }
    )

    try second.recordFile(
      id: UUID().uuidString.lowercased(),
      order: 0,
      declaredMediaType: "image/png",
      source: fixture("ocr-english.png")
    )
    let summary = try second.finish()

    XCTAssertEqual(summary.status, "complete")
    XCTAssertEqual(parentSyncs, 2)
  }

  func testProviderCanDisappearAfterCopyAndOwnedHandoffStillSucceeds() throws {
    let ingestionId = UUID().uuidString.lowercased()
    let packId = UUID().uuidString.lowercased()
    let itemId = UUID().uuidString.lowercased()
    let applicationSupport = root.appendingPathComponent("ApplicationSupport", isDirectory: true)
    try FileManager.default.createDirectory(at: applicationSupport, withIntermediateDirectories: true)
    let source = try sourceCopy("ephemeral-provider.png", from: fixture("ocr-english.png"))
    let session = try ShareIngestionSession(container: root, ingestionId: ingestionId)
    try session.recordFile(id: itemId, order: 0, declaredMediaType: "image/png", source: source)
    try FileManager.default.removeItem(at: source)
    _ = try session.finish()

    let handoff = try InboxArtifactHandoff.handoff(
      container: root,
      applicationSupport: applicationSupport,
      ingestionId: ingestionId,
      packId: packId,
      requiredHeadroomBytes: 0,
      availableBytes: { _ in Int64.max }
    )

    XCTAssertEqual((handoff["artifacts"] as? [[String: Any]])?.count, 1)
    XCTAssertTrue(FileManager.default.fileExists(
      atPath: applicationSupport.appendingPathComponent("Packs/\(packId)/originals/\(itemId).bin").path
    ))
  }

  func testFailedOnlyManifestHandsOffAndAcknowledgesWithoutCreatingAnArtifact() throws {
    let ingestionId = UUID().uuidString.lowercased()
    let packId = UUID().uuidString.lowercased()
    let applicationSupport = root.appendingPathComponent("ApplicationSupport", isDirectory: true)
    try FileManager.default.createDirectory(at: applicationSupport, withIntermediateDirectories: true)
    let session = try ShareIngestionSession(container: root, ingestionId: ingestionId)
    try session.recordFailure(
      id: UUID().uuidString.lowercased(),
      order: 0,
      declaredMediaType: "text/plain",
      code: "IMPORT_PROVIDER_PERMISSION_EXPIRED"
    )
    _ = try session.finish()

    let handoff = try InboxArtifactHandoff.handoff(
      container: root,
      applicationSupport: applicationSupport,
      ingestionId: ingestionId,
      packId: packId,
      requiredHeadroomBytes: 0,
      availableBytes: { _ in Int64.max }
    )

    XCTAssertEqual((handoff["artifacts"] as? [[String: Any]])?.count, 0)
    XCTAssertTrue(try InboxArtifactHandoff.acknowledge(container: root, ingestionId: ingestionId))
    XCTAssertFalse(FileManager.default.fileExists(
      atPath: root.appendingPathComponent("Inbox/\(ingestionId)").path
    ))
  }

  func testInterruptionBeforeDirectoryPublishExposesNoHalfImportAndRetryIsClean() throws {
    let ingestionId = UUID().uuidString.lowercased()
    let itemId = UUID().uuidString.lowercased()
    XCTAssertThrowsError(try interruptedImport(ingestionId: ingestionId, itemId: itemId)) { error in
      XCTAssertEqual(error as? ShareIngestionFatalError, .interrupted)
    }
    XCTAssertFalse(FileManager.default.fileExists(
      atPath: root.appendingPathComponent("Inbox/\(ingestionId)").path
    ))

    let retry = try ShareIngestionSession(container: root, ingestionId: ingestionId)
    try retry.recordFile(
      id: itemId,
      order: 0,
      declaredMediaType: "image/png",
      source: fixture("ocr-english.png")
    )
    let result = try retry.finish()

    XCTAssertEqual(result.copied, 1)
    XCTAssertEqual(
      try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("Inbox").path).count,
      1
    )
  }

  func testFailureAfterDirectoryRenameReturnsTheAlreadyVisibleCommittedImport() throws {
    let ingestionId = UUID().uuidString.lowercased()
    let itemId = UUID().uuidString.lowercased()
    let session = try ShareIngestionSession(
      container: root,
      ingestionId: ingestionId,
      operationHook: { point in
        if case .afterDirectoryPublish = point {
          throw ShareIngestionFatalError.interrupted
        }
      }
    )
    try session.recordFile(
      id: itemId,
      order: 0,
      declaredMediaType: "image/png",
      source: fixture("ocr-english.png")
    )

    let result = try session.finish()

    XCTAssertEqual(result.status, "complete")
    XCTAssertEqual(result.copied, 1)
    XCTAssertTrue(FileManager.default.fileExists(
      atPath: root.appendingPathComponent("Inbox/\(ingestionId)/manifest.json").path
    ))
    XCTAssertTrue(try ShareIngestionSession(
      container: root,
      ingestionId: ingestionId
    ).finish().replayed)
  }

  func testOversizedTextAndDeclaredTypeMismatchHaveStableRejectedCodes() throws {
    let session = try ShareIngestionSession(
      container: root,
      ingestionId: UUID().uuidString.lowercased()
    )
    try session.recordData(
      id: UUID().uuidString.lowercased(),
      order: 0,
      declaredMediaType: "text/plain",
      data: Data(repeating: 0x78, count: ShareIngestionSession.maximumTextBytes + 1)
    )
    try session.recordFile(
      id: UUID().uuidString.lowercased(),
      order: 1,
      declaredMediaType: "image/png",
      source: fixture("text-one-page.pdf")
    )

    let result = try session.finish()
    let items = try XCTUnwrap(result.manifest["items"] as? [[String: Any]])

    XCTAssertEqual(result.status, "failed")
    XCTAssertEqual(result.rejected, 2)
    XCTAssertEqual(
      items.compactMap { $0["errorCode"] as? String },
      ["IMPORT_SIZE_LIMIT_EXCEEDED", "IMPORT_TYPE_UNSUPPORTED"]
    )
    XCTAssertEqual(items[1]["mediaType"] as? String, "application/pdf")
  }

  func testOversizedDeclaredMimeFallsBackBeforeManifestSerialization() throws {
    let session = try ShareIngestionSession(
      container: root,
      ingestionId: UUID().uuidString.lowercased()
    )
    try session.recordFailure(
      id: UUID().uuidString.lowercased(),
      order: 0,
      declaredMediaType: "application/" + String(repeating: "x", count: 500_000),
      code: "IMPORT_COPY_FAILED"
    )

    let result = try session.finish()
    let items = try XCTUnwrap(result.manifest["items"] as? [[String: Any]])
    XCTAssertEqual(items.count, 1)
    let item = try XCTUnwrap(items.first)

    XCTAssertEqual(item["mediaType"] as? String, "application/octet-stream")
    let manifest = root.appendingPathComponent("Inbox/\(result.ingestionId)/manifest.json")
    XCTAssertLessThan(try Data(contentsOf: manifest).count, 2_000)
  }

  func testStorageFailureDuringItemPublicationAbortsInsteadOfBecomingAnItemFailure() throws {
    let ingestionId = UUID().uuidString.lowercased()
    var session: ShareIngestionSession? = try ShareIngestionSession(
      container: root,
      ingestionId: ingestionId,
      operationHook: { point in
        if case .beforeItemPublish = point {
          throw ShareIngestionFatalError.storageWriteFailed
        }
      }
    )

    XCTAssertThrowsError(
      try session?.recordData(
        id: UUID().uuidString.lowercased(),
        order: 0,
        declaredMediaType: "text/plain",
        data: Data("synthetic text".utf8)
      )
    ) { error in
      XCTAssertEqual(error as? ShareIngestionFatalError, .storageWriteFailed)
    }
    session = nil
    XCTAssertFalse(FileManager.default.fileExists(
      atPath: root.appendingPathComponent("InboxStaging/\(ingestionId)").path
    ))
  }

  func testTwentyFirstItemRemainsVisibleAsAStableRejection() throws {
    let session = try ShareIngestionSession(
      container: root,
      ingestionId: UUID().uuidString.lowercased()
    )
    for order in 0..<20 {
      try session.recordData(
        id: UUID().uuidString.lowercased(),
        order: order,
        declaredMediaType: "text/plain",
        data: Data("item-\(order)".utf8)
      )
    }
    try session.recordFailure(
      id: UUID().uuidString.lowercased(),
      order: 20,
      declaredMediaType: "text/plain",
      code: "IMPORT_SIZE_LIMIT_EXCEEDED"
    )

    let result = try session.finish()

    XCTAssertEqual(result.status, "partial")
    XCTAssertEqual(result.copied, 20)
    XCTAssertEqual(result.rejected, 1)
    XCTAssertEqual((result.manifest["items"] as? [[String: Any]])?.count, 21)
  }

  func testWildcardImageUsesDetectedBinaryLimitInsteadOfProviderHint() throws {
    var image = Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    image.append(Data(repeating: 0x01, count: ShareIngestionSession.maximumTextBytes + 1 - image.count))
    let session = try ShareIngestionSession(
      container: root,
      ingestionId: UUID().uuidString.lowercased()
    )

    try session.recordData(
      id: UUID().uuidString.lowercased(),
      order: 0,
      declaredMediaType: "*/*",
      data: image
    )
    let result = try session.finish()

    XCTAssertEqual(result.status, "complete")
    XCTAssertEqual(result.copied, 1)
  }

  func testTwentyImagesAtFiveMiBEachStreamWithinTheExtensionCopyBudgetWithoutProcessing() throws {
    let source = root.appendingPathComponent("synthetic-large-image.bin")
    var image = Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    image.append(Data(repeating: 0x01, count: 5 * 1024 * 1024 - image.count))
    try image.write(to: source)
    let footprintBefore = currentPhysicalFootprintBytes()
    var observedFootprint = footprintBefore
    let session = try ShareIngestionSession(
      container: root,
      ingestionId: UUID().uuidString.lowercased(),
      operationHook: { _ in
        observedFootprint = max(observedFootprint, currentPhysicalFootprintBytes())
      }
    )

    let started = Date()
    for order in 0..<20 {
      try session.recordFile(
        id: UUID().uuidString.lowercased(),
        order: order,
        declaredMediaType: "image/png",
        source: source
      )
    }
    let result = try session.finish()
    let duration = Date().timeIntervalSince(started)
    let footprintAfter = currentPhysicalFootprintBytes()
    observedFootprint = max(observedFootprint, footprintAfter)
    let footprintGrowth = observedFootprint > footprintBefore
      ? observedFootprint - footprintBefore
      : 0

    XCTAssertEqual(result.copied, 20)
    XCTAssertLessThan(duration, 10)
    XCTAssertLessThan(footprintGrowth, 32 * 1024 * 1024)
    print(
      "SHARE_INGESTION_BENCHMARK platform=swift-macos items=20 itemBytes=5242880 " +
      "totalBytes=104857600 durationMs=\(Int(duration * 1_000)) bufferBytes=65536 " +
      "baselinePhysFootprintBytes=\(footprintBefore) " +
      "observedPhysFootprintBytes=\(observedFootprint) " +
      "physFootprintGrowthBytes=\(footprintGrowth) ocrRuns=0"
    )
  }

  private func interruptedImport(ingestionId: String, itemId: String) throws {
    let session = try ShareIngestionSession(
      container: root,
      ingestionId: ingestionId,
      operationHook: { point in
        if case .beforeDirectoryPublish = point {
          throw ShareIngestionFatalError.interrupted
        }
      }
    )
    try session.recordFile(
      id: itemId,
      order: 0,
      declaredMediaType: "image/png",
      source: fixture("ocr-english.png")
    )
    _ = try session.finish()
  }

  private func fixture(_ name: String) -> URL {
    var repository = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    for _ in 0..<4 { repository.deleteLastPathComponent() }
    return repository.appendingPathComponent("fixtures/media/\(name)")
  }

  @discardableResult
  private func sourceCopy(_ name: String, from source: URL) throws -> URL {
    let destination = root.appendingPathComponent(name)
    try FileManager.default.copyItem(at: source, to: destination)
    return destination
  }
}

private func currentPhysicalFootprintBytes() -> UInt64 {
  var info = task_vm_info_data_t()
  var count = mach_msg_type_number_t(
    MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size
  )
  let status = withUnsafeMutablePointer(to: &info) { pointer in
    pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
      task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
    }
  }
  guard status == KERN_SUCCESS else { return 0 }
  return info.phys_footprint
}
