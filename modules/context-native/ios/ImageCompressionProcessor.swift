import CoreGraphics
import CryptoKit
import Darwin
import Foundation
import ImageIO

enum ImageCompressionProcessor {
  static let revision = "1"
  static let maximumOutputPixels = 4_194_304
  static let maximumOutputBytes: Int64 = 52_428_800

  static func inspect(
    fileURL: URL,
    expectedByteCount: Int64,
    expectedSHA256: String,
    cancellation: ImageHashCancellationToken
  ) throws -> [String: Any] {
    try withVerifiedImageSource(
      fileURL: fileURL,
      expectedByteCount: expectedByteCount,
      expectedSHA256: expectedSHA256,
      cancellation: cancellation
    ) { source, properties in
      let dimensions = try orientedDimensions(properties)
      let pixelCount = dimensions.width.multipliedReportingOverflow(by: dimensions.height)
      guard !pixelCount.overflow, pixelCount.partialValue > 0,
            pixelCount.partialValue <= ImagePerceptualHasher.maximumPixelCount else {
        throw ImagePerceptualHashError.resourceLimit
      }
      guard let sourceMediaType = mediaType(source: source) else {
        throw ImagePerceptualHashError.invalidImage
      }
      return [
        "schemaVersion": 1,
        "sourceByteCount": expectedByteCount,
        "sourceSha256": expectedSHA256,
        "sourceMediaType": sourceMediaType,
        "width": dimensions.width,
        "height": dimensions.height,
        "hasAlpha": try imageHasAlpha(source: source, cancellation: cancellation),
        "animated": false,
        "orientationApplied": true,
        "revision": revision,
      ]
    }
  }

  static func compress(
    taskId: String,
    fileURL: URL,
    expectedByteCount: Int64,
    expectedSHA256: String,
    targetWidth: Int,
    targetHeight: Int,
    quality: Double,
    outputMediaType: String,
    preserveAlpha: Bool,
    cancellation: ImageHashCancellationToken,
    beforePublish: (() -> Void)? = nil
  ) throws -> [String: Any] {
    let started = ContinuousClock.now
    let pixelCount = targetWidth.multipliedReportingOverflow(by: targetHeight)
    guard UUID(uuidString: taskId)?.uuidString.lowercased() == taskId,
          targetWidth > 0, targetHeight > 0,
          pixelCount.overflow == false,
          pixelCount.partialValue <= maximumOutputPixels,
          quality >= 0.58, quality <= 1,
          outputMediaType == "image/jpeg" || outputMediaType == "image/png",
          (outputMediaType == "image/png") == preserveAlpha,
          (!preserveAlpha || quality == 1) else {
      throw ImagePerceptualHashError.invalidImage
    }
    let output = try withVerifiedImageSource(
      fileURL: fileURL,
      expectedByteCount: expectedByteCount,
      expectedSHA256: expectedSHA256,
      cancellation: cancellation
    ) { source, properties -> URL in
      let sourceDimensions = try orientedDimensions(properties)
      guard mediaType(source: source) != nil,
            targetWidth <= sourceDimensions.width,
            targetHeight <= sourceDimensions.height,
            try imageHasAlpha(source: source, cancellation: cancellation) == preserveAlpha else {
        throw ImagePerceptualHashError.invalidImage
      }
      let thumbnailOptions: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: max(targetWidth, targetHeight),
        kCGImageSourceShouldCacheImmediately: true,
      ]
      guard let thumbnail = CGImageSourceCreateThumbnailAtIndex(
        source,
        0,
        thumbnailOptions as CFDictionary
      ) else {
        try cancellation.check()
        throw ImagePerceptualHashError.invalidImage
      }
      try cancellation.check()
      let outputImage = try render(
        image: thumbnail,
        width: targetWidth,
        height: targetHeight,
        preserveAlpha: preserveAlpha
      )
      let destination = try ImageCompressionTemporaryStore.prepare(taskId: taskId)
      do {
        guard let encoder = CGImageDestinationCreateWithURL(
          destination.partial as CFURL,
          (preserveAlpha ? "public.png" : "public.jpeg") as CFString,
          1,
          nil
        ) else { throw ImagePerceptualHashError.resourceLimit }
        let options: [CFString: Any] = preserveAlpha
          ? [:]
          : [kCGImageDestinationLossyCompressionQuality: quality]
        CGImageDestinationAddImage(encoder, outputImage, options as CFDictionary)
        guard CGImageDestinationFinalize(encoder) else {
          throw ImagePerceptualHashError.invalidImage
        }
        let handle = try FileHandle(forWritingTo: destination.partial)
        do {
          try handle.synchronize()
          try handle.close()
        } catch {
          try? handle.close()
          throw error
        }
        beforePublish?()
        try cancellation.check()
        try FileManager.default.moveItem(
          at: destination.partial,
          to: destination.complete
        )
        ImageCompressionTemporaryStore.register(
          taskId: taskId,
          fileURL: destination.complete
        )
        return destination.complete
      } catch let processingError {
        do {
          try ImageCompressionTemporaryStore.removeUnregistered(
            [destination.partial, destination.complete]
          )
        } catch {
          throw error
        }
        throw processingError
      }
    }
    do {
      try cancellation.check()
      let metadata = try outputMetadata(output, cancellation: cancellation)
      return [
        "schemaVersion": 1,
        "taskId": taskId,
        "sourceSha256": expectedSHA256,
        "temporaryFileUri": output.absoluteString,
        "outputByteCount": metadata.byteCount,
        "outputSha256": metadata.sha256,
        "width": targetWidth,
        "height": targetHeight,
        "mediaType": outputMediaType,
        "quality": quality,
        "alphaPreserved": preserveAlpha,
        "engine": "core-graphics",
        "revision": revision,
        "durationMs": durationMilliseconds(since: started),
      ]
    } catch let processingError {
      guard ImageCompressionTemporaryStore.finish(taskId: taskId) else {
        throw ImagePerceptualHashError.resourceLimit
      }
      throw processingError
    }
  }

  private static func withVerifiedImageSource<T>(
    fileURL: URL,
    expectedByteCount: Int64,
    expectedSHA256: String,
    cancellation: ImageHashCancellationToken,
    operation: (CGImageSource, [CFString: Any]) throws -> T
  ) throws -> T {
    try cancellation.check()
    let snapshot = try ImmutableImageSnapshot.create(
      sourceURL: fileURL,
      expectedByteCount: expectedByteCount,
      expectedSHA256: expectedSHA256,
      cancellation: cancellation
    )
    return try snapshot.withURL { snapshotURL in
      let provider = try CancellableImageDataProvider.create(
        url: snapshotURL,
        byteCount: expectedByteCount,
        cancellation: cancellation
      )
      guard let source = CGImageSourceCreateWithDataProvider(provider, nil),
            ImagePerceptualHasher.acceptsFrameCount(CGImageSourceGetCount(source)),
            let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil)
              as? [CFString: Any] else {
        try cancellation.check()
        throw ImagePerceptualHashError.invalidImage
      }
      try cancellation.check()
      return try operation(source, properties)
    }
  }

  private static func orientedDimensions(
    _ properties: [CFString: Any]
  ) throws -> (width: Int, height: Int) {
    guard let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
          let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue,
          width > 0, height > 0 else {
      throw ImagePerceptualHashError.invalidImage
    }
    let orientation = (properties[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
    return [5, 6, 7, 8].contains(orientation)
      ? (height, width)
      : (width, height)
  }

  private static func imageHasAlpha(
    source: CGImageSource,
    cancellation: ImageHashCancellationToken
  ) throws -> Bool {
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceThumbnailMaxPixelSize: 1,
      kCGImageSourceShouldCacheImmediately: true,
    ]
    guard let image = CGImageSourceCreateThumbnailAtIndex(
      source,
      0,
      options as CFDictionary
    ) else {
      try cancellation.check()
      throw ImagePerceptualHashError.invalidImage
    }
    let alpha = image.alphaInfo
    return alpha != .none && alpha != .noneSkipFirst && alpha != .noneSkipLast
  }

  private static func render(
    image: CGImage,
    width: Int,
    height: Int,
    preserveAlpha: Bool
  ) throws -> CGImage {
    let alpha: CGImageAlphaInfo = preserveAlpha ? .premultipliedLast : .noneSkipLast
    guard let context = CGContext(
      data: nil,
      width: width,
      height: height,
      bitsPerComponent: 8,
      bytesPerRow: width * 4,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue | alpha.rawValue
    ) else { throw ImagePerceptualHashError.resourceLimit }
    if !preserveAlpha {
      context.setFillColor(gray: 1, alpha: 1)
      context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    }
    context.interpolationQuality = .high
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    guard let output = context.makeImage() else {
      throw ImagePerceptualHashError.resourceLimit
    }
    return output
  }

  private static func mediaType(source: CGImageSource) -> String? {
    switch CGImageSourceGetType(source) as String? {
    case "public.jpeg": return "image/jpeg"
    case "public.png": return "image/png"
    case "com.compuserve.gif": return "image/gif"
    case "com.microsoft.bmp", "public.bmp": return "image/bmp"
    case "org.webmproject.webp": return "image/webp"
    case "public.heic", "public.heif": return "image/heic"
    default: return nil
    }
  }

  static func outputMetadata(
    _ fileURL: URL,
    cancellation: ImageHashCancellationToken,
    readChunk: ((FileHandle) throws -> Data)? = nil
  ) throws -> (byteCount: Int64, sha256: String) {
    let handle = try FileHandle(forReadingFrom: fileURL)
    defer { try? handle.close() }
    var hash = SHA256()
    var byteCount: Int64 = 0
    while true {
      try cancellation.check()
      let data: Data
      if let readChunk {
        data = try readChunk(handle)
      } else {
        data = try handle.read(upToCount: 64 * 1_024) ?? Data()
      }
      if data.isEmpty { break }
      byteCount += Int64(data.count)
      hash.update(data: data)
    }
    guard byteCount > 0, byteCount <= maximumOutputBytes else {
      throw ImagePerceptualHashError.resourceLimit
    }
    try cancellation.check()
    return (byteCount, hash.finalize().map { String(format: "%02x", $0) }.joined())
  }

  private static func durationMilliseconds(
    since started: ContinuousClock.Instant
  ) -> Double {
    let duration = started.duration(to: .now)
    let components = duration.components
    return Double(components.seconds) * 1_000
      + Double(components.attoseconds) / 1_000_000_000_000_000
  }
}

final class ImageCompressionStartupMaintenanceBarrier: @unchecked Sendable {
  private let lock = NSLock()
  private let completion = DispatchGroup()
  private var started = false

  func start(
    queue: DispatchQueue = DispatchQueue.global(qos: .utility),
    operation: @escaping @Sendable () -> Void
  ) {
    lock.lock()
    guard !started else {
      lock.unlock()
      return
    }
    started = true
    completion.enter()
    lock.unlock()
    queue.async { [completion] in
      defer { completion.leave() }
      operation()
    }
  }

  func waitUntilFinished() {
    lock.lock()
    let shouldWait = started
    lock.unlock()
    if shouldWait { completion.wait() }
  }
}

enum ImageCompressionStartupRecoveryReporter {
  static let eventId = "00000000-0000-4000-8000-000000000014"
  private static let operationLock = NSRecursiveLock()
  private static var unpublishedFailureCode: String?

  static func reconcile(
    container: URL,
    failureCode: String?,
    persistRecovery: (URL, String, String) throws -> Void = { container, code, id in
      try RecoveryMetadataEventStore.persistRecovery(
        container: container,
        code: code,
        id: id
      )
    },
    acknowledge: (URL, String) throws -> Bool = { container, id in
      try RecoveryMetadataEventStore.ack(
        container: container,
        folder: "RecoveryEvents",
        id: id
      )
    }
  ) throws {
    operationLock.lock()
    defer { operationLock.unlock() }
    do {
      if let failureCode {
        guard failureCode == ImagePerceptualHashError.cleanupFailure.stableCode else {
          throw ImagePerceptualHashError.cleanupFailure
        }
        try persistRecovery(container, failureCode, eventId)
      } else {
        _ = try acknowledge(container, eventId)
      }
      unpublishedFailureCode = nil
    } catch {
      if let failureCode { unpublishedFailureCode = failureCode }
      throw error
    }
  }

  static func retryPendingPublication(container: URL) throws {
    operationLock.lock()
    defer { operationLock.unlock() }
    if let failureCode = unpublishedFailureCode {
      try reconcile(container: container, failureCode: failureCode)
    }
  }
}

enum ImageCompressionTemporaryStore {
  private static let lock = NSLock()
  private static let maintenanceLock = NSLock()
  private static var outputs: [String: URL] = [:]
  private static var startupFailureCode: String?
  private static let directoryName = "ImageCompression"
  private static let sessionPrefix = UUID().uuidString.lowercased() + "-"

  static func startupMaintenance(
    fileManager: FileManager = .default,
    remover: (URL) throws -> Void = { try FileManager.default.removeItem(at: $0) }
  ) throws {
    maintenanceLock.lock()
    defer { maintenanceLock.unlock() }
    for attempt in 0..<2 {
      do {
        let root = try directory(fileManager: fileManager)
        for child in try fileManager.contentsOfDirectory(
          at: root,
          includingPropertiesForKeys: nil
        ) {
          if child.lastPathComponent.hasPrefix(sessionPrefix) { continue }
          do {
            try remover(child)
          } catch {
            if try !existsNoFollow(child) { continue }
            throw error
          }
        }
        startupFailureCode = nil
        return
      } catch {
        if attempt == 1 {
          startupFailureCode = ImagePerceptualHashError.cleanupFailure.stableCode
          throw ImagePerceptualHashError.cleanupFailure
        }
      }
    }
  }

  @discardableResult
  static func runStartupMaintenance(
    fileManager: FileManager = .default,
    remover: (URL) throws -> Void = { try FileManager.default.removeItem(at: $0) }
  ) -> String? {
    do {
      try startupMaintenance(fileManager: fileManager, remover: remover)
      return nil
    } catch {
      return ImagePerceptualHashError.cleanupFailure.stableCode
    }
  }

  static func currentStartupFailureCode() -> String? {
    maintenanceLock.lock()
    defer { maintenanceLock.unlock() }
    return startupFailureCode
  }

  static func prepare(taskId: String) throws -> (partial: URL, complete: URL) {
    guard UUID(uuidString: taskId)?.uuidString.lowercased() == taskId else {
      throw ImagePerceptualHashError.invalidImage
    }
    // This synchronous fence makes inherited-output cleanup observable before
    // the process can create or publish a new derivative.
    try startupMaintenance()
    let root = try directory()
    let complete = root.appendingPathComponent("\(sessionPrefix)\(taskId).tmp")
    let partial = root.appendingPathComponent("\(sessionPrefix)\(taskId).tmp.partial")
    try removeIfPresent(partial)
    guard try !existsNoFollow(complete) else {
      throw ImagePerceptualHashError.resourceLimit
    }
    return (partial, complete)
  }

  static func register(taskId: String, fileURL: URL) {
    lock.lock()
    outputs[taskId] = fileURL
    lock.unlock()
  }

  static func removeUnregistered(_ fileURLs: [URL]) throws {
    for fileURL in fileURLs {
      try removeIfPresent(fileURL)
    }
  }

  @discardableResult
  static func finish(taskId: String) -> Bool {
    lock.lock()
    let output = outputs[taskId]
    lock.unlock()
    guard let output else { return true }
    let removed: Bool
    do {
      try FileManager.default.removeItem(at: output)
      removed = true
    } catch {
      removed = (try? !existsNoFollow(output)) == true
    }
    guard removed else { return false }
    lock.lock()
    if outputs[taskId] == output { outputs.removeValue(forKey: taskId) }
    lock.unlock()
    return true
  }

  private static func directory(fileManager: FileManager = .default) throws -> URL {
    let value = fileManager.temporaryDirectory.appendingPathComponent(
      directoryName,
      isDirectory: true
    )
    try fileManager.createDirectory(
      at: value,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )
    let metadata = try value.resourceValues(forKeys: [
      .isDirectoryKey,
      .isSymbolicLinkKey,
    ])
    guard metadata.isDirectory == true, metadata.isSymbolicLink != true else {
      throw ImagePerceptualHashError.resourceLimit
    }
    try fileManager.setAttributes(
      [.posixPermissions: 0o700],
      ofItemAtPath: value.path
    )
    return value
  }

  private static func existsNoFollow(_ fileURL: URL) throws -> Bool {
    var metadata = stat()
    if lstat(fileURL.path, &metadata) == 0 { return true }
    if errno == ENOENT { return false }
    throw ImagePerceptualHashError.resourceLimit
  }

  private static func removeIfPresent(_ fileURL: URL) throws {
    if unlink(fileURL.path) == 0 || errno == ENOENT { return }
    throw ImagePerceptualHashError.resourceLimit
  }
}
