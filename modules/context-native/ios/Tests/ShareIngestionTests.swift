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

  func testFileBackedTextPayloadRemainsAStreamableFile() throws {
    let source = root.appendingPathComponent("provider-text.txt")
    try Data("synthetic text".utf8).write(to: source)

    XCTAssertEqual(
      ShareRepresentationValue.payload(source as NSURL, kind: .text),
      .file(source)
    )
    XCTAssertNil(ShareRepresentationValue.payload(source as NSURL, kind: .webURL))
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
    let session = try ShareIngestionSession(
      container: root,
      ingestionId: UUID().uuidString.lowercased()
    )

    let residentBefore = peakResidentBytes()
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
    let residentAfter = peakResidentBytes()
    let residentGrowth = residentAfter > residentBefore ? residentAfter - residentBefore : 0

    XCTAssertEqual(result.copied, 20)
    XCTAssertLessThan(duration, 10)
    XCTAssertLessThan(residentGrowth, 32 * 1024 * 1024)
    print(
      "SHARE_INGESTION_BENCHMARK platform=swift-macos items=20 itemBytes=5242880 " +
      "totalBytes=104857600 durationMs=\(Int(duration * 1_000)) bufferBytes=65536 " +
      "peakResidentBytes=\(residentAfter) residentGrowthBytes=\(residentGrowth) ocrRuns=0"
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

private func peakResidentBytes() -> UInt64 {
  var usage = rusage()
  guard getrusage(RUSAGE_SELF, &usage) == 0 else { return 0 }
  return UInt64(usage.ru_maxrss)
}
