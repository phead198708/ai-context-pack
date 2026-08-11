import CryptoKit
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

  func testOnlySingleFrameSourcesAreAccepted() {
    XCTAssertTrue(ImagePerceptualHasher.acceptsFrameCount(1))
    XCTAssertFalse(ImagePerceptualHasher.acceptsFrameCount(0))
    XCTAssertFalse(ImagePerceptualHasher.acceptsFrameCount(2))
  }

  func testSyntheticMediaHashesAreStable() throws {
    for name in ["ocr-english.png", "ocr-rotated.jpg"] {
      let url = fixtureURL(name)
      let data = try Data(contentsOf: url)
      let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
      let value = try ImagePerceptualHasher.hash(
        fileURL: url,
        expectedByteCount: Int64(data.count),
        expectedSHA256: digest,
        cancellation: ImageHashCancellationToken()
      )
      let hash = try XCTUnwrap(value["hash"] as? String)
      XCTAssertEqual(hash, "000000a810000000")
    }
  }

  func testRegistryCancellationIsOwnerScopedAndCooperative() throws {
    let registry = ImageHashTaskRegistry()
    let taskId = "123e4567-e89b-42d3-a456-426614174000"
    let token = try XCTUnwrap(registry.reserve(ownerId: "owner-a", taskId: taskId))
    XCTAssertNil(registry.reserve(ownerId: "owner-b", taskId: taskId))
    XCTAssertTrue(registry.cancel(taskId: taskId))
    XCTAssertThrowsError(try token.check()) {
      XCTAssertEqual(($0 as? ImagePerceptualHashError)?.stableCode, "PIPELINE_STAGE_FAILED")
    }
    registry.finish(ownerId: "owner-b", taskId: taskId, token: token)
    XCTAssertNil(registry.reserve(ownerId: "owner-b", taskId: taskId))
    registry.finish(ownerId: "owner-a", taskId: taskId, token: token)
    XCTAssertNotNil(registry.reserve(ownerId: "owner-b", taskId: taskId))
  }

  private func fixtureURL(_ name: String) -> URL {
    let tests = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    let repository = tests.deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
    return repository.appendingPathComponent("fixtures/media/\(name)")
  }
}
