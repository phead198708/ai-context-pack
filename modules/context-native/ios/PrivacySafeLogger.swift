import Foundation
#if canImport(OSLog)
import OSLog
#endif

enum PrivacySafeLogError: Error, Equatable {
  case unsafeEvent
  case unsafeField
  case unsafeValue

  var stableCode: String {
    switch self {
    case .unsafeEvent: "UNSAFE_LOG_EVENT"
    case .unsafeField: "UNSAFE_LOG_FIELD"
    case .unsafeValue: "UNSAFE_LOG_VALUE"
    }
  }
}

enum PrivacySafeLogValue: Equatable {
  case string(String)
  case integer(Int64)
  case decimal(Double)
}

struct PrivacySafeLogger {
  typealias Sink = (String) -> Void

  private static let allowedEvents: Set<String> = [
    "inbox_scan",
    "import_completed",
    "import_failed",
    "ocr_completed",
    "pdf_probe_completed",
  ]
  private static let allowedCodes: Set<String> = [
    "INBOX_SCAN_FAILED",
    "NATIVE_ADAPTER_UNAVAILABLE",
    "NATIVE_MANIFEST_INVALID",
    "NATIVE_OCR_RESULT_INVALID",
    "NATIVE_PDF_RESULT_INVALID",
    "OCR_IMAGE_DECODE_FAILED",
    "OCR_RECOGNITION_FAILED",
    "SHARE_COPY_FAILED",
    "SHARE_IMPORT_FAILED",
    "SHARE_IMPORT_EVENT_INVALID",
  ]
  private static let allowedEngines: Set<String> = [
    "apple-vision",
    "ml-kit-latin",
    "ml-kit-chinese",
    "pdfkit",
    "pdf-renderer",
  ]
  private static let allowedKeys: Set<String> = [
    "code",
    "count",
    "bytes",
    "durationMs",
    "version",
    "engine",
    "anonymousId",
  ]
  private static let versionPattern = try! NSRegularExpression(
    pattern: #"^[0-9]+(?:\.[0-9]+){0,3}$"#
  )
  private static let anonymousIdPattern = try! NSRegularExpression(
    pattern: #"^(?:[0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$"#
  )

  private let sink: Sink

  init(sink: @escaping Sink = PrivacySafeLogger.systemSink) {
    self.sink = sink
  }

  func log(event: String, fields: [String: PrivacySafeLogValue] = [:]) throws {
    sink(try Self.serialize(event: event, fields: fields))
  }

  static func serialize(
    event: String,
    fields: [String: PrivacySafeLogValue] = [:]
  ) throws -> String {
    guard allowedEvents.contains(event) else { throw PrivacySafeLogError.unsafeEvent }
    guard Set(fields.keys).isSubset(of: allowedKeys) else {
      throw PrivacySafeLogError.unsafeField
    }

    var record: [String: Any] = ["event": event]
    for (key, value) in fields {
      switch (key, value) {
      case ("code", .string(let string)) where allowedCodes.contains(string):
        record[key] = string
      case ("engine", .string(let string)) where allowedEngines.contains(string):
        record[key] = string
      case ("version", .string(let string)) where
        string.utf8.count <= 32 && matches(versionPattern, value: string):
        record[key] = string
      case ("anonymousId", .string(let string)) where
        matches(anonymousIdPattern, value: string):
        record[key] = string
      case ("count", .integer(let number)) where number >= 0:
        record[key] = number
      case ("bytes", .integer(let number)) where number >= 0:
        record[key] = number
      case ("durationMs", .integer(let number)) where number >= 0:
        record[key] = number
      case ("durationMs", .decimal(let number)) where number.isFinite && number >= 0:
        record[key] = number
      default:
        throw PrivacySafeLogError.unsafeValue
      }
    }

    guard JSONSerialization.isValidJSONObject(record),
          let serialized = String(
            data: try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]),
            encoding: .utf8
          ) else {
      throw PrivacySafeLogError.unsafeValue
    }
    return serialized
  }

  private static func matches(_ expression: NSRegularExpression, value: String) -> Bool {
    let range = NSRange(value.startIndex..<value.endIndex, in: value)
    return expression.firstMatch(in: value, range: range)?.range == range
  }

  private static func systemSink(_ serialized: String) {
    #if canImport(OSLog)
    privacySafeOSLogger.info("\(serialized, privacy: .public)")
    #endif
  }
}

#if canImport(OSLog)
private let privacySafeOSLogger = Logger(
  subsystem: "com.aicontextpack",
  category: "privacy-safe"
)
#endif
