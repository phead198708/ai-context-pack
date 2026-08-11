import CryptoKit
import ImageIO
import XCTest
@testable import ContextNativeRecovery

private final class LockedCounter: @unchecked Sendable {
  private let lock = NSLock()
  private var storedValue = 0

  func increment() {
    lock.lock()
    storedValue += 1
    lock.unlock()
  }

  var value: Int {
    lock.lock()
    defer { lock.unlock() }
    return storedValue
  }
}

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

  func testSharedAnimatedFixturesAreRejectedByGenericFrameCount() throws {
    let fixture = fixtureURL("contracts/image-animation-policy-v1.tsv")
    let lines = try String(contentsOf: fixture, encoding: .utf8).split(separator: "\n")
    XCTAssertEqual(lines.count, 3)
    for line in lines {
      let fields = line.split(separator: "\t", maxSplits: 1)
      let data = try XCTUnwrap(Data(base64Encoded: String(fields[1])))
      let source = try XCTUnwrap(CGImageSourceCreateWithData(data as CFData, nil))
      XCTAssertFalse(ImagePerceptualHasher.acceptsFrameCount(CGImageSourceGetCount(source)))
    }
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
    XCTAssertFalse(registry.cancel(ownerId: "owner-b", taskId: taskId))
    XCTAssertNoThrow(try token.check())
    XCTAssertTrue(registry.cancel(ownerId: "owner-a", taskId: taskId))
    XCTAssertThrowsError(try token.check()) {
      XCTAssertEqual(($0 as? ImagePerceptualHashError)?.stableCode, "PIPELINE_STAGE_FAILED")
    }
    registry.finish(ownerId: "owner-b", taskId: taskId, token: token)
    XCTAssertNil(registry.reserve(ownerId: "owner-b", taskId: taskId))
    registry.finish(ownerId: "owner-a", taskId: taskId, token: token)
    XCTAssertNotNil(registry.reserve(ownerId: "owner-b", taskId: taskId))
    XCTAssertFalse(registry.cancel(ownerId: "owner-a", taskId: taskId))
    registry.destroyOwner("owner-b")
    let replacement = try XCTUnwrap(registry.reserve(ownerId: "owner-c", taskId: taskId))
    XCTAssertFalse(registry.cancel(ownerId: "owner-b", taskId: taskId))
    XCTAssertNoThrow(try replacement.check())
  }

  func testCancellationBeforeSchedulerAttachmentStillCancelsAndJoinsWork() throws {
    let registry = ImageHashTaskRegistry()
    let taskId = "223e4567-e89b-42d3-a456-426614174000"
    let token = try XCTUnwrap(registry.reserve(ownerId: "owner-a", taskId: taskId))
    XCTAssertTrue(registry.cancel(ownerId: "owner-a", taskId: taskId))
    let cancelled = LockedCounter()
    let waited = LockedCounter()
    registry.attach(
      ownerId: "owner-a",
      taskId: taskId,
      token: token,
      cancel: { cancelled.increment() },
      awaitCompletion: {
        waited.increment()
        return true
      }
    )
    XCTAssertEqual(cancelled.value, 1)
    XCTAssertEqual(waited.value, 1)
    XCTAssertThrowsError(try token.check())
  }

  func testLateAttachmentCannotTakeOverSameOwnerReplacementGeneration() throws {
    let registry = ImageHashTaskRegistry()
    let taskId = "323e4567-e89b-42d3-a456-426614174000"
    let staleToken = try XCTUnwrap(registry.reserve(ownerId: "owner-a", taskId: taskId))
    registry.finish(ownerId: "owner-a", taskId: taskId, token: staleToken)
    let replacement = try XCTUnwrap(registry.reserve(ownerId: "owner-a", taskId: taskId))
    let cancelled = LockedCounter()
    let waited = LockedCounter()

    registry.attach(
      ownerId: "owner-a",
      taskId: taskId,
      token: staleToken,
      cancel: { cancelled.increment() },
      awaitCompletion: {
        waited.increment()
        return true
      }
    )

    XCTAssertEqual(cancelled.value, 1)
    XCTAssertEqual(waited.value, 1)
    XCTAssertNoThrow(try replacement.check())
    XCTAssertTrue(registry.cancel(ownerId: "owner-a", taskId: taskId))
    XCTAssertThrowsError(try replacement.check())
  }

  func testHasherUsesOneImmutableNoFollowSnapshotAcrossPathReplacement() throws {
    let original = try Data(contentsOf: fixtureURL("ocr-english.png"))
    let source = FileManager.default.temporaryDirectory.appendingPathComponent(
      "image-hash-swap-\(UUID().uuidString).png"
    )
    try original.write(to: source, options: .atomic)
    defer { try? FileManager.default.removeItem(at: source) }
    let digest = SHA256.hash(data: original).map { String(format: "%02x", $0) }.joined()

    let result = try ImagePerceptualHasher.hash(
      fileURL: source,
      expectedByteCount: Int64(original.count),
      expectedSHA256: digest,
      cancellation: ImageHashCancellationToken(),
      sourceMutationHook: { phase in
        if phase == "snapshot-ready" {
          try Data("replacement".utf8).write(to: source, options: .atomic)
        } else if phase == "decode-complete" {
          try original.write(to: source, options: .atomic)
        }
      }
    )
    XCTAssertEqual(result["hash"] as? String, "000000a810000000")
    XCTAssertEqual(try Data(contentsOf: source), original)
  }

  func testHasherRejectsSymlinkSources() throws {
    let target = fixtureURL("ocr-english.png")
    let link = FileManager.default.temporaryDirectory.appendingPathComponent(
      "image-hash-link-\(UUID().uuidString).png"
    )
    try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
    defer { try? FileManager.default.removeItem(at: link) }
    let data = try Data(contentsOf: target)
    let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    XCTAssertThrowsError(
      try ImagePerceptualHasher.hash(
        fileURL: link,
        expectedByteCount: Int64(data.count),
        expectedSHA256: digest,
        cancellation: ImageHashCancellationToken()
      )
    ) { error in
      XCTAssertEqual((error as? ImagePerceptualHashError)?.stableCode, "ARTIFACT_INTEGRITY_FAILED")
    }
  }

  func testProcessSchedulerBoundsWorkAndJoinsCancellation() throws {
    let scheduler = ImageHashScheduler()
    var works: [ImageHashScheduledWork] = []
    for _ in 0..<ImageHashScheduler.maximumScheduledWork {
      let token = ImageHashCancellationToken()
      let work = scheduler.submit(
        token: token,
        work: {
          while true {
            try token.check()
            Thread.sleep(forTimeInterval: 0.005)
          }
        },
        completion: { _ in }
      )
      works.append(try XCTUnwrap(work))
    }
    XCTAssertNil(
      scheduler.submit(
        token: ImageHashCancellationToken(),
        work: { [:] },
        completion: { _ in }
      )
    )
    for work in works { XCTAssertTrue(work.cancelAndWait()) }
    XCTAssertEqual(scheduler.scheduledWorkCount, 0)
  }

  private func fixtureURL(_ name: String) -> URL {
    let tests = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    let repository = tests.deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
    return repository.appendingPathComponent(
      name.contains("/") ? "fixtures/\(name)" : "fixtures/media/\(name)"
    )
  }
}
