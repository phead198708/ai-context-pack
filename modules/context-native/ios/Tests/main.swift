import Darwin
import Foundation
import XCTest

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

  private func createLock(id: String) throws -> URL {
    let directory = root.appendingPathComponent("InboxWriterLocks", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let lock = directory.appendingPathComponent("\(id).lock")
    XCTAssertTrue(FileManager.default.createFile(atPath: lock.path, contents: Data()))
    return lock
  }
}
