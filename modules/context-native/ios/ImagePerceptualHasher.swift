import CoreGraphics
import CryptoKit
import Darwin
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

  var isCancelled: Bool {
    lock.lock()
    defer { lock.unlock() }
    return cancelled
  }
}

final class ImageHashTaskRegistry: @unchecked Sendable {
  private final class Entry {
    let ownerId: String
    let token: ImageHashCancellationToken
    var cancelTask: (@Sendable () -> Void)?
    var awaitCompletion: (@Sendable () -> Bool)?

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

  func attach(
    ownerId: String,
    taskId: String,
    token: ImageHashCancellationToken,
    cancel: @escaping @Sendable () -> Void,
    awaitCompletion: @escaping @Sendable () -> Bool
  ) {
    lock.lock()
    let entry = entries[taskId]
    guard entry?.ownerId == ownerId, entry?.token === token else {
      lock.unlock()
      cancel()
      _ = awaitCompletion()
      return
    }
    entry?.cancelTask = cancel
    entry?.awaitCompletion = awaitCompletion
    let alreadyCancelled = entry?.token.isCancelled == true
    lock.unlock()
    if alreadyCancelled {
      cancel()
      _ = awaitCompletion()
    }
  }

  func cancel(ownerId: String, taskId: String) -> Bool {
    lock.lock()
    let entry = entries[taskId]
    guard entry?.ownerId == ownerId else {
      lock.unlock()
      return false
    }
    entry?.token.cancel()
    let cancelTask = entry?.cancelTask
    let awaitCompletion = entry?.awaitCompletion
    lock.unlock()
    cancelTask?()
    return awaitCompletion?() ?? true
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
    let ownedIds = entries.compactMap { $0.value.ownerId == ownerId ? $0.key : nil }
    let owned = ownedIds.compactMap { entries.removeValue(forKey: $0) }
    for entry in owned { entry.token.cancel() }
    let cancellations = owned.compactMap(\.cancelTask)
    let waits = owned.compactMap(\.awaitCompletion)
    lock.unlock()
    cancellations.forEach { $0() }
    waits.forEach { _ = $0() }
  }
}

final class ImageHashScheduledWork: @unchecked Sendable {
  private let operation: Operation
  private let completion: DispatchGroup
  private let token: ImageHashCancellationToken

  init(operation: Operation, completion: DispatchGroup, token: ImageHashCancellationToken) {
    self.operation = operation
    self.completion = completion
    self.token = token
  }

  func cancel() {
    token.cancel()
    operation.cancel()
  }

  func cancelAndWait() -> Bool {
    cancel()
    return completion.wait(timeout: .now() + .seconds(2)) == .success
  }
}

final class ImageHashScheduler: @unchecked Sendable {
  static let maximumScheduledWork = 3

  private final class Delivery: @unchecked Sendable {
    private let lock = NSLock()
    private var delivered = false

    func deliver(
      _ result: Result<[String: Any], Error>,
      to completion: @escaping @Sendable (Result<[String: Any], Error>) -> Void
    ) {
      lock.lock()
      guard !delivered else {
        lock.unlock()
        return
      }
      delivered = true
      lock.unlock()
      completion(result)
    }
  }

  private let lock = NSLock()
  private let queue: OperationQueue = {
    let value = OperationQueue()
    value.name = "ai-context-pack-image-hash"
    value.qualityOfService = .utility
    value.maxConcurrentOperationCount = 1
    return value
  }()
  private var scheduledCount = 0

  func submit(
    token: ImageHashCancellationToken,
    work: @escaping @Sendable () throws -> [String: Any],
    completion: @escaping @Sendable (Result<[String: Any], Error>) -> Void
  ) -> ImageHashScheduledWork? {
    lock.lock()
    guard scheduledCount < Self.maximumScheduledWork else {
      lock.unlock()
      return nil
    }
    scheduledCount += 1
    lock.unlock()

    let delivery = Delivery()
    let group = DispatchGroup()
    group.enter()
    let operation = BlockOperation()
    operation.addExecutionBlock { [weak operation] in
      guard operation?.isCancelled != true else {
        delivery.deliver(.failure(ImagePerceptualHashError.cancelled), to: completion)
        return
      }
      do {
        delivery.deliver(.success(try work()), to: completion)
      } catch {
        delivery.deliver(.failure(error), to: completion)
      }
    }
    operation.completionBlock = { [weak self, weak operation] in
      if operation?.isCancelled == true {
        delivery.deliver(.failure(ImagePerceptualHashError.cancelled), to: completion)
      }
      self?.lock.lock()
      self?.scheduledCount -= 1
      self?.lock.unlock()
      group.leave()
    }
    let scheduled = ImageHashScheduledWork(
      operation: operation,
      completion: group,
      token: token
    )
    queue.addOperation(operation)
    return scheduled
  }

  var scheduledWorkCount: Int {
    lock.lock()
    defer { lock.unlock() }
    return scheduledCount
  }
}

enum ImageHashSnapshotStore {
  static let directoryName = "ImageHashSnapshots"
  static let currentProcessPrefix =
    "snapshot-\(UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: ""))-"

  static func prepare(fileManager: FileManager = .default) throws -> URL {
    let directory = fileManager.temporaryDirectory.appendingPathComponent(
      directoryName,
      isDirectory: true
    )
    try fileManager.createDirectory(
      at: directory,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )
    let values = try directory.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
    guard values.isDirectory == true, values.isSymbolicLink != true else {
      throw ImagePerceptualHashError.resourceLimit
    }
    try fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
    return directory
  }

  static func runStartupMaintenance(
    fileManager: FileManager = .default
  ) {
    guard let directory = try? prepare(fileManager: fileManager) else { return }
    _ = try? purgeInherited(
      in: directory,
      fileManager: fileManager
    )
  }

  @discardableResult
  static func purgeInherited(
    in directory: URL,
    preservingPrefix: String = currentProcessPrefix,
    fileManager: FileManager = .default
  ) throws -> Int {
    let candidates = try fileManager.contentsOfDirectory(
      at: directory,
      includingPropertiesForKeys: [
        .isRegularFileKey,
        .isSymbolicLinkKey,
      ],
      options: [.skipsHiddenFiles]
    )
    var removed = 0
    for candidate in candidates {
      guard candidate.lastPathComponent.hasPrefix("snapshot-"),
            candidate.pathExtension == "tmp",
            !candidate.lastPathComponent.hasPrefix(preservingPrefix) else { continue }
      let values = try candidate.resourceValues(forKeys: [
        .isRegularFileKey,
        .isSymbolicLinkKey,
      ])
      guard values.isRegularFile == true, values.isSymbolicLink != true else { continue }
      try fileManager.removeItem(at: candidate)
      removed += 1
    }
    return removed
  }

  static func createURL(fileManager: FileManager = .default) throws -> URL {
    try prepare(fileManager: fileManager).appendingPathComponent(
      "\(currentProcessPrefix)\(UUID().uuidString.lowercased()).tmp"
    )
  }
}

final class ImmutableImageSnapshot {
  let url: URL
  private let removeItem: (URL) throws -> Void
  private var closed = false

  init(
    url: URL,
    removeItem: @escaping (URL) throws -> Void = { try FileManager.default.removeItem(at: $0) }
  ) {
    self.url = url
    self.removeItem = removeItem
  }

  deinit {
    if !closed { try? removeItem(url) }
  }

  func close() throws {
    guard !closed else { return }
    do {
      try removeItem(url)
      closed = true
    } catch {
      let cocoaError = error as NSError
      if cocoaError.domain == NSCocoaErrorDomain && cocoaError.code == NSFileNoSuchFileError {
        closed = true
        return
      }
      throw ImagePerceptualHashError.resourceLimit
    }
  }

  func withURL<ResultValue>(_ body: (URL) throws -> ResultValue) throws -> ResultValue {
    let result: Result<ResultValue, Error>
    do {
      result = .success(try body(url))
    } catch {
      result = .failure(error)
    }
    // A cleanup error wins over a processing error so private snapshot retention
    // cannot be hidden behind the original failure.
    try close()
    return try result.get()
  }

  static func create(
    sourceURL: URL,
    expectedByteCount: Int64,
    expectedSHA256: String,
    cancellation: ImageHashCancellationToken,
    removeItem: @escaping (URL) throws -> Void = { try FileManager.default.removeItem(at: $0) }
  ) throws -> ImmutableImageSnapshot {
    guard expectedByteCount > 0,
          expectedByteCount <= ImagePerceptualHasher.maximumSourceBytes,
          expectedSHA256.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else {
      throw ImagePerceptualHashError.integrityFailure
    }
    let source = Darwin.open(sourceURL.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
    guard source >= 0 else { throw ImagePerceptualHashError.integrityFailure }
    defer { Darwin.close(source) }
    var metadata = stat()
    guard fstat(source, &metadata) == 0,
          metadata.st_mode & S_IFMT == S_IFREG,
          metadata.st_size == expectedByteCount else {
      throw ImagePerceptualHashError.integrityFailure
    }

    let snapshotURL: URL
    do {
      snapshotURL = try ImageHashSnapshotStore.createURL()
    } catch {
      throw ImagePerceptualHashError.resourceLimit
    }
    let destination = Darwin.open(
      snapshotURL.path,
      O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
      S_IRUSR | S_IWUSR
    )
    guard destination >= 0 else { throw ImagePerceptualHashError.resourceLimit }
    do {
      var digest = SHA256()
      var copied: Int64 = 0
      var buffer = [UInt8](repeating: 0, count: 64 * 1_024)
      while true {
        try cancellation.check()
        let count = buffer.withUnsafeMutableBytes { bytes in
          Darwin.read(source, bytes.baseAddress, bytes.count)
        }
        guard count >= 0 else { throw ImagePerceptualHashError.integrityFailure }
        if count == 0 { break }
        copied += Int64(count)
        guard copied <= expectedByteCount else {
          throw ImagePerceptualHashError.integrityFailure
        }
        digest.update(data: Data(buffer[0..<count]))
        var written = 0
        while written < count {
          let amount = buffer.withUnsafeBytes { bytes in
            Darwin.write(destination, bytes.baseAddress!.advanced(by: written), count - written)
          }
          guard amount > 0 else { throw ImagePerceptualHashError.resourceLimit }
          written += amount
        }
      }
      let actualSHA256 = digest.finalize().map { String(format: "%02x", $0) }.joined()
      guard copied == expectedByteCount, actualSHA256 == expectedSHA256,
            fchmod(destination, S_IRUSR) == 0 else {
        throw ImagePerceptualHashError.integrityFailure
      }
      Darwin.close(destination)
      return ImmutableImageSnapshot(url: snapshotURL, removeItem: removeItem)
    } catch {
      let operationError = error
      Darwin.close(destination)
      do {
        try removeItem(snapshotURL)
      } catch {
        throw ImagePerceptualHashError.resourceLimit
      }
      throw operationError
    }
  }
}

private final class CancellableImageDataProviderContext: @unchecked Sendable {
  let descriptor: Int32
  let byteCount: Int64
  let cancellation: ImageHashCancellationToken
  let readHook: ((off_t) -> Void)?

  init(
    descriptor: Int32,
    byteCount: Int64,
    cancellation: ImageHashCancellationToken,
    readHook: ((off_t) -> Void)?
  ) {
    self.descriptor = descriptor
    self.byteCount = byteCount
    self.cancellation = cancellation
    self.readHook = readHook
  }

  deinit { Darwin.close(descriptor) }
}

private let imageProviderGetBytes: CGDataProviderGetBytesAtPositionCallback = {
  info, buffer, position, requestedCount in
  guard let info, position >= 0 else { return 0 }
  let context = Unmanaged<CancellableImageDataProviderContext>
    .fromOpaque(info).takeUnretainedValue()
  guard !context.cancellation.isCancelled else { return 0 }
  context.readHook?(position)
  guard !context.cancellation.isCancelled,
        Int64(position) < context.byteCount else { return 0 }
  let remaining = context.byteCount - Int64(position)
  let boundedCount = min(requestedCount, 64 * 1_024, Int(remaining))
  guard boundedCount > 0 else { return 0 }
  let count = Darwin.pread(
    context.descriptor,
    buffer,
    boundedCount,
    position
  )
  return count > 0 ? count : 0
}

private let imageProviderRelease: CGDataProviderReleaseInfoCallback = { info in
  guard let info else { return }
  Unmanaged<CancellableImageDataProviderContext>.fromOpaque(info).release()
}

enum CancellableImageDataProvider {
  static func create(
    url: URL,
    byteCount: Int64,
    cancellation: ImageHashCancellationToken,
    readHook: ((off_t) -> Void)? = nil
  ) throws -> CGDataProvider {
    let descriptor = Darwin.open(url.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
    guard descriptor >= 0 else { throw ImagePerceptualHashError.integrityFailure }
    var metadata = stat()
    guard fstat(descriptor, &metadata) == 0,
          metadata.st_mode & S_IFMT == S_IFREG,
          metadata.st_size == byteCount else {
      Darwin.close(descriptor)
      throw ImagePerceptualHashError.integrityFailure
    }
    let context = CancellableImageDataProviderContext(
      descriptor: descriptor,
      byteCount: byteCount,
      cancellation: cancellation,
      readHook: readHook
    )
    let info = Unmanaged.passRetained(context).toOpaque()
    var callbacks = CGDataProviderDirectCallbacks(
      version: 0,
      getBytePointer: nil,
      releaseBytePointer: nil,
      getBytesAtPosition: imageProviderGetBytes,
      releaseInfo: imageProviderRelease
    )
    guard let provider = CGDataProvider(
      directInfo: info,
      size: off_t(byteCount),
      callbacks: &callbacks
    ) else {
      Unmanaged<CancellableImageDataProviderContext>.fromOpaque(info).release()
      throw ImagePerceptualHashError.resourceLimit
    }
    return provider
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
    cancellation: ImageHashCancellationToken,
    sourceMutationHook: ((String) throws -> Void)? = nil,
    providerReadHook: ((off_t) -> Void)? = nil,
    snapshotRemoveItem: @escaping (URL) throws -> Void = {
      try FileManager.default.removeItem(at: $0)
    }
  ) throws -> [String: Any] {
    let started = ContinuousClock.now
    try cancellation.check()
    let snapshot = try ImmutableImageSnapshot.create(
      sourceURL: fileURL,
      expectedByteCount: expectedByteCount,
      expectedSHA256: expectedSHA256,
      cancellation: cancellation,
      removeItem: snapshotRemoveItem
    )
    return try snapshot.withURL { snapshotURL in
      try sourceMutationHook?("snapshot-ready")
      let provider = try CancellableImageDataProvider.create(
        url: snapshotURL,
        byteCount: expectedByteCount,
        cancellation: cancellation,
        readHook: providerReadHook
      )
      guard let source = CGImageSourceCreateWithDataProvider(provider, nil) else {
        try cancellation.check()
        throw ImagePerceptualHashError.invalidImage
      }
      guard acceptsFrameCount(CGImageSourceGetCount(source)) else {
        try cancellation.check()
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
        try cancellation.check()
        throw ImagePerceptualHashError.invalidImage
      }
      try cancellation.check()
      let luminance = try sampleLuminance(image: image, cancellation: cancellation)
      try sourceMutationHook?("decode-complete")
      try cancellation.check()
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
    image: CGImage,
    cancellation: ImageHashCancellationToken
  ) throws -> [UInt8] {
    let width = image.width
    let height = image.height
    guard width > 0, height > 0 else { throw ImagePerceptualHashError.invalidImage }
    let bytesPerRow = width * 4
    var rowBytes = [UInt8](repeating: 0, count: bytesPerRow)
    var totals = [UInt64](repeating: 0, count: sampleWidth * sampleHeight)
    var counts = [UInt64](repeating: 0, count: sampleWidth * sampleHeight)
    try rowBytes.withUnsafeMutableBytes { buffer in
      guard let context = CGContext(
        data: buffer.baseAddress,
        width: width,
        height: 1,
        bitsPerComponent: 8,
        bytesPerRow: bytesPerRow,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue
          | CGImageAlphaInfo.premultipliedLast.rawValue
      ) else { throw ImagePerceptualHashError.resourceLimit }
      let pixels = buffer.bindMemory(to: UInt8.self)
      context.interpolationQuality = .none
      for y in 0..<height {
        try cancellation.check()
        guard let rowImage = image.cropping(
          to: CGRect(x: 0, y: y, width: width, height: 1)
        ) else { throw ImagePerceptualHashError.invalidImage }
        context.interpolationQuality = .none
        context.setFillColor(gray: 1, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: width, height: 1))
        context.draw(rowImage, in: CGRect(x: 0, y: 0, width: width, height: 1))
        for x in 0..<width {
          let offset = x * 4
          let luminance = UInt64(
            (299 * Int(pixels[offset])
              + 587 * Int(pixels[offset + 1])
              + 114 * Int(pixels[offset + 2])) / 1_000
          )
          for row in matchingBuckets(coordinate: y, length: height, count: sampleHeight) {
            for column in matchingBuckets(coordinate: x, length: width, count: sampleWidth) {
              let index = row * sampleWidth + column
              totals[index] += luminance
              counts[index] += 1
            }
          }
        }
      }
    }
    return totals.indices.map { index in
      precondition(counts[index] > 0)
      return UInt8(totals[index] / counts[index])
    }
  }

  private static func matchingBuckets(coordinate: Int, length: Int, count: Int) -> ClosedRange<Int> {
    if length >= count {
      let bucket = min(count - 1, Int(((Int64(coordinate) + 1) * Int64(count) - 1) / Int64(length)))
      return bucket...bucket
    }
    var first = count
    var last = -1
    for bucket in 0..<count {
      let start = bucket * length / count
      let end = min(length, max(start + 1, (bucket + 1) * length / count))
      if coordinate >= start && coordinate < end {
        first = min(first, bucket)
        last = max(last, bucket)
      }
    }
    precondition(first <= last)
    return first...last
  }

  private static func durationMilliseconds(since start: ContinuousClock.Instant) -> Double {
    let duration = start.duration(to: .now)
    return Double(duration.components.seconds) * 1_000
      + Double(duration.components.attoseconds) / 1_000_000_000_000_000
  }

}
