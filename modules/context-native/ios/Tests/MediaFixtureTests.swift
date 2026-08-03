import Foundation
import ImageIO
import PDFKit
import Vision
import XCTest

final class MediaFixtureTests: XCTestCase {
  func testEnglishAndSimplifiedChineseOCRFixturesDecodeAndRecognize() throws {
    let englishURL = fixtureURL("ocr-english.png")
    let chineseURL = fixtureURL("ocr-chinese.png")

    for url in [englishURL, chineseURL] {
      let image = try loadImage(url)
      XCTAssertEqual(image.width, 1_800)
      XCTAssertEqual(image.height, 600)
    }

    let english = try recognize(englishURL, languages: ["en-US"])
    XCTAssertTrue(english.localizedCaseInsensitiveContains("synthetic"), english)
    XCTAssertTrue(english.localizedCaseInsensitiveContains("retry import"), english)

    let chinese = try recognize(chineseURL, languages: ["zh-Hans", "en-US"])
      .replacingOccurrences(of: " ", with: "")
    XCTAssertTrue(chinese.contains("合成测试"), chinese)
    XCTAssertTrue(chinese.contains("重新导入"), chinese)
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

  private func recognize(_ url: URL, languages: [String]) throws -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = languages
    try VNImageRequestHandler(cgImage: loadImage(url), options: [:]).perform([request])
    return (request.results ?? [])
      .compactMap { $0.topCandidates(1).first?.string }
      .joined(separator: "\n")
  }

  private func openPDF(_ name: String) throws -> PDFDocument {
    try XCTUnwrap(PDFDocument(url: fixtureURL(name)))
  }

  private func pageText(_ document: PDFDocument, index: Int) -> String {
    (document.page(at: index)?.string ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }
}
