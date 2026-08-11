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

private final class LockedErrorBox: @unchecked Sendable {
  private let lock = NSLock()
  private var stored: Error?

  func set(_ error: Error) {
    lock.lock()
    stored = error
    lock.unlock()
  }

  var value: Error? {
    lock.lock()
    defer { lock.unlock() }
    return stored
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

  func testStructurallyPaddedAnimationContainersRemainMultiFrame() throws {
    let fixture = fixtureURL("contracts/image-animation-policy-v1.tsv")
    let values = try Dictionary(
      uniqueKeysWithValues: String(contentsOf: fixture, encoding: .utf8)
        .split(separator: "\n")
        .map { line -> (String, Data) in
          let fields = line.split(separator: "\t", maxSplits: 1)
          return (
            String(fields[0]),
            try XCTUnwrap(Data(base64Encoded: String(fields[1])))
          )
        }
    )
    let padded = [
      try insertPrivatePNGChunks(try XCTUnwrap(values["animated-apng"]), count: 2_048),
      insertGIFCommentExtensions(
        try XCTUnwrap(values["animated-gif"]),
        count: 65_536
      ),
    ]

    for data in padded {
      let source = try XCTUnwrap(CGImageSourceCreateWithData(data as CFData, nil))
      XCTAssertFalse(ImagePerceptualHasher.acceptsFrameCount(CGImageSourceGetCount(source)))
    }

    let malformedVariants = [
      try XCTUnwrap(values["animated-apng"]) + Data([0]),
      try XCTUnwrap(values["animated-gif"]) + Data([0]),
      try replacePNGAnimationFrameCount(
        try XCTUnwrap(values["animated-apng"]),
        frameCount: 3
      ),
    ]
    for data in malformedVariants {
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

  private func insertPrivatePNGChunks(_ data: Data, count: Int) throws -> Data {
    let type = Data("acTL".utf8)
    let typeRange = try XCTUnwrap(data.range(of: type))
    let insertionIndex = typeRange.lowerBound - 4
    let chunk = Data([0, 0, 0, 0]) + Data("vpAg".utf8) + Data([0x01, 0x55, 0xc2, 0xb3])
    var padding = Data()
    padding.reserveCapacity(chunk.count * count)
    for _ in 0..<count { padding.append(chunk) }
    var result = data
    result.insert(contentsOf: padding, at: insertionIndex)
    return result
  }

  private func insertGIFCommentExtensions(_ data: Data, count: Int) -> Data {
    let packed = Int(data[10])
    let colorTableBytes = (packed & 0x80) == 0 ? 0 : 3 * (1 << ((packed & 0x07) + 1))
    let insertionIndex = 13 + colorTableBytes
    var padding = Data()
    padding.reserveCapacity(count * 3)
    for _ in 0..<count { padding.append(contentsOf: [0x21, 0xfe, 0x00]) }
    var result = data
    result.insert(contentsOf: padding, at: insertionIndex)
    return result
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

  func testSnapshotStartupMaintenancePurgesOnlyStaleOwnedFiles() throws {
    let fileManager = FileManager.default
    let directory = fileManager.temporaryDirectory.appendingPathComponent(
      "image-hash-snapshot-test-\(UUID().uuidString)",
      isDirectory: true
    )
    try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? fileManager.removeItem(at: directory) }
    let stale = directory.appendingPathComponent("snapshot-stale.tmp")
    let current = directory.appendingPathComponent("snapshot-current.tmp")
    let unrelated = directory.appendingPathComponent("unrelated.tmp")
    try Data("stale synthetic bytes".utf8).write(to: stale)
    try Data("current synthetic bytes".utf8).write(to: current)
    try Data("unrelated".utf8).write(to: unrelated)
    try fileManager.setAttributes(
      [.modificationDate: Date(timeIntervalSince1970: 1)],
      ofItemAtPath: stale.path
    )
    try fileManager.setAttributes(
      [.modificationDate: Date(timeIntervalSince1970: 9)],
      ofItemAtPath: current.path
    )
    try fileManager.setAttributes(
      [.modificationDate: Date(timeIntervalSince1970: 1)],
      ofItemAtPath: unrelated.path
    )

    XCTAssertEqual(
      try ImageHashSnapshotStore.purgeStale(
        in: directory,
        olderThan: Date(timeIntervalSince1970: 5)
      ),
      1
    )
    XCTAssertFalse(fileManager.fileExists(atPath: stale.path))
    XCTAssertTrue(fileManager.fileExists(atPath: current.path))
    XCTAssertTrue(fileManager.fileExists(atPath: unrelated.path))
  }

  func testCancellableDataProviderStopsSupplyingSnapshotBytes() throws {
    let url = fixtureURL("ocr-english.png")
    let byteCount = try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber
    let token = ImageHashCancellationToken()
    let provider = try CancellableImageDataProvider.create(
      url: url,
      byteCount: try XCTUnwrap(byteCount).int64Value,
      cancellation: token
    )
    token.cancel()
    XCTAssertNil(provider.data)
  }

  func testCancellationInterruptsTheSynchronousImageIOReadBoundary() throws {
    let url = fixtureURL("ocr-english.png")
    let data = try Data(contentsOf: url)
    let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    let token = ImageHashCancellationToken()
    let readStarted = DispatchSemaphore(value: 0)
    let releaseRead = DispatchSemaphore(value: 0)
    let completed = expectation(description: "hash cancellation completed")
    let captured = LockedErrorBox()

    DispatchQueue.global(qos: .utility).async {
      do {
        _ = try ImagePerceptualHasher.hash(
          fileURL: url,
          expectedByteCount: Int64(data.count),
          expectedSHA256: digest,
          cancellation: token,
          providerReadHook: { _ in
            readStarted.signal()
            _ = releaseRead.wait(timeout: .now() + 2)
          }
        )
      } catch {
        captured.set(error)
      }
      completed.fulfill()
    }

    XCTAssertEqual(readStarted.wait(timeout: .now() + 2), .success)
    token.cancel()
    releaseRead.signal()
    wait(for: [completed], timeout: 2)
    XCTAssertEqual(
      (captured.value as? ImagePerceptualHashError)?.stableCode,
      "PIPELINE_STAGE_FAILED"
    )
  }

  private func fixtureURL(_ name: String) -> URL {
    let tests = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    let repository = tests.deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
    return repository.appendingPathComponent(
      name.contains("/") ? "fixtures/\(name)" : "fixtures/media/\(name)"
    )
  }

  private func replacePNGAnimationFrameCount(
    _ data: Data,
    frameCount: UInt32
  ) throws -> Data {
    let typeRange = try XCTUnwrap(data.range(of: Data("acTL".utf8)))
    let chunkOffset = typeRange.lowerBound - 4
    var result = data
    result.replaceSubrange(
      (chunkOffset + 8)..<(chunkOffset + 12),
      with: [
        UInt8((frameCount >> 24) & 0xff),
        UInt8((frameCount >> 16) & 0xff),
        UInt8((frameCount >> 8) & 0xff),
        UInt8(frameCount & 0xff),
      ]
    )
    let crc = crc32(result[(chunkOffset + 4)..<(chunkOffset + 16)])
    result.replaceSubrange(
      (chunkOffset + 16)..<(chunkOffset + 20),
      with: [
        UInt8((crc >> 24) & 0xff),
        UInt8((crc >> 16) & 0xff),
        UInt8((crc >> 8) & 0xff),
        UInt8(crc & 0xff),
      ]
    )
    return result
  }

  private func crc32(_ bytes: Data.SubSequence) -> UInt32 {
    var crc: UInt32 = 0xffff_ffff
    for byte in bytes {
      crc ^= UInt32(byte)
      for _ in 0..<8 {
        crc = (crc & 1) == 1 ? (crc >> 1) ^ 0xedb8_8320 : crc >> 1
      }
    }
    return crc ^ 0xffff_ffff
  }
}
