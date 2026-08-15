import CoreGraphics
import CryptoKit
import Darwin
import Foundation
import ImageIO
import XCTest
@testable import ContextNativeRecovery

final class ImageCompressionProcessorTests: XCTestCase {
  private var source: URL!

  override func setUpWithError() throws {
    source = FileManager.default.temporaryDirectory.appendingPathComponent(
      "\(UUID().uuidString).png"
    )
    try writeTransparentFixture(source, width: 256, height: 128)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: source)
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "ImageCompression",
      isDirectory: true
    )
    for child in (try? FileManager.default.contentsOfDirectory(
      at: directory,
      includingPropertiesForKeys: nil
    )) ?? [] {
      try? FileManager.default.removeItem(at: child)
    }
  }

  func testTransparentFixtureRemainsAlphaReadableAndOriginalIsImmutable() throws {
    let sourceMetadata = try metadata(source)
    let originalBytes = try Data(contentsOf: source)
    let inspection = try ImageCompressionProcessor.inspect(
      fileURL: source,
      expectedByteCount: sourceMetadata.byteCount,
      expectedSHA256: sourceMetadata.sha256,
      cancellation: ImageHashCancellationToken()
    )
    XCTAssertEqual(inspection["width"] as? Int, 256)
    XCTAssertEqual(inspection["height"] as? Int, 128)
    XCTAssertEqual(inspection["hasAlpha"] as? Bool, true)

    let taskId = UUID().uuidString.lowercased()
    let output = try ImageCompressionProcessor.compress(
      taskId: taskId,
      fileURL: source,
      expectedByteCount: sourceMetadata.byteCount,
      expectedSHA256: sourceMetadata.sha256,
      targetWidth: 128,
      targetHeight: 64,
      quality: 1,
      outputMediaType: "image/png",
      preserveAlpha: true,
      cancellation: ImageHashCancellationToken()
    )
    let outputURL = try XCTUnwrap(
      (output["temporaryFileUri"] as? String).flatMap(URL.init(string:))
    )
    let imageSource = try XCTUnwrap(CGImageSourceCreateWithURL(outputURL as CFURL, nil))
    let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(imageSource, 0, nil))
    XCTAssertEqual(image.width, 128)
    XCTAssertEqual(image.height, 64)
    XCTAssertNotEqual(image.alphaInfo, .none)
    XCTAssertEqual(try Data(contentsOf: source), originalBytes)
    XCTAssertTrue(ImageCompressionTemporaryStore.finish(taskId: taskId))
    XCTAssertFalse(FileManager.default.fileExists(atPath: outputURL.path))
  }

  func testCancellationPublishesNoValidLookingPartialDerivative() throws {
    let sourceMetadata = try metadata(source)
    let token = ImageHashCancellationToken()
    let taskId = UUID().uuidString.lowercased()
    XCTAssertThrowsError(
      try ImageCompressionProcessor.compress(
        taskId: taskId,
        fileURL: source,
        expectedByteCount: sourceMetadata.byteCount,
        expectedSHA256: sourceMetadata.sha256,
        targetWidth: 128,
        targetHeight: 64,
        quality: 1,
        outputMediaType: "image/png",
        preserveAlpha: true,
        cancellation: token,
        beforePublish: { token.cancel() }
      )
    ) {
      XCTAssertEqual(($0 as? ImagePerceptualHashError)?.stableCode, "PIPELINE_STAGE_FAILED")
    }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "ImageCompression",
      isDirectory: true
    )
    let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
    XCTAssertFalse(names.contains { $0.contains(taskId) })
  }

  func testCancellationStopsCompleteOutputHashingAfterTheCurrentChunk() throws {
    let output = FileManager.default.temporaryDirectory.appendingPathComponent(
      "\(UUID().uuidString).bin"
    )
    try Data(repeating: 0x5a, count: 192 * 1_024).write(to: output)
    defer { try? FileManager.default.removeItem(at: output) }
    let token = ImageHashCancellationToken()
    var reads = 0

    XCTAssertThrowsError(
      try ImageCompressionProcessor.outputMetadata(
        output,
        cancellation: token,
        readChunk: { handle in
          let data = try handle.read(upToCount: 64 * 1_024) ?? Data()
          reads += 1
          if reads == 1 { token.cancel() }
          return data
        }
      )
    ) {
      XCTAssertEqual(($0 as? ImagePerceptualHashError)?.stableCode, "PIPELINE_STAGE_FAILED")
    }
    XCTAssertEqual(reads, 1)
  }

  func testStartupMaintenancePurgesInheritedFilesButPreservesCurrentTasks() throws {
    let taskId = UUID().uuidString.lowercased()
    let paths = try ImageCompressionTemporaryStore.prepare(taskId: taskId)
    try Data([1]).write(to: paths.partial)
    try Data([2]).write(to: paths.complete)
    ImageCompressionTemporaryStore.register(taskId: taskId, fileURL: paths.complete)
    let inherited = paths.partial.deletingLastPathComponent().appendingPathComponent(
      "inherited-\(UUID().uuidString).tmp"
    )
    try Data([3]).write(to: inherited)

    XCTAssertNil(ImageCompressionTemporaryStore.runStartupMaintenance())

    XCTAssertTrue(FileManager.default.fileExists(atPath: paths.partial.path))
    XCTAssertTrue(FileManager.default.fileExists(atPath: paths.complete.path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: inherited.path))
    try ImageCompressionTemporaryStore.removeUnregistered([paths.partial])
    XCTAssertTrue(ImageCompressionTemporaryStore.finish(taskId: taskId))
  }

  func testStartupMaintenanceReportsRemovalFailureAfterBoundedRetry() throws {
    let taskId = UUID().uuidString.lowercased()
    let paths = try ImageCompressionTemporaryStore.prepare(taskId: taskId)
    let inherited = paths.partial.deletingLastPathComponent().appendingPathComponent(
      "inherited-\(UUID().uuidString).tmp"
    )
    try Data([7]).write(to: inherited)
    var attempts = 0

    XCTAssertThrowsError(
      try ImageCompressionTemporaryStore.startupMaintenance(remover: { candidate in
        if candidate.lastPathComponent == inherited.lastPathComponent {
          attempts += 1
          throw CocoaError(.fileWriteNoPermission)
        }
        try FileManager.default.removeItem(at: candidate)
      })
    ) {
      XCTAssertEqual(
        ($0 as? ImagePerceptualHashError)?.stableCode,
        "PIPELINE_RECOVERY_REQUIRED"
      )
    }
    XCTAssertEqual(attempts, 2)
    XCTAssertTrue(FileManager.default.fileExists(atPath: inherited.path))

    attempts = 0
    XCTAssertEqual(
      ImageCompressionTemporaryStore.runStartupMaintenance(remover: { candidate in
        if candidate.lastPathComponent == inherited.lastPathComponent {
          attempts += 1
          throw CocoaError(.fileWriteNoPermission)
        }
        try FileManager.default.removeItem(at: candidate)
      }),
      "PIPELINE_RECOVERY_REQUIRED"
    )
    XCTAssertEqual(attempts, 2)
    XCTAssertEqual(
      ImageCompressionTemporaryStore.currentStartupFailureCode(),
      "PIPELINE_RECOVERY_REQUIRED"
    )
    try FileManager.default.removeItem(at: inherited)
    XCTAssertNil(ImageCompressionTemporaryStore.runStartupMaintenance())
    XCTAssertNil(ImageCompressionTemporaryStore.currentStartupFailureCode())
  }

  func testStartupCleanupFailureUsesTheDurablePrivacySafeRecoveryEvent() throws {
    let container = FileManager.default.temporaryDirectory.appendingPathComponent(
      "compression-recovery-\(UUID().uuidString)",
      isDirectory: true
    )
    defer { try? FileManager.default.removeItem(at: container) }

    try ImageCompressionStartupRecoveryReporter.reconcile(
      container: container,
      failureCode: "PIPELINE_RECOVERY_REQUIRED"
    )

    XCTAssertEqual(
      try RecoveryMetadataEventStore.read(container: container, folder: "RecoveryEvents")
        .map { [$0["id"] as? String, $0["code"] as? String] },
      [[
        ImageCompressionStartupRecoveryReporter.eventId,
        "PIPELINE_RECOVERY_REQUIRED",
      ]]
    )

    try ImageCompressionStartupRecoveryReporter.reconcile(
      container: container,
      failureCode: nil
    )
    XCTAssertEqual(
      try RecoveryMetadataEventStore.read(container: container, folder: "RecoveryEvents").count,
      0
    )
  }

  func testStartupRecoveryPublicationFailureRemainsFailClosedUntilRetry() throws {
    let container = FileManager.default.temporaryDirectory.appendingPathComponent(
      "compression-recovery-write-failure-\(UUID().uuidString)",
      isDirectory: true
    )
    defer { try? FileManager.default.removeItem(at: container) }

    XCTAssertThrowsError(
      try ImageCompressionStartupRecoveryReporter.reconcile(
        container: container,
        failureCode: "PIPELINE_RECOVERY_REQUIRED",
        persistRecovery: { _, _, _ in throw CocoaError(.fileWriteOutOfSpace) }
      )
    )
    XCTAssertEqual(
      try RecoveryMetadataEventStore.read(container: container, folder: "RecoveryEvents").count,
      0
    )

    try ImageCompressionStartupRecoveryReporter.retryPendingPublication(
      container: container
    )

    XCTAssertEqual(
      try RecoveryMetadataEventStore.read(container: container, folder: "RecoveryEvents")
        .map { $0["code"] as? String },
      ["PIPELINE_RECOVERY_REQUIRED"]
    )
    try ImageCompressionStartupRecoveryReporter.reconcile(
      container: container,
      failureCode: nil
    )
  }

  func testFirstRecoveryReadWaitsForStartupCleanupPublication() throws {
    let container = FileManager.default.temporaryDirectory.appendingPathComponent(
      "compression-startup-barrier-\(UUID().uuidString)",
      isDirectory: true
    )
    defer { try? FileManager.default.removeItem(at: container) }
    let barrier = ImageCompressionStartupMaintenanceBarrier()
    let maintenanceStarted = DispatchSemaphore(value: 0)
    let releaseMaintenance = DispatchSemaphore(value: 0)
    let readFinished = DispatchSemaphore(value: 0)

    barrier.start {
      maintenanceStarted.signal()
      releaseMaintenance.wait()
      try? ImageCompressionStartupRecoveryReporter.reconcile(
        container: container,
        failureCode: "PIPELINE_RECOVERY_REQUIRED"
      )
    }
    XCTAssertEqual(maintenanceStarted.wait(timeout: .now() + 1), .success)
    DispatchQueue.global(qos: .userInitiated).async {
      barrier.waitUntilFinished()
      readFinished.signal()
    }
    XCTAssertEqual(readFinished.wait(timeout: .now() + 0.05), .timedOut)

    releaseMaintenance.signal()
    XCTAssertEqual(readFinished.wait(timeout: .now() + 1), .success)
    XCTAssertEqual(
      try RecoveryMetadataEventStore.read(container: container, folder: "RecoveryEvents")
        .map { $0["code"] as? String },
      ["PIPELINE_RECOVERY_REQUIRED"]
    )
    try ImageCompressionStartupRecoveryReporter.reconcile(
      container: container,
      failureCode: nil
    )
  }

  func testRotatedTextFixtureRemainsSystemReadableAfterCompactCompression() throws {
    let source = fixtureURL("ocr-rotated.jpg")
    let sourceMetadata = try metadata(source)
    let inspection = try ImageCompressionProcessor.inspect(
      fileURL: source,
      expectedByteCount: sourceMetadata.byteCount,
      expectedSHA256: sourceMetadata.sha256,
      cancellation: ImageHashCancellationToken()
    )
    XCTAssertEqual(inspection["width"] as? Int, 1_800)
    XCTAssertEqual(inspection["height"] as? Int, 600)
    let taskId = UUID().uuidString.lowercased()
    let output = try ImageCompressionProcessor.compress(
      taskId: taskId,
      fileURL: source,
      expectedByteCount: sourceMetadata.byteCount,
      expectedSHA256: sourceMetadata.sha256,
      targetWidth: 1_280,
      targetHeight: 427,
      quality: 0.7,
      outputMediaType: "image/jpeg",
      preserveAlpha: false,
      cancellation: ImageHashCancellationToken()
    )
    let secondTaskId = UUID().uuidString.lowercased()
    let secondOutput = try ImageCompressionProcessor.compress(
      taskId: secondTaskId,
      fileURL: source,
      expectedByteCount: sourceMetadata.byteCount,
      expectedSHA256: sourceMetadata.sha256,
      targetWidth: 1_280,
      targetHeight: 427,
      quality: 0.7,
      outputMediaType: "image/jpeg",
      preserveAlpha: false,
      cancellation: ImageHashCancellationToken()
    )
    XCTAssertEqual(output["outputByteCount"] as? Int64, secondOutput["outputByteCount"] as? Int64)
    XCTAssertEqual(output["outputSha256"] as? String, secondOutput["outputSha256"] as? String)
    let outputURL = try XCTUnwrap(
      (output["temporaryFileUri"] as? String).flatMap(URL.init(string:))
    )
    defer {
      XCTAssertTrue(ImageCompressionTemporaryStore.finish(taskId: taskId))
      XCTAssertTrue(ImageCompressionTemporaryStore.finish(taskId: secondTaskId))
    }
    let imageSource = try XCTUnwrap(CGImageSourceCreateWithURL(outputURL as CFURL, nil))
    let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(imageSource, 0, nil))
    XCTAssertEqual(image.width, 1_280)
    XCTAssertEqual(image.height, 427)

    let recognized = try AppleVisionOCRProcessor().recognize(
      taskId: UUID().uuidString.lowercased(),
      fileURL: outputURL,
      script: "latin",
      recognitionLevel: "accurate"
    )
    let text = try XCTUnwrap(recognized["text"] as? String)
    XCTAssertTrue(text.replacingOccurrences(of: " ", with: "")
      .localizedCaseInsensitiveContains("TypeError"))
    XCTAssertTrue(text.localizedCaseInsensitiveContains("E42"))
    XCTAssertTrue(text.localizedCaseInsensitiveContains("retry import"))
  }

  func testTenTwentyAndFiftyImageCompressionBenchmarksAreBounded() throws {
    let source = fixtureURL("ocr-rotated.jpg")
    let sourceMetadata = try metadata(source)
    for count in [10, 20, 50] {
      var usageBefore = rusage()
      XCTAssertEqual(getrusage(RUSAGE_SELF, &usageBefore), 0)
      let started = ContinuousClock.now
      var outputBytes: Int64 = 0
      for _ in 0..<count {
        let taskId = UUID().uuidString.lowercased()
        let output = try ImageCompressionProcessor.compress(
          taskId: taskId,
          fileURL: source,
          expectedByteCount: sourceMetadata.byteCount,
          expectedSHA256: sourceMetadata.sha256,
          targetWidth: 1_280,
          targetHeight: 427,
          quality: 0.7,
          outputMediaType: "image/jpeg",
          preserveAlpha: false,
          cancellation: ImageHashCancellationToken()
        )
        outputBytes += try XCTUnwrap(output["outputByteCount"] as? Int64)
        XCTAssertTrue(ImageCompressionTemporaryStore.finish(taskId: taskId))
      }
      let duration = started.duration(to: .now)
      let durationMs = Double(duration.components.seconds) * 1_000
        + Double(duration.components.attoseconds) / 1_000_000_000_000_000
      var usageAfter = rusage()
      XCTAssertEqual(getrusage(RUSAGE_SELF, &usageAfter), 0)
      let observedPeakBytes = max(usageBefore.ru_maxrss, usageAfter.ru_maxrss)
      XCTAssertGreaterThan(durationMs, 0)
      XCTAssertGreaterThan(observedPeakBytes, 0)
      XCTAssertGreaterThan(outputBytes, 0)
      print(
        "IMAGE_COMPRESSION_BENCHMARK platform=swift images=\(count) " +
          "inputBytes=\(sourceMetadata.byteCount * Int64(count)) " +
          "outputBytes=\(outputBytes) durationMs=\(Int(durationMs)) " +
          "observedPeakBytes=\(observedPeakBytes)"
      )
    }
  }

  private func writeTransparentFixture(_ url: URL, width: Int, height: Int) throws {
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let context = try XCTUnwrap(
      CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: width * 4,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
      )
    )
    context.clear(CGRect(x: 0, y: 0, width: width, height: height))
    context.setFillColor(red: 0.1, green: 0.2, blue: 0.9, alpha: 0.8)
    context.fill(CGRect(x: 8, y: 8, width: width - 16, height: height - 16))
    let image = try XCTUnwrap(context.makeImage())
    let destination = try XCTUnwrap(
      CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil)
    )
    CGImageDestinationAddImage(destination, image, nil)
    XCTAssertTrue(CGImageDestinationFinalize(destination))
  }

  private func metadata(_ url: URL) throws -> (byteCount: Int64, sha256: String) {
    let data = try Data(contentsOf: url)
    return (
      Int64(data.count),
      SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    )
  }

  private func fixtureURL(_ name: String) -> URL {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .appendingPathComponent("../../../../fixtures/media/\(name)")
      .standardizedFileURL
  }
}
