import Foundation
import ImageIO
import PDFKit
import Vision
import XCTest
@testable import ContextNativeRecovery

final class MediaFixtureTests: XCTestCase {
  private let firstTaskId = "123e4567-e89b-42d3-a456-426614174000"
  private let secondTaskId = "223e4567-e89b-42d3-a456-426614174000"

  func testProductionAdapterRecognizesEnglishProgrammingErrorAndChineseFixtures() throws {
    let englishURL = fixtureURL("ocr-english.png")
    let chineseURL = fixtureURL("ocr-chinese.png")

    for url in [englishURL, chineseURL] {
      let image = try loadImage(url)
      XCTAssertEqual(image.width, 1_800)
      XCTAssertEqual(image.height, 600)
    }

    let processor = AppleVisionOCRProcessor()
    let englishResult = try processor.recognize(
      taskId: firstTaskId,
      fileURL: englishURL,
      script: "latin",
      recognitionLevel: "accurate"
    )
    let english = try XCTUnwrap(englishResult["text"] as? String)
    let compactEnglish = english.replacingOccurrences(of: " ", with: "")
    XCTAssertTrue(compactEnglish.localizedCaseInsensitiveContains("TypeError"))
    XCTAssertTrue(english.localizedCaseInsensitiveContains("E42"))
    XCTAssertTrue(english.localizedCaseInsensitiveContains("retry import"))

    let chineseResult = try processor.recognize(
      taskId: secondTaskId,
      fileURL: chineseURL,
      script: "chinese",
      recognitionLevel: "accurate"
    )
    let chinese = try XCTUnwrap(chineseResult["text"] as? String)
      .replacingOccurrences(of: " ", with: "")
    XCTAssertTrue(chinese.contains("合成测试"))
    XCTAssertTrue(chinese.contains("重新导入"))

    for result in [englishResult, chineseResult] {
      XCTAssertEqual(result["schemaVersion"] as? Int, 1)
      XCTAssertEqual(result["recognitionLevel"] as? String, "accurate")
      XCTAssertNotNil(result["revision"] as? String)
      try assertValidOrderedTopLeftBlocks(result)
      try assertFixtureTextRegionMapsToPreview(result)
    }
  }

  func testCapabilitiesAreOfflineAndExposeSupportedScripts() throws {
    let capabilities = AppleVisionOCRProcessor().capabilities()
    XCTAssertEqual(capabilities["schemaVersion"] as? Int, 1)
    let engines = try XCTUnwrap(capabilities["engines"] as? [[String: Any]])
    let engine = try XCTUnwrap(engines.first)
    XCTAssertEqual(engine["engine"] as? String, "apple-vision")
    XCTAssertEqual(engine["offline"] as? Bool, true)
    XCTAssertEqual(engine["ready"] as? Bool, true)
    let scripts = try XCTUnwrap(engine["scripts"] as? [String])
    XCTAssertTrue(scripts.contains("latin"))
    XCTAssertTrue(scripts.contains("chinese"))
  }

  func testEXIFRotatedFixtureUsesPreviewCoordinateSpace() throws {
    let result = try AppleVisionOCRProcessor().recognize(
      taskId: firstTaskId,
      fileURL: fixtureURL("ocr-rotated.jpg"),
      script: "latin",
      recognitionLevel: "accurate"
    )
    let text = try XCTUnwrap(result["text"] as? String)
    XCTAssertTrue(text.localizedCaseInsensitiveContains("TypeError"))
    XCTAssertTrue(text.localizedCaseInsensitiveContains("E42"))
    XCTAssertTrue(text.localizedCaseInsensitiveContains("retry import"))
    try assertValidOrderedTopLeftBlocks(result)
    try assertFixtureTextRegionMapsToPreview(result)
  }

  func testCorruptHugeCancellationAndMemoryPressureHaveStableCodes() throws {
    XCTAssertThrowsError(
      try AppleVisionOCRProcessor().recognize(
        taskId: firstTaskId,
        fileURL: fixtureURL("ocr-corrupt.png"),
        script: "latin",
        recognitionLevel: "accurate"
      )
    ) { error in
      XCTAssertEqual((error as? OCRProcessingError)?.stableCode, "OCR_IMAGE_DECODE_FAILED")
    }
    XCTAssertThrowsError(
      try OCRResourcePolicy.validate(width: 12_001, height: 1, fileBytes: 1)
    ) { error in
      XCTAssertEqual((error as? OCRProcessingError)?.stableCode, "OCR_IMAGE_TOO_LARGE")
    }

    let registry = OCRCancellationRegistry()
    let request = VNRecognizeTextRequest()
    try registry.begin(taskId: firstTaskId, request: request)
    XCTAssertTrue(registry.cancel(taskId: firstTaskId))
    XCTAssertEqual(registry.failure(taskId: firstTaskId), .cancelled)
    registry.finish(taskId: firstTaskId)
    registry.setMemoryPressure(true)
    XCTAssertThrowsError(try registry.begin(taskId: secondTaskId, request: request)) { error in
      XCTAssertEqual((error as? OCRProcessingError)?.stableCode, "RESOURCE_MEMORY_PRESSURE")
    }
  }

  func testDenseReadingOrderIsDeterministicAcrossInputPermutations() {
    let blocks = [
      ocrBlock("A", x: 0.1, y: 0.018),
      ocrBlock("B", x: 0.2, y: 0.009),
      ocrBlock("C", x: 0.3, y: 0),
    ]
    let permutations = [
      blocks,
      blocks.reversed().map { $0 },
      [blocks[1], blocks[2], blocks[0]],
      [blocks[2], blocks[0], blocks[1]],
    ]
    for permutation in permutations {
      XCTAssertEqual(
        sortOCRBlocksInReadingOrder(permutation).compactMap { $0["text"] as? String },
        ["B", "C", "A"]
      )
    }
  }

  func testReadingOrderUsesUTF16CodeUnitsForCanonicalUnicodeParity() {
    let composed = ocrBlock("\u{00E9}", x: 0.1, y: 0.1)
    let decomposed = ocrBlock("e\u{0301}", x: 0.1, y: 0.1)
    for permutation in [[composed, decomposed], [decomposed, composed]] {
      XCTAssertEqual(
        sortOCRBlocksInReadingOrder(permutation).compactMap { $0["text"] as? String },
        ["e\u{0301}", "\u{00E9}"]
      )
    }
  }

  func testAggregateTextLimitFailsBeforeJoiningBlocks() throws {
    XCTAssertEqual(
      try advanceOCRAggregateTextLength(
        currentLength: OCRResourcePolicy.maximumTextLength - 1,
        nextTextLength: 1,
        hasPreviousBlock: false
      ),
      OCRResourcePolicy.maximumTextLength
    )
    XCTAssertThrowsError(
      try advanceOCRAggregateTextLength(
        currentLength: OCRResourcePolicy.maximumTextLength,
        nextTextLength: 1,
        hasPreviousBlock: true
      )
    ) { error in
      XCTAssertEqual(error as? OCRProcessingError, .resultInvalid)
    }
  }

  func testDestroyedModuleCancelsAndSharedRegistryBlocksReplacementUntilFinish() throws {
    let registry = OCRCancellationRegistry()
    let firstProcessor = AppleVisionOCRProcessor(registry: registry)
    let secondProcessor = AppleVisionOCRProcessor(registry: registry)
    let lifetime = OCRModuleLifetime()
    let secondRequest = VNRecognizeTextRequest()
    try firstProcessor.reserve(taskId: firstTaskId)
    try lifetime.begin(taskId: firstTaskId)

    let destroyedTask = try XCTUnwrap(lifetime.destroy())
    XCTAssertTrue(firstProcessor.cancel(taskId: destroyedTask))
    XCTAssertEqual(registry.failure(taskId: firstTaskId), .cancelled)
    XCTAssertFalse(lifetime.claimDelivery(taskId: firstTaskId))
    XCTAssertThrowsError(try registry.begin(taskId: secondTaskId, request: secondRequest)) {
      XCTAssertEqual($0 as? OCRProcessingError, .resourceBusy)
    }

    lifetime.finish(taskId: firstTaskId)
    firstProcessor.finish(taskId: firstTaskId)
    try registry.begin(taskId: secondTaskId, request: secondRequest)
    XCTAssertTrue(secondProcessor.cancel(taskId: secondTaskId))
    registry.finish(taskId: secondTaskId)
  }

  func testTextScannedAndMixedPDFFixturesHaveExpectedPageSemantics() throws {
    let text = try openPDF("text-one-page.pdf")
    XCTAssertEqual(text.pageCount, 1)
    XCTAssertTrue(text.page(at: 0)?.string?.contains("Synthetic PDF fixture") == true)

    let scanned = try openPDF("scanned-one-page.pdf")
    XCTAssertEqual(scanned.pageCount, 1)
    XCTAssertTrue(pageText(scanned, index: 0).isEmpty)

    let mixed = try openPDF("mixed-two-page.pdf")
    XCTAssertEqual(mixed.pageCount, 2)
    XCTAssertTrue(pageText(mixed, index: 0).contains("Synthetic embedded page"))
    XCTAssertTrue(pageText(mixed, index: 1).isEmpty)
  }

  func testCorruptPDFFixtureIsRejected() {
    XCTAssertNil(PDFDocument(url: fixtureURL("corrupt-truncated.pdf")))
  }

  private func fixtureURL(_ name: String) -> URL {
    var repository = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    for _ in 0..<4 { repository.deleteLastPathComponent() }
    return repository.appendingPathComponent("fixtures/media/\(name)")
  }

  private func loadImage(_ url: URL) throws -> CGImage {
    let source = try XCTUnwrap(CGImageSourceCreateWithURL(url as CFURL, nil))
    return try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
  }

  private func assertValidOrderedTopLeftBlocks(_ result: [String: Any]) throws {
    let blocks = try XCTUnwrap(result["blocks"] as? [[String: Any]])
    XCTAssertFalse(blocks.isEmpty)
    var previousY = -1.0
    var previousX = -1.0
    for block in blocks {
      let bounds = try XCTUnwrap(block["bounds"] as? [String: Double])
      let x = try XCTUnwrap(bounds["x"])
      let y = try XCTUnwrap(bounds["y"])
      let width = try XCTUnwrap(bounds["width"])
      let height = try XCTUnwrap(bounds["height"])
      XCTAssertGreaterThanOrEqual(x, 0)
      XCTAssertGreaterThanOrEqual(y, 0)
      XCTAssertLessThanOrEqual(x + width, 1.000_001)
      XCTAssertLessThanOrEqual(y + height, 1.000_001)
      if abs(y - previousY) > 0.01 {
        XCTAssertGreaterThanOrEqual(y, previousY)
      } else {
        XCTAssertGreaterThanOrEqual(x, previousX)
      }
      previousY = y
      previousX = x
    }
  }

  private func assertFixtureTextRegionMapsToPreview(_ result: [String: Any]) throws {
    let blocks = try XCTUnwrap(result["blocks"] as? [[String: Any]])
    let bounds = try XCTUnwrap(blocks.first?["bounds"] as? [String: Double])
    let x = try XCTUnwrap(bounds["x"])
    let y = try XCTUnwrap(bounds["y"])
    let width = try XCTUnwrap(bounds["width"])
    let height = try XCTUnwrap(bounds["height"])
    XCTAssertLessThan(x, 0.2)
    XCTAssertLessThan(y, 0.7)
    XCTAssertGreaterThan(width, 0.2)
    XCTAssertGreaterThan(height, 0.05)
  }

  private func openPDF(_ name: String) throws -> PDFDocument {
    try XCTUnwrap(PDFDocument(url: fixtureURL(name)))
  }

  private func pageText(_ document: PDFDocument, index: Int) -> String {
    (document.page(at: index)?.string ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private func ocrBlock(_ text: String, x: Double, y: Double) -> [String: Any] {
    [
      "text": text,
      "bounds": ["x": x, "y": y, "width": 0.05, "height": 0.02],
    ]
  }
}
