import Foundation

enum PlainTextFileReaderError: Error, Equatable {
  case invalidLocalFile
  case invalidUTF8
  case tooLarge
  case resultInvalid

  var stableCode: String {
    switch self {
    case .invalidLocalFile: return "INVALID_LOCAL_FILE_URI"
    case .invalidUTF8: return "TEXT_INVALID_UTF8"
    case .tooLarge: return "TEXT_TOO_LARGE"
    case .resultInvalid: return "TEXT_RESULT_INVALID"
    }
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
