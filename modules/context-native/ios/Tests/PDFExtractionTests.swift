import Darwin
import CoreGraphics
import CryptoKit
import Foundation
import PDFKit
import XCTest
@testable import ContextNativeRecovery

final class PDFExtractionTests: XCTestCase {
  private let firstTaskId = "123e4567-e89b-42d3-a456-426614174000"
  private let secondTaskId = "223e4567-e89b-42d3-a456-426614174000"
  private let thirdTaskId = "323e4567-e89b-42d3-a456-426614174000"

  func testInspectAndExtractTextScannedAndMixedFixtures() throws {
    let processor = ApplePDFProcessor()
    let info = try processor.inspect(fileURL: fixtureURL("text-one-page.pdf"))
    XCTAssertEqual(info["schemaVersion"] as? Int, 1)
    XCTAssertEqual(info["pageCount"] as? Int, 1)
    XCTAssertEqual(info["engine"] as? String, "pdfkit")
    let expectedHash = SHA256.hash(data: try Data(contentsOf: fixtureURL("text-one-page.pdf")))
      .map { String(format: "%02x", $0) }.joined()
    XCTAssertEqual(info["sha256"] as? String, expectedHash)

    let embeddedHash = try beginSession(
      processor,
      taskId: firstTaskId,
      file: fixtureURL("text-one-page.pdf")
    )
    let embedded = try processor.extractPage(
      taskId: firstTaskId,
      fileURL: fixtureURL("text-one-page.pdf"),
      expectedSourceSHA256: embeddedHash,
      pageIndex: 0,
      script: "latin",
      reserved: true
    )
    XCTAssertEqual(embedded["status"] as? String, "complete")
    XCTAssertEqual(embedded["method"] as? String, "embedded-text")
    XCTAssertEqual(embedded["engine"] as? String, "pdfkit")
    XCTAssertTrue((embedded["text"] as? String)?.contains("Synthetic PDF fixture") == true)
    XCTAssertEqual(
      embedded["characterCount"] as? Int,
      (embedded["text"] as? String)?.utf16.count
    )
    processor.finish(taskId: firstTaskId)

    let renderedHash = try beginSession(
      processor,
      taskId: secondTaskId,
      file: fixtureURL("scanned-one-page.pdf")
    )
    let rendered = try processor.extractPage(
      taskId: secondTaskId,
      fileURL: fixtureURL("scanned-one-page.pdf"),
      expectedSourceSHA256: renderedHash,
      pageIndex: 0,
      script: "latin",
      reserved: true
    )
    XCTAssertEqual(rendered["status"] as? String, "complete")
    XCTAssertEqual(rendered["method"] as? String, "rendered-ocr")
    XCTAssertEqual(rendered["engine"] as? String, "apple-vision")
    XCTAssertTrue((rendered["warnings"] as? [String])?.contains("PDF_PAGE_OCR_FALLBACK") == true)
    processor.finish(taskId: secondTaskId)

    let mixed = fixtureURL("mixed-two-page.pdf")
    let mixedHash = try beginSession(processor, taskId: firstTaskId, file: mixed)
    let first = try processor.extractPage(
      taskId: firstTaskId,
      fileURL: mixed,
      expectedSourceSHA256: mixedHash,
      pageIndex: 0,
      script: "latin",
      reserved: true
    )
    let second = try processor.extractPage(
      taskId: firstTaskId,
      fileURL: mixed,
      expectedSourceSHA256: mixedHash,
      pageIndex: 1,
      script: "latin",
      reserved: true
    )
    XCTAssertEqual(first["method"] as? String, "embedded-text")
    XCTAssertEqual(second["method"] as? String, "rendered-ocr")
    processor.finish(taskId: firstTaskId)
  }

  func testCorruptOutOfRangeAndSharedCancellationHaveStableCodes() throws {
    let processor = ApplePDFProcessor()
    XCTAssertThrowsError(try processor.inspect(fileURL: fixtureURL("corrupt-truncated.pdf"))) {
      XCTAssertEqual(($0 as? PDFProcessingError)?.stableCode, "PDF_CORRUPT")
    }
    let sourceHash = try beginSession(
      processor,
      taskId: firstTaskId,
      file: fixtureURL("text-one-page.pdf")
    )
    XCTAssertThrowsError(
      try processor.extractPage(
        taskId: firstTaskId,
        fileURL: fixtureURL("text-one-page.pdf"),
        expectedSourceSHA256: sourceHash,
        pageIndex: 1,
        script: "latin",
        reserved: true
      )
    ) {
      XCTAssertEqual(($0 as? PDFProcessingError)?.stableCode, "PDF_PAGE_OUT_OF_RANGE")
    }
    processor.finish(taskId: firstTaskId)

    let registry = OCRCancellationRegistry()
    let first = ApplePDFProcessor(registry: registry)
    let replacement = ApplePDFProcessor(registry: registry)
    try first.reserve(taskId: firstTaskId)
    XCTAssertTrue(first.cancel(taskId: firstTaskId))
    XCTAssertThrowsError(try replacement.reserve(taskId: secondTaskId)) {
      XCTAssertEqual(($0 as? PDFProcessingError)?.stableCode, "PDF_RESOURCE_BUSY")
    }
    first.finish(taskId: firstTaskId)
    try replacement.reserve(taskId: secondTaskId)
    replacement.finish(taskId: secondTaskId)
  }

  func testCancelledInspectionStopsBeforeHashingAndReleasesTheSourceSnapshot() throws {
    let processor = ApplePDFProcessor()
    let document = fixtureURL("text-one-page.pdf")
    try processor.reserve(taskId: firstTaskId)
    XCTAssertTrue(processor.cancel(taskId: firstTaskId))

    XCTAssertThrowsError(
      try processor.inspect(
        taskId: firstTaskId,
        fileURL: document,
        expectedSourceSHA256: try pdfSHA256(document),
        reserved: true
      )
    ) {
      XCTAssertEqual(($0 as? PDFProcessingError)?.stableCode, "PDF_CANCELLED")
    }

    let replacementHash = try beginSession(
      processor,
      taskId: secondTaskId,
      file: document
    )
    XCTAssertEqual(replacementHash, try pdfSHA256(document))
    processor.finish(taskId: secondTaskId)
  }

  func testDestroyDefersSharedRegistryReleaseUntilActivePageWorkUnwinds() throws {
    let registry = OCRCancellationRegistry()
    let first = ApplePDFProcessor(registry: registry)
    let replacement = ApplePDFProcessor(registry: registry)
    try first.reserve(taskId: firstTaskId)

    first.destroy(activeTaskId: firstTaskId)
    XCTAssertEqual(registry.failure(taskId: firstTaskId), .cancelled)
    XCTAssertThrowsError(try replacement.reserve(taskId: secondTaskId)) {
      XCTAssertEqual($0 as? PDFProcessingError, .resourceBusy)
    }

    first.finish(taskId: firstTaskId)
    XCTAssertNoThrow(try replacement.reserve(taskId: secondTaskId))
    replacement.finish(taskId: secondTaskId)
  }

  func testDeliveryRejectionReleasesOnlyDestroyedPageOperation() throws {
    let registry = OCRCancellationRegistry()
    let first = ApplePDFProcessor(registry: registry)
    let replacement = ApplePDFProcessor(registry: registry)
    let lifetime = OCRModuleLifetime()
    let coordinator = PDFProcessorFinishCoordinator()
    let owner = PDFProcessorFinishOwner(finishProcessor: first.finish)
    let active = try beginPDFOperationLifetime(
      lifetime: lifetime,
      coordinator: coordinator,
      owner: owner,
      taskId: firstTaskId
    ) {
      try first.reserve(taskId: firstTaskId)
    }

    XCTAssertTrue(active.claimDelivery())
    XCTAssertThrowsError(try replacement.reserve(taskId: secondTaskId)) {
      XCTAssertEqual($0 as? PDFProcessingError, .resourceBusy)
    }

    XCTAssertFalse(active.finish(keepSession: true))
    XCTAssertTrue(coordinator.requestFinish(fallbackOwner: owner, taskId: firstTaskId) {})
    let rejected = try beginPDFOperationLifetime(
      lifetime: lifetime,
      coordinator: coordinator,
      owner: owner,
      taskId: firstTaskId
    ) {
      try first.reserve(taskId: firstTaskId)
    }
    XCTAssertEqual(lifetime.destroy(), firstTaskId)
    XCTAssertFalse(rejected.claimDelivery())
    XCTAssertTrue(rejected.finish(keepSession: false))
    XCTAssertNoThrow(try replacement.reserve(taskId: secondTaskId))
    replacement.finish(taskId: secondTaskId)
  }

  func testExplicitFinishWaitsForMatchingNativeOperationToUnwind() throws {
    let registry = OCRCancellationRegistry()
    let first = ApplePDFProcessor(registry: registry)
    let replacement = ApplePDFProcessor(registry: registry)
    let lifetime = OCRModuleLifetime()
    let coordinator = PDFProcessorFinishCoordinator()
    let firstOwner = PDFProcessorFinishOwner(finishProcessor: first.finish)
    let replacementOwner = PDFProcessorFinishOwner(finishProcessor: replacement.finish)
    let active = try beginPDFOperationLifetime(
      lifetime: lifetime,
      coordinator: coordinator,
      owner: firstOwner,
      taskId: firstTaskId
    ) { try first.reserve(taskId: firstTaskId) }

    var acknowledged = 0
    XCTAssertFalse(coordinator.requestFinish(fallbackOwner: replacementOwner, taskId: firstTaskId) {
      acknowledged += 1
    })
    XCTAssertEqual(acknowledged, 0)
    XCTAssertThrowsError(try replacement.reserve(taskId: secondTaskId)) {
      XCTAssertEqual($0 as? PDFProcessingError, .resourceBusy)
    }

    XCTAssertTrue(active.finish(keepSession: true))
    XCTAssertEqual(acknowledged, 1)
    XCTAssertNoThrow(try replacement.reserve(taskId: secondTaskId))
    replacement.finish(taskId: secondTaskId)
  }

  func testRecreatedModuleCannotReleaseAnotherModulesActivePDFOperation() throws {
    let registry = OCRCancellationRegistry()
    let first = ApplePDFProcessor(registry: registry)
    let recreated = ApplePDFProcessor(registry: registry)
    let replacement = ApplePDFProcessor(registry: registry)
    let firstLifetime = OCRModuleLifetime()
    let coordinator = PDFProcessorFinishCoordinator()
    let firstOwner = PDFProcessorFinishOwner(finishProcessor: first.finish)
    let recreatedOwner = PDFProcessorFinishOwner(finishProcessor: recreated.finish)
    let active = try beginPDFOperationLifetime(
      lifetime: firstLifetime,
      coordinator: coordinator,
      owner: firstOwner,
      taskId: firstTaskId
    ) { try first.reserve(taskId: firstTaskId) }

    XCTAssertFalse(coordinator.destroyOwner(firstOwner))
    first.destroy(activeTaskId: firstTaskId)
    var acknowledged = 0
    XCTAssertFalse(coordinator.requestFinish(fallbackOwner: recreatedOwner, taskId: firstTaskId) {
      acknowledged += 1
    })
    XCTAssertThrowsError(try replacement.reserve(taskId: thirdTaskId)) {
      XCTAssertEqual($0 as? PDFProcessingError, .resourceBusy)
    }

    XCTAssertTrue(active.finish(keepSession: true))
    XCTAssertEqual(acknowledged, 1)
    XCTAssertNoThrow(try replacement.reserve(taskId: thirdTaskId))
    replacement.finish(taskId: thirdTaskId)
  }

  func testRecreatedModuleCannotAcknowledgeFinishUntilOriginalOwnerCleanupCompletes() throws {
    let registry = OCRCancellationRegistry()
    let first = ApplePDFProcessor(registry: registry)
    let recreated = ApplePDFProcessor(registry: registry)
    let replacement = ApplePDFProcessor(registry: registry)
    let coordinator = PDFProcessorFinishCoordinator()
    let cleanupStarted = DispatchSemaphore(value: 0)
    let allowCleanup = DispatchSemaphore(value: 0)
    let cleanupFinished = expectation(description: "original owner cleanup finished")
    let acknowledgementLock = NSLock()
    var acknowledgements = 0
    let recordAcknowledgement = {
      acknowledgementLock.lock()
      acknowledgements += 1
      acknowledgementLock.unlock()
    }
    let firstOwner = PDFProcessorFinishOwner { taskId in
      cleanupStarted.signal()
      XCTAssertEqual(allowCleanup.wait(timeout: .now() + 5), .success)
      first.finish(taskId: taskId)
    }
    let recreatedOwner = PDFProcessorFinishOwner(finishProcessor: recreated.finish)
    let replacementOwner = PDFProcessorFinishOwner(finishProcessor: replacement.finish)
    let active = try coordinator.beginOperation(
      owner: firstOwner,
      taskId: firstTaskId
    ) { try first.reserve(taskId: firstTaskId) }

    XCTAssertFalse(coordinator.requestFinish(
      fallbackOwner: recreatedOwner,
      taskId: firstTaskId,
      completion: recordAcknowledgement
    ))
    DispatchQueue.global(qos: .userInitiated).async {
      _ = active.finish(keepSession: true)
      cleanupFinished.fulfill()
    }
    XCTAssertEqual(cleanupStarted.wait(timeout: .now() + 5), .success)

    XCTAssertFalse(coordinator.requestFinish(
      fallbackOwner: recreatedOwner,
      taskId: firstTaskId,
      completion: recordAcknowledgement
    ))
    XCTAssertThrowsError(
      try coordinator.beginOperation(
        owner: replacementOwner,
        taskId: secondTaskId
      ) { try replacement.reserve(taskId: secondTaskId) }
    ) {
      XCTAssertEqual($0 as? PDFProcessingError, .resourceBusy)
    }
    acknowledgementLock.lock()
    XCTAssertEqual(acknowledgements, 0)
    acknowledgementLock.unlock()

    allowCleanup.signal()
    wait(for: [cleanupFinished], timeout: 5)
    acknowledgementLock.lock()
    XCTAssertEqual(acknowledgements, 2)
    acknowledgementLock.unlock()
    let replacementOperation = try coordinator.beginOperation(
      owner: replacementOwner,
      taskId: secondTaskId
    ) { try replacement.reserve(taskId: secondTaskId) }
    XCTAssertTrue(replacementOperation.finish(keepSession: false))
  }

  func testConcurrentBeginFailureCannotStealActivePageDeliveryClaim() throws {
    let registry = OCRCancellationRegistry()
    let processor = ApplePDFProcessor(registry: registry)
    let lifetime = OCRModuleLifetime()
    let coordinator = PDFProcessorFinishCoordinator()
    let owner = PDFProcessorFinishOwner(finishProcessor: processor.finish)
    let active = try beginPDFOperationLifetime(
      lifetime: lifetime,
      coordinator: coordinator,
      owner: owner,
      taskId: firstTaskId
    ) { try processor.reserve(taskId: firstTaskId) }

    XCTAssertThrowsError(
      try beginPDFOperationLifetime(
        lifetime: lifetime,
        coordinator: coordinator,
        owner: owner,
        taskId: firstTaskId,
        prepare: {}
      )
    ) {
      XCTAssertEqual($0 as? PDFProcessingError, .resourceBusy)
    }
    XCTAssertThrowsError(
      try beginPDFOperationLifetime(
        lifetime: lifetime,
        coordinator: coordinator,
        owner: owner,
        taskId: secondTaskId,
        prepare: {}
      )
    ) {
      XCTAssertEqual($0 as? PDFProcessingError, .resourceBusy)
    }

    XCTAssertTrue(active.claimDelivery())
    let replacement = ApplePDFProcessor(registry: registry)
    XCTAssertThrowsError(try replacement.reserve(taskId: secondTaskId)) {
      XCTAssertEqual($0 as? PDFProcessingError, .resourceBusy)
    }
    XCTAssertFalse(active.finish(keepSession: true))
    XCTAssertTrue(coordinator.requestFinish(fallbackOwner: owner, taskId: firstTaskId) {})
  }

  func testConcurrentBeginFailureCannotHideActivePageFromDestroy() throws {
    let registry = OCRCancellationRegistry()
    let processor = ApplePDFProcessor(registry: registry)
    let replacement = ApplePDFProcessor(registry: registry)
    let lifetime = OCRModuleLifetime()
    let coordinator = PDFProcessorFinishCoordinator()
    let owner = PDFProcessorFinishOwner(finishProcessor: processor.finish)
    let active = try beginPDFOperationLifetime(
      lifetime: lifetime,
      coordinator: coordinator,
      owner: owner,
      taskId: firstTaskId
    ) { try processor.reserve(taskId: firstTaskId) }
    XCTAssertThrowsError(
      try beginPDFOperationLifetime(
        lifetime: lifetime,
        coordinator: coordinator,
        owner: owner,
        taskId: firstTaskId,
        prepare: {}
      )
    ) {
      XCTAssertEqual($0 as? PDFProcessingError, .resourceBusy)
    }

    let destroyedTaskId = try XCTUnwrap(lifetime.destroy())
    XCTAssertFalse(coordinator.destroyOwner(owner))
    processor.destroy(activeTaskId: destroyedTaskId)
    XCTAssertThrowsError(try replacement.reserve(taskId: secondTaskId)) {
      XCTAssertEqual($0 as? PDFProcessingError, .resourceBusy)
    }
    XCTAssertFalse(active.claimDelivery())
    XCTAssertTrue(active.finish(keepSession: false))
    XCTAssertNoThrow(try replacement.reserve(taskId: secondTaskId))
    replacement.finish(taskId: secondTaskId)
  }

  func testDestroyReleasesRetainedOwnerWhenActivePageTaskDiffers() throws {
    let registry = OCRCancellationRegistry()
    let processor = ApplePDFProcessor(registry: registry)
    let replacement = ApplePDFProcessor(registry: registry)
    let lifetime = OCRModuleLifetime()
    let coordinator = PDFProcessorFinishCoordinator()
    let owner = PDFProcessorFinishOwner(finishProcessor: processor.finish)
    let document = fixtureURL("text-one-page.pdf")
    let sourceSHA256 = try beginSession(
      processor,
      taskId: firstTaskId,
      file: document
    )
    XCTAssertNoThrow(
      try processor.validatePageRequest(
        taskId: firstTaskId,
        fileURL: document,
        expectedSourceSHA256: sourceSHA256
      )
    )
    XCTAssertThrowsError(
      try processor.validatePageRequest(
        taskId: secondTaskId,
        fileURL: document,
        expectedSourceSHA256: sourceSHA256
      )
    ) {
      XCTAssertEqual($0 as? PDFProcessingError, .resultInvalid)
    }
    let stalePage = try beginPDFOperationLifetime(
      lifetime: lifetime,
      coordinator: coordinator,
      owner: owner,
      taskId: secondTaskId,
      prepare: {}
    )

    XCTAssertThrowsError(
      try processor.extractPage(
        taskId: secondTaskId,
        fileURL: document,
        expectedSourceSHA256: sourceSHA256,
        pageIndex: 0,
        script: "latin",
        reserved: true
      )
    ) {
      XCTAssertEqual($0 as? PDFProcessingError, .resultInvalid)
    }

    let destroyedTaskId = try XCTUnwrap(lifetime.destroy())
    XCTAssertFalse(coordinator.destroyOwner(owner))
    processor.destroy(activeTaskId: destroyedTaskId)
    XCTAssertFalse(stalePage.claimDelivery())
    XCTAssertTrue(stalePage.finish(keepSession: false))

    XCTAssertNoThrow(try replacement.reserve(taskId: thirdTaskId))
    replacement.finish(taskId: thirdTaskId)
  }

  func testEncryptedBlankSparseOverLimitAndOversizedFixturesAreDeterministic() throws {
    let processor = ApplePDFProcessor()
    XCTAssertThrowsError(try processor.inspect(fileURL: fixtureURL("encrypted-one-page.pdf"))) {
      XCTAssertEqual(($0 as? PDFProcessingError)?.stableCode, "PDF_ENCRYPTED")
    }
    XCTAssertThrowsError(try processor.inspect(fileURL: fixtureURL("over-limit-26-pages.pdf"))) {
      XCTAssertEqual(($0 as? PDFProcessingError)?.stableCode, "PDF_TOO_MANY_PAGES")
    }

    let blankHash = try beginSession(
      processor,
      taskId: firstTaskId,
      file: fixtureURL("empty-one-page.pdf")
    )
    let blank = try processor.extractPage(
      taskId: firstTaskId,
      fileURL: fixtureURL("empty-one-page.pdf"),
      expectedSourceSHA256: blankHash,
      pageIndex: 0,
      script: "latin",
      reserved: true
    )
    XCTAssertEqual(blank["status"] as? String, "complete")
    XCTAssertEqual(blank["method"] as? String, "rendered-ocr")
    XCTAssertTrue((blank["warnings"] as? [String])?.contains("PDF_PAGE_EMPTY") == true)
    processor.finish(taskId: firstTaskId)

    let sparseHash = try beginSession(
      processor,
      taskId: secondTaskId,
      file: fixtureURL("sparse-one-page.pdf")
    )
    let sparse = try processor.extractPage(
      taskId: secondTaskId,
      fileURL: fixtureURL("sparse-one-page.pdf"),
      expectedSourceSHA256: sparseHash,
      pageIndex: 0,
      script: "latin",
      reserved: true
    )
    XCTAssertEqual(sparse["status"] as? String, "complete")
    XCTAssertEqual(sparse["method"] as? String, "rendered-ocr")
    XCTAssertTrue(
      (sparse["warnings"] as? [String])?.contains("PDF_EMBEDDED_TEXT_SPARSE") == true
    )
    XCTAssertFalse((sparse["warnings"] as? [String])?.contains("PDF_PAGE_EMPTY") == true)
    XCTAssertTrue((sparse["text"] as? String)?.contains("A") == true)
    XCTAssertEqual(sparse["embeddedText"] as? String, "A")
    processor.finish(taskId: secondTaskId)

    let oversized = FileManager.default.temporaryDirectory
      .appendingPathComponent("\(UUID().uuidString).pdf")
    XCTAssertTrue(FileManager.default.createFile(atPath: oversized.path, contents: Data()))
    defer { try? FileManager.default.removeItem(at: oversized) }
    let handle = try FileHandle(forWritingTo: oversized)
    try handle.truncate(atOffset: UInt64(PDFResourcePolicy.maximumFileBytes + 1))
    try handle.close()
    XCTAssertThrowsError(try processor.inspect(fileURL: oversized)) {
      XCTAssertEqual(($0 as? PDFProcessingError)?.stableCode, "PDF_TOO_LARGE")
    }
  }

  func testPermissionsEncryptedPDFWithEmptyUserPasswordIsRejectedWhileUnlocked() throws {
    let encrypted = FileManager.default.temporaryDirectory
      .appendingPathComponent("\(UUID().uuidString).pdf")
    defer { try? FileManager.default.removeItem(at: encrypted) }
    var mediaBox = CGRect(x: 0, y: 0, width: 200, height: 200)
    let options = [
      kCGPDFContextOwnerPassword: "synthetic-owner",
      kCGPDFContextUserPassword: "",
    ] as CFDictionary
    guard let context = CGContext(encrypted as CFURL, mediaBox: &mediaBox, options) else {
      return XCTFail("Failed to create synthetic encrypted PDF")
    }
    context.beginPDFPage(nil)
    context.fill(CGRect(x: 20, y: 20, width: 40, height: 40))
    context.endPDFPage()
    context.closePDF()

    let document = try XCTUnwrap(PDFDocument(url: encrypted))
    XCTAssertTrue(document.isEncrypted)
    XCTAssertFalse(document.isLocked)
    XCTAssertThrowsError(try ApplePDFProcessor().inspect(fileURL: encrypted)) {
      XCTAssertEqual(($0 as? PDFProcessingError)?.stableCode, "PDF_ENCRYPTED")
    }
  }

  func testTwentyPageMixedBenchmarkRecordsBoundedMemoryAndCancellation() throws {
    let processor = ApplePDFProcessor()
    let document = fixtureURL("mixed-twenty-page.pdf")
    let info = try processor.inspect(fileURL: document)
    XCTAssertEqual(info["pageCount"] as? Int, 20)
    let taskId = UUID().uuidString.lowercased()
    let sourceSHA256 = try beginSession(processor, taskId: taskId, file: document)

    var usageBefore = rusage()
    XCTAssertEqual(getrusage(RUSAGE_SELF, &usageBefore), 0)
    let started = ContinuousClock.now
    var embeddedPages = 0
    var renderedPages = 0
    for pageIndex in 0..<20 {
      let result = try processor.extractPage(
        taskId: taskId,
        fileURL: document,
        expectedSourceSHA256: sourceSHA256,
        pageIndex: pageIndex,
        script: "latin",
        reserved: true
      )
      XCTAssertEqual(result["status"] as? String, "complete")
      if result["method"] as? String == "embedded-text" { embeddedPages += 1 }
      if result["method"] as? String == "rendered-ocr" { renderedPages += 1 }
    }
    let duration = started.duration(to: .now)
    let durationMs = Double(duration.components.seconds) * 1_000 +
      Double(duration.components.attoseconds) / 1_000_000_000_000_000
    var usageAfter = rusage()
    XCTAssertEqual(getrusage(RUSAGE_SELF, &usageAfter), 0)
    let observedPeakBytes = max(usageBefore.ru_maxrss, usageAfter.ru_maxrss)

    XCTAssertEqual(embeddedPages, 10)
    XCTAssertEqual(renderedPages, 10)
    XCTAssertGreaterThan(durationMs, 0)
    XCTAssertGreaterThan(observedPeakBytes, 0)
    processor.finish(taskId: taskId)

    let cancellationId = UUID().uuidString.lowercased()
    let cancellationHash = try beginSession(
      processor,
      taskId: cancellationId,
      file: document
    )
    XCTAssertTrue(processor.cancel(taskId: cancellationId))
    XCTAssertThrowsError(
      try processor.extractPage(
        taskId: cancellationId,
        fileURL: document,
        expectedSourceSHA256: cancellationHash,
        pageIndex: 0,
        script: "latin",
        reserved: true
      )
    ) {
      XCTAssertEqual(($0 as? PDFProcessingError)?.stableCode, "PDF_CANCELLED")
    }
    processor.finish(taskId: cancellationId)

    print(
      "PDF_BENCHMARK_IOS pages=20 durationMs=\(Int(durationMs)) " +
        "observedPeakBytes=\(observedPeakBytes) cancellation=PDF_CANCELLED"
    )
  }

  func testPageExtractionUsesTheImmutableInspectedSnapshotAfterPathReplacement() throws {
    let file = FileManager.default.temporaryDirectory
      .appendingPathComponent("\(UUID().uuidString).pdf")
    defer { try? FileManager.default.removeItem(at: file) }
    try Data(contentsOf: fixtureURL("text-one-page.pdf")).write(to: file)
    let processor = ApplePDFProcessor()
    let sourceSHA256 = try beginSession(processor, taskId: firstTaskId, file: file)

    try Data(contentsOf: fixtureURL("scanned-one-page.pdf")).write(to: file, options: .atomic)
    let result = try processor.extractPage(
      taskId: firstTaskId,
      fileURL: file,
      expectedSourceSHA256: sourceSHA256,
      pageIndex: 0,
      script: "latin",
      reserved: true
    )
    XCTAssertEqual(result["method"] as? String, "embedded-text")
    XCTAssertTrue((result["text"] as? String)?.contains("Synthetic PDF fixture") == true)
    processor.finish(taskId: firstTaskId)
  }

  func testEmbeddedTextThresholdAndSparseReconciliationUseUTF16Units() {
    XCTAssertEqual(
      pdfEmbeddedTextNonWhitespaceUTF16Count(String(repeating: "😀", count: 8)),
      16
    )
    XCTAssertEqual(
      pdfEmbeddedTextNonWhitespaceUTF16Count(
        " \n\u{0085}\u{00A0}\u{3000}" + String(repeating: "😀", count: 7)
      ),
      14
    )
    XCTAssertEqual(
      reconcilePDFSparseEmbeddedText(embedded: "A", recognized: "4"),
      "A\n4"
    )
    XCTAssertEqual(
      reconcilePDFSparseEmbeddedText(embedded: "A", recognized: "OCR A result"),
      "A\nOCR A result"
    )
    XCTAssertEqual(reconcilePDFSparseEmbeddedText(embedded: "A", recognized: "CAT"), "A\nCAT")
    XCTAssertEqual(reconcilePDFSparseEmbeddedText(embedded: "A", recognized: "A"), "A")
    XCTAssertEqual(
      reconcilePDFSparseEmbeddedText(embedded: "é", recognized: "e\u{301}"),
      "é\ne\u{301}"
    )
    XCTAssertEqual(
      reconcilePDFSparseEmbeddedText(
        embedded: " \n\u{0085}\u{00A0}\u{3000}",
        recognized: "Recovered by OCR"
      ),
      "Recovered by OCR"
    )
  }

  func testPlainTextReaderIsStrictBoundedAndPreservesBytes() throws {
    XCTAssertEqual(PlainTextFileReaderError.resultInvalid.stableCode, "TEXT_RESULT_INVALID")
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }

    let valid = root.appendingPathComponent("valid.txt")
    let source = "中文 👩🏽‍💻\r\n    code"
    try Data(source.utf8).write(to: valid)
    let result = try PlainTextFileReader.read(fileURL: valid)
    XCTAssertEqual(result["text"] as? String, source)
    XCTAssertEqual(result["byteCount"] as? Int, Data(source.utf8).count)

    let invalid = root.appendingPathComponent("invalid.txt")
    try Data([0xC3, 0x28]).write(to: invalid)
    XCTAssertThrowsError(try PlainTextFileReader.read(fileURL: invalid)) {
      XCTAssertEqual($0 as? PlainTextFileReaderError, .invalidUTF8)
    }

    let oversized = root.appendingPathComponent("oversized.txt")
    try Data(repeating: 0x61, count: PlainTextFileReader.maximumBytes + 1).write(to: oversized)
    XCTAssertThrowsError(try PlainTextFileReader.read(fileURL: oversized)) {
      XCTAssertEqual($0 as? PlainTextFileReaderError, .tooLarge)
    }

    let link = root.appendingPathComponent("link.txt")
    try FileManager.default.createSymbolicLink(at: link, withDestinationURL: valid)
    XCTAssertThrowsError(try PlainTextFileReader.read(fileURL: link)) {
      XCTAssertEqual($0 as? PlainTextFileReaderError, .invalidLocalFile)
    }
  }

  private func fixtureURL(_ name: String) -> URL {
    var repository = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    for _ in 0..<4 { repository.deleteLastPathComponent() }
    return repository.appendingPathComponent("fixtures/media/\(name)")
  }

  private func pdfSHA256(_ file: URL) throws -> String {
    SHA256.hash(data: try Data(contentsOf: file))
      .map { String(format: "%02x", $0) }.joined()
  }

  @discardableResult
  private func beginSession(
    _ processor: ApplePDFProcessor,
    taskId: String,
    file: URL
  ) throws -> String {
    let sourceSHA256 = try pdfSHA256(file)
    _ = try processor.inspect(
      taskId: taskId,
      fileURL: file,
      expectedSourceSHA256: sourceSHA256
    )
    return sourceSHA256
  }
}
