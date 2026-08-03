import Foundation

enum InboxManifestValidationError: Error {
  case invalidManifest
}

enum InboxManifestValidator {
  static func read(inbox: URL) throws -> [[String: Any]] {
    let root = inbox.resolvingSymlinksInPath().standardizedFileURL
    let directories = try FileManager.default.contentsOfDirectory(
      at: root,
      includingPropertiesForKeys: [.isDirectoryKey],
      options: [.skipsHiddenFiles]
    )
    var ids = Set<String>()
    return try directories.compactMap { ingestion in
      let values = try ingestion.resourceValues(forKeys: [.isDirectoryKey])
      let id = ingestion.lastPathComponent
      guard values.isDirectory == true,
            ingestion.deletingLastPathComponent().resolvingSymlinksInPath().standardizedFileURL == root,
            canonicalUUID(id),
            ids.insert(id).inserted else {
        throw InboxManifestValidationError.invalidManifest
      }
      let children = try FileManager.default.contentsOfDirectory(
        at: ingestion,
        includingPropertiesForKeys: [.isDirectoryKey],
        options: [.skipsHiddenFiles]
      )
      guard try children.allSatisfy({ try $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory != true }) else {
        throw InboxManifestValidationError.invalidManifest
      }
      let manifestURL = ingestion.appendingPathComponent("manifest.json")
      guard FileManager.default.fileExists(atPath: manifestURL.path) else { return nil }
      let data = try Data(contentsOf: manifestURL)
      guard let manifest = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw InboxManifestValidationError.invalidManifest
      }
      try validate(manifest, ingestion: ingestion, id: id)
      return manifest
    }
  }

  private static func validate(_ manifest: [String: Any], ingestion: URL, id: String) throws {
    guard manifest["ingestionId"] as? String == id,
          let items = manifest["items"] as? [[String: Any]] else {
      throw InboxManifestValidationError.invalidManifest
    }
    let ownedDirectory = ingestion.resolvingSymlinksInPath().standardizedFileURL
    for item in items {
      guard let value = item["localUri"] as? String,
            let url = URL(string: value),
            url.isFileURL,
            url.host == nil,
            url.query == nil,
            url.fragment == nil,
            url.deletingLastPathComponent().resolvingSymlinksInPath().standardizedFileURL == ownedDirectory else {
        throw InboxManifestValidationError.invalidManifest
      }
      if item["status"] as? String == "copied" {
        guard let byteCount = item["byteCount"] as? NSNumber,
              FileManager.default.fileExists(atPath: url.path),
              let actualBytes = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize,
              actualBytes == byteCount.intValue else {
          throw InboxManifestValidationError.invalidManifest
        }
      }
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
}
