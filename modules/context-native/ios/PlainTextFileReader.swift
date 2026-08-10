import Foundation

enum PlainTextFileReaderError: Error, Equatable {
  case invalidLocalFile
  case invalidUTF8
  case tooLarge
  case resourceBusy
  case resultInvalid

  var stableCode: String {
    switch self {
    case .invalidLocalFile: return "INVALID_LOCAL_FILE_URI"
    case .invalidUTF8: return "TEXT_INVALID_UTF8"
    case .tooLarge: return "TEXT_TOO_LARGE"
    case .resourceBusy: return "TEXT_RESOURCE_BUSY"
    case .resultInvalid: return "TEXT_RESULT_INVALID"
    }
  }
}

final class PlainTextReadCoordinator: @unchecked Sendable {
  typealias ReadOperation = () throws -> [String: Any]
  typealias Completion = (Result<[String: Any], Error>) -> Void

  static let defaultMaximumOutstanding = 3

  private let lock = NSLock()
  private let queue: DispatchQueue
  private let maximumOutstanding: Int
  private var outstanding = 0

  init(
    maximumOutstanding: Int = defaultMaximumOutstanding,
    queue: DispatchQueue = DispatchQueue(
      label: "com.example.aicontextpack.plain-text",
      qos: .userInitiated
    )
  ) {
    precondition(maximumOutstanding > 0)
    self.maximumOutstanding = maximumOutstanding
    self.queue = queue
  }

  func read(fileURL: URL) async throws -> [String: Any] {
    try await withCheckedThrowingContinuation { continuation in
      do {
        try submit(
          operation: { try PlainTextFileReader.read(fileURL: fileURL) },
          completion: { continuation.resume(with: $0) }
        )
      } catch {
        continuation.resume(throwing: error)
      }
    }
  }

  func submit(
    operation: @escaping ReadOperation,
    completion: @escaping Completion
  ) throws {
    try reserve()
    queue.async { [self] in
      let result: Result<[String: Any], Error>
      do {
        result = .success(try operation())
      } catch {
        result = .failure(error)
      }
      release()
      completion(result)
    }
  }

  private func reserve() throws {
    lock.lock()
    defer { lock.unlock() }
    guard outstanding < maximumOutstanding else {
      throw PlainTextFileReaderError.resourceBusy
    }
    outstanding += 1
  }

  private func release() {
    lock.lock()
    precondition(outstanding > 0)
    outstanding -= 1
    lock.unlock()
  }
}

enum PlainTextFileReader {
  static let maximumBytes = 1_048_576

  static func read(fileURL: URL) throws -> [String: Any] {
    guard fileURL.isFileURL else { throw PlainTextFileReaderError.invalidLocalFile }
    let values: URLResourceValues
    do {
      values = try fileURL.resourceValues(
        forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]
      )
    } catch {
      throw PlainTextFileReaderError.invalidLocalFile
    }
    guard values.isRegularFile == true, values.isSymbolicLink != true,
          let size = values.fileSize, size >= 0 else {
      throw PlainTextFileReaderError.invalidLocalFile
    }
    guard size <= maximumBytes else { throw PlainTextFileReaderError.tooLarge }
    let handle: FileHandle
    do { handle = try FileHandle(forReadingFrom: fileURL) }
    catch { throw PlainTextFileReaderError.invalidLocalFile }
    defer { try? handle.close() }
    var data = Data()
    data.reserveCapacity(min(size, maximumBytes))
    do {
      while true {
        let remaining = maximumBytes - data.count
        guard remaining >= 0 else { throw PlainTextFileReaderError.tooLarge }
        guard let chunk = try handle.read(upToCount: min(16 * 1_024, remaining + 1)),
              !chunk.isEmpty else { break }
        guard chunk.count <= remaining else { throw PlainTextFileReaderError.tooLarge }
        data.append(chunk)
      }
    } catch let error as PlainTextFileReaderError {
      throw error
    } catch {
      throw PlainTextFileReaderError.invalidLocalFile
    }
    guard data.count == size else { throw PlainTextFileReaderError.resultInvalid }
    guard let text = String(data: data, encoding: .utf8) else {
      throw PlainTextFileReaderError.invalidUTF8
    }
    return [
      "schemaVersion": 1,
      "text": text,
      "byteCount": data.count,
      "encoding": "utf-8",
      "revision": "1",
    ]
  }
}
