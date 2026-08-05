import CryptoKit
import Foundation
import XCTest
@testable import ContextNativeRecovery

final class OwnedArtifactStoreTests: XCTestCase {
  private var root: URL!
  private var source: URL!
  private let packId = "123e4567-e89b-42d3-a456-426614174000"
  private let artifactId = "223e4567-e89b-42d3-a456-426614174000"

  override func setUpWithError() throws {
    root = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString.lowercased(), isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
    source = root.appendingPathComponent("synthetic-source.bin")
    try Data([1, 2, 3, 4]).write(to: source)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: root)
  }

  func testAtomicPublishIsIdempotentAndOriginalIsImmutable() throws {
    let path = "Packs/\(packId)/originals/\(artifactId).bin"
    let hash = digest(Data([1, 2, 3, 4]))
    let first = try OwnedArtifactStore.publish(
      root: root,
      source: source,
      relativePath: path,
      expectedByteCount: 4,
      expectedSha256: hash
    )
    XCTAssertEqual(first["created"] as? Bool, true)
    XCTAssertEqual(first["sha256"] as? String, hash)

    let replay = try OwnedArtifactStore.publish(
      root: root,
      source: source,
      relativePath: path,
      expectedByteCount: 4,
      expectedSha256: hash
    )
    XCTAssertEqual(replay["created"] as? Bool, false)

    let replacement = root.appendingPathComponent("replacement.bin")
    try Data([9, 9, 9, 9]).write(to: replacement)
    XCTAssertThrowsError(try OwnedArtifactStore.publish(
      root: root,
      source: replacement,
      relativePath: path,
      expectedByteCount: 4,
      expectedSha256: digest(Data([9, 9, 9, 9]))
    )) { error in
      XCTAssertEqual(error as? OwnedArtifactStoreError, .immutableConflict)
    }
    XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent(path)), Data([1, 2, 3, 4]))
  }

  func testAbandonedPartialIsReplacedBeforePublication() throws {
    let path = "Packs/\(packId)/derived/\(artifactId).txt"
    let destination = root.appendingPathComponent(path)
    try FileManager.default.createDirectory(
      at: destination.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    try Data([8, 8]).write(to: destination.appendingPathExtension("partial"))

    let result = try OwnedArtifactStore.publish(
      root: root,
      source: source,
      relativePath: path,
      expectedByteCount: 4,
      expectedSha256: digest(Data([1, 2, 3, 4]))
    )

    XCTAssertEqual(result["created"] as? Bool, true)
    XCTAssertFalse(FileManager.default.fileExists(
      atPath: destination.appendingPathExtension("partial").path
    ))
    XCTAssertEqual(try Data(contentsOf: destination), Data([1, 2, 3, 4]))
  }

  func testAbandonedPartialIsListedCountedQuarantinedAndPurged() throws {
    let path = "Packs/\(packId)/derived/\(artifactId).txt"
    let partialPath = "\(path).partial"
    let partial = root.appendingPathComponent(partialPath)
    try FileManager.default.createDirectory(
      at: partial.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    try Data([8, 8]).write(to: partial)

    let listed = try OwnedArtifactStore.list(root: root)
    XCTAssertEqual(listed.count, 1)
    XCTAssertEqual(listed.first?["relativePath"] as? String, partialPath)
    XCTAssertEqual(listed.first?["byteCount"] as? Int64, 2)
    let initialUsage = try OwnedArtifactStore.usage(root: root)
    XCTAssertEqual(initialUsage["artifactCount"] as? Int, 1)
    XCTAssertEqual(initialUsage["artifactBytes"] as? Int64, 2)

    let quarantined = try OwnedArtifactStore.quarantine(
      root: root,
      relativePath: partialPath
    )
    XCTAssertEqual(quarantined["quarantined"] as? Bool, true)
    XCTAssertEqual(quarantined["anonymousId"] as? String, artifactId)
    XCTAssertEqual(quarantined["byteCount"] as? Int64, 2)
    XCTAssertFalse(FileManager.default.fileExists(atPath: partial.path))
    let quarantinedUsage = try OwnedArtifactStore.usage(root: root)
    XCTAssertEqual(quarantinedUsage["artifactCount"] as? Int, 0)
    XCTAssertEqual(quarantinedUsage["quarantineCount"] as? Int, 1)

    let purge = try OwnedArtifactStore.purgeQuarantine(
      root: root,
      olderThanEpochMs: Int64(Date().timeIntervalSince1970 * 1_000) + 1_000
    )
    XCTAssertEqual(purge["purgedCount"] as? Int, 1)
    XCTAssertEqual(purge["purgedBytes"] as? Int64, 2)
  }

  func testTwoStoreCallersSerializeTheSameImmutableDestination() throws {
    let path = "Packs/\(packId)/exports/\(artifactId).zip"
    let first = root.appendingPathComponent("first.bin")
    let second = root.appendingPathComponent("second.bin")
    try Data(repeating: 1, count: 128 * 1_024).write(to: first)
    try Data(repeating: 2, count: 128 * 1_024).write(to: second)
    let start = DispatchSemaphore(value: 0)
    let group = DispatchGroup()
    let resultLock = NSLock()
    var outcomes: [String] = []

    for input in [first, second] {
      group.enter()
      DispatchQueue.global().async {
        defer { group.leave() }
        _ = start.wait(timeout: .now() + 5)
        let outcome: String
        do {
          _ = try OwnedArtifactStore.publish(
            root: self.root,
            source: input,
            relativePath: path,
            expectedByteCount: 128 * 1_024,
            expectedSha256: self.digest(try Data(contentsOf: input))
          )
          outcome = "created"
        } catch let error as OwnedArtifactStoreError {
          outcome = error.stableCode
        } catch {
          outcome = "unexpected"
        }
        resultLock.lock()
        outcomes.append(outcome)
        resultLock.unlock()
      }
    }
    start.signal()
    start.signal()
    XCTAssertEqual(group.wait(timeout: .now() + 10), .success)
    XCTAssertEqual(outcomes.sorted(), ["STORAGE_ARTIFACT_IMMUTABLE", "created"])
  }

  func testVerificationListingUsageQuarantineAndRemovalExposeMetadataOnly() throws {
    let path = "Packs/\(packId)/previews/\(artifactId).png"
    let hash = digest(Data([1, 2, 3, 4]))
    _ = try OwnedArtifactStore.publish(
      root: root,
      source: source,
      relativePath: path,
      expectedByteCount: 4,
      expectedSha256: hash
    )
    XCTAssertEqual(
      try OwnedArtifactStore.verify(
        root: root,
        relativePath: path,
        expectedByteCount: 4,
        expectedSha256: hash
      )["status"] as? String,
      "verified"
    )
    XCTAssertEqual(try OwnedArtifactStore.list(root: root).count, 1)
    XCTAssertEqual(try OwnedArtifactStore.usage(root: root)["artifactBytes"] as? Int64, 4)

    let quarantined = try OwnedArtifactStore.quarantine(root: root, relativePath: path)
    XCTAssertEqual(quarantined["quarantined"] as? Bool, true)
    XCTAssertEqual(quarantined["anonymousId"] as? String, artifactId)
    XCTAssertEqual(quarantined["byteCount"] as? Int64, 4)
    let usage = try OwnedArtifactStore.usage(root: root)
    XCTAssertEqual(usage["artifactCount"] as? Int, 0)
    XCTAssertEqual(usage["quarantineCount"] as? Int, 1)
    XCTAssertTrue(try OwnedArtifactStore.remove(root: root, relativePath: path))
    let purge = try OwnedArtifactStore.purgeQuarantine(
      root: root,
      olderThanEpochMs: Int64(Date().timeIntervalSince1970 * 1_000) + 1_000
    )
    XCTAssertEqual(purge["purgedCount"] as? Int, 1)
    XCTAssertEqual(purge["purgedBytes"] as? Int64, 4)
    XCTAssertEqual(try OwnedArtifactStore.usage(root: root)["quarantineCount"] as? Int, 0)
  }

  func testRejectsTraversalProviderNamesAndSymlinkSources() throws {
    let invalid = [
      "/Packs/\(packId)/originals/\(artifactId).bin",
      "Packs/\(packId)/originals/../\(artifactId).bin",
      "Packs/\(packId)/originals/private-name.png",
      "Packs/\(packId)/originals/%2e%2e.bin",
    ]
    for path in invalid {
      XCTAssertThrowsError(try OwnedArtifactStore.publish(
        root: root,
        source: source,
        relativePath: path,
        expectedByteCount: nil,
        expectedSha256: nil
      ))
    }
    XCTAssertThrowsError(try OwnedArtifactStore.publish(
      root: root,
      source: source,
      relativePath: "Packs/\(packId)/derived/\(artifactId).txt",
      expectedByteCount: 4,
      expectedSha256: String(repeating: "١", count: 64)
    )) { error in
      XCTAssertEqual(error as? OwnedArtifactStoreError, .invalidInput)
    }
    let symlink = root.appendingPathComponent("source-link.bin")
    try FileManager.default.createSymbolicLink(at: symlink, withDestinationURL: source)
    XCTAssertThrowsError(try OwnedArtifactStore.publish(
      root: root,
      source: symlink,
      relativePath: "Packs/\(packId)/exports/\(artifactId).zip",
      expectedByteCount: nil,
      expectedSha256: nil
    )) { error in
      XCTAssertEqual(error as? OwnedArtifactStoreError, .integrityFailed)
    }

    let pack = root.appendingPathComponent("Packs/\(packId)", isDirectory: true)
    try FileManager.default.createDirectory(at: pack, withIntermediateDirectories: true)
    let escape = root.appendingPathComponent("escape", isDirectory: true)
    try FileManager.default.createDirectory(at: escape, withIntermediateDirectories: false)
    let destination = escape.appendingPathComponent("\(artifactId).bin")
    try Data([1, 2, 3, 4]).write(to: destination)
    try FileManager.default.createSymbolicLink(
      at: pack.appendingPathComponent("originals"),
      withDestinationURL: escape
    )
    XCTAssertThrowsError(try OwnedArtifactStore.verify(
      root: root,
      relativePath: "Packs/\(packId)/originals/\(artifactId).bin",
      expectedByteCount: 4,
      expectedSha256: digest(Data([1, 2, 3, 4]))
    )) { error in
      XCTAssertEqual(error as? OwnedArtifactStoreError, .integrityFailed)
    }
  }

  private func digest(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }
}
