import CoreGraphics
import CryptoKit
import Foundation
import PDFKit
import Vision

enum PDFProcessingError: Error, Equatable {
  case invalidRequest
  case invalidLocalFile
  case cancelled
  case corrupt
  case encrypted
  case empty
  case tooLarge
  case tooManyPages
  case pageOutOfRange
  case pageExtractionFailed
  case resourceBusy
  case resultInvalid
  case memoryPressure

  var stableCode: String {
    switch self {
    case .invalidRequest, .resultInvalid: return "PDF_RESULT_INVALID"
    case .invalidLocalFile: return "INVALID_LOCAL_FILE_URI"
    case .cancelled: return "PDF_CANCELLED"
    case .corrupt: return "PDF_CORRUPT"
    case .encrypted: return "PDF_ENCRYPTED"
    case .empty: return "PDF_EMPTY"
    case .tooLarge: return "PDF_TOO_LARGE"
    case .tooManyPages: return "PDF_TOO_MANY_PAGES"
    case .pageOutOfRange: return "PDF_PAGE_OUT_OF_RANGE"
    case .pageExtractionFailed: return "PDF_PAGE_EXTRACTION_FAILED"
    case .resourceBusy: return "PDF_RESOURCE_BUSY"
    case .memoryPressure: return "RESOURCE_MEMORY_PRESSURE"
    }
  }

  static func fromOCR(_ error: OCRProcessingError) -> PDFProcessingError {
    switch error {
    case .cancelled: return .cancelled
    case .resourceBusy: return .resourceBusy
    case .memoryPressure: return .memoryPressure
    case .invalidLocalFile: return .invalidLocalFile
    default: return .pageExtractionFailed
    }
  }
}

struct PDFResourcePolicy {
  static let maximumPages = 25
  static let maximumFileBytes = 52_428_800
  static let maximumRenderedDimension = 2_200
  static let maximumRenderedPixels = 8_000_000
  static let minimumEmbeddedTextCharacters = 16
  static let maximumPageTextLength = 1_000_000
}

internal func pdfEmbeddedTextNonWhitespaceUTF16Count(_ input: String) -> Int {
  input.unicodeScalars.reduce(into: 0) { count, scalar in
    guard !isPDFDensityWhitespace(scalar.value) else { return }
    count += scalar.value > 0xFFFF ? 2 : 1
  }
}

private func isPDFDensityWhitespace(_ value: UInt32) -> Bool {
  value == 0x0020 || value == 0x0085 || value == 0x00A0 || value == 0x1680 ||
    (value >= 0x0009 && value <= 0x000D) ||
    (value >= 0x2000 && value <= 0x200A) ||
    value == 0x2028 || value == 0x2029 || value == 0x202F || value == 0x205F ||
    value == 0x3000
}

internal func reconcilePDFSparseEmbeddedText(
  embedded: String,
  recognized: String
) -> String {
  guard !embedded.isEmpty else { return recognized }
  guard !recognized.isEmpty else { return embedded }
  if recognized.contains(embedded) { return recognized }
  if embedded.contains(recognized) { return embedded }
  return embedded + "\n" + recognized
}

final class ApplePDFProcessor: @unchecked Sendable {
  private let registry: OCRCancellationRegistry

  init(registry: OCRCancellationRegistry = OCRCancellationRegistry()) {
    self.registry = registry
  }

  func inspect(fileURL: URL) throws -> [String: Any] {
    let fileSize = try validatedFileSize(fileURL)
    let sourceSHA256 = try sha256(fileURL)
    let document = try openDocument(fileURL)
    try validateDocument(document)
    return [
      "schemaVersion": 1,
      "pageCount": document.pageCount,
      "byteCount": fileSize,
      "sha256": sourceSHA256,
      "engine": "pdfkit",
      "revision": "PDFKit",
      "limit": [
        "pages": PDFResourcePolicy.maximumPages,
        "bytes": PDFResourcePolicy.maximumFileBytes,
      ],
    ]
  }

  func reserve(taskId: String) throws {
    guard isCanonicalPDFTaskId(taskId) else { throw PDFProcessingError.invalidRequest }
    do { try registry.reserve(taskId: taskId) }
    catch let error as OCRProcessingError { throw PDFProcessingError.fromOCR(error) }
  }

  func extractPage(
    taskId: String,
    fileURL: URL,
    expectedSourceSHA256: String,
    pageIndex: Int,
    script: String,
    reserved: Bool = false
  ) throws -> [String: Any] {
    var registered = reserved
    defer {
      if registered { registry.finish(taskId: taskId) }
    }
    guard isCanonicalPDFTaskId(taskId),
          pageIndex >= 0,
          pageIndex < PDFResourcePolicy.maximumPages,
          script == "latin" || script == "chinese" else {
      throw PDFProcessingError.invalidRequest
    }
    if !reserved {
      try reserve(taskId: taskId)
      registered = true
    }

    _ = try validatedFileSize(fileURL)
    try validateExpectedSource(fileURL, expectedSHA256: expectedSourceSHA256)
    let document = try openDocument(fileURL)
    try validateDocument(document)
    guard pageIndex < document.pageCount else { throw PDFProcessingError.pageOutOfRange }
    guard let page = document.page(at: pageIndex) else {
      throw PDFProcessingError.pageExtractionFailed
    }
    try checkCancellation(taskId)

    let started = ContinuousClock.now
    let embedded = normalizePDFText(page.string ?? "")
    guard embedded.utf16.count <= PDFResourcePolicy.maximumPageTextLength else {
      return try sourceBoundResult(
        failedResult(
          pageIndex: pageIndex,
          warnings: ["PDF_PAGE_EXTRACTION_FAILED"],
          started: started
        ),
        fileURL: fileURL,
        expectedSHA256: expectedSourceSHA256
      )
    }
    let nonWhitespaceCount = pdfEmbeddedTextNonWhitespaceUTF16Count(embedded)
    if nonWhitespaceCount >= PDFResourcePolicy.minimumEmbeddedTextCharacters {
      return try sourceBoundResult(
        completeResult(
          pageIndex: pageIndex,
          method: "embedded-text",
          engine: "pdfkit",
          revision: "PDFKit",
          text: embedded,
          blocks: [],
          warnings: [],
          started: started
        ),
        fileURL: fileURL,
        expectedSHA256: expectedSourceSHA256
      )
    }

    var warnings = [String]()
    if nonWhitespaceCount > 0 { warnings.append("PDF_EMBEDDED_TEXT_SPARSE") }
    warnings.append("PDF_PAGE_OCR_FALLBACK")
    do {
      let recognized = try recognizeRenderedPage(
        taskId: taskId,
        page: page,
        script: script
      )
      let reconciledText = reconcilePDFSparseEmbeddedText(
        embedded: embedded,
        recognized: recognized.text
      )
      if reconciledText.isEmpty { warnings.append("PDF_PAGE_EMPTY") }
      return try sourceBoundResult(
        completeResult(
          pageIndex: pageIndex,
          method: "rendered-ocr",
          engine: "apple-vision",
          revision: String(VNRecognizeTextRequestRevision3),
          text: reconciledText,
          blocks: recognized.blocks,
          warnings: warnings,
          started: started
        ),
        fileURL: fileURL,
        expectedSHA256: expectedSourceSHA256
      )
    } catch let error as PDFProcessingError {
      switch error {
      case .cancelled, .memoryPressure, .resourceBusy:
        throw error
      default:
        warnings.append("PDF_PAGE_EXTRACTION_FAILED")
        return try sourceBoundResult(
          failedResult(
            pageIndex: pageIndex,
            warnings: warnings,
            started: started
          ),
          fileURL: fileURL,
          expectedSHA256: expectedSourceSHA256
        )
      }
    } catch {
      warnings.append("PDF_PAGE_EXTRACTION_FAILED")
      return try sourceBoundResult(
        failedResult(pageIndex: pageIndex, warnings: warnings, started: started),
        fileURL: fileURL,
        expectedSHA256: expectedSourceSHA256
      )
    }
  }

  func cancel(taskId: String) -> Bool {
    guard isCanonicalPDFTaskId(taskId) else { return false }
    return registry.cancel(taskId: taskId)
  }

  func finish(taskId: String) {
    registry.finish(taskId: taskId)
  }

  private func validatedFileSize(_ fileURL: URL) throws -> Int {
    guard fileURL.isFileURL else { throw PDFProcessingError.invalidLocalFile }
    let values: URLResourceValues
    do {
      values = try fileURL.resourceValues(
        forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]
      )
    } catch {
      throw PDFProcessingError.invalidLocalFile
    }
    guard values.isRegularFile == true, values.isSymbolicLink != true,
          let fileSize = values.fileSize, fileSize >= 0 else {
      throw PDFProcessingError.invalidLocalFile
    }
    guard fileSize <= PDFResourcePolicy.maximumFileBytes else {
      throw PDFProcessingError.tooLarge
    }
    return fileSize
  }

  private func sha256(_ fileURL: URL) throws -> String {
    guard let input = InputStream(url: fileURL) else {
      throw PDFProcessingError.invalidLocalFile
    }
    input.open()
    defer { input.close() }
    var hasher = SHA256()
    var buffer = [UInt8](repeating: 0, count: 64 * 1_024)
    while true {
      let count = input.read(&buffer, maxLength: buffer.count)
      if count < 0 { throw PDFProcessingError.corrupt }
      if count == 0 { break }
      hasher.update(data: Data(buffer[0..<count]))
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
  }

  private func validateExpectedSource(_ fileURL: URL, expectedSHA256: String) throws {
    guard expectedSHA256.count == 64,
          expectedSHA256.unicodeScalars.allSatisfy({
            ($0.value >= 48 && $0.value <= 57) || ($0.value >= 97 && $0.value <= 102)
          }),
          (try? validatedFileSize(fileURL)) != nil,
          (try? sha256(fileURL)) == expectedSHA256 else {
      throw PDFProcessingError.resultInvalid
    }
  }

  private func sourceBoundResult(
    _ result: [String: Any],
    fileURL: URL,
    expectedSHA256: String
  ) throws -> [String: Any] {
    try validateExpectedSource(fileURL, expectedSHA256: expectedSHA256)
    return result
  }

  private func openDocument(_ fileURL: URL) throws -> PDFDocument {
    guard let document = PDFDocument(url: fileURL) else {
      throw PDFProcessingError.corrupt
    }
    if document.isEncrypted || document.isLocked {
      throw PDFProcessingError.encrypted
    }
    return document
  }

  private func validateDocument(_ document: PDFDocument) throws {
    guard document.pageCount > 0 else { throw PDFProcessingError.empty }
    guard document.pageCount <= PDFResourcePolicy.maximumPages else {
      throw PDFProcessingError.tooManyPages
    }
  }

  private func checkCancellation(_ taskId: String) throws {
    guard let failure = registry.failure(taskId: taskId) else { return }
    throw PDFProcessingError.fromOCR(failure)
  }

  private func recognizeRenderedPage(
    taskId: String,
    page: PDFPage,
    script: String
  ) throws -> (text: String, blocks: [[String: Any]]) {
    let image = try render(page: page)
    try checkCancellation(taskId)
    let request = VNRecognizeTextRequest()
    request.revision = VNRecognizeTextRequestRevision3
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.automaticallyDetectsLanguage = true
    request.recognitionLanguages = script == "chinese" ? ["zh-Hans", "en-US"] : ["en-US"]
    do { try registry.attach(taskId: taskId, request: request) }
    catch let error as OCRProcessingError { throw PDFProcessingError.fromOCR(error) }
    do {
      try VNImageRequestHandler(cgImage: image).perform([request])
    } catch {
      try checkCancellation(taskId)
      throw PDFProcessingError.pageExtractionFailed
    }
    try checkCancellation(taskId)

    let observations = request.results ?? []
    guard observations.count <= OCRResourcePolicy.maximumBlocks else {
      throw PDFProcessingError.pageExtractionFailed
    }
    var blocks = [[String: Any]]()
    var aggregateTextLength = 0
    for observation in observations {
      guard let candidate = observation.topCandidates(1).first,
            !candidate.string.isEmpty else { continue }
      let length = candidate.string.utf16.count
      guard length <= OCRResourcePolicy.maximumBlockTextLength else {
        throw PDFProcessingError.pageExtractionFailed
      }
      do {
        aggregateTextLength = try advanceOCRAggregateTextLength(
          currentLength: aggregateTextLength,
          nextTextLength: length,
          hasPreviousBlock: !blocks.isEmpty
        )
      } catch {
        throw PDFProcessingError.pageExtractionFailed
      }
      blocks.append([
        "text": normalizePDFText(candidate.string),
        "confidence": Double(candidate.confidence),
        "bounds": normalizedPDFVisionBounds(observation.boundingBox),
      ])
    }
    let sorted = sortOCRBlocksInReadingOrder(blocks)
    let text = sorted.compactMap { $0["text"] as? String }.joined(separator: "\n")
    guard text.utf16.count <= OCRResourcePolicy.maximumTextLength else {
      throw PDFProcessingError.pageExtractionFailed
    }
    return (text, sorted)
  }

  private func render(page: PDFPage) throws -> CGImage {
    let bounds = page.bounds(for: .mediaBox)
    guard bounds.width.isFinite, bounds.height.isFinite,
          bounds.width > 0, bounds.height > 0 else {
      throw PDFProcessingError.pageExtractionFailed
    }
    let dimensionScale = CGFloat(PDFResourcePolicy.maximumRenderedDimension) /
      max(bounds.width, bounds.height)
    let pixelScale = sqrt(
      CGFloat(PDFResourcePolicy.maximumRenderedPixels) /
        (bounds.width * bounds.height)
    )
    let scale = min(2, dimensionScale, pixelScale)
    let width = max(1, Int(ceil(bounds.width * scale)))
    let height = max(1, Int(ceil(bounds.height * scale)))
    guard width <= PDFResourcePolicy.maximumRenderedDimension,
          height <= PDFResourcePolicy.maximumRenderedDimension,
          width <= PDFResourcePolicy.maximumRenderedPixels / height else {
      throw PDFProcessingError.pageExtractionFailed
    }
    guard let context = CGContext(
      data: nil,
      width: width,
      height: height,
      bitsPerComponent: 8,
      bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
      throw PDFProcessingError.memoryPressure
    }
    context.setFillColor(CGColor(gray: 1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.saveGState()
    context.translateBy(x: 0, y: CGFloat(height))
    context.scaleBy(x: scale, y: -scale)
    context.translateBy(x: -bounds.minX, y: -bounds.minY)
    page.draw(with: .mediaBox, to: context)
    context.restoreGState()
    guard let image = context.makeImage() else {
      throw PDFProcessingError.pageExtractionFailed
    }
    return image
  }

  private func completeResult(
    pageIndex: Int,
    method: String,
    engine: String,
    revision: String,
    text: String,
    blocks: [[String: Any]],
    warnings: [String],
    started: ContinuousClock.Instant
  ) -> [String: Any] {
    [
      "schemaVersion": 1,
      "pageIndex": pageIndex,
      "method": method,
      "engine": engine,
      "revision": revision,
      "durationMs": pdfDurationMilliseconds(since: started),
      "characterCount": text.utf16.count,
      "warnings": warnings,
      "status": "complete",
      "text": text,
      "blocks": blocks,
    ]
  }

  private func failedResult(
    pageIndex: Int,
    warnings: [String],
    started: ContinuousClock.Instant
  ) -> [String: Any] {
    [
      "schemaVersion": 1,
      "pageIndex": pageIndex,
      "method": "rendered-ocr",
      "engine": "apple-vision",
      "revision": String(VNRecognizeTextRequestRevision3),
      "durationMs": pdfDurationMilliseconds(since: started),
      "characterCount": 0,
      "warnings": Array(warnings.prefix(4)),
      "status": "failed",
      "errorCode": "PDF_PAGE_EXTRACTION_FAILED",
    ]
  }
}

private func normalizePDFText(_ input: String) -> String {
  let normalizedLines = input.replacingOccurrences(of: "\r\n", with: "\n")
    .replacingOccurrences(of: "\r", with: "\n")
  var normalized = String.UnicodeScalarView()
  for scalar in normalizedLines.unicodeScalars {
    let value = scalar.value
    let unsafe = value <= 0x0008 || value == 0x000B || value == 0x000C ||
      (value >= 0x000E && value <= 0x001F) ||
      (value >= 0x007F && value <= 0x009F) ||
      (value >= 0x202A && value <= 0x202E) ||
      (value >= 0x2066 && value <= 0x2069)
    normalized.append(unsafe ? Unicode.Scalar(0xFFFD)! : scalar)
  }
  return String(normalized)
}

private func normalizedPDFVisionBounds(_ value: CGRect) -> [String: Double] {
  let x = min(max(value.minX, 0), 1)
  let y = min(max(1 - value.maxY, 0), 1)
  let width = min(max(value.width, 0), 1 - x)
  let height = min(max(value.height, 0), 1 - y)
  return ["x": x, "y": y, "width": width, "height": height]
}

private func isCanonicalPDFTaskId(_ value: String) -> Bool {
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

private func pdfDurationMilliseconds(since started: ContinuousClock.Instant) -> Double {
  let duration = started.duration(to: .now)
  return Double(duration.components.seconds) * 1_000 +
    Double(duration.components.attoseconds) / 1_000_000_000_000_000
}
