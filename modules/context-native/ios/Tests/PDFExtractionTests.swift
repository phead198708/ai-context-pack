import Darwin
import Foundation
import XCTest
@testable import ContextNativeRecovery

final class PDFExtractionTests: XCTestCase {
  private let firstTaskId = "123e4567-e89b-42d3-a456-426614174000"
  private let secondTaskId = "223e4567-e89b-42d3-a456-426614174000"

  func testInspectAndExtractTextScannedAndMixedFixtures() throws {
    let processor = ApplePDFProcessor()
    let info = try processor.inspect(fileURL: fixtureURL("text-one-page.pdf"))
    XCTAssertEqual(info["schemaVersion"] as? Int, 1)
    XCTAssertEqual(info["pageCount"] as? Int, 1)
    XCTAssertEqual(info["engine"] as? String, "pdfkit")

    let embedded = try processor.extractPage(
      taskId: firstTaskId,
      fileURL: fixtureURL("text-one-page.pdf"),
      pageIndex: 0,
      script: "latin"
    )
    XCTAssertEqual(embedded["status"] as? String, "complete")
    XCTAssertEqual(embedded["method"] as? String, "embedded-text")
    XCTAssertEqual(embedded["engine"] as? String, "pdfkit")
    XCTAssertTrue((embedded["text"] as? String)?.contains("Synthetic PDF fixture") == true)
    XCTAssertEqual(
      embedded["characterCount"] as? Int,
      (embedded["text"] as? String)?.utf16.count
    )

    let rendered = try processor.extractPage(
      taskId: secondTaskId,
      fileURL: fixtureURL("scanned-one-page.pdf"),
      pageIndex: 0,
      script: "latin"
    )
    XCTAssertEqual(rendered["status"] as? String, "complete")
    XCTAssertEqual(rendered["method"] as? String, "rendered-ocr")
    XCTAssertEqual(rendered["engine"] as? String, "apple-vision")
    XCTAssertTrue((rendered["warnings"] as? [String])?.contains("PDF_PAGE_OCR_FALLBACK") == true)

    let mixed = fixtureURL("mixed-two-page.pdf")
    let first = try processor.extractPage(
      taskId: firstTaskId,
      fileURL: mixed,
      pageIndex: 0,
      script: "latin"
    )
    let second = try processor.extractPage(
      taskId: secondTaskId,
      fileURL: mixed,
      pageIndex: 1,
      script: "latin"
    )
    XCTAssertEqual(first["method"] as? String, "embedded-text")
    XCTAssertEqual(second["method"] as? String, "rendered-ocr")
  }

  func testCorruptOutOfRangeAndSharedCancellationHaveStableCodes() throws {
    let processor = ApplePDFProcessor()
    XCTAssertThrowsError(try processor.inspect(fileURL: fixtureURL("corrupt-truncated.pdf"))) {
      XCTAssertEqual(($0 as? PDFProcessingError)?.stableCode, "PDF_CORRUPT")
    }
    XCTAssertThrowsError(
      try processor.extractPage(
        taskId: firstTaskId,
        fileURL: fixtureURL("text-one-page.pdf"),
        pageIndex: 1,
        script: "latin"
      )
    ) {
      XCTAssertEqual(($0 as? PDFProcessingError)?.stableCode, "PDF_PAGE_OUT_OF_RANGE")
    }

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

  func testEncryptedBlankSparseOverLimitAndOversizedFixturesAreDeterministic() throws {
    let processor = ApplePDFProcessor()
    XCTAssertThrowsError(try processor.inspect(fileURL: fixtureURL("encrypted-one-page.pdf"))) {
      XCTAssertEqual(($0 as? PDFProcessingError)?.stableCode, "PDF_ENCRYPTED")
    }
    XCTAssertThrowsError(try processor.inspect(fileURL: fixtureURL("over-limit-26-pages.pdf"))) {
      XCTAssertEqual(($0 as? PDFProcessingError)?.stableCode, "PDF_TOO_MANY_PAGES")
    }

    let blank = try processor.extractPage(
      taskId: firstTaskId,
      fileURL: fixtureURL("empty-one-page.pdf"),
      pageIndex: 0,
      script: "latin"
    )
    XCTAssertEqual(blank["status"] as? String, "complete")
    XCTAssertEqual(blank["method"] as? String, "rendered-ocr")
    XCTAssertTrue((blank["warnings"] as? [String])?.contains("PDF_PAGE_EMPTY") == true)

    let sparse = try processor.extractPage(
      taskId: secondTaskId,
      fileURL: fixtureURL("sparse-one-page.pdf"),
      pageIndex: 0,
      script: "latin"
    )
    XCTAssertEqual(sparse["status"] as? String, "complete")
    XCTAssertEqual(sparse["method"] as? String, "rendered-ocr")
    XCTAssertTrue(
      (sparse["warnings"] as? [String])?.contains("PDF_EMBEDDED_TEXT_SPARSE") == true
    )

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

  func testTwentyPageMixedBenchmarkRecordsBoundedMemoryAndCancellation() throws {
    let processor = ApplePDFProcessor()
    let document = fixtureURL("mixed-twenty-page.pdf")
    let info = try processor.inspect(fileURL: document)
    XCTAssertEqual(info["pageCount"] as? Int, 20)

    var usageBefore = rusage()
    XCTAssertEqual(getrusage(RUSAGE_SELF, &usageBefore), 0)
    let started = ContinuousClock.now
    var embeddedPages = 0
    var renderedPages = 0
    for pageIndex in 0..<20 {
      let result = try processor.extractPage(
        taskId: UUID().uuidString.lowercased(),
        fileURL: document,
        pageIndex: pageIndex,
        script: "latin"
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

    let cancellationId = UUID().uuidString.lowercased()
    try processor.reserve(taskId: cancellationId)
    XCTAssertTrue(processor.cancel(taskId: cancellationId))
    XCTAssertThrowsError(
      try processor.extractPage(
        taskId: cancellationId,
        fileURL: document,
        pageIndex: 0,
        script: "latin",
        reserved: true
      )
    ) {
      XCTAssertEqual(($0 as? PDFProcessingError)?.stableCode, "PDF_CANCELLED")
    }

    print(
      "PDF_BENCHMARK_IOS pages=20 durationMs=\(Int(durationMs)) " +
        "observedPeakBytes=\(observedPeakBytes) cancellation=PDF_CANCELLED"
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
}
