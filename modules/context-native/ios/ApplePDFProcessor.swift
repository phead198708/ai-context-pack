import CoreGraphics
import CryptoKit
import Darwin
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
  reconcilePDFSparseEmbeddedTextWithinLimit(
    embedded: embedded,
    recognized: recognized,
    maximumUTF16Length: Int.max
  )!
}

internal func reconcilePDFSparseEmbeddedTextWithinLimit(
  embedded: String,
  recognized: String,
  maximumUTF16Length: Int
) -> String? {
  guard maximumUTF16Length >= 0 else { return nil }
  let densitySafeEmbedded = pdfEmbeddedTextNonWhitespaceUTF16Count(embedded) == 0
    ? ""
    : embedded
  guard !densitySafeEmbedded.isEmpty else {
    return recognized.utf16.count <= maximumUTF16Length ? recognized : nil
  }
  guard !recognized.isEmpty else {
    return embedded.utf16.count <= maximumUTF16Length ? embedded : nil
  }
  if densitySafeEmbedded.utf16.elementsEqual(recognized.utf16) {
    return densitySafeEmbedded.utf16.count <= maximumUTF16Length ? densitySafeEmbedded : nil
  }
  let embeddedLength = densitySafeEmbedded.utf16.count
  let recognizedLength = recognized.utf16.count
  guard embeddedLength <= maximumUTF16Length,
        recognizedLength < maximumUTF16Length,
        embeddedLength <= maximumUTF16Length - recognizedLength - 1 else {
    return nil
  }
  return densitySafeEmbedded + "\n" + recognized
}

private struct ApplePDFSourceSession {
  let taskId: String
  let filePath: String
  let sourceSHA256: String
  let document: PDFDocument
}

final class ApplePDFProcessor: @unchecked Sendable {
  private let registry: OCRCancellationRegistry
  private let sourceLock = NSLock()
  private var sourceSession: ApplePDFSourceSession?

  init(registry: OCRCancellationRegistry = OCRCancellationRegistry()) {
    self.registry = registry
  }

  func inspect(fileURL: URL) throws -> [String: Any] {
    let snapshot = try readSourceSnapshot(fileURL: fileURL, taskId: nil)
    let document = try openDocument(snapshot.data)
    try validateDocument(document)
    return documentInfo(
      document: document,
      byteCount: snapshot.byteCount,
      sourceSHA256: snapshot.sourceSHA256
    )
  }

  func inspect(
    taskId: String,
    fileURL: URL,
    expectedSourceSHA256: String,
    reserved: Bool = false
  ) throws -> [String: Any] {
    var registered = reserved
    do {
      guard isCanonicalPDFTaskId(taskId),
            isCanonicalPDFSHA256(expectedSourceSHA256) else {
        throw PDFProcessingError.invalidRequest
      }
      if !reserved {
        try reserve(taskId: taskId)
        registered = true
      }
      let snapshot = try readSourceSnapshot(fileURL: fileURL, taskId: taskId)
      guard snapshot.sourceSHA256 == expectedSourceSHA256 else {
        throw PDFProcessingError.resultInvalid
      }
      let document = try openDocument(snapshot.data)
      try validateDocument(document)
      let session = ApplePDFSourceSession(
        taskId: taskId,
        filePath: fileURL.standardizedFileURL.path,
        sourceSHA256: snapshot.sourceSHA256,
        document: document
      )
      sourceLock.lock()
      defer { sourceLock.unlock() }
      guard sourceSession == nil else { throw PDFProcessingError.resourceBusy }
      sourceSession = session
      return documentInfo(
        document: document,
        byteCount: snapshot.byteCount,
        sourceSHA256: snapshot.sourceSHA256
      )
    } catch {
      if registered { registry.finish(taskId: taskId) }
      throw error
    }
  }

  private func documentInfo(
    document: PDFDocument,
    byteCount: Int,
    sourceSHA256: String
  ) -> [String: Any] {
    [
      "schemaVersion": 1,
      "pageCount": document.pageCount,
      "byteCount": byteCount,
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
    guard isCanonicalPDFTaskId(taskId),
          pageIndex >= 0,
          pageIndex < PDFResourcePolicy.maximumPages,
          script == "latin" || script == "chinese" else {
      throw PDFProcessingError.invalidRequest
    }
    guard reserved else { throw PDFProcessingError.invalidRequest }
    let document = try sourceDocument(
      taskId: taskId,
      fileURL: fileURL,
      expectedSourceSHA256: expectedSourceSHA256
    )
    guard pageIndex < document.pageCount else { throw PDFProcessingError.pageOutOfRange }
    guard let page = document.page(at: pageIndex) else {
      throw PDFProcessingError.pageExtractionFailed
    }
    try checkCancellation(taskId)

    let started = ContinuousClock.now
    let embedded = normalizePDFText(page.string ?? "")
    guard embedded.utf16.count <= PDFResourcePolicy.maximumPageTextLength else {
      return failedResult(
        pageIndex: pageIndex,
        warnings: ["PDF_PAGE_EXTRACTION_FAILED"],
        started: started
      )
    }
    let nonWhitespaceCount = pdfEmbeddedTextNonWhitespaceUTF16Count(embedded)
    if nonWhitespaceCount >= PDFResourcePolicy.minimumEmbeddedTextCharacters {
      return completeResult(
        pageIndex: pageIndex,
        method: "embedded-text",
        engine: "pdfkit",
        revision: "PDFKit",
        text: embedded,
        blocks: [],
        warnings: [],
        started: started
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
      guard let reconciledText = reconcilePDFSparseEmbeddedTextWithinLimit(
        embedded: embedded,
        recognized: recognized.text,
        maximumUTF16Length: PDFResourcePolicy.maximumPageTextLength
      ) else {
        warnings.append("PDF_PAGE_EXTRACTION_FAILED")
        return failedResult(
          pageIndex: pageIndex,
          warnings: warnings,
          started: started
        )
      }
      if reconciledText.isEmpty { warnings.append("PDF_PAGE_EMPTY") }
      return completeResult(
        pageIndex: pageIndex,
        method: "rendered-ocr",
        engine: "apple-vision",
        revision: String(VNRecognizeTextRequestRevision3),
        text: reconciledText,
        blocks: recognized.blocks,
        embeddedText: nonWhitespaceCount > 0 ? embedded : nil,
        warnings: warnings,
        started: started
      )
    } catch let error as PDFProcessingError {
      switch error {
      case .cancelled, .memoryPressure, .resourceBusy:
        throw error
      default:
        warnings.append("PDF_PAGE_EXTRACTION_FAILED")
        return failedResult(
          pageIndex: pageIndex,
          warnings: warnings,
          started: started
        )
      }
    } catch {
      warnings.append("PDF_PAGE_EXTRACTION_FAILED")
      return failedResult(pageIndex: pageIndex, warnings: warnings, started: started)
    }
  }

  func validatePageRequest(
    taskId: String,
    fileURL: URL,
    expectedSourceSHA256: String
  ) throws {
    _ = try sourceDocument(
      taskId: taskId,
      fileURL: fileURL,
      expectedSourceSHA256: expectedSourceSHA256
    )
  }

  func cancel(taskId: String) -> Bool {
    guard isCanonicalPDFTaskId(taskId) else { return false }
    return registry.cancel(taskId: taskId)
  }

  func finish(taskId: String) {
    sourceLock.lock()
    if sourceSession?.taskId == taskId { sourceSession = nil }
    sourceLock.unlock()
    registry.finish(taskId: taskId)
  }

  func destroy(activeTaskId: String? = nil) {
    sourceLock.lock()
    let sessionTaskId = sourceSession?.taskId
    sourceSession = nil
    sourceLock.unlock()
    let registryTaskId = sessionTaskId ?? activeTaskId
    if let registryTaskId {
      _ = registry.cancel(taskId: registryTaskId)
      // Keep process-wide single-flight ownership while an active Vision/PDF
      // operation unwinds. A mismatched request cannot operate on the retained
      // session, so it must not defer release of that session's actual owner.
      if activeTaskId == nil || activeTaskId != registryTaskId {
        registry.finish(taskId: registryTaskId)
      }
    }
  }

  private func readSourceSnapshot(
    fileURL: URL,
    taskId: String?
  ) throws -> (data: Data, byteCount: Int, sourceSHA256: String) {
    guard fileURL.isFileURL else { throw PDFProcessingError.invalidLocalFile }
    let descriptor = Darwin.open(fileURL.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
    guard descriptor >= 0 else { throw PDFProcessingError.invalidLocalFile }
    var info = stat()
    guard fstat(descriptor, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else {
      Darwin.close(descriptor)
      throw PDFProcessingError.invalidLocalFile
    }
    guard info.st_size >= 0 else {
      Darwin.close(descriptor)
      throw PDFProcessingError.invalidLocalFile
    }
    guard info.st_size <= PDFResourcePolicy.maximumFileBytes else {
      Darwin.close(descriptor)
      throw PDFProcessingError.tooLarge
    }

    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    defer { try? handle.close() }
    var data = Data()
    data.reserveCapacity(Int(info.st_size))
    var hasher = SHA256()
    while true {
      if let taskId { try checkCancellation(taskId) }
      let chunk: Data
      do { chunk = try handle.read(upToCount: 64 * 1_024) ?? Data() }
      catch { throw PDFProcessingError.corrupt }
      if chunk.isEmpty { break }
      guard data.count <= PDFResourcePolicy.maximumFileBytes - chunk.count else {
        throw PDFProcessingError.tooLarge
      }
      data.append(chunk)
      hasher.update(data: chunk)
    }
    guard data.count == Int(info.st_size) else { throw PDFProcessingError.corrupt }
    if let taskId { try checkCancellation(taskId) }
    return (
      data,
      data.count,
      hasher.finalize().map { String(format: "%02x", $0) }.joined()
    )
  }

  private func sourceDocument(
    taskId: String,
    fileURL: URL,
    expectedSourceSHA256: String
  ) throws -> PDFDocument {
    sourceLock.lock()
    defer { sourceLock.unlock() }
    guard let session = sourceSession,
          session.taskId == taskId,
          session.filePath == fileURL.standardizedFileURL.path,
          session.sourceSHA256 == expectedSourceSHA256 else {
      throw PDFProcessingError.resultInvalid
    }
    return session.document
  }

  private func openDocument(_ data: Data) throws -> PDFDocument {
    guard let document = PDFDocument(data: data) else {
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
    embeddedText: String? = nil,
    warnings: [String],
    started: ContinuousClock.Instant
  ) -> [String: Any] {
    var result: [String: Any] = [
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
    if let embeddedText { result["embeddedText"] = embeddedText }
    return result
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

final class PDFProcessorFinishOwner: @unchecked Sendable {
  let finishProcessor: (String) -> Void

  init(finishProcessor: @escaping (String) -> Void) {
    self.finishProcessor = finishProcessor
  }
}

final class PDFProcessorFinishCoordinator: @unchecked Sendable {
  private final class State {
    let taskId: String
    let owner: PDFProcessorFinishOwner
    var operationActive: Bool
    var finishRequested = false
    var cleanupActive = false
    var completions: [() -> Void] = []

    init(taskId: String, owner: PDFProcessorFinishOwner, operationActive: Bool) {
      self.taskId = taskId
      self.owner = owner
      self.operationActive = operationActive
    }
  }

  private struct Cleanup {
    let taskId: String
    let finishProcessor: (String) -> Void
    let trackedState: State?
    let fallbackCompletions: [() -> Void]
  }

  private let lock = NSLock()
  private var state: State?

  func beginOperation(
    owner: PDFProcessorFinishOwner,
    taskId: String,
    prepare: () throws -> Void
  ) throws -> PDFProcessorOperationLease {
    lock.lock()
    defer { lock.unlock() }
    if let state,
       state.taskId != taskId ||
       state.owner !== owner ||
       state.operationActive ||
       state.finishRequested ||
       state.cleanupActive {
      throw PDFProcessingError.resourceBusy
    }
    try prepare()
    if let state {
      state.operationActive = true
    } else {
      state = State(taskId: taskId, owner: owner, operationActive: true)
    }
    return PDFProcessorOperationLease(coordinator: self, owner: owner, taskId: taskId)
  }

  @discardableResult
  func requestFinish(
    fallbackOwner: PDFProcessorFinishOwner,
    taskId: String,
    completion: @escaping () -> Void
  ) -> Bool {
    let cleanup: Cleanup?
    lock.lock()
    if let state, state.taskId == taskId {
      state.finishRequested = true
      state.completions.append(completion)
      if state.operationActive {
        lock.unlock()
        return false
      }
      if state.cleanupActive {
        lock.unlock()
        return false
      }
      state.cleanupActive = true
      cleanup = Cleanup(
        taskId: taskId,
        finishProcessor: state.owner.finishProcessor,
        trackedState: state,
        fallbackCompletions: []
      )
    } else {
      cleanup = Cleanup(
        taskId: taskId,
        finishProcessor: fallbackOwner.finishProcessor,
        trackedState: nil,
        fallbackCompletions: [completion]
      )
    }
    lock.unlock()
    runCleanup(cleanup!)
    return true
  }

  @discardableResult
  func destroyOwner(_ owner: PDFProcessorFinishOwner) -> Bool {
    let cleanup: Cleanup?
    lock.lock()
    guard let state, state.owner === owner else {
      lock.unlock()
      return false
    }
    state.finishRequested = true
    if state.operationActive {
      lock.unlock()
      return false
    }
    if state.cleanupActive {
      lock.unlock()
      return false
    }
    state.cleanupActive = true
    cleanup = Cleanup(
      taskId: state.taskId,
      finishProcessor: state.owner.finishProcessor,
      trackedState: state,
      fallbackCompletions: []
    )
    lock.unlock()
    runCleanup(cleanup!)
    return true
  }

  fileprivate func finishOperation(
    owner: PDFProcessorFinishOwner,
    taskId: String,
    keepSession: Bool
  ) -> Bool {
    let cleanup: Cleanup?
    lock.lock()
    guard let state,
          state.taskId == taskId,
          state.owner === owner,
          state.operationActive else {
      lock.unlock()
      return false
    }
    state.operationActive = false
    if keepSession, !state.finishRequested {
      lock.unlock()
      return false
    }
    if state.cleanupActive {
      lock.unlock()
      return false
    }
    state.cleanupActive = true
    cleanup = Cleanup(
      taskId: taskId,
      finishProcessor: state.owner.finishProcessor,
      trackedState: state,
      fallbackCompletions: []
    )
    lock.unlock()
    runCleanup(cleanup!)
    return true
  }

  private func runCleanup(_ cleanup: Cleanup) {
    cleanup.finishProcessor(cleanup.taskId)
    let completions: [() -> Void]
    if let trackedState = cleanup.trackedState {
      lock.lock()
      precondition(state === trackedState && trackedState.cleanupActive)
      trackedState.cleanupActive = false
      completions = trackedState.completions
      trackedState.completions.removeAll()
      state = nil
      lock.unlock()
    } else {
      completions = cleanup.fallbackCompletions
    }
    completions.forEach { $0() }
  }
}

final class PDFProcessorOperationLease: @unchecked Sendable {
  private let lock = NSLock()
  private let coordinator: PDFProcessorFinishCoordinator
  private let owner: PDFProcessorFinishOwner
  private let taskId: String
  private var finished = false

  fileprivate init(
    coordinator: PDFProcessorFinishCoordinator,
    owner: PDFProcessorFinishOwner,
    taskId: String
  ) {
    self.coordinator = coordinator
    self.owner = owner
    self.taskId = taskId
  }

  @discardableResult
  func finish(keepSession: Bool) -> Bool {
    lock.lock()
    guard !finished else {
      lock.unlock()
      return false
    }
    finished = true
    lock.unlock()
    return coordinator.finishOperation(
      owner: owner,
      taskId: taskId,
      keepSession: keepSession
    )
  }
}

final class PDFOperationLifetimeLease {
  private let lifetime: OCRModuleLifetime
  private let taskId: String
  private let processorOperation: PDFProcessorOperationLease

  fileprivate init(
    lifetime: OCRModuleLifetime,
    taskId: String,
    processorOperation: PDFProcessorOperationLease
  ) {
    self.lifetime = lifetime
    self.taskId = taskId
    self.processorOperation = processorOperation
  }

  func claimDelivery() -> Bool {
    lifetime.claimDelivery(taskId: taskId)
  }

  @discardableResult
  func finish(keepSession: Bool) -> Bool {
    lifetime.finish(taskId: taskId)
    return processorOperation.finish(keepSession: keepSession)
  }
}

func beginPDFOperationLifetime(
  lifetime: OCRModuleLifetime,
  coordinator: PDFProcessorFinishCoordinator,
  owner: PDFProcessorFinishOwner,
  taskId: String,
  prepare: () throws -> Void
) throws -> PDFOperationLifetimeLease {
  let processorOperation = try coordinator.beginOperation(
    owner: owner,
    taskId: taskId,
    prepare: prepare
  )
  do {
    try lifetime.begin(taskId: taskId)
  } catch {
    _ = processorOperation.finish(keepSession: false)
    throw error
  }
  return PDFOperationLifetimeLease(
    lifetime: lifetime,
    taskId: taskId,
    processorOperation: processorOperation
  )
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

private func isCanonicalPDFSHA256(_ value: String) -> Bool {
  value.count == 64 && value.unicodeScalars.allSatisfy {
    ($0.value >= 48 && $0.value <= 57) || ($0.value >= 97 && $0.value <= 102)
  }
}

private func pdfDurationMilliseconds(since started: ContinuousClock.Instant) -> Double {
  let duration = started.duration(to: .now)
  return Double(duration.components.seconds) * 1_000 +
    Double(duration.components.attoseconds) / 1_000_000_000_000_000
}
