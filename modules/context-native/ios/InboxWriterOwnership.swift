import Darwin
import Foundation

enum InboxWriterOwnershipError: Error {
  case invalidIdentifier
  case registryUnavailable
  case ownershipUnavailable
}

enum InboxWriterRegistry {
  static let fileName = ".registry.lock"
  private static let localLock = NSRecursiveLock()
  private static var locallyOwnedIds = Set<String>()

  static func registerLocalOwnership(_ id: String) {
    localLock.lock()
    defer { localLock.unlock() }
    locallyOwnedIds.insert(id.lowercased())
  }

  static func unregisterLocalOwnership(_ id: String) {
    localLock.lock()
    defer { localLock.unlock() }
    locallyOwnedIds.remove(id.lowercased())
  }

  static func isLocallyOwned(_ id: String) -> Bool {
    localLock.lock()
    defer { localLock.unlock() }
    return locallyOwnedIds.contains(id.lowercased())
  }

  static func withLock<T>(container: URL, _ body: (URL) throws -> T) throws -> T {
    localLock.lock()
    defer { localLock.unlock() }
    let directory = container.appendingPathComponent("InboxWriterLocks", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let registry = directory.appendingPathComponent(fileName)
    let descriptor = Darwin.open(registry.path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
    guard descriptor >= 0 else { throw InboxWriterOwnershipError.registryUnavailable }
    guard Darwin.lockf(descriptor, F_LOCK, 0) == 0 else {
      Darwin.close(descriptor)
      throw InboxWriterOwnershipError.registryUnavailable
    }
    defer {
      Darwin.lockf(descriptor, F_ULOCK, 0)
      Darwin.close(descriptor)
    }
    return try body(directory)
  }
}

final class InboxWriterOwnership {
  private let container: URL
  private let lockURL: URL
  private var descriptor: Int32

  private init(container: URL, lockURL: URL, descriptor: Int32) {
    self.container = container
    self.lockURL = lockURL
    self.descriptor = descriptor
  }

  static func acquire(
    container: URL,
    ingestionId: String,
    publishedBeforeOwnership: () -> Void = {}
  ) throws -> InboxWriterOwnership {
    guard let identifier = UUID(uuidString: ingestionId),
          identifier.uuidString.lowercased() == ingestionId.lowercased() else {
      throw InboxWriterOwnershipError.invalidIdentifier
    }
    return try InboxWriterRegistry.withLock(container: container) { directory in
      let lockURL = directory.appendingPathComponent("\(ingestionId.lowercased()).lock")
      let descriptor = Darwin.open(
        lockURL.path,
        O_CREAT | O_EXCL | O_RDWR,
        S_IRUSR | S_IWUSR
      )
      guard descriptor >= 0 else { throw InboxWriterOwnershipError.ownershipUnavailable }
      do {
        publishedBeforeOwnership()
        guard Darwin.lockf(descriptor, F_TLOCK, 0) == 0 else {
          throw InboxWriterOwnershipError.ownershipUnavailable
        }
        InboxWriterRegistry.registerLocalOwnership(ingestionId)
        return InboxWriterOwnership(container: container, lockURL: lockURL, descriptor: descriptor)
      } catch {
        Darwin.close(descriptor)
        try? FileManager.default.removeItem(at: lockURL)
        throw error
      }
    }
  }

  func release() {
    guard descriptor >= 0 else { return }
    let ownedDescriptor = descriptor
    descriptor = -1
    do {
      try InboxWriterRegistry.withLock(container: container) { _ in
        InboxWriterRegistry.unregisterLocalOwnership(lockURL.deletingPathExtension().lastPathComponent)
        try? FileManager.default.removeItem(at: lockURL)
        Darwin.lockf(ownedDescriptor, F_ULOCK, 0)
        Darwin.close(ownedDescriptor)
      }
    } catch {
      InboxWriterRegistry.unregisterLocalOwnership(lockURL.deletingPathExtension().lastPathComponent)
      Darwin.lockf(ownedDescriptor, F_ULOCK, 0)
      Darwin.close(ownedDescriptor)
    }
  }

  deinit { release() }
}
