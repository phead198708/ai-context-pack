import UIKit

private let appGroupIdentifier = "group.com.example.aicontextpack"

final class ShareViewController: UIViewController {
  private let statusLabel = UILabel()
  private var session: ShareIngestionSession?
  private var itemIds: [String] = []
  private var attachments: [NSItemProvider] = []
  private var finished = false

  override func viewDidLoad() {
    super.viewDidLoad()
    configureStatus()
    beginImport()
  }

  private func configureStatus() {
    statusLabel.text = "Preparing import…"
    statusLabel.textAlignment = .center
    statusLabel.numberOfLines = 0
    statusLabel.adjustsFontForContentSizeCategory = true
    statusLabel.accessibilityTraits = [.updatesFrequently]
    statusLabel.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(statusLabel)
    NSLayoutConstraint.activate([
      statusLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
      statusLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
      statusLabel.centerYAnchor.constraint(equalTo: view.centerYAnchor),
    ])
  }

  private func beginImport() {
    attachments = extensionContext?.inputItems
      .compactMap { $0 as? NSExtensionItem }
      .flatMap { $0.attachments ?? [] } ?? []
    guard !attachments.isEmpty else {
      finishWithError(message: "No shared items were provided.")
      return
    }
    guard attachments.count <= ShareIngestionSession.maximumReportedItemCount else {
      finishWithError(message: "Too many shared items.")
      return
    }
    guard let container = FileManager.default.containerURL(
      forSecurityApplicationGroupIdentifier: appGroupIdentifier
    ) else {
      finishWithError(message: "Import storage is unavailable.")
      return
    }
    let ingestionId = UUID().uuidString.lowercased()
    itemIds = attachments.map { _ in UUID().uuidString.lowercased() }
    do {
      session = try ShareIngestionSession(container: container, ingestionId: ingestionId)
      processAttachment(at: 0)
    } catch {
      finishWithError(message: "Import could not be started.")
    }
  }

  private func processAttachment(at index: Int) {
    guard !finished, let session else { return }
    guard index < attachments.count else {
      do { finishSuccessfully(try session.finish()) }
      catch { finishWithError(message: "Import could not be published.") }
      return
    }
    DispatchQueue.main.async {
      self.statusLabel.text = "Importing \(index + 1) of \(self.attachments.count)…"
    }
    let provider = attachments[index]
    let id = itemIds[index]
    if index >= ShareIngestionSession.maximumItemCount {
      do {
        let declaredMediaType = ShareRepresentationSelector.select(
          provider.registeredTypeIdentifiers
        )?.mediaType
        try session.recordFailure(
          id: id,
          order: index,
          declaredMediaType: declaredMediaType,
          code: "IMPORT_SIZE_LIMIT_EXCEEDED"
        )
        processAttachment(at: index + 1)
      } catch {
        finishWithError(message: "Import could not be recorded.")
      }
      return
    }
    guard let representation = ShareRepresentationSelector.select(
      provider.registeredTypeIdentifiers
    ) else {
      do {
        try session.recordFailure(
          id: id,
          order: index,
          declaredMediaType: "application/octet-stream",
          code: "IMPORT_TYPE_UNSUPPORTED"
        )
        processAttachment(at: index + 1)
      } catch {
        finishWithError(message: "Import could not be recorded.")
      }
      return
    }
    switch representation.kind {
    case .file:
      provider.loadFileRepresentation(forTypeIdentifier: representation.identifier) {
        [weak self] source, _ in
        guard let self, let session = self.session else { return }
        do {
          if let source {
            try session.recordFile(
              id: id,
              order: index,
              declaredMediaType: representation.mediaType,
              source: source
            )
          } else {
            try session.recordFailure(
              id: id,
              order: index,
              declaredMediaType: representation.mediaType,
              code: "IMPORT_PROVIDER_PERMISSION_EXPIRED"
            )
          }
          self.processAttachment(at: index + 1)
        } catch {
          self.finishWithError(message: "Import could not be recorded.")
        }
      }
    case .text, .webURL:
      provider.loadItem(forTypeIdentifier: representation.identifier, options: nil) {
        [weak self] value, _ in
        guard let self, let session = self.session else { return }
        do {
          switch ShareRepresentationValue.payload(value, kind: representation.kind) {
          case .file(let source):
            try session.recordFile(
              id: id,
              order: index,
              declaredMediaType: representation.mediaType,
              source: source
            )
          case .data(let data):
            try session.recordData(
              id: id,
              order: index,
              declaredMediaType: representation.mediaType,
              data: data
            )
          case nil:
            try session.recordFailure(
              id: id,
              order: index,
              declaredMediaType: representation.mediaType,
              code: "IMPORT_PROVIDER_PERMISSION_EXPIRED"
            )
          }
          self.processAttachment(at: index + 1)
        } catch {
          self.finishWithError(message: "Import could not be recorded.")
        }
      }
    }
  }

  private func finishSuccessfully(_ summary: ShareIngestionSummary) {
    guard !finished else { return }
    finished = true
    DispatchQueue.main.async {
      self.statusLabel.text = "Accepted \(summary.copied) · Rejected \(summary.rejected) · Failed \(summary.failed)"
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) {
        self.extensionContext?.completeRequest(returningItems: nil)
      }
    }
  }

  private func finishWithError(message: String) {
    guard !finished else { return }
    finished = true
    DispatchQueue.main.async {
      self.statusLabel.text = message
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) {
        self.extensionContext?.cancelRequest(withError: ShareExtensionError.importFailed)
      }
    }
  }

}

private enum ShareExtensionError: Error { case importFailed }
