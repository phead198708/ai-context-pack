import UIKit
import UniformTypeIdentifiers

private let appGroupIdentifier = "group.com.example.aicontextpack"
private let maximumImageBytes = 52_428_800

final class ShareViewController: UIViewController {
  private let statusLabel = UILabel()

  override func viewDidLoad() {
    super.viewDidLoad()
    statusLabel.text = "Importing image…"
    statusLabel.textAlignment = .center
    statusLabel.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(statusLabel)
    NSLayoutConstraint.activate([statusLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24), statusLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24), statusLabel.centerYAnchor.constraint(equalTo: view.centerYAnchor)])
    receiveSingleImage()
  }

  private func receiveSingleImage() {
    guard let provider = extensionContext?.inputItems.compactMap({ $0 as? NSExtensionItem }).flatMap({ $0.attachments ?? [] }).first(where: { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }),
          let selectedTypeIdentifier = provider.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .image) == true }) else {
      finish(message: "No supported image", error: true); return
    }
    guard let mediaType = UTType(selectedTypeIdentifier)?.preferredMIMEType else {
      finish(message: "Unsupported image type", error: true); return
    }
    provider.loadFileRepresentation(forTypeIdentifier: selectedTypeIdentifier) { [weak self] source, _ in
      guard let self, let source else { self?.finish(message: "Import failed", error: true); return }
      do { try self.copyAndWriteManifest(source: source, mediaType: mediaType); self.finish(message: "Image saved", error: false) }
      catch { self.finish(message: "Import failed", error: true) }
    }
  }

  private func copyAndWriteManifest(source: URL, mediaType: String) throws {
    guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier) else { throw ShareError.appGroupUnavailable }
    let ingestionId = UUID().uuidString.lowercased(), itemId = UUID().uuidString.lowercased()
    let directory = container.appendingPathComponent("InboxStaging/\(ingestionId)", isDirectory: true)
    let publishedDirectory = container.appendingPathComponent("Inbox/\(ingestionId)", isDirectory: true)
    let writerLock = try InboxWriterOwnership.acquire(container: container, ingestionId: ingestionId)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    var committed = false
    defer {
      if !committed { try? FileManager.default.removeItem(at: directory) }
    }
    let partial = directory.appendingPathComponent("\(itemId).partial"), destination = directory.appendingPathComponent("\(itemId).bin")
    try copyBounded(from: source, to: partial, limit: maximumImageBytes)
    try FileManager.default.moveItem(at: partial, to: destination)
    let bytes = (try destination.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
    let publishedDestination = publishedDirectory.appendingPathComponent(destination.lastPathComponent)
    let timestamp = ISO8601DateFormatter()
    timestamp.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let manifest: [String: Any] = ["schemaVersion": 1, "ingestionId": ingestionId, "createdAt": timestamp.string(from: Date()), "source": "ios-share-extension", "status": "complete", "items": [["id": itemId, "mediaType": mediaType, "byteCount": bytes, "localUri": publishedDestination.absoluteString, "status": "copied"]]]
    let data = try JSONSerialization.data(withJSONObject: manifest, options: [.sortedKeys])
    let manifestPartial = directory.appendingPathComponent("manifest.partial"), manifestURL = directory.appendingPathComponent("manifest.json")
    try data.write(to: manifestPartial, options: .atomic)
    try FileManager.default.moveItem(at: manifestPartial, to: manifestURL)
    try FileManager.default.createDirectory(at: publishedDirectory.deletingLastPathComponent(), withIntermediateDirectories: true)
    try FileManager.default.moveItem(at: directory, to: publishedDirectory)
    committed = true
    writerLock.release()
  }

  private func copyBounded(from source: URL, to destination: URL, limit: Int) throws {
    if let size = try? source.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > limit {
      throw ShareError.imageTooLarge
    }
    guard FileManager.default.createFile(atPath: destination.path, contents: nil) else { throw ShareError.copyFailed }
    let input = try FileHandle(forReadingFrom: source)
    let output: FileHandle
    do { output = try FileHandle(forWritingTo: destination) }
    catch { try? input.close(); throw ShareError.copyFailed }
    defer {
      try? input.close()
      try? output.close()
    }
    var total = 0
    while let data = try input.read(upToCount: 64 * 1024), !data.isEmpty {
      total += data.count
      guard total <= limit else { throw ShareError.imageTooLarge }
      try output.write(contentsOf: data)
    }
  }

  private func finish(message: String, error: Bool) {
    DispatchQueue.main.async { self.statusLabel.text = message; DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { error ? self.extensionContext?.cancelRequest(withError: ShareError.importFailed) : self.extensionContext?.completeRequest(returningItems: nil) } }
  }
}

private enum ShareError: Error { case appGroupUnavailable, copyFailed, imageTooLarge, importFailed, writerLockUnavailable }
