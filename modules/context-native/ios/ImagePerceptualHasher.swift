import CoreGraphics
import Foundation
import ImageIO

enum ImagePerceptualHashError: Error {
  case invalidImage
  case resourceLimit

  var stableCode: String {
    switch self {
    case .invalidImage: return "PROCESSOR_OUTPUT_INVALID"
    case .resourceLimit: return "RESOURCE_MEMORY_PRESSURE"
    }
  }
}

enum ImagePerceptualHasher {
  static let maximumSourceBytes: Int64 = 52_428_800
  // v1 decodes the bounded original once so both platforms sample identical
  // source coordinates. This limit caps the RGBA working set at about 64 MiB.
  static let maximumPixelCount = 16_000_000
  static let sampleWidth = 9
  static let sampleHeight = 8

  static func hash(fileURL: URL) throws -> [String: Any] {
    let started = ContinuousClock.now
    let values = try fileURL.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
    guard values.isRegularFile == true,
          let fileSize = values.fileSize,
          fileSize >= 0,
          Int64(fileSize) <= maximumSourceBytes,
          let source = CGImageSourceCreateWithURL(fileURL as CFURL, nil),
          CGImageSourceGetCount(source) == 1 else {
      throw ImagePerceptualHashError.invalidImage
    }
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
    let luminance = sampleLuminance(
      rgba: rgba,
      width: image.width,
      height: image.height,
      bytesPerRow: bytesPerRow
    )
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

  static func sampleLuminance(
    rgba: [UInt8],
    width: Int,
    height: Int,
    bytesPerRow: Int
  ) -> [UInt8] {
    precondition(width > 0 && height > 0)
    precondition(rgba.count >= bytesPerRow * height)
    var samples = [UInt8](repeating: 0, count: sampleWidth * sampleHeight)
    for row in 0..<sampleHeight {
      let yStart = row * height / sampleHeight
      let yEnd = min(height, max(yStart + 1, (row + 1) * height / sampleHeight))
      for column in 0..<sampleWidth {
        let xStart = column * width / sampleWidth
        let xEnd = min(width, max(xStart + 1, (column + 1) * width / sampleWidth))
        var total: UInt64 = 0
        var count: UInt64 = 0
        for y in yStart..<yEnd {
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
}
