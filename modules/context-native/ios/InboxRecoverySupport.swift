import Darwin
import Foundation

enum InboxRecoverySupportError: Error {
  case invalidState
}

enum RecoveryMetadataEventError: Error, Equatable {
  case invalidId
  case schemaInvalid
  case readFailed
  case writeFailed
  case acknowledgmentFailed

  var stableCode: String {
    switch self {
    case .invalidId: "METADATA_EVENT_ID_INVALID"
    case .schemaInvalid: "NATIVE_EVENT_SCHEMA_INVALID"
    case .readFailed: "NATIVE_EVENT_STORE_READ_FAILED"
    case .writeFailed: "NATIVE_EVENT_STORE_WRITE_FAILED"
    case .acknowledgmentFailed: "NATIVE_RECOVERY_ACK_FAILED"
    }
  }
}

enum RecoveryMetadataOperation {
  case write
  case list
  case read
  case quarantine
  case acknowledge
}

enum InboxRecoverySupport {
  static func recoverIncompleteTransactions(inbox: URL, staging: URL, container: URL) throws -> Bool {
    try recoverOrphanLocks(container: container)
    var recovered = try recoverCandidates(root: staging, container: container) { _ in true }
    recovered = try recoverCandidates(root: inbox, container: container) { child in
      !FileManager.default.fileExists(atPath: child.appendingPathComponent("manifest.json").path)
    } || recovered
    return recovered
  }

  static func recoverOrphanLocks(container: URL) throws {
    let directory = container.appendingPathComponent("InboxWriterLocks", isDirectory: true)
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: directory.path, isDirectory: &isDirectory) else { return }
    guard isDirectory.boolValue else { throw InboxRecoverySupportError.invalidState }
    try InboxWriterRegistry.withLock(container: container) { _ in
      let locks = try FileManager.default.contentsOfDirectory(
        at: directory,
        includingPropertiesForKeys: [.isRegularFileKey],
        options: [.skipsHiddenFiles]
      )
      for lockURL in locks {
        if lockURL.lastPathComponent == InboxWriterRegistry.fileName { continue }
        let values = try lockURL.resourceValues(forKeys: [.isRegularFileKey])
        let id = lockURL.deletingPathExtension().lastPathComponent
        guard values.isRegularFile == true,
              lockURL.pathExtension == "lock",
              UUID(uuidString: id) != nil else { throw InboxRecoverySupportError.invalidState }
        let staging = container.appendingPathComponent("InboxStaging/\(id)")
        let published = container.appendingPathComponent("Inbox/\(id)")
        let manifest = published.appendingPathComponent("manifest.json")
        if InboxWriterRegistry.isLocallyOwned(id) { continue }
        if FileManager.default.fileExists(atPath: staging.path) ||
            (FileManager.default.fileExists(atPath: published.path) &&
             !FileManager.default.fileExists(atPath: manifest.path)) { continue }
        let descriptor = Darwin.open(lockURL.path, O_RDWR)
        guard descriptor >= 0 else { throw InboxRecoverySupportError.invalidState }
        if Darwin.lockf(descriptor, F_TLOCK, 0) == 0 {
          try FileManager.default.removeItem(at: lockURL)
          Darwin.lockf(descriptor, F_ULOCK, 0)
          Darwin.close(descriptor)
        } else {
          let lockError = errno
          Darwin.close(descriptor)
          guard lockError == EWOULDBLOCK || lockError == EAGAIN else {
            throw InboxRecoverySupportError.invalidState
          }
        }
      }
    }
  }

  private static func recoverCandidates(
    root: URL,
    container: URL,
    isIncomplete: (URL) -> Bool
  ) throws -> Bool {
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: root.path, isDirectory: &isDirectory) else { return false }
    guard isDirectory.boolValue else { throw InboxRecoverySupportError.invalidState }
    let children = try FileManager.default.contentsOfDirectory(
      at: root,
      includingPropertiesForKeys: [.isDirectoryKey],
      options: [.skipsHiddenFiles]
    )
    var recovered = false
    for child in children {
      let values = try child.resourceValues(forKeys: [.isDirectoryKey])
      guard values.isDirectory == true,
            isIncomplete(child),
            let lock = try TransactionRecoveryLock.acquire(directory: child, container: container) else { continue }
      defer { lock.release() }
      try RecoveryMetadataEventStore.persistRecovery(container: container)
      try FileManager.default.removeItem(at: child)
      recovered = true
    }
    return recovered
  }
}

final class TransactionRecoveryLock {
  private var descriptor: Int32
  private let removableURL: URL?
  private let container: URL?
  private init(descriptor: Int32, removableURL: URL? = nil, container: URL? = nil) {
    self.descriptor = descriptor
    self.removableURL = removableURL
    self.container = container
  }

  static func acquire(directory: URL, container: URL) throws -> TransactionRecoveryLock? {
    try InboxWriterRegistry.withLock(container: container) { _ in
      let external = container.appendingPathComponent("InboxWriterLocks/\(directory.lastPathComponent).lock")
      let legacy = directory.appendingPathComponent(".writer.lock")
      if InboxWriterRegistry.isLocallyOwned(directory.lastPathComponent) { return nil }
      let lockURL = FileManager.default.fileExists(atPath: external.path) ? external : legacy
      guard FileManager.default.fileExists(atPath: lockURL.path) else {
        return TransactionRecoveryLock(descriptor: -1)
      }
      let descriptor = Darwin.open(lockURL.path, O_RDWR)
      guard descriptor >= 0 else { throw InboxRecoverySupportError.invalidState }
      guard Darwin.lockf(descriptor, F_TLOCK, 0) == 0 else {
        let lockError = errno
        Darwin.close(descriptor)
        if lockError == EWOULDBLOCK || lockError == EAGAIN { return nil }
        throw InboxRecoverySupportError.invalidState
      }
      return TransactionRecoveryLock(
        descriptor: descriptor,
        removableURL: lockURL == external ? external : nil,
        container: container
      )
    }
  }

  func release() {
    guard descriptor >= 0 else { return }
    let ownedDescriptor = descriptor
    descriptor = -1
    guard let removableURL, let container else {
      Darwin.lockf(ownedDescriptor, F_ULOCK, 0)
      Darwin.close(ownedDescriptor)
      return
    }
    do {
      try InboxWriterRegistry.withLock(container: container) { _ in
        try? FileManager.default.removeItem(at: removableURL)
        Darwin.lockf(ownedDescriptor, F_ULOCK, 0)
        Darwin.close(ownedDescriptor)
      }
    } catch {
      Darwin.lockf(ownedDescriptor, F_ULOCK, 0)
      Darwin.close(ownedDescriptor)
    }
  }

  deinit { release() }
}

enum RecoveryMetadataEventStore {
  typealias OperationHook = (RecoveryMetadataOperation) throws -> Void
  private static let canonicalEventIdPattern =
    #"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"#

  static func persistRecovery(
    container: URL,
    operationHook: OperationHook = { _ in }
  ) throws {
    let id = UUID().uuidString.lowercased()
    let event: [String: Any] = [
      "schemaVersion": 1,
      "id": id,
      "code": "INBOX_RECOVERY_REQUIRED",
      "createdAtMs": Int64(Date().timeIntervalSince1970 * 1_000)
    ]
    let directory = container.appendingPathComponent("RecoveryEvents", isDirectory: true)
    do {
      try operationHook(.write)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let data = try JSONSerialization.data(withJSONObject: event, options: [.sortedKeys])
      try data.write(to: directory.appendingPathComponent("\(id).json"), options: [.atomic])
    } catch {
      throw RecoveryMetadataEventError.writeFailed
    }
  }

  static func read(
    container: URL,
    folder: String,
    operationHook: OperationHook = { _ in }
  ) throws -> [[String: Any]] {
    let directory = container.appendingPathComponent(folder, isDirectory: true)
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: directory.path, isDirectory: &isDirectory) else { return [] }
    guard isDirectory.boolValue else { throw RecoveryMetadataEventError.readFailed }
    let files: [URL]
    do {
      try operationHook(.list)
      files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
    } catch {
      throw RecoveryMetadataEventError.readFailed
    }
    let events = try files.filter { $0.pathExtension == "json" }.map { url in
      let data: Data
      do {
        try operationHook(.read)
        data = try Data(contentsOf: url)
      } catch {
        throw RecoveryMetadataEventError.readFailed
      }
      do {
        guard let event = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              event["schemaVersion"] as? Int == 1,
              let id = event["id"] as? String,
              canonicalEventId(id),
              url.deletingPathExtension().lastPathComponent == id,
              event["code"] as? String == "INBOX_RECOVERY_REQUIRED",
              event["createdAtMs"] is NSNumber else {
          throw RecoveryMetadataEventError.schemaInvalid
        }
        return event
      } catch {
        let quarantined = url.deletingPathExtension().appendingPathExtension("invalid")
        do {
          try operationHook(.quarantine)
          if FileManager.default.fileExists(atPath: quarantined.path) {
            try FileManager.default.removeItem(at: quarantined)
          }
          try FileManager.default.moveItem(at: url, to: quarantined)
        } catch {
          throw RecoveryMetadataEventError.writeFailed
        }
        throw RecoveryMetadataEventError.schemaInvalid
      }
    }
    return events.sorted {
      ($0["createdAtMs"] as? NSNumber)?.int64Value ?? 0 <
        ($1["createdAtMs"] as? NSNumber)?.int64Value ?? 0
    }
  }

  static func ack(
    container: URL,
    folder: String,
    id: String,
    operationHook: OperationHook = { _ in }
  ) throws -> Bool {
    guard canonicalEventId(id) else { throw RecoveryMetadataEventError.invalidId }
    let url = container.appendingPathComponent(folder, isDirectory: true).appendingPathComponent("\(id).json")
    guard FileManager.default.fileExists(atPath: url.path) else { return true }
    do {
      try operationHook(.acknowledge)
      try FileManager.default.removeItem(at: url)
    } catch {
      throw RecoveryMetadataEventError.acknowledgmentFailed
    }
    return true
  }

  private static func canonicalEventId(_ value: String) -> Bool {
    guard value.range(of: canonicalEventIdPattern, options: .regularExpression) != nil,
          let uuid = UUID(uuidString: value) else { return false }
    return uuid.uuidString.lowercased() == value
  }
}
