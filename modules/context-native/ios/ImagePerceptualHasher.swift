import CoreGraphics
import CryptoKit
import Foundation
import ImageIO

enum ImagePerceptualHashError: Error {
  case invalidImage
  case resourceLimit
  case cancelled
  case integrityFailure

  var stableCode: String {
    switch self {
    case .invalidImage: return "PROCESSOR_OUTPUT_INVALID"
    case .resourceLimit: return "RESOURCE_MEMORY_PRESSURE"
    case .cancelled: return "PIPELINE_STAGE_FAILED"
    case .integrityFailure: return "ARTIFACT_INTEGRITY_FAILED"
    }
  }
}

final class ImageHashCancellationToken: @unchecked Sendable {
  private let lock = NSLock()
  private var cancelled = false

  func cancel() {
    lock.lock()
    cancelled = true
    lock.unlock()
  }

  func check() throws {
    lock.lock()
    let value = cancelled
    lock.unlock()
    if value || Task<Never, Never>.isCancelled {
      throw ImagePerceptualHashError.cancelled
    }
  }
}

final class ImageHashTaskRegistry: @unchecked Sendable {
  private final class Entry {
    let ownerId: String
    let token: ImageHashCancellationToken
    var cancelTask: (@Sendable () -> Void)?

    init(ownerId: String, token: ImageHashCancellationToken) {
      self.ownerId = ownerId
      self.token = token
    }
  }

  private let lock = NSLock()
  private var entries: [String: Entry] = [:]

  func reserve(ownerId: String, taskId: String) -> ImageHashCancellationToken? {
    lock.lock()
    defer { lock.unlock() }
    guard UUID(uuidString: taskId)?.uuidString.lowercased() == taskId,
          entries[taskId] == nil else { return nil }
    let token = ImageHashCancellationToken()
    entries[taskId] = Entry(ownerId: ownerId, token: token)
    return token
  }

  func attach(ownerId: String, taskId: String, cancel: @escaping @Sendable () -> Void) {
    lock.lock()
    let entry = entries[taskId]
    guard entry?.ownerId == ownerId else {
      lock.unlock()
      cancel()
      return
    }
    entry?.cancelTask = cancel
    lock.unlock()
  }

  func cancel(taskId: String) -> Bool {
    lock.lock()
    let entry = entries[taskId]
    entry?.token.cancel()
    let cancelTask = entry?.cancelTask
    lock.unlock()
    cancelTask?()
    return true
  }

  func finish(ownerId: String, taskId: String, token: ImageHashCancellationToken) {
    lock.lock()
    defer { lock.unlock() }
    guard let entry = entries[taskId], entry.ownerId == ownerId,
          entry.token === token else { return }
    entries.removeValue(forKey: taskId)
  }

  func destroyOwner(_ ownerId: String) {
    lock.lock()
    let owned = entries.values.filter { $0.ownerId == ownerId }
    for entry in owned { entry.token.cancel() }
    let cancellations = owned.compactMap(\.cancelTask)
    lock.unlock()
    cancellations.forEach { $0() }
  }
}

enum ImagePerceptualHasher {
  static let maximumSourceBytes: Int64 = 52_428_800
  // v1 decodes the bounded original once so both platforms sample identical
  // source coordinates. This limit caps the RGBA working set at about 64 MiB.
  static let maximumPixelCount = 16_000_000
  static let sampleWidth = 9
  static let sampleHeight = 8

  static func hash(
    fileURL: URL,
    expectedByteCount: Int64,
    expectedSHA256: String,
    cancellation: ImageHashCancellationToken
  ) throws -> [String: Any] {
    let started = ContinuousClock.now
    try cancellation.check()
    let values = try fileURL.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
    guard values.isRegularFile == true,
          let fileSize = values.fileSize,
          fileSize > 0,
          Int64(fileSize) <= maximumSourceBytes,
          Int64(fileSize) == expectedByteCount,
          expectedSHA256.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
          try sourceSHA256(fileURL, cancellation: cancellation) == expectedSHA256 else {
      throw ImagePerceptualHashError.integrityFailure
    }
    guard let source = CGImageSourceCreateWithURL(fileURL as CFURL, nil),
          acceptsFrameCount(CGImageSourceGetCount(source)) else {
      throw ImagePerceptualHashError.invalidImage
    }
    try cancellation.check()
    guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
          let height = properties[kCGImagePropertyPixelHeight] as? NSNumber else {
      throw ImagePerceptualHashError.invalidImage
    }
    let pixelCount = width.int64Value.multipliedReportingOverflow(by: height.int64Value)
    guard !pixelCount.overflow, pixelCount.partialValue > 0,
          pixelCount.partialValue <= Int64(maximumPixelCount) else {
      throw ImagePerceptualHashError.resourceLimit
    }
    let thumbnailOptions: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: max(width.intValue, height.intValue),
      kCGImageSourceShouldCacheImmediately: true,
    ]
    guard let image = CGImageSourceCreateThumbnailAtIndex(
      source,
      0,
      thumbnailOptions as CFDictionary
    ) else {
      throw ImagePerceptualHashError.invalidImage
    }
    try cancellation.check()
    let bytesPerRow = image.width * 4
    var rgba = [UInt8](repeating: 0, count: bytesPerRow * image.height)
    try rgba.withUnsafeMutableBytes { buffer in
      guard let context = CGContext(
        data: buffer.baseAddress,
        width: image.width,
        height: image.height,
        bitsPerComponent: 8,
        bytesPerRow: bytesPerRow,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue
          | CGImageAlphaInfo.premultipliedLast.rawValue
      ) else {
        throw ImagePerceptualHashError.resourceLimit
      }
      context.interpolationQuality = .none
      context.setFillColor(gray: 1, alpha: 1)
      context.fill(CGRect(x: 0, y: 0, width: image.width, height: image.height))
      context.draw(
        image,
        in: CGRect(x: 0, y: 0, width: image.width, height: image.height)
      )
    }
    try cancellation.check()
    let luminance = try sampleLuminance(
      rgba: rgba,
      width: image.width,
      height: image.height,
      bytesPerRow: bytesPerRow,
      cancellation: cancellation
    )
    try cancellation.check()
    let finalValues = try fileURL.resourceValues(forKeys: [.fileSizeKey])
    guard Int64(finalValues.fileSize ?? -1) == expectedByteCount,
          try sourceSHA256(fileURL, cancellation: cancellation) == expectedSHA256 else {
      throw ImagePerceptualHashError.integrityFailure
    }
    return [
      "schemaVersion": 1,
      "algorithm": "dhash-64-v1",
      "hash": hash(luminance: luminance),
      "sampleWidth": sampleWidth,
      "sampleHeight": sampleHeight,
      "orientationApplied": true,
      "durationMs": durationMilliseconds(since: started),
      "revision": "1",
    ]
  }

  static func hash(luminance: [UInt8]) -> String {
    precondition(luminance.count == sampleWidth * sampleHeight)
    var result: UInt64 = 0
    for row in 0..<sampleHeight {
      for column in 0..<(sampleWidth - 1) {
        result <<= 1
        if luminance[row * sampleWidth + column] > luminance[row * sampleWidth + column + 1] {
          result |= 1
        }
      }
    }
    return String(format: "%016llx", result)
  }

  static func acceptsFrameCount(_ count: Int) -> Bool { count == 1 }

  static func sampleLuminance(
    rgba: [UInt8],
    width: Int,
    height: Int,
    bytesPerRow: Int,
    cancellation: ImageHashCancellationToken? = nil
  ) throws -> [UInt8] {
    precondition(width > 0 && height > 0)
    precondition(rgba.count >= bytesPerRow * height)
    var samples = [UInt8](repeating: 0, count: sampleWidth * sampleHeight)
    for row in 0..<sampleHeight {
      try cancellation?.check()
      let yStart = row * height / sampleHeight
      let yEnd = min(height, max(yStart + 1, (row + 1) * height / sampleHeight))
      for column in 0..<sampleWidth {
        let xStart = column * width / sampleWidth
        let xEnd = min(width, max(xStart + 1, (column + 1) * width / sampleWidth))
        var total: UInt64 = 0
        var count: UInt64 = 0
        for y in yStart..<yEnd {
          try cancellation?.check()
          for x in xStart..<xEnd {
            let offset = y * bytesPerRow + x * 4
            total += UInt64(
              (299 * Int(rgba[offset])
                + 587 * Int(rgba[offset + 1])
                + 114 * Int(rgba[offset + 2])) / 1_000
            )
            count += 1
          }
        }
        samples[row * sampleWidth + column] = UInt8(total / count)
      }
    }
    return samples
  }

  private static func durationMilliseconds(since start: ContinuousClock.Instant) -> Double {
    let duration = start.duration(to: .now)
    return Double(duration.components.seconds) * 1_000
      + Double(duration.components.attoseconds) / 1_000_000_000_000_000
  }

  private static func sourceSHA256(
    _ fileURL: URL,
    cancellation: ImageHashCancellationToken
  ) throws -> String {
    let handle = try FileHandle(forReadingFrom: fileURL)
    defer { try? handle.close() }
    var digest = SHA256()
    while true {
      try cancellation.check()
      guard let data = try handle.read(upToCount: 64 * 1_024), !data.isEmpty else { break }
      digest.update(data: data)
    }
    return digest.finalize().map { String(format: "%02x", $0) }.joined()
  }
}
