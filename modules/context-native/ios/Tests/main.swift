import Darwin
import Foundation
import XCTest
@testable import ContextNativeRecovery

final class PrivacySafeLoggerTests: XCTestCase {
  func testForbiddenContentFieldsNeverReachSink() throws {
    let forbidden = [
      "text",
      "ocrText",
      "filename",
      "url",
      "fileBytes",
      "detectorMatch",
    ]
    for key in forbidden {
      var serialized: [String] = []
      let logger = PrivacySafeLogger { serialized.append($0) }
      XCTAssertThrowsError(try logger.log(
        event: "import_completed",
        fields: [key: .string("synthetic-private-value")]
      )) { error in
        XCTAssertEqual(error as? PrivacySafeLogError, .unsafeField)
      }
      XCTAssertTrue(serialized.isEmpty)
    }
  }

  func testApprovedKeysRejectUserControlledValues() throws {
    let invalid: [[String: PrivacySafeLogValue]] = [
      ["code": .string("secret text")],
      ["engine": .string("private-engine")],
      ["version": .string("private/path")],
      ["anonymousId": .string("fixture.png")],
      ["count": .decimal(1.5)],
      ["bytes": .integer(-1)],
      ["durationMs": .decimal(.infinity)],
    ]
    for fields in invalid {
      XCTAssertThrowsError(try PrivacySafeLogger.serialize(
        event: "ocr_completed",
        fields: fields
      )) { error in
        XCTAssertEqual(error as? PrivacySafeLogError, .unsafeValue)
      }
    }
  }

  func testUnknownEventIsRejected() throws {
    XCTAssertThrowsError(try PrivacySafeLogger.serialize(event: "private event")) { error in
      XCTAssertEqual(error as? PrivacySafeLogError, .unsafeEvent)
    }
  }

  func testAllowlistedMetadataSerializesDeterministically() throws {
    let serialized = try PrivacySafeLogger.serialize(
      event: "ocr_completed",
      fields: [
        "engine": .string("apple-vision"),
        "durationMs": .decimal(12.5),
        "version": .string("3.0.0"),
        "anonymousId": .string(String(repeating: "f", count: 64)),
      ]
    )
    let object = try XCTUnwrap(
      JSONSerialization.jsonObject(with: Data(serialized.utf8)) as? [String: Any]
    )
    XCTAssertEqual(object["event"] as? String, "ocr_completed")
    XCTAssertEqual(object["engine"] as? String, "apple-vision")
    XCTAssertEqual(object["durationMs"] as? Double, 12.5)
    XCTAssertNil(object["text"])
  }
}

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

    assertMetadataError(.schemaInvalid) {
      _ = try RecoveryMetadataEventStore.read(container: root, folder: "RecoveryEvents")
    }
    XCTAssertFalse(FileManager.default.fileExists(atPath: event.path))
    XCTAssertTrue(FileManager.default.fileExists(atPath: events.appendingPathComponent("broken.invalid").path))
  }

  func testInvalidRecoveryEventIdHasStableCode() throws {
    assertMetadataError(.invalidId) {
      _ = try RecoveryMetadataEventStore.ack(
        container: root,
        folder: "RecoveryEvents",
        id: "not-a-uuid"
      )
    }
  }

  func testEqualNonRfcRecoveryIdsAreQuarantinedAndCannotBeAcknowledged() throws {
    let invalidIds = [
      "00000000-0000-0000-0000-000000000000",
      "00000000-0000-0000-8000-000000000000",
      "00000000-0000-4000-0000-000000000000"
    ]
    let events = root.appendingPathComponent("RecoveryEvents", isDirectory: true)
    try FileManager.default.createDirectory(at: events, withIntermediateDirectories: true)

    for id in invalidIds {
      let event = events.appendingPathComponent("\(id).json")
      let payload: [String: Any] = [
        "schemaVersion": 1,
        "id": id,
        "code": "INBOX_RECOVERY_REQUIRED",
        "createdAtMs": 1
      ]
      try JSONSerialization.data(withJSONObject: payload).write(to: event)

      assertMetadataError(.schemaInvalid) {
        _ = try RecoveryMetadataEventStore.read(container: root, folder: "RecoveryEvents")
      }
      XCTAssertFalse(FileManager.default.fileExists(atPath: event.path))
      XCTAssertTrue(FileManager.default.fileExists(
        atPath: events.appendingPathComponent("\(id).invalid").path
      ))
      XCTAssertEqual(
        try RecoveryMetadataEventStore.read(container: root, folder: "RecoveryEvents").count,
        0
      )
      assertMetadataError(.invalidId) {
        _ = try RecoveryMetadataEventStore.ack(
          container: root,
          folder: "RecoveryEvents",
          id: id
        )
      }
    }
  }

  func testMissingRecoveryEventAcknowledgementIsIdempotent() throws {
    let id = UUID().uuidString.lowercased()
    XCTAssertTrue(try RecoveryMetadataEventStore.ack(
      container: root,
      folder: "RecoveryEvents",
      id: id
    ))
  }

  func testRecoveryEventRemoveFailureHasStableCode() throws {
    let id = UUID().uuidString.lowercased()
    let events = root.appendingPathComponent("RecoveryEvents", isDirectory: true)
    try FileManager.default.createDirectory(at: events, withIntermediateDirectories: true)
    try Data("event".utf8).write(to: events.appendingPathComponent("\(id).json"))

    assertMetadataError(.acknowledgmentFailed) {
      _ = try RecoveryMetadataEventStore.ack(
        container: root,
        folder: "RecoveryEvents",
        id: id,
        operationHook: { operation in
          if case .acknowledge = operation { throw TestIOError.injected }
        }
      )
    }
  }

  func testUnreadableRecoveryDirectoryHasStableCode() throws {
    let events = root.appendingPathComponent("RecoveryEvents", isDirectory: true)
    try FileManager.default.createDirectory(at: events, withIntermediateDirectories: true)

    assertMetadataError(.readFailed) {
      _ = try RecoveryMetadataEventStore.read(
        container: root,
        folder: "RecoveryEvents",
        operationHook: { operation in
          if case .list = operation { throw TestIOError.injected }
        }
      )
    }
  }

  func testRecoveryEventQuarantineFailureHasStableCode() throws {
    let events = root.appendingPathComponent("RecoveryEvents", isDirectory: true)
    try FileManager.default.createDirectory(at: events, withIntermediateDirectories: true)
    let event = events.appendingPathComponent("broken.json")
    try Data("malformed".utf8).write(to: event)

    assertMetadataError(.writeFailed) {
      _ = try RecoveryMetadataEventStore.read(
        container: root,
        folder: "RecoveryEvents",
        operationHook: { operation in
          if case .quarantine = operation { throw TestIOError.injected }
        }
      )
    }
    XCTAssertTrue(FileManager.default.fileExists(atPath: event.path))
  }

  func testRecoveryEventWriteFailureHasStableCode() throws {
    assertMetadataError(.writeFailed) {
      try RecoveryMetadataEventStore.persistRecovery(
        container: root,
        operationHook: { operation in
          if case .write = operation { throw TestIOError.injected }
        }
      )
    }
  }

  func testRecoveryMetadataErrorCodesRemainStable() {
    XCTAssertEqual(RecoveryMetadataEventError.invalidId.stableCode, "METADATA_EVENT_ID_INVALID")
    XCTAssertEqual(RecoveryMetadataEventError.schemaInvalid.stableCode, "NATIVE_EVENT_SCHEMA_INVALID")
    XCTAssertEqual(RecoveryMetadataEventError.readFailed.stableCode, "NATIVE_EVENT_STORE_READ_FAILED")
    XCTAssertEqual(RecoveryMetadataEventError.writeFailed.stableCode, "NATIVE_EVENT_STORE_WRITE_FAILED")
    XCTAssertEqual(
      RecoveryMetadataEventError.acknowledgmentFailed.stableCode,
      "NATIVE_RECOVERY_ACK_FAILED"
    )
  }

  func testSwiftEncodersMatchEverySharedV1Fixture() throws {
    let testDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    let repository = testDirectory
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
    let fixtures = repository.appendingPathComponent("fixtures/contracts", isDirectory: true)

    for (name, payload) in ContractFixtureEncoder.payloads {
      let expectedData = try Data(contentsOf: fixtures.appendingPathComponent(name))
      let expected = try JSONSerialization.jsonObject(with: expectedData)
      let canonicalExpected = try JSONSerialization.data(withJSONObject: expected, options: [.sortedKeys])
      let canonicalPayload = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
      XCTAssertEqual(canonicalPayload, canonicalExpected, name)
    }
  }

  func testManifestIdentityMatchesItsSingleLayerDirectory() throws {
    let id = UUID().uuidString.lowercased()
    try writeManifest(directoryId: id, manifestId: id)

    let manifests = try InboxManifestValidator.read(inbox: root.appendingPathComponent("Inbox"))

    XCTAssertEqual(manifests.count, 1)
    XCTAssertEqual(manifests.first?["ingestionId"] as? String, id)
  }

  func testPersistenceErrorCodesRemainValidFailedManifestValues() throws {
    let id = UUID().uuidString.lowercased()
    for errorCode in [
      "STORAGE_DIVERGENCE_DETECTED",
      "STORAGE_ARTIFACT_IMMUTABLE",
      "PERSISTENCE_CONFLICT",
      "DEVELOPMENT_RESET_FORBIDDEN"
    ] {
      try writeFailedManifest(
        directoryId: id,
        manifestId: id,
        errorCode: errorCode
      )
      let manifest = try InboxManifestValidator.readPublished(
        inbox: root.appendingPathComponent("Inbox"),
        ingestionId: id
      )
      let items = try XCTUnwrap(manifest["items"] as? [[String: Any]])
      XCTAssertEqual(items.first?["errorCode"] as? String, errorCode)
    }
  }

  func testManifestIdentityMismatchIsRejected() throws {
    try writeManifest(
      directoryId: UUID().uuidString.lowercased(),
      manifestId: UUID().uuidString.lowercased()
    )

    XCTAssertThrowsError(try InboxManifestValidator.read(inbox: root.appendingPathComponent("Inbox")))
  }

  func testUnknownManifestSchemaVersionIsExplicitlyRejected() throws {
    let id = UUID().uuidString.lowercased()
    try writeManifest(directoryId: id, manifestId: id, schemaVersion: 2)

    XCTAssertThrowsError(
      try InboxManifestValidator.read(inbox: root.appendingPathComponent("Inbox"))
    ) { error in
      XCTAssertEqual(error as? InboxManifestValidationError, .unsupportedVersion)
      XCTAssertEqual((error as? InboxManifestValidationError)?.stableCode, "SCHEMA_VERSION_UNSUPPORTED")
    }
  }

  func testEveryNumericUnsupportedManifestSchemaVersionIsExplicitlyRejected() throws {
    for schemaVersion in [NSNumber(value: -1), NSNumber(value: 1.5), NSNumber(value: 2)] {
      let id = UUID().uuidString.lowercased()
      try writeManifest(directoryId: id, manifestId: id, schemaVersion: schemaVersion)

      XCTAssertThrowsError(
        try InboxManifestValidator.readPublished(
          inbox: root.appendingPathComponent("Inbox"),
          ingestionId: id
        )
      ) { error in
        XCTAssertEqual(error as? InboxManifestValidationError, .unsupportedVersion)
        XCTAssertEqual(
          (error as? InboxManifestValidationError)?.stableCode,
          "SCHEMA_VERSION_UNSUPPORTED"
        )
      }
    }
  }

  func testArbitraryPrecisionNumericManifestSchemaVersionIsExplicitlyRejected() throws {
    for rawVersion in [
      "1.0",
      "1e0",
      "1.0000000000000001",
      "1.000000000000000000000000000000000000001"
    ] {
      let id = UUID().uuidString.lowercased()
      try writeManifest(directoryId: id, manifestId: id)
      try rewriteManifestSchemaVersion(directoryId: id, rawToken: rawVersion)

      XCTAssertThrowsError(
        try InboxManifestValidator.readPublished(
          inbox: root.appendingPathComponent("Inbox"),
          ingestionId: id
        )
      ) { error in
        XCTAssertEqual(error as? InboxManifestValidationError, .unsupportedVersion)
        XCTAssertEqual(
          (error as? InboxManifestValidationError)?.stableCode,
          "SCHEMA_VERSION_UNSUPPORTED"
        )
      }
    }
  }

  func testEscapedDuplicateSchemaVersionKeyCannotHideUnsupportedToken() throws {
    let id = UUID().uuidString.lowercased()
    try writeManifest(directoryId: id, manifestId: id)
    try rewriteManifestSchemaVersion(
      directoryId: id,
      rawToken: "1,\"\\u0073chemaVersion\":1.000000000000000000000000000000000000001"
    )

    XCTAssertThrowsError(
      try InboxManifestValidator.readPublished(
        inbox: root.appendingPathComponent("Inbox"),
        ingestionId: id
      )
    ) { error in
      XCTAssertEqual(error as? InboxManifestValidationError, .invalidManifest)
      XCTAssertEqual((error as? InboxManifestValidationError)?.stableCode, "SCHEMA_INVALID")
    }
  }

  func testNonNumericManifestSchemaVersionsRemainSchemaInvalid() throws {
    let schemaVersions: [Any] = ["1", true]
    for schemaVersion in schemaVersions {
      let id = UUID().uuidString.lowercased()
      try writeManifest(directoryId: id, manifestId: id, schemaVersion: schemaVersion)

      XCTAssertThrowsError(
        try InboxManifestValidator.readPublished(
          inbox: root.appendingPathComponent("Inbox"),
          ingestionId: id
        )
      ) { error in
        XCTAssertEqual(error as? InboxManifestValidationError, .invalidManifest)
        XCTAssertEqual((error as? InboxManifestValidationError)?.stableCode, "SCHEMA_INVALID")
      }
    }
  }

  func testMalformedCurrentVersionManifestIsSchemaInvalid() throws {
    let id = UUID().uuidString.lowercased()
    let directory = root.appendingPathComponent("Inbox/\(id)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try Data("{truncated".utf8).write(to: directory.appendingPathComponent("manifest.json"))

    XCTAssertThrowsError(
      try InboxManifestValidator.read(inbox: root.appendingPathComponent("Inbox"))
    ) { error in
      XCTAssertEqual(error as? InboxManifestValidationError, .invalidManifest)
      XCTAssertEqual((error as? InboxManifestValidationError)?.stableCode, "SCHEMA_INVALID")
    }
    XCTAssertEqual(
      try FileManager.default.contentsOfDirectory(
        at: root.appendingPathComponent("Inbox"),
        includingPropertiesForKeys: nil
      ).count,
      0
    )
    XCTAssertEqual(
      try FileManager.default.contentsOfDirectory(
        at: root.appendingPathComponent("InboxQuarantine"),
        includingPropertiesForKeys: nil
      ).count,
      1
    )
    XCTAssertEqual(
      try InboxManifestValidator.read(inbox: root.appendingPathComponent("Inbox")).count,
      0
    )
  }

  func testCalendarInvalidTimestampsAreSchemaInvalid() throws {
    for timestamp in [
      "2026-02-29T00:00:00Z",
      "2026-01-01T24:00:00Z",
      "2026-04-31T00:00:00Z"
    ] {
      let id = UUID().uuidString.lowercased()
      try writeManifest(directoryId: id, manifestId: id, createdAt: timestamp)

      XCTAssertThrowsError(
        try InboxManifestValidator.read(inbox: root.appendingPathComponent("Inbox"))
      ) { error in
        XCTAssertEqual(error as? InboxManifestValidationError, .invalidManifest)
        XCTAssertEqual((error as? InboxManifestValidationError)?.stableCode, "SCHEMA_INVALID")
      }

      try FileManager.default.removeItem(at: root.appendingPathComponent("Inbox"))
    }
  }

  func testRealLeapDayWithNanosecondPrecisionIsAccepted() throws {
    let id = UUID().uuidString.lowercased()
    try writeManifest(
      directoryId: id,
      manifestId: id,
      createdAt: "2024-02-29T23:59:59.123456789Z"
    )

    XCTAssertEqual(
      try InboxManifestValidator.read(inbox: root.appendingPathComponent("Inbox")).count,
      1
    )
  }

  func testMissingCopiedFileIsArtifactIntegrityFailure() throws {
    let id = UUID().uuidString.lowercased()
    try writeManifest(directoryId: id, manifestId: id)
    let item = root.appendingPathComponent("Inbox/\(id)/\(manifestItemId).bin")
    try FileManager.default.removeItem(at: item)

    assertArtifactIntegrityFailure {
      _ = try InboxManifestValidator.read(inbox: root.appendingPathComponent("Inbox"))
    }
  }

  func testSizeMismatchedCopiedFileIsArtifactIntegrityFailure() throws {
    let id = UUID().uuidString.lowercased()
    try writeManifest(directoryId: id, manifestId: id)
    let item = root.appendingPathComponent("Inbox/\(id)/\(manifestItemId).bin")
    try Data([1, 2, 3, 4]).write(to: item)

    assertArtifactIntegrityFailure {
      _ = try InboxManifestValidator.read(inbox: root.appendingPathComponent("Inbox"))
    }
  }

  func testEqualLengthDigestMismatchIsArtifactIntegrityFailure() throws {
    let id = UUID().uuidString.lowercased()
    try writeManifest(
      directoryId: id,
      manifestId: id,
      sha256: originalItemSHA256
    )
    let item = root.appendingPathComponent("Inbox/\(id)/\(manifestItemId).bin")
    try Data([3, 2, 1]).write(to: item)

    assertArtifactIntegrityFailure {
      _ = try InboxManifestValidator.read(inbox: root.appendingPathComponent("Inbox"))
    }
  }

  func testMatchingCopiedFileDigestIsAccepted() throws {
    let id = UUID().uuidString.lowercased()
    try writeManifest(
      directoryId: id,
      manifestId: id,
      sha256: originalItemSHA256
    )

    XCTAssertEqual(
      try InboxManifestValidator.read(inbox: root.appendingPathComponent("Inbox")).count,
      1
    )
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
    let otherItem = root.appendingPathComponent("Inbox/\(otherId)/823e4567-e89b-42d3-a456-426614174000.bin")
    try writeManifest(directoryId: id, manifestId: id, itemURL: otherItem)

    XCTAssertThrowsError(try InboxManifestValidator.read(inbox: root.appendingPathComponent("Inbox")))
  }

  func testOversizedManifestMediaTypeIsSchemaInvalid() throws {
    let id = UUID().uuidString.lowercased()
    try writeManifest(
      directoryId: id,
      manifestId: id,
      mediaType: "application/" + String(repeating: "x", count: 127)
    )

    XCTAssertThrowsError(
      try InboxManifestValidator.read(inbox: root.appendingPathComponent("Inbox"))
    ) { error in
      XCTAssertEqual(error as? InboxManifestValidationError, .invalidManifest)
    }
  }

  private func writeManifest(
    directoryId: String,
    manifestId: String,
    itemURL externalItem: URL? = nil,
    schemaVersion: Any = 1,
    createdAt: String = "2026-01-01T00:00:00.000Z",
    sha256: String? = nil,
    mediaType: String = "image/png"
  ) throws {
    let directory = root.appendingPathComponent("Inbox/\(directoryId)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let item = externalItem ?? directory.appendingPathComponent("\(manifestItemId).bin")
    if externalItem == nil { try Data([1, 2, 3]).write(to: item) }
    var copiedItem: [String: Any] = [
      "id": manifestItemId,
      "order": 0,
      "mediaType": mediaType,
      "byteCount": 3,
      "relativePath": item.lastPathComponent,
      "status": "copied"
    ]
    if let sha256 { copiedItem["sha256"] = sha256 }
    let manifest: [String: Any] = [
      "schemaVersion": schemaVersion,
      "ingestionId": manifestId,
      "createdAt": createdAt,
      "source": "ios-share-extension",
      "status": "complete",
      "items": [copiedItem]
    ]
    let data = try JSONSerialization.data(withJSONObject: manifest, options: [.sortedKeys])
    try data.write(to: directory.appendingPathComponent("manifest.json"))
  }

  private func writeFailedManifest(
    directoryId: String,
    manifestId: String,
    errorCode: String
  ) throws {
    let directory = root.appendingPathComponent("Inbox/\(directoryId)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let manifest: [String: Any] = [
      "schemaVersion": 1,
      "ingestionId": manifestId,
      "createdAt": "2026-01-01T00:00:00.000Z",
      "source": "ios-share-extension",
      "status": "failed",
      "items": [[
        "id": manifestItemId,
        "order": 0,
        "mediaType": "application/octet-stream",
        "byteCount": 0,
        "status": "failed",
        "errorCode": errorCode,
      ]],
    ]
    let data = try JSONSerialization.data(withJSONObject: manifest, options: [.sortedKeys])
    try data.write(to: directory.appendingPathComponent("manifest.json"), options: .atomic)
  }

  private func rewriteManifestSchemaVersion(
    directoryId: String,
    rawToken: String
  ) throws {
    let manifestURL = root.appendingPathComponent("Inbox/\(directoryId)/manifest.json")
    var serialized = String(decoding: try Data(contentsOf: manifestURL), as: UTF8.self)
    let currentVersion = "\"schemaVersion\":1"
    let range = try XCTUnwrap(serialized.range(of: currentVersion))
    serialized.replaceSubrange(range, with: "\"schemaVersion\":\(rawToken)")
    try Data(serialized.utf8).write(to: manifestURL)
  }

  private func createLock(id: String) throws -> URL {
    let directory = root.appendingPathComponent("InboxWriterLocks", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let lock = directory.appendingPathComponent("\(id).lock")
    XCTAssertTrue(FileManager.default.createFile(atPath: lock.path, contents: Data()))
    return lock
  }

  private func assertMetadataError(
    _ expected: RecoveryMetadataEventError,
    operation: () throws -> Void
  ) {
    XCTAssertThrowsError(try operation()) { error in
      XCTAssertEqual(error as? RecoveryMetadataEventError, expected)
      XCTAssertFalse(expected.stableCode.isEmpty)
    }
  }

  private func assertArtifactIntegrityFailure(operation: () throws -> Void) {
    XCTAssertThrowsError(try operation()) { error in
      XCTAssertEqual(error as? InboxManifestValidationError, .artifactIntegrityFailed)
      XCTAssertEqual(
        (error as? InboxManifestValidationError)?.stableCode,
        "ARTIFACT_INTEGRITY_FAILED"
      )
    }
  }

  private let manifestItemId = "823e4567-e89b-42d3-a456-426614174000"
  private let originalItemSHA256 =
    "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81"
}

final class InboxArtifactHandoffTests: XCTestCase {
  private var container: URL!
  private var applicationSupport: URL!

  override func setUpWithError() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    container = root.appendingPathComponent("Group", isDirectory: true)
    applicationSupport = root.appendingPathComponent("ApplicationSupport", isDirectory: true)
    try FileManager.default.createDirectory(at: container, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: applicationSupport, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: container.deletingLastPathComponent())
  }

  func testHandoffPublishesOwnedPathAndAcknowledgesOnlyAfterCommitBoundary() throws {
    let ingestionId = UUID().uuidString.lowercased()
    let packId = UUID().uuidString.lowercased()
    let itemId = UUID().uuidString.lowercased()
    try writeManifest(ingestionId: ingestionId, items: [(itemId, "image/png", Data([1, 2, 3]))])

    let result = try InboxArtifactHandoff.handoff(
      container: container,
      applicationSupport: applicationSupport,
      ingestionId: ingestionId,
      packId: packId,
      requiredHeadroomBytes: 0,
      availableBytes: { _ in Int64.max }
    )

    let artifacts = try XCTUnwrap(result["artifacts"] as? [[String: Any]])
    XCTAssertEqual(artifacts.count, 1)
    XCTAssertEqual((result["manifestFingerprint"] as? String)?.count, 64)
    XCTAssertEqual((artifacts.first?["sha256"] as? String)?.count, 64)
    XCTAssertEqual(
      artifacts.first?["relativePath"] as? String,
      "Packs/\(packId)/originals/\(itemId).bin"
    )
    XCTAssertTrue(FileManager.default.fileExists(
      atPath: applicationSupport.appendingPathComponent("Packs/\(packId)/originals/\(itemId).bin").path
    ))
    XCTAssertTrue(FileManager.default.fileExists(
      atPath: container.appendingPathComponent("Inbox/\(ingestionId)").path
    ))

    XCTAssertTrue(try InboxArtifactHandoff.acknowledge(
      container: container,
      ingestionId: ingestionId
    ))
    XCTAssertFalse(FileManager.default.fileExists(
      atPath: container.appendingPathComponent("Inbox/\(ingestionId)").path
    ))
    XCTAssertTrue(try InboxArtifactHandoff.acknowledge(
      container: container,
      ingestionId: ingestionId
    ))
  }

  func testEveryHandoffInterruptionReplaysWithoutDuplicateArtifacts() throws {
    let points: [InboxArtifactHandoffPoint] = [
      .beforeCopy, .duringCopy, .afterFileClose, .beforePublishRename,
    ]
    for point in points {
      let ingestionId = UUID().uuidString.lowercased()
      let packId = UUID().uuidString.lowercased()
      let itemId = UUID().uuidString.lowercased()
      try writeManifest(
        ingestionId: ingestionId,
        items: [(itemId, "image/png", Data(repeating: 7, count: 131_072))]
      )
      var interrupted = false
      XCTAssertThrowsError(try InboxArtifactHandoff.handoff(
        container: container,
        applicationSupport: applicationSupport,
        ingestionId: ingestionId,
        packId: packId,
        requiredHeadroomBytes: 0,
        availableBytes: { _ in Int64.max },
        operationHook: { observed in
          if !interrupted && samePoint(observed, point) {
            interrupted = true
            throw TestIOError.injected
          }
        }
      ))
      XCTAssertTrue(interrupted)

      let replay = try InboxArtifactHandoff.handoff(
        container: container,
        applicationSupport: applicationSupport,
        ingestionId: ingestionId,
        packId: packId,
        requiredHeadroomBytes: 0,
        availableBytes: { _ in Int64.max }
      )
      XCTAssertEqual((replay["artifacts"] as? [[String: Any]])?.count, 1)
      let directory = applicationSupport.appendingPathComponent("Packs/\(packId)/originals")
      XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), ["\(itemId).bin"])
    }
  }

  func testLowDiskFailsBeforeAnyPartialFileIsCreated() throws {
    let ingestionId = UUID().uuidString.lowercased()
    let packId = UUID().uuidString.lowercased()
    let itemId = UUID().uuidString.lowercased()
    try writeManifest(ingestionId: ingestionId, items: [(itemId, "image/png", Data([1]))])

    XCTAssertThrowsError(try InboxArtifactHandoff.handoff(
      container: container,
      applicationSupport: applicationSupport,
      ingestionId: ingestionId,
      packId: packId,
      requiredHeadroomBytes: 1,
      availableBytes: { _ in 1 }
    )) { error in
      XCTAssertEqual(error as? InboxArtifactHandoffError, .lowDisk)
      XCTAssertEqual((error as? InboxArtifactHandoffError)?.stableCode, "RESOURCE_LOW_DISK")
    }
    XCTAssertFalse(FileManager.default.fileExists(
      atPath: applicationSupport.appendingPathComponent("Packs/\(packId)").path
    ))
  }

  func testReplayBudgetsOnlyHeadroomWhenArtifactIsAlreadyPublished() throws {
    let ingestionId = UUID().uuidString.lowercased()
    let packId = UUID().uuidString.lowercased()
    let itemId = UUID().uuidString.lowercased()
    try writeManifest(
      ingestionId: ingestionId,
      items: [(itemId, "image/png", Data(repeating: 1, count: 4_096))]
    )
    _ = try InboxArtifactHandoff.handoff(
      container: container,
      applicationSupport: applicationSupport,
      ingestionId: ingestionId,
      packId: packId,
      requiredHeadroomBytes: 128,
      availableBytes: { _ in Int64.max }
    )

    let replay = try InboxArtifactHandoff.handoff(
      container: container,
      applicationSupport: applicationSupport,
      ingestionId: ingestionId,
      packId: packId,
      requiredHeadroomBytes: 128,
      availableBytes: { _ in 128 }
    )
    XCTAssertEqual((replay["artifacts"] as? [[String: Any]])?.count, 1)
  }

  func testNewDestinationHierarchySynchronizesEveryDirectoryAndParent() throws {
    let ingestionId = UUID().uuidString.lowercased()
    let packId = UUID().uuidString.lowercased()
    let itemId = UUID().uuidString.lowercased()
    try writeManifest(ingestionId: ingestionId, items: [(itemId, "image/png", Data([1]))])
    var synchronized: [String] = []

    _ = try InboxArtifactHandoff.handoff(
      container: container,
      applicationSupport: applicationSupport,
      ingestionId: ingestionId,
      packId: packId,
      requiredHeadroomBytes: 0,
      availableBytes: { _ in Int64.max },
      directorySynchronizer: { synchronized.append($0.standardizedFileURL.path) }
    )

    let packs = applicationSupport.appendingPathComponent("Packs")
    let pack = packs.appendingPathComponent(packId)
    let originals = pack.appendingPathComponent("originals")
    for directory in [
      applicationSupport!.deletingLastPathComponent(),
      applicationSupport!,
      packs,
      pack,
      originals,
    ] {
      XCTAssertTrue(synchronized.contains(directory.standardizedFileURL.path))
    }
  }

  func testFreshInstallCreatesAndSynchronizesApplicationSupportAncestors() throws {
    let root = container.deletingLastPathComponent()
    let library = root.appendingPathComponent("Library", isDirectory: true)
    try FileManager.default.createDirectory(at: library, withIntermediateDirectories: false)
    let applicationSupportDirectory = library.appendingPathComponent(
      "Application Support",
      isDirectory: true
    )
    applicationSupport = applicationSupportDirectory.appendingPathComponent(
      "AIContextPack",
      isDirectory: true
    )
    XCTAssertFalse(FileManager.default.fileExists(atPath: applicationSupportDirectory.path))
    let ingestionId = UUID().uuidString.lowercased()
    let packId = UUID().uuidString.lowercased()
    let itemId = UUID().uuidString.lowercased()
    try writeManifest(ingestionId: ingestionId, items: [(itemId, "image/png", Data([1]))])
    var synchronized: [String] = []
    var capacityProbe: URL?

    _ = try InboxArtifactHandoff.handoff(
      container: container,
      applicationSupport: applicationSupport,
      ingestionId: ingestionId,
      packId: packId,
      requiredHeadroomBytes: 0,
      availableBytes: { directory in
        capacityProbe = directory
        return Int64.max
      },
      directorySynchronizer: { synchronized.append($0.standardizedFileURL.path) }
    )

    XCTAssertEqual(capacityProbe?.standardizedFileURL, library.standardizedFileURL)
    let packs = applicationSupport.appendingPathComponent("Packs")
    let pack = packs.appendingPathComponent(packId)
    let originals = pack.appendingPathComponent("originals")
    for directory in [
      library,
      applicationSupportDirectory,
      applicationSupport!,
      packs,
      pack,
      originals,
    ] {
      XCTAssertTrue(synchronized.contains(directory.standardizedFileURL.path))
    }
  }

  func testDirectorySynchronizationFailureFailsBeforePublishingArtifacts() throws {
    let ingestionId = UUID().uuidString.lowercased()
    let packId = UUID().uuidString.lowercased()
    let itemId = UUID().uuidString.lowercased()
    try writeManifest(ingestionId: ingestionId, items: [(itemId, "image/png", Data([1]))])

    XCTAssertThrowsError(try InboxArtifactHandoff.handoff(
      container: container,
      applicationSupport: applicationSupport,
      ingestionId: ingestionId,
      packId: packId,
      requiredHeadroomBytes: 0,
      availableBytes: { _ in Int64.max },
      directorySynchronizer: { directory in
        if directory.lastPathComponent == packId { throw TestIOError.injected }
      }
    )) { error in
      XCTAssertEqual(error as? InboxArtifactHandoffError, .writeFailed)
    }
    XCTAssertFalse(FileManager.default.fileExists(
      atPath: applicationSupport.appendingPathComponent(
        "Packs/\(packId)/originals/\(itemId).bin"
      ).path
    ))
    var retriedExistingPackSync = false
    _ = try InboxArtifactHandoff.handoff(
      container: container,
      applicationSupport: applicationSupport,
      ingestionId: ingestionId,
      packId: packId,
      requiredHeadroomBytes: 0,
      availableBytes: { _ in Int64.max },
      directorySynchronizer: { directory in
        if directory.lastPathComponent == packId { retriedExistingPackSync = true }
      }
    )
    XCTAssertTrue(retriedExistingPackSync)
  }

  func testAcknowledgementCrashAfterRenameLeavesScannerInvisibleTombstone() throws {
    let ingestionId = UUID().uuidString.lowercased()
    let itemId = UUID().uuidString.lowercased()
    try writeManifest(ingestionId: ingestionId, items: [(itemId, "image/png", Data([1]))])
    var interrupted = false

    XCTAssertThrowsError(try InboxArtifactHandoff.acknowledge(
      container: container,
      ingestionId: ingestionId,
      operationHook: { point in
        if !interrupted, case .afterTombstoneRename = point {
          interrupted = true
          throw TestIOError.injected
        }
      }
    ))
    XCTAssertTrue(interrupted)
    XCTAssertFalse(FileManager.default.fileExists(
      atPath: container.appendingPathComponent("Inbox/\(ingestionId)").path
    ))
    XCTAssertTrue(
      try InboxManifestValidator.read(
        inbox: container.appendingPathComponent("Inbox")
      ).isEmpty
    )
    let tombstones = container.appendingPathComponent("InboxAckTombstones")
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: tombstones.path).count, 1)
    XCTAssertTrue(try InboxArtifactHandoff.acknowledge(
      container: container,
      ingestionId: ingestionId
    ))
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: tombstones.path), [])
  }

  func testAcknowledgementCrashAfterReceiptCannotReopenAnAlreadyConsumedId() throws {
    let ingestionId = UUID().uuidString.lowercased()
    let itemId = UUID().uuidString.lowercased()
    try writeManifest(
      ingestionId: ingestionId,
      items: [(itemId, "image/png", Data([1, 2, 3]))]
    )
    var interrupted = false

    XCTAssertThrowsError(try InboxArtifactHandoff.acknowledge(
      container: container,
      ingestionId: ingestionId,
      operationHook: { point in
        if !interrupted, case .afterReceiptPublish = point {
          interrupted = true
          throw TestIOError.injected
        }
      }
    ))

    XCTAssertTrue(interrupted)
    XCTAssertTrue(FileManager.default.fileExists(
      atPath: container.appendingPathComponent("Inbox/\(ingestionId)").path
    ))
    XCTAssertTrue(FileManager.default.fileExists(
      atPath: container.appendingPathComponent(
        "InboxAcknowledgements/\(ingestionId).json"
      ).path
    ))
    let replay = try ShareIngestionSession(
      container: container,
      ingestionId: ingestionId
    )
    try replay.recordFile(
      id: UUID().uuidString.lowercased(),
      order: 0,
      declaredMediaType: "image/png",
      source: container.appendingPathComponent("provider-must-not-open")
    )
    XCTAssertTrue(try replay.finish().replayed)
    XCTAssertTrue(try InboxArtifactHandoff.acknowledge(
      container: container,
      ingestionId: ingestionId
    ))
    XCTAssertFalse(FileManager.default.fileExists(
      atPath: container.appendingPathComponent("Inbox/\(ingestionId)").path
    ))
    XCTAssertTrue(FileManager.default.fileExists(
      atPath: container.appendingPathComponent(
        "InboxAcknowledgements/\(ingestionId).json"
      ).path
    ))
  }

  func testAcknowledgementPreservesUnsupportedReceiptSchemaCode() throws {
    let ingestionId = UUID().uuidString.lowercased()
    let receipts = container.appendingPathComponent(
      "InboxAcknowledgements",
      isDirectory: true
    )
    try FileManager.default.createDirectory(at: receipts, withIntermediateDirectories: false)
    try Data(#"{"schemaVersion":2}"#.utf8).write(
      to: receipts.appendingPathComponent("\(ingestionId).json")
    )

    XCTAssertThrowsError(try InboxArtifactHandoff.acknowledge(
      container: container,
      ingestionId: ingestionId
    )) { error in
      XCTAssertEqual(error as? InboxArtifactHandoffError, .unsupportedVersion)
      XCTAssertEqual(
        (error as? InboxArtifactHandoffError)?.stableCode,
        "SCHEMA_VERSION_UNSUPPORTED"
      )
    }
  }

  func testAcknowledgementPreservesUnsupportedTombstoneSchemaCode() throws {
    let ingestionId = UUID().uuidString.lowercased()
    let tombstones = container.appendingPathComponent(
      "InboxAckTombstones",
      isDirectory: true
    )
    try FileManager.default.createDirectory(at: tombstones, withIntermediateDirectories: false)
    let tombstone = tombstones.appendingPathComponent(
      "\(ingestionId)-\(UUID().uuidString.lowercased()).ack",
      isDirectory: true
    )
    try FileManager.default.createDirectory(at: tombstone, withIntermediateDirectories: false)
    try Data(#"{"schemaVersion":2}"#.utf8).write(
      to: tombstone.appendingPathComponent("manifest.json")
    )

    XCTAssertThrowsError(try InboxArtifactHandoff.acknowledge(
      container: container,
      ingestionId: ingestionId
    )) { error in
      XCTAssertEqual(error as? InboxArtifactHandoffError, .unsupportedVersion)
      XCTAssertEqual(
        (error as? InboxArtifactHandoffError)?.stableCode,
        "SCHEMA_VERSION_UNSUPPORTED"
      )
    }
    XCTAssertFalse(FileManager.default.fileExists(
      atPath: container.appendingPathComponent(
        "InboxAcknowledgements/\(ingestionId).json"
      ).path
    ))
  }

  func testAcknowledgementTombstoneDeletionIsBestEffortAndRetryable() throws {
    let ingestionId = UUID().uuidString.lowercased()
    let itemId = UUID().uuidString.lowercased()
    try writeManifest(ingestionId: ingestionId, items: [(itemId, "image/png", Data([1]))])
    var deletionObserved = false
    var childrenBeforeInterruption = 0
    var childrenAfterInterruption = 0

    XCTAssertTrue(try InboxArtifactHandoff.acknowledge(
      container: container,
      ingestionId: ingestionId,
      tombstoneRemover: { tombstone in
        deletionObserved = true
        let children = try FileManager.default.contentsOfDirectory(
          at: tombstone,
          includingPropertiesForKeys: nil
        )
        childrenBeforeInterruption = children.count
        try FileManager.default.removeItem(at: try XCTUnwrap(children.first))
        childrenAfterInterruption = try FileManager.default.contentsOfDirectory(
          at: tombstone,
          includingPropertiesForKeys: nil
        ).count
        throw TestIOError.injected
      }
    ))
    XCTAssertTrue(deletionObserved)
    XCTAssertEqual(childrenAfterInterruption, childrenBeforeInterruption - 1)
    let tombstones = container.appendingPathComponent("InboxAckTombstones")
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: tombstones.path).count, 1)
    XCTAssertTrue(try InboxArtifactHandoff.acknowledge(
      container: container,
      ingestionId: ingestionId
    ))
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: tombstones.path), [])
  }

  func testStartupSweepResumesAfterInterruption() throws {
    _ = try leaveAcknowledgementTombstone()
    _ = try leaveAcknowledgementTombstone()
    let tombstones = container.appendingPathComponent("InboxAckTombstones")
    var removals = 0

    XCTAssertThrowsError(try InboxArtifactHandoff.sweepAcknowledgementTombstones(
      container: container,
      operationHook: { point in
        if case .afterRemoval = point {
          removals += 1
          if removals == 1 { throw TestIOError.injected }
        }
      }
    ))
    XCTAssertEqual(removals, 1)
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: tombstones.path).count, 1)

    InboxArtifactHandoff.runStartupMaintenance(container: container)
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: tombstones.path), [])
  }

  func testStartupSweepRetriesDeletionFailure() throws {
    _ = try leaveAcknowledgementTombstone()
    let tombstones = container.appendingPathComponent("InboxAckTombstones")

    let failed = try InboxArtifactHandoff.sweepAcknowledgementTombstones(
      container: container,
      tombstoneRemover: { _ in throw TestIOError.injected }
    )
    XCTAssertEqual(failed, InboxTombstoneSweepResult(scanned: 1, removed: 0, failed: 1))
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: tombstones.path).count, 1)

    InboxArtifactHandoff.runStartupMaintenance(container: container)
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: tombstones.path), [])
  }

  func testStartupSweepContainsParentSynchronizationFailure() throws {
    _ = try leaveAcknowledgementTombstone()
    let tombstones = container.appendingPathComponent("InboxAckTombstones")

    let failed = try InboxArtifactHandoff.sweepAcknowledgementTombstones(
      container: container,
      directorySynchronizer: { directory in
        if directory.standardizedFileURL == tombstones.standardizedFileURL {
          throw TestIOError.injected
        }
      }
    )
    XCTAssertEqual(failed, InboxTombstoneSweepResult(scanned: 1, removed: 0, failed: 1))
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: tombstones.path), [])
    InboxArtifactHandoff.runStartupMaintenance(container: container)
  }

  func testRequestedManifestSnapshotSerializesConcurrentAckOfOtherIngestion() throws {
    let requestedId = UUID().uuidString.lowercased()
    let acknowledgedId = UUID().uuidString.lowercased()
    let requestedItem = UUID().uuidString.lowercased()
    try writeManifest(
      ingestionId: requestedId,
      items: [(requestedItem, "image/png", Data([1]))]
    )
    try writeManifest(
      ingestionId: acknowledgedId,
      items: [(UUID().uuidString.lowercased(), "image/png", Data([2]))]
    )
    let snapshotEntered = DispatchSemaphore(value: 0)
    let releaseSnapshot = DispatchSemaphore(value: 0)
    let handoffFinished = DispatchSemaphore(value: 0)
    let ackAttempted = DispatchSemaphore(value: 0)
    let ackFinished = DispatchSemaphore(value: 0)
    var handoffError: Error?
    var acknowledgementError: Error?

    DispatchQueue.global().async {
      defer { handoffFinished.signal() }
      do {
        _ = try InboxArtifactHandoff.handoff(
          container: self.container,
          applicationSupport: self.applicationSupport,
          ingestionId: requestedId,
          packId: UUID().uuidString.lowercased(),
          requiredHeadroomBytes: 0,
          availableBytes: { _ in Int64.max },
          snapshotHook: {
            snapshotEntered.signal()
            _ = releaseSnapshot.wait(timeout: .now() + 5)
          }
        )
      } catch {
        handoffError = error
      }
    }
    XCTAssertEqual(snapshotEntered.wait(timeout: .now() + 5), .success)
    DispatchQueue.global().async {
      ackAttempted.signal()
      do {
        _ = try InboxArtifactHandoff.acknowledge(
          container: self.container,
          ingestionId: acknowledgedId
        )
      } catch {
        acknowledgementError = error
      }
      ackFinished.signal()
    }
    XCTAssertEqual(ackAttempted.wait(timeout: .now() + 5), .success)
    XCTAssertEqual(ackFinished.wait(timeout: .now() + 0.1), .timedOut)
    releaseSnapshot.signal()
    XCTAssertEqual(handoffFinished.wait(timeout: .now() + 5), .success)
    XCTAssertEqual(ackFinished.wait(timeout: .now() + 5), .success)
    XCTAssertNil(handoffError)
    XCTAssertNil(acknowledgementError)
    XCTAssertTrue(FileManager.default.fileExists(
      atPath: container.appendingPathComponent("Inbox/\(requestedId)").path
    ))
    XCTAssertFalse(FileManager.default.fileExists(
      atPath: container.appendingPathComponent("Inbox/\(acknowledgedId)").path
    ))
  }

  func testManifestMutationDuringHandoffFailsExactByteBinding() throws {
    let ingestionId = UUID().uuidString.lowercased()
    let packId = UUID().uuidString.lowercased()
    let itemId = UUID().uuidString.lowercased()
    try writeManifest(ingestionId: ingestionId, items: [(itemId, "image/png", Data([1, 2, 3]))])
    let manifest = container.appendingPathComponent("Inbox/\(ingestionId)/manifest.json")
    var mutated = false

    XCTAssertThrowsError(try InboxArtifactHandoff.handoff(
      container: container,
      applicationSupport: applicationSupport,
      ingestionId: ingestionId,
      packId: packId,
      requiredHeadroomBytes: 0,
      availableBytes: { _ in Int64.max },
      operationHook: { point in
        if !mutated && samePoint(point, .afterFileClose) {
          mutated = true
          var bytes = try Data(contentsOf: manifest)
          bytes.append(0x20)
          try bytes.write(to: manifest)
        }
      }
    )) { error in
      XCTAssertEqual(error as? InboxArtifactHandoffError, .integrityFailed)
      XCTAssertEqual(
        (error as? InboxArtifactHandoffError)?.stableCode,
        "ARTIFACT_INTEGRITY_FAILED"
      )
    }
    XCTAssertTrue(mutated)
    XCTAssertTrue(FileManager.default.fileExists(
      atPath: container.appendingPathComponent("Inbox/\(ingestionId)").path
    ))
  }

  func testExistingDestinationMustMatchSourceEvenWithoutManifestHash() throws {
    let ingestionId = UUID().uuidString.lowercased()
    let packId = UUID().uuidString.lowercased()
    let itemId = UUID().uuidString.lowercased()
    try writeManifest(ingestionId: ingestionId, items: [(itemId, "image/png", Data([1, 2, 3]))])
    let destination = applicationSupport.appendingPathComponent(
      "Packs/\(packId)/originals/\(itemId).bin"
    )
    try FileManager.default.createDirectory(
      at: destination.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    try Data([3, 2, 1]).write(to: destination)

    XCTAssertThrowsError(try InboxArtifactHandoff.handoff(
      container: container,
      applicationSupport: applicationSupport,
      ingestionId: ingestionId,
      packId: packId,
      requiredHeadroomBytes: 0,
      availableBytes: { _ in Int64.max }
    )) { error in
      XCTAssertEqual(error as? InboxArtifactHandoffError, .integrityFailed)
    }
  }

  func testDestinationAncestorsRejectPreexistingSymlinks() throws {
    for level in ["Packs", "pack", "originals"] {
      let packs = applicationSupport.appendingPathComponent("Packs", isDirectory: true)
      try? FileManager.default.removeItem(at: packs)
      let outside = applicationSupport.deletingLastPathComponent()
        .appendingPathComponent("outside-\(level)", isDirectory: true)
      try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
      let ingestionId = UUID().uuidString.lowercased()
      let packId = UUID().uuidString.lowercased()
      let itemId = UUID().uuidString.lowercased()
      try writeManifest(
        ingestionId: ingestionId,
        items: [(itemId, "image/png", Data([1, 2, 3]))]
      )

      switch level {
      case "Packs":
        try FileManager.default.createSymbolicLink(at: packs, withDestinationURL: outside)
      case "pack":
        try FileManager.default.createDirectory(at: packs, withIntermediateDirectories: false)
        try FileManager.default.createSymbolicLink(
          at: packs.appendingPathComponent(packId, isDirectory: true),
          withDestinationURL: outside
        )
      default:
        let pack = packs.appendingPathComponent(packId, isDirectory: true)
        try FileManager.default.createDirectory(at: pack, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(
          at: pack.appendingPathComponent("originals", isDirectory: true),
          withDestinationURL: outside
        )
      }

      XCTAssertThrowsError(try InboxArtifactHandoff.handoff(
        container: container,
        applicationSupport: applicationSupport,
        ingestionId: ingestionId,
        packId: packId,
        requiredHeadroomBytes: 0,
        availableBytes: { _ in Int64.max }
      )) { error in
        XCTAssertEqual(error as? InboxArtifactHandoffError, .integrityFailed, level)
      }
      XCTAssertFalse(FileManager.default.fileExists(
        atPath: outside.appendingPathComponent("\(itemId).bin").path
      ))
    }
  }

  func testDestinationAncestorSwapBeforeCopyFailsClosed() throws {
    let ingestionId = UUID().uuidString.lowercased()
    let packId = UUID().uuidString.lowercased()
    let itemId = UUID().uuidString.lowercased()
    try writeManifest(
      ingestionId: ingestionId,
      items: [(itemId, "image/png", Data([1, 2, 3]))]
    )
    let originals = applicationSupport.appendingPathComponent(
      "Packs/\(packId)/originals",
      isDirectory: true
    )
    let displaced = applicationSupport.appendingPathComponent(
      "Packs/\(packId)/originals-displaced",
      isDirectory: true
    )
    let outside = applicationSupport.deletingLastPathComponent()
      .appendingPathComponent("outside-swap", isDirectory: true)
    try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
    var swapped = false

    XCTAssertThrowsError(try InboxArtifactHandoff.handoff(
      container: container,
      applicationSupport: applicationSupport,
      ingestionId: ingestionId,
      packId: packId,
      requiredHeadroomBytes: 0,
      availableBytes: { _ in Int64.max },
      operationHook: { point in
        guard samePoint(point, .beforeCopy), !swapped else { return }
        swapped = true
        try FileManager.default.moveItem(at: originals, to: displaced)
        try FileManager.default.createSymbolicLink(
          at: originals,
          withDestinationURL: outside
        )
      }
    )) { error in
      XCTAssertEqual(error as? InboxArtifactHandoffError, .integrityFailed)
    }
    XCTAssertTrue(swapped)
    XCTAssertFalse(FileManager.default.fileExists(
      atPath: outside.appendingPathComponent("\(itemId).bin").path
    ))
    XCTAssertFalse(FileManager.default.fileExists(
      atPath: displaced.appendingPathComponent("\(itemId).bin").path
    ))
  }

  func testDestinationPacksSwapBackToDisplacedTreeFailsClosed() throws {
    let ingestionId = UUID().uuidString.lowercased()
    let packId = UUID().uuidString.lowercased()
    let itemId = UUID().uuidString.lowercased()
    try writeManifest(
      ingestionId: ingestionId,
      items: [(itemId, "image/png", Data([1, 2, 3]))]
    )
    let packs = applicationSupport.appendingPathComponent("Packs", isDirectory: true)
    let displaced = applicationSupport.appendingPathComponent(
      "Packs-displaced",
      isDirectory: true
    )
    var swapped = false

    XCTAssertThrowsError(try InboxArtifactHandoff.handoff(
      container: container,
      applicationSupport: applicationSupport,
      ingestionId: ingestionId,
      packId: packId,
      requiredHeadroomBytes: 0,
      availableBytes: { _ in Int64.max },
      operationHook: { point in
        guard samePoint(point, .beforeCopy), !swapped else { return }
        swapped = true
        try FileManager.default.moveItem(at: packs, to: displaced)
        try FileManager.default.createSymbolicLink(
          at: packs,
          withDestinationURL: displaced
        )
      }
    )) { error in
      XCTAssertEqual(error as? InboxArtifactHandoffError, .integrityFailed)
    }
    XCTAssertTrue(swapped)
    XCTAssertFalse(FileManager.default.fileExists(
      atPath: displaced
        .appendingPathComponent("\(packId)/originals/\(itemId).bin")
        .path
    ))
  }

  func testTwentyImageAndNearLimitPdfCopyBenchmarkDoesNotRunOcr() throws {
    let imageIngestion = UUID().uuidString.lowercased()
    let imagePack = UUID().uuidString.lowercased()
    let imageItems = (0..<20).map { _ in
      (UUID().uuidString.lowercased(), "image/png", Data(repeating: 1, count: 256 * 1024))
    }
    try writeManifest(ingestionId: imageIngestion, items: imageItems)
    let imagesStarted = Date()
    let imageResult = try InboxArtifactHandoff.handoff(
      container: container,
      applicationSupport: applicationSupport,
      ingestionId: imageIngestion,
      packId: imagePack,
      requiredHeadroomBytes: 0,
      availableBytes: { _ in Int64.max }
    )
    XCTAssertEqual((imageResult["artifacts"] as? [[String: Any]])?.count, 20)
    let imageDuration = Date().timeIntervalSince(imagesStarted)

    let pdfIngestion = UUID().uuidString.lowercased()
    let pdfPack = UUID().uuidString.lowercased()
    let pdfId = UUID().uuidString.lowercased()
    try writeManifest(
      ingestionId: pdfIngestion,
      items: [(pdfId, "application/pdf", Data(repeating: 2, count: 49 * 1024 * 1024))]
    )
    let pdfStarted = Date()
    let pdfResult = try InboxArtifactHandoff.handoff(
      container: container,
      applicationSupport: applicationSupport,
      ingestionId: pdfIngestion,
      packId: pdfPack,
      requiredHeadroomBytes: 0,
      availableBytes: { _ in Int64.max }
    )
    XCTAssertEqual((pdfResult["artifacts"] as? [[String: Any]])?.count, 1)
    let pdfDuration = Date().timeIntervalSince(pdfStarted)

    print(
      "PERSISTENCE_BENCHMARK platform=swift images=20 imageBytes=5242880 " +
      "imageMs=\(Int(imageDuration * 1_000)) pdfBytes=51380224 pdfMs=\(Int(pdfDuration * 1_000)) ocrRuns=0"
    )
    XCTAssertLessThan(imageDuration, 10)
    XCTAssertLessThan(pdfDuration, 10)
  }

  private func writeManifest(
    ingestionId: String,
    items: [(String, String, Data)]
  ) throws {
    let directory = container.appendingPathComponent("Inbox/\(ingestionId)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    var payloadItems: [[String: Any]] = []
    for (index, item) in items.enumerated() {
      try item.2.write(to: directory.appendingPathComponent("\(item.0).bin"))
      payloadItems.append([
        "id": item.0,
        "order": index,
        "mediaType": item.1,
        "status": "copied",
        "byteCount": item.2.count,
        "relativePath": "\(item.0).bin",
      ])
    }
    let payload: [String: Any] = [
      "schemaVersion": 1,
      "ingestionId": ingestionId,
      "createdAt": "2026-08-03T00:00:00Z",
      "source": "ios-share-extension",
      "status": "complete",
      "items": payloadItems,
    ]
    try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
      .write(to: directory.appendingPathComponent("manifest.json"))
  }

  private func leaveAcknowledgementTombstone() throws -> String {
    let ingestionId = UUID().uuidString.lowercased()
    try writeManifest(
      ingestionId: ingestionId,
      items: [(UUID().uuidString.lowercased(), "image/png", Data([1]))]
    )
    XCTAssertThrowsError(try InboxArtifactHandoff.acknowledge(
      container: container,
      ingestionId: ingestionId,
      operationHook: { point in
        if case .afterTombstoneRename = point { throw TestIOError.injected }
      }
    ))
    return ingestionId
  }
}

private func samePoint(_ lhs: InboxArtifactHandoffPoint, _ rhs: InboxArtifactHandoffPoint) -> Bool {
  switch (lhs, rhs) {
  case (.beforeCopy, .beforeCopy),
       (.duringCopy, .duringCopy),
       (.afterFileClose, .afterFileClose),
       (.beforePublishRename, .beforePublishRename): true
  default: false
  }
}

private enum TestIOError: Error {
  case injected
}
