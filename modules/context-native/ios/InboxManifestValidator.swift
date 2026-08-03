import CoreFoundation
import CryptoKit
import Foundation

enum InboxManifestValidationError: Error, Equatable {
  case invalidManifest
  case unsupportedVersion
  case artifactIntegrityFailed

  var stableCode: String {
    switch self {
    case .invalidManifest: "SCHEMA_INVALID"
    case .unsupportedVersion: "SCHEMA_VERSION_UNSUPPORTED"
    case .artifactIntegrityFailed: "ARTIFACT_INTEGRITY_FAILED"
    }
  }
}

enum InboxManifestValidator {
  private static let manifestKeys: Set<String> = [
    "schemaVersion", "ingestionId", "createdAt", "source", "status", "items",
  ]
  private static let copiedItemKeys: Set<String> = [
    "id", "order", "mediaType", "status", "byteCount", "relativePath", "sha256",
  ]
  private static let failedItemKeys: Set<String> = [
    "id", "order", "mediaType", "status", "byteCount", "errorCode",
  ]
  private static let stableErrorCodes: Set<String> = [
    "DOMAIN_INVALID_TRANSITION",
    "SCHEMA_INVALID",
    "SCHEMA_VERSION_UNSUPPORTED",
    "ARTIFACT_INTEGRITY_FAILED",
    "IMPORT_PROVIDER_PERMISSION_EXPIRED",
    "IMPORT_TYPE_UNSUPPORTED",
    "IMPORT_COPY_FAILED",
    "IMPORT_PARTIAL_FAILURE",
    "PIPELINE_STAGE_FAILED",
    "PROCESSOR_OUTPUT_INVALID",
    "PIPELINE_RECOVERY_REQUIRED",
    "PRIVACY_REVIEW_REQUIRED",
    "PRIVACY_EXPORT_BLOCKED",
    "RESOURCE_LOW_DISK",
    "RESOURCE_MEMORY_PRESSURE",
    "STORAGE_WRITE_FAILED",
  ]

  static func read(inbox: URL) throws -> [[String: Any]] {
    let root = inbox.resolvingSymlinksInPath().standardizedFileURL
    let directories = try FileManager.default.contentsOfDirectory(
      at: root,
      includingPropertiesForKeys: [.isDirectoryKey],
      options: [.skipsHiddenFiles]
    )
    var ids = Set<String>()
    return try directories.compactMap { ingestion in
      let id = ingestion.lastPathComponent
      guard ids.insert(id).inserted else {
        throw InboxManifestValidationError.invalidManifest
      }
      return try readIngestion(root: root, ingestion: ingestion, id: id)
    }
  }

  static func readPublished(inbox: URL, ingestionId: String) throws -> [String: Any] {
    guard canonicalUUID(ingestionId) else {
      throw InboxManifestValidationError.invalidManifest
    }
    let root = inbox.resolvingSymlinksInPath().standardizedFileURL
    let ingestion = root.appendingPathComponent(ingestionId, isDirectory: true)
    guard let manifest = try readIngestion(
      root: root,
      ingestion: ingestion,
      id: ingestionId
    ) else {
      throw InboxManifestValidationError.invalidManifest
    }
    return manifest
  }

  private static func readIngestion(
    root: URL,
    ingestion: URL,
    id: String
  ) throws -> [String: Any]? {
    let values = try ingestion.resourceValues(forKeys: [.isDirectoryKey])
    guard values.isDirectory == true,
          ingestion.deletingLastPathComponent().resolvingSymlinksInPath().standardizedFileURL == root,
          canonicalUUID(id) else {
      throw InboxManifestValidationError.invalidManifest
    }
    let children = try FileManager.default.contentsOfDirectory(
      at: ingestion,
      includingPropertiesForKeys: [.isDirectoryKey],
      options: [.skipsHiddenFiles]
    )
    guard try children.allSatisfy({
      try $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory != true
    }) else {
      throw InboxManifestValidationError.invalidManifest
    }
    let manifestURL = ingestion.appendingPathComponent("manifest.json")
    guard FileManager.default.fileExists(atPath: manifestURL.path) else { return nil }
    let data = try Data(contentsOf: manifestURL)
    let decoded: Any
    do { decoded = try JSONSerialization.jsonObject(with: data) }
    catch { throw InboxManifestValidationError.invalidManifest }
    guard let manifest = decoded as? [String: Any] else {
      throw InboxManifestValidationError.invalidManifest
    }
    try validate(manifest, ingestion: ingestion, id: id)
    return manifest
  }

  private static func validate(_ manifest: [String: Any], ingestion: URL, id: String) throws {
    guard let schemaVersion = nonNegativeInteger(manifest["schemaVersion"]) else {
      throw InboxManifestValidationError.invalidManifest
    }
    guard schemaVersion == 1 else {
      throw InboxManifestValidationError.unsupportedVersion
    }
    guard Set(manifest.keys) == manifestKeys,
          manifest["ingestionId"] as? String == id,
          let createdAt = manifest["createdAt"] as? String,
          isoDateTime(createdAt),
          let source = manifest["source"] as? String,
          source == "ios-share-extension" || source == "android-share-intent",
          let status = manifest["status"] as? String,
          ["complete", "partial", "failed"].contains(status),
          let items = manifest["items"] as? [[String: Any]],
          !items.isEmpty else {
      throw InboxManifestValidationError.invalidManifest
    }

    let ownedDirectory = ingestion.resolvingSymlinksInPath().standardizedFileURL
    var itemIds = Set<String>()
    var copied = 0
    var failed = 0
    for (order, item) in items.enumerated() {
      guard let itemId = item["id"] as? String,
            canonicalUUID(itemId),
            itemIds.insert(itemId).inserted,
            nonNegativeInteger(item["order"]) == Int64(order),
            let mediaType = item["mediaType"] as? String,
            mediaType.range(of: "^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$", options: .regularExpression) != nil,
            let itemStatus = item["status"] as? String else {
        throw InboxManifestValidationError.invalidManifest
      }

      if itemStatus == "copied" {
        guard Set(item.keys).isSubset(of: copiedItemKeys),
              copiedItemKeys.subtracting(["sha256"]).isSubset(of: Set(item.keys)),
              let relativePath = item["relativePath"] as? String,
              relativePath == "\(itemId).bin",
              !relativePath.contains("/") && !relativePath.contains("\\"),
              let byteCount = nonNegativeInteger(item["byteCount"]),
              item["sha256"] == nil || validSHA256(item["sha256"]),
              item["localUri"] == nil,
              item["providerUri"] == nil else {
          throw InboxManifestValidationError.invalidManifest
        }
        let candidate = ingestion.appendingPathComponent(relativePath).standardizedFileURL
        guard FileManager.default.fileExists(atPath: candidate.path) else {
          throw InboxManifestValidationError.artifactIntegrityFailed
        }
        let file = candidate.resolvingSymlinksInPath().standardizedFileURL
        guard file.deletingLastPathComponent() == ownedDirectory else {
          throw InboxManifestValidationError.invalidManifest
        }
        guard let actualBytes = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize,
              Int64(actualBytes) == byteCount else {
          throw InboxManifestValidationError.artifactIntegrityFailed
        }
        if let expectedDigest = item["sha256"] as? String {
          let actualDigest: String
          do { actualDigest = try sha256(file) }
          catch { throw InboxManifestValidationError.artifactIntegrityFailed }
          guard actualDigest == expectedDigest else {
            throw InboxManifestValidationError.artifactIntegrityFailed
          }
        }
        copied += 1
      } else if itemStatus == "failed" {
        guard Set(item.keys) == failedItemKeys,
              nonNegativeInteger(item["byteCount"]) == 0,
              let errorCode = item["errorCode"] as? String,
              stableErrorCodes.contains(errorCode) else {
          throw InboxManifestValidationError.invalidManifest
        }
        failed += 1
      } else {
        throw InboxManifestValidationError.invalidManifest
      }
    }

    guard (status == "complete" && copied > 0 && failed == 0)
            || (status == "partial" && copied > 0 && failed > 0)
            || (status == "failed" && copied == 0 && failed > 0) else {
      throw InboxManifestValidationError.invalidManifest
    }
  }

  private static func canonicalUUID(_ value: String) -> Bool {
    guard let uuid = UUID(uuidString: value) else { return false }
    let range = value.range(
      of: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
      options: .regularExpression
    )
    return range != nil && uuid.uuidString.lowercased() == value
  }

  private static func isoDateTime(_ value: String) -> Bool {
    guard value.range(
      of: "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d{1,9})?Z$",
      options: .regularExpression
    ) != nil else { return false }
    let year = Int(value.prefix(4))!
    let monthStart = value.index(value.startIndex, offsetBy: 5)
    let monthEnd = value.index(monthStart, offsetBy: 2)
    let dayStart = value.index(value.startIndex, offsetBy: 8)
    let dayEnd = value.index(dayStart, offsetBy: 2)
    let month = Int(value[monthStart..<monthEnd])!
    let day = Int(value[dayStart..<dayEnd])!
    let maximumDay: Int
    switch month {
    case 2:
      maximumDay = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) ? 29 : 28
    case 4, 6, 9, 11:
      maximumDay = 30
    default:
      maximumDay = 31
    }
    return day <= maximumDay
  }

  private static func validSHA256(_ value: Any?) -> Bool {
    guard let value = value as? String else { return false }
    return value.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
  }

  private static func sha256(_ file: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: file)
    defer { try? handle.close() }
    var hasher = SHA256()
    while let data = try handle.read(upToCount: 64 * 1024), !data.isEmpty {
      hasher.update(data: data)
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
  }

  private static func nonNegativeInteger(_ value: Any?) -> Int64? {
    guard let value = value as? NSNumber,
          CFGetTypeID(value) != CFBooleanGetTypeID(),
          value.doubleValue.isFinite,
          value.doubleValue >= 0,
          value.doubleValue.rounded() == value.doubleValue,
          value.doubleValue <= Double(9_007_199_254_740_991) else {
      return nil
    }
    return value.int64Value
  }
}
