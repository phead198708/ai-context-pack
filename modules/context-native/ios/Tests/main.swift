import Darwin
import Foundation
import XCTest
@testable import ContextNativeRecovery

final class InboxRecoverySupportTests: XCTestCase {
  private var root: URL!

  override func setUpWithError() throws {
    root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: root)
  }

  func testAbandonedLockOnlyArtifactIsRemoved() throws {
    let id = UUID().uuidString.lowercased()
    let lock = try createLock(id: id)

    try InboxRecoverySupport.recoverOrphanLocks(container: root)

    XCTAssertFalse(FileManager.default.fileExists(atPath: lock.path))
  }

  func testLiveLockBeforeDirectoryCreationIsPreserved() throws {
    let id = UUID().uuidString.lowercased()
    let lock = try createLock(id: id)
    let holder = Process()
    holder.executableURL = URL(fileURLWithPath: "/usr/bin/lockf")
    holder.arguments = [lock.path, "/bin/sleep", "10"]
    try holder.run()
    Thread.sleep(forTimeInterval: 0.1)
    XCTAssertTrue(holder.isRunning)
    defer {
      holder.terminate()
      holder.waitUntilExit()
    }

    try InboxRecoverySupport.recoverOrphanLocks(container: root)

    XCTAssertTrue(FileManager.default.fileExists(atPath: lock.path))
  }

  func testScannerCannotObserveUnlockedVisibleWriterOwnership() throws {
    let id = UUID().uuidString.lowercased()
    let published = DispatchSemaphore(value: 0)
    let allowOwnership = DispatchSemaphore(value: 0)
    let ownershipAcquired = DispatchSemaphore(value: 0)
    let releaseWriter = DispatchSemaphore(value: 0)
    let writerFinished = DispatchSemaphore(value: 0)
    let scannerAttempted = DispatchSemaphore(value: 0)
    let scannerFinished = DispatchSemaphore(value: 0)
    let lock = root.appendingPathComponent("InboxWriterLocks/\(id).lock")

    DispatchQueue.global().async {
      defer { writerFinished.signal() }
      do {
        let ownership = try InboxWriterOwnership.acquire(container: self.root, ingestionId: id) {
          published.signal()
          _ = allowOwnership.wait(timeout: .now() + 5)
        }
        ownershipAcquired.signal()
        _ = releaseWriter.wait(timeout: .now() + 5)
        ownership.release()
      } catch {
        XCTFail("writer failed: \(error)")
      }
    }

    XCTAssertEqual(published.wait(timeout: .now() + 5), .success)
    XCTAssertTrue(FileManager.default.fileExists(atPath: lock.path))
    DispatchQueue.global().async {
      scannerAttempted.signal()
      do {
        try InboxRecoverySupport.recoverOrphanLocks(container: self.root)
      } catch {
        XCTFail("scanner failed: \(error)")
      }
      scannerFinished.signal()
    }
    XCTAssertEqual(scannerAttempted.wait(timeout: .now() + 5), .success)
    XCTAssertTrue(FileManager.default.fileExists(atPath: lock.path))

    allowOwnership.signal()
    XCTAssertEqual(ownershipAcquired.wait(timeout: .now() + 5), .success)
    XCTAssertEqual(scannerFinished.wait(timeout: .now() + 5), .success)
    XCTAssertTrue(FileManager.default.fileExists(atPath: lock.path))

    releaseWriter.signal()
    XCTAssertEqual(writerFinished.wait(timeout: .now() + 5), .success)
    XCTAssertFalse(FileManager.default.fileExists(atPath: lock.path))
  }

  func testMalformedLockRegistryFailsClosed() throws {
    _ = try createLock(id: "not-a-uuid")
    XCTAssertThrowsError(try InboxRecoverySupport.recoverOrphanLocks(container: root))
  }

  func testRecoveryEventIsDurableBeforeIncompleteDirectoryIsDeleted() throws {
    let id = UUID().uuidString.lowercased()
    let staging = root.appendingPathComponent("InboxStaging/\(id)", isDirectory: true)
    try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
    try Data("private".utf8).write(to: staging.appendingPathComponent("item.bin"))

    XCTAssertTrue(try InboxRecoverySupport.recoverIncompleteTransactions(
      inbox: root.appendingPathComponent("Inbox"),
      staging: root.appendingPathComponent("InboxStaging"),
      container: root
    ))

    XCTAssertFalse(FileManager.default.fileExists(atPath: staging.path))
    XCTAssertEqual(try RecoveryMetadataEventStore.read(container: root, folder: "RecoveryEvents").count, 1)
  }

  func testMalformedRecoveryEventIsQuarantined() throws {
    let events = root.appendingPathComponent("RecoveryEvents", isDirectory: true)
    try FileManager.default.createDirectory(at: events, withIntermediateDirectories: true)
    let event = events.appendingPathComponent("broken.json")
    try Data("private-content-must-not-be-returned".utf8).write(to: event)

    XCTAssertThrowsError(try RecoveryMetadataEventStore.read(container: root, folder: "RecoveryEvents"))
    XCTAssertFalse(FileManager.default.fileExists(atPath: event.path))
    XCTAssertTrue(FileManager.default.fileExists(atPath: events.appendingPathComponent("broken.invalid").path))
  }

  func testManifestIdentityMatchesItsSingleLayerDirectory() throws {
    let id = UUID().uuidString.lowercased()
    try writeManifest(directoryId: id, manifestId: id)

    let manifests = try InboxManifestValidator.read(inbox: root.appendingPathComponent("Inbox"))

    XCTAssertEqual(manifests.count, 1)
    XCTAssertEqual(manifests.first?["ingestionId"] as? String, id)
  }

  func testManifestIdentityMismatchIsRejected() throws {
    try writeManifest(
      directoryId: UUID().uuidString.lowercased(),
      manifestId: UUID().uuidString.lowercased()
    )

    XCTAssertThrowsError(try InboxManifestValidator.read(inbox: root.appendingPathComponent("Inbox")))
  }

  func testNestedManifestIsRejected() throws {
    let id = UUID().uuidString.lowercased()
    try writeManifest(directoryId: id, manifestId: id)
    let nested = root.appendingPathComponent("Inbox/\(id)/nested", isDirectory: true)
    try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: true)
    try Data("{}".utf8).write(to: nested.appendingPathComponent("manifest.json"))

    XCTAssertThrowsError(try InboxManifestValidator.read(inbox: root.appendingPathComponent("Inbox")))
  }

  func testInvalidIngestionDirectoryNameIsRejected() throws {
    try writeManifest(directoryId: "not-a-uuid", manifestId: "not-a-uuid")

    XCTAssertThrowsError(try InboxManifestValidator.read(inbox: root.appendingPathComponent("Inbox")))
  }

  func testManifestItemCannotClaimAnotherIngestionDirectory() throws {
    let id = UUID().uuidString.lowercased()
    let otherId = UUID().uuidString.lowercased()
    try writeManifest(directoryId: otherId, manifestId: otherId)
    let otherItem = root.appendingPathComponent("Inbox/\(otherId)/item.bin")
    try writeManifest(directoryId: id, manifestId: id, itemURL: otherItem)

    XCTAssertThrowsError(try InboxManifestValidator.read(inbox: root.appendingPathComponent("Inbox")))
  }

  private func writeManifest(directoryId: String, manifestId: String, itemURL externalItem: URL? = nil) throws {
    let directory = root.appendingPathComponent("Inbox/\(directoryId)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let item = externalItem ?? directory.appendingPathComponent("item.bin")
    if externalItem == nil { try Data([1, 2, 3]).write(to: item) }
    let manifest: [String: Any] = [
      "schemaVersion": 1,
      "ingestionId": manifestId,
      "createdAt": "2026-01-01T00:00:00.000Z",
      "source": "ios-share-extension",
      "status": "complete",
      "items": [[
        "id": "item",
        "mediaType": "image/png",
        "byteCount": 3,
        "localUri": item.absoluteString,
        "status": "copied"
      ]]
    ]
    let data = try JSONSerialization.data(withJSONObject: manifest, options: [.sortedKeys])
    try data.write(to: directory.appendingPathComponent("manifest.json"))
  }

  private func createLock(id: String) throws -> URL {
    let directory = root.appendingPathComponent("InboxWriterLocks", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let lock = directory.appendingPathComponent("\(id).lock")
    XCTAssertTrue(FileManager.default.createFile(atPath: lock.path, contents: Data()))
    return lock
  }
}
