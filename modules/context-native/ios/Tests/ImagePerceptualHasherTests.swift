import XCTest
@testable import ContextNativeRecovery

final class ImagePerceptualHasherTests: XCTestCase {
  func testDifferenceHashUsesCanonicalRowMajorBitOrder() {
    var pixels = [UInt8](repeating: 0, count: 9 * 8)
    for row in 0..<8 {
      for column in 0..<9 {
        pixels[row * 9 + column] = UInt8(9 - column)
      }
    }
    XCTAssertEqual(ImagePerceptualHasher.hash(luminance: pixels), "ffffffffffffffff")
    XCTAssertEqual(
      ImagePerceptualHasher.hash(luminance: [UInt8](repeating: 7, count: 9 * 8)),
      "0000000000000000"
    )
  }

  func testSyntheticMediaHashesAreStable() throws {
    for name in ["ocr-english.png", "ocr-rotated.jpg"] {
      let value = try ImagePerceptualHasher.hash(fileURL: fixtureURL(name))
      let hash = try XCTUnwrap(value["hash"] as? String)
      XCTAssertEqual(hash, "000000a810000000")
    }
  }

  private func fixtureURL(_ name: String) -> URL {
    let tests = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    let repository = tests.deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
    return repository.appendingPathComponent("fixtures/media/\(name)")
  }
}
