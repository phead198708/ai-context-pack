import Foundation
import ImageIO
import Vision

enum OCRProcessingError: Error, Equatable {
  case invalidRequest
  case invalidLocalFile
  case cancelled
  case engineUnavailable
  case imageDecodeFailed
  case imageTooLarge
  case languageUnavailable
  case recognitionFailed
  case resourceBusy
  case resultInvalid
  case memoryPressure

  var stableCode: String {
    switch self {
    case .invalidRequest, .resultInvalid: return "OCR_RESULT_INVALID"
    case .invalidLocalFile: return "INVALID_LOCAL_FILE_URI"
    case .cancelled: return "OCR_CANCELLED"
    case .engineUnavailable: return "OCR_ENGINE_UNAVAILABLE"
    case .imageDecodeFailed: return "OCR_IMAGE_DECODE_FAILED"
    case .imageTooLarge: return "OCR_IMAGE_TOO_LARGE"
    case .languageUnavailable: return "OCR_LANGUAGE_UNAVAILABLE"
    case .recognitionFailed: return "OCR_RECOGNITION_FAILED"
    case .resourceBusy: return "OCR_RESOURCE_BUSY"
    case .memoryPressure: return "RESOURCE_MEMORY_PRESSURE"
    }
  }
}

struct OCRResourcePolicy {
  static let maximumPixelCount = 40_000_000
  static let maximumDimension = 12_000
  static let maximumFileBytes = 52_428_800
  static let maximumBlocks = 10_000
  static let maximumTextLength = 1_000_000
  static let maximumBlockTextLength = 100_000

  static func validate(width: Int, height: Int, fileBytes: Int) throws {
    guard width > 0, height > 0, fileBytes >= 0 else {
      throw OCRProcessingError.imageDecodeFailed
    }
    guard width <= maximumDimension,
          height <= maximumDimension,
          width <= maximumPixelCount / height,
          fileBytes <= maximumFileBytes else {
      throw OCRProcessingError.imageTooLarge
    }
  }
}

final class OCRCancellationRegistry: @unchecked Sendable {
  private let lock = NSLock()
  private var activeTaskId: String?
  private weak var activeRequest: VNRequest?
  private var cancelCode: OCRProcessingError?
  private var memoryPressure = false

  func reserve(taskId: String) throws {
    lock.lock()
    defer { lock.unlock() }
    guard activeTaskId == nil else { throw OCRProcessingError.resourceBusy }
    if memoryPressure {
      memoryPressure = false
      throw OCRProcessingError.memoryPressure
    }
    activeTaskId = taskId
    activeRequest = nil
    cancelCode = nil
  }

  func attach(taskId: String, request: VNRequest) throws {
    lock.lock()
    defer { lock.unlock() }
    guard activeTaskId == taskId else { throw OCRProcessingError.resourceBusy }
    if let cancelCode { throw cancelCode }
    activeRequest = request
  }

  func begin(taskId: String, request: VNRequest) throws {
    try reserve(taskId: taskId)
    do {
      try attach(taskId: taskId, request: request)
    } catch {
      finish(taskId: taskId)
      throw error
    }
  }

  func cancel(taskId: String) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard activeTaskId == taskId else { return true }
    cancelCode = .cancelled
    activeRequest?.cancel()
    return true
  }

  func failure(taskId: String) -> OCRProcessingError? {
    lock.lock()
    defer { lock.unlock() }
    return activeTaskId == taskId ? cancelCode : nil
  }

  func finish(taskId: String) {
    lock.lock()
    defer { lock.unlock() }
    guard activeTaskId == taskId else { return }
    activeTaskId = nil
    activeRequest = nil
    cancelCode = nil
  }

  func setMemoryPressure(_ active: Bool) {
    lock.lock()
    memoryPressure = active
    if active, activeTaskId != nil {
      cancelCode = .memoryPressure
      activeRequest?.cancel()
    }
    lock.unlock()
  }
}

final class OCRModuleLifetime: @unchecked Sendable {
  private let lock = NSLock()
  private var destroyed = false
  private var activeTaskId: String?
  private var settled = false

  func begin(taskId: String) throws {
    lock.lock()
    defer { lock.unlock() }
    guard !destroyed else { throw OCRProcessingError.cancelled }
    guard activeTaskId == nil else { throw OCRProcessingError.resourceBusy }
    activeTaskId = taskId
    settled = false
  }

  func claimDelivery(taskId: String) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard !destroyed, activeTaskId == taskId, !settled else { return false }
    settled = true
    return true
  }

  func finish(taskId: String) {
    lock.lock()
    defer { lock.unlock() }
    guard activeTaskId == taskId else { return }
    activeTaskId = nil
    settled = false
  }

  func destroy() -> String? {
    lock.lock()
    defer { lock.unlock() }
    destroyed = true
    guard let activeTaskId, !settled else { return nil }
    settled = true
    return activeTaskId
  }
}

final class AppleVisionOCRProcessor: @unchecked Sendable {
  private let registry: OCRCancellationRegistry

  init(registry: OCRCancellationRegistry = OCRCancellationRegistry()) {
    self.registry = registry
  }

  func capabilities() -> [String: Any] {
    let revision = VNRecognizeTextRequestRevision3
    let languages = supportedLanguages(level: .accurate, revision: revision)
    var scripts: [String] = []
    if languages.contains(where: { $0.hasPrefix("en") }) { scripts.append("latin") }
    if languages.contains(where: { $0 == "zh-Hans" || $0.hasPrefix("zh-Hans-") }) {
      scripts.append("chinese")
    }
    return [
      "schemaVersion": 1,
      "engines": [[
        "engine": "apple-vision",
        "revision": String(revision),
        "scripts": scripts,
        "recognitionLevels": ["accurate", "fast"],
        "ready": scripts.contains("latin") && scripts.contains("chinese"),
        "offline": true,
      ]],
      "maximumPixelCount": OCRResourcePolicy.maximumPixelCount,
      "maximumDimension": OCRResourcePolicy.maximumDimension,
    ]
  }

  func recognize(
    taskId: String,
    fileURL: URL,
    script: String,
    recognitionLevel: String,
    reserved: Bool = false
  ) throws -> [String: Any] {
    var registered = reserved
    defer {
      if registered { registry.finish(taskId: taskId) }
    }
    guard isCanonicalTaskId(taskId), script == "latin" || script == "chinese" else {
      throw OCRProcessingError.invalidRequest
    }
    let level: VNRequestTextRecognitionLevel
    switch recognitionLevel {
    case "accurate": level = .accurate
    case "fast": level = .fast
    default: throw OCRProcessingError.invalidRequest
    }
    let revision = VNRecognizeTextRequestRevision3
    let supported = supportedLanguages(level: level, revision: revision)
    let requested = script == "chinese" ? ["zh-Hans", "en-US"] : ["en-US"]
    guard requested.allSatisfy({ requestedLanguage in
      supported.contains(where: { language in
        language == requestedLanguage ||
          (requestedLanguage == "en-US" && language.hasPrefix("en"))
      })
    }) else { throw OCRProcessingError.languageUnavailable }

    let request = VNRecognizeTextRequest()
    request.revision = revision
    request.recognitionLevel = level
    request.usesLanguageCorrection = true
    request.automaticallyDetectsLanguage = true
    request.recognitionLanguages = requested
    if reserved {
      try registry.attach(taskId: taskId, request: request)
    } else {
      try registry.begin(taskId: taskId, request: request)
      registered = true
    }

    let started = ContinuousClock.now
    return try autoreleasepool {
      guard fileURL.isFileURL,
            let values = try? fileURL.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]),
            values.isRegularFile == true,
            let source = CGImageSourceCreateWithURL(fileURL as CFURL, nil),
            let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil)
              as? [CFString: Any],
            let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
            let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue else {
        throw OCRProcessingError.imageDecodeFailed
      }
      try OCRResourcePolicy.validate(
        width: width,
        height: height,
        fileBytes: values.fileSize ?? 0
      )
      guard let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw OCRProcessingError.imageDecodeFailed
      }
      if let failure = registry.failure(taskId: taskId) { throw failure }
      do {
        try VNImageRequestHandler(
          cgImage: image,
          orientation: imageOrientation(source: source)
        ).perform([request])
      } catch {
        if let failure = registry.failure(taskId: taskId) { throw failure }
        throw OCRProcessingError.recognitionFailed
      }
      if let failure = registry.failure(taskId: taskId) { throw failure }

      let observations = request.results ?? []
      guard observations.count <= OCRResourcePolicy.maximumBlocks else {
        throw OCRProcessingError.resultInvalid
      }
      let blocks: [[String: Any]] = sortOCRBlocksInReadingOrder(
        try observations.compactMap { observation in
          guard let candidate = observation.topCandidates(1).first,
                !candidate.string.isEmpty else { return nil }
          guard candidate.string.utf16.count <= OCRResourcePolicy.maximumBlockTextLength else {
            throw OCRProcessingError.resultInvalid
          }
          let bounds = normalizedTopLeftBounds(observation.boundingBox)
          return [
            "text": candidate.string,
            "confidence": Double(candidate.confidence),
            "bounds": bounds,
          ]
        }
      )
      let text = blocks.compactMap { $0["text"] as? String }.joined(separator: "\n")
      guard text.utf16.count <= OCRResourcePolicy.maximumTextLength else {
        throw OCRProcessingError.resultInvalid
      }
      let lowConfidence = blocks.contains { block in
        (block["confidence"] as? Double).map { $0 < 0.5 } == true
      }
      return [
        "schemaVersion": 1,
        "text": text,
        "blocks": blocks,
        "durationMs": durationMilliseconds(since: started),
        "engine": "apple-vision",
        "revision": String(revision),
        "recognitionLevel": recognitionLevel,
        "warnings": lowConfidence ? ["OCR_LOW_CONFIDENCE"] : [],
      ]
    }
  }

  func cancel(taskId: String) -> Bool {
    guard isCanonicalTaskId(taskId) else { return false }
    return registry.cancel(taskId: taskId)
  }

  func reserve(taskId: String) throws {
    guard isCanonicalTaskId(taskId) else { throw OCRProcessingError.invalidRequest }
    try registry.reserve(taskId: taskId)
  }

  func finish(taskId: String) {
    registry.finish(taskId: taskId)
  }

  func setMemoryPressure(_ active: Bool) {
    registry.setMemoryPressure(active)
  }

  private func supportedLanguages(
    level: VNRequestTextRecognitionLevel,
    revision: Int
  ) -> [String] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = level
    request.revision = revision
    return (try? request.supportedRecognitionLanguages()) ?? []
  }
}

private func isCanonicalTaskId(_ value: String) -> Bool {
  guard value == value.lowercased(),
        let uuid = UUID(uuidString: value),
        uuid.uuidString.lowercased() == value else { return false }
  let components = value.split(separator: "-")
  guard components.count == 5,
        let version = components[2].first,
        "12345".contains(version),
        let variant = components[3].first,
        "89ab".contains(variant) else { return false }
  return true
}

private func normalizedTopLeftBounds(_ value: CGRect) -> [String: Double] {
  let x = value.minX.clamped(to: 0...1)
  let y = (1 - value.maxY).clamped(to: 0...1)
  let width = value.width.clamped(to: 0...(1 - x))
  let height = value.height.clamped(to: 0...(1 - y))
  return ["x": x, "y": y, "width": width, "height": height]
}

func sortOCRBlocksInReadingOrder(_ blocks: [[String: Any]]) -> [[String: Any]] {
  let topLeftSorted = blocks.sorted { left, right in
    compareOCRBlock(left, right, keys: ["y", "x", "width", "height"])
  }
  var rows: [[[String: Any]]] = []
  for block in topLeftSorted {
    let y = ocrBounds(block)["y"] ?? 0
    if let anchorY = rows.last?.first.map({ ocrBounds($0)["y"] ?? 0 }),
       y - anchorY < ocrRowTolerance {
      rows[rows.count - 1].append(block)
    } else {
      rows.append([block])
    }
  }
  return rows.flatMap { row in
    row.sorted { left, right in
      compareOCRBlock(left, right, keys: ["x", "y", "width", "height"])
    }
  }
}

private func compareOCRBlock(
  _ left: [String: Any],
  _ right: [String: Any],
  keys: [String]
) -> Bool {
  let leftBounds = ocrBounds(left)
  let rightBounds = ocrBounds(right)
  for key in keys {
    let leftValue = leftBounds[key] ?? 0
    let rightValue = rightBounds[key] ?? 0
    if leftValue != rightValue { return leftValue < rightValue }
  }
  return (left["text"] as? String ?? "") < (right["text"] as? String ?? "")
}

private func ocrBounds(_ block: [String: Any]) -> [String: Double] {
  block["bounds"] as? [String: Double] ?? [:]
}

private let ocrRowTolerance = 0.01

private extension Comparable {
  func clamped(to limits: ClosedRange<Self>) -> Self {
    min(max(self, limits.lowerBound), limits.upperBound)
  }
}

private func imageOrientation(source: CGImageSource) -> CGImagePropertyOrientation {
  guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil)
          as? [CFString: Any],
        let rawValue = properties[kCGImagePropertyOrientation] as? NSNumber else {
    return .up
  }
  return CGImagePropertyOrientation(rawValue: rawValue.uint32Value) ?? .up
}

private func durationMilliseconds(
  since started: ContinuousClock.Instant
) -> Double {
  let duration = started.duration(to: .now)
  return Double(duration.components.seconds) * 1_000 +
    Double(duration.components.attoseconds) / 1_000_000_000_000_000
}
