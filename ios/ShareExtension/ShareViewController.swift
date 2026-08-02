import UIKit
import UniformTypeIdentifiers

private let appGroupIdentifier = "group.com.example.aicontextpack"

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
    guard let provider = extensionContext?.inputItems.compactMap({ $0 as? NSExtensionItem }).flatMap({ $0.attachments ?? [] }).first(where: { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }) else {
      finish(message: "No supported image", error: true); return
    }
    provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { [weak self] source, _ in
      guard let self, let source else { self?.finish(message: "Import failed", error: true); return }
      do { try self.copyAndWriteManifest(source: source, mediaType: provider.registeredTypeIdentifiers.first ?? UTType.image.identifier); self.finish(message: "Image saved", error: false) }
      catch { self.finish(message: "Import failed", error: true) }
    }
  }

  private func copyAndWriteManifest(source: URL, mediaType: String) throws {
    guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier) else { throw ShareError.appGroupUnavailable }
    let ingestionId = UUID().uuidString.lowercased(), itemId = UUID().uuidString.lowercased()
    let directory = container.appendingPathComponent("Inbox/\(ingestionId)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let partial = directory.appendingPathComponent("\(itemId).partial"), destination = directory.appendingPathComponent("\(itemId).bin")
    try FileManager.default.copyItem(at: source, to: partial)
    try FileManager.default.moveItem(at: partial, to: destination)
    let bytes = (try destination.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
    let manifest: [String: Any] = ["schemaVersion": 1, "ingestionId": ingestionId, "createdAt": ISO8601DateFormatter().string(from: Date()), "source": "ios-share-extension", "status": "complete", "items": [["id": itemId, "mediaType": mediaType, "byteCount": bytes, "localUri": destination.absoluteString, "status": "copied"]]]
    let data = try JSONSerialization.data(withJSONObject: manifest, options: [.sortedKeys])
    let manifestPartial = directory.appendingPathComponent("manifest.partial"), manifestURL = directory.appendingPathComponent("manifest.json")
    try data.write(to: manifestPartial, options: .atomic)
    try FileManager.default.moveItem(at: manifestPartial, to: manifestURL)
  }

  private func finish(message: String, error: Bool) {
    DispatchQueue.main.async { self.statusLabel.text = message; DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { error ? self.extensionContext?.cancelRequest(withError: ShareError.importFailed) : self.extensionContext?.completeRequest(returningItems: nil) } }
  }
}

private enum ShareError: Error { case appGroupUnavailable, importFailed }
