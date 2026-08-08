import ExpoModulesCore
import Foundation
import ImageIO
import PDFKit
import Vision

private let appGroupIdentifier = "group.com.example.aicontextpack"

public final class ContextNativeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ContextNative")

    OnCreate {
      guard let container = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: appGroupIdentifier
      ) else { return }
      DispatchQueue.global(qos: .utility).async {
        InboxArtifactHandoff.runStartupMaintenance(container: container)
      }
    }

    AsyncFunction("scanInbox") { () throws -> [[String: Any]] in
      guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier) else {
        throw NativeError("APP_GROUP_UNAVAILABLE")
      }
      let inbox = container.appendingPathComponent("Inbox", isDirectory: true)
      let staging = container.appendingPathComponent("InboxStaging", isDirectory: true)
      do {
        if try !RecoveryMetadataEventStore.read(container: container, folder: "RecoveryEvents").isEmpty {
          throw NativeError("INBOX_RECOVERY_REQUIRED")
        }
      } catch let error as NativeError {
        throw error
      } catch let error as RecoveryMetadataEventError {
        throw NativeError(error.stableCode)
      } catch {
        throw NativeError("NATIVE_EVENT_STORE_READ_FAILED")
      }
      let recovered: Bool
      do { recovered = try InboxRecoverySupport.recoverIncompleteTransactions(inbox: inbox, staging: staging, container: container) }
      catch let error as RecoveryMetadataEventError { throw NativeError(error.stableCode) }
      catch { throw NativeError("INBOX_SCAN_FAILED") }
      if recovered { throw NativeError("INBOX_RECOVERY_REQUIRED") }
      var isDirectory: ObjCBool = false
      guard FileManager.default.fileExists(atPath: inbox.path, isDirectory: &isDirectory) else { return [] }
      guard isDirectory.boolValue else { throw NativeError("INBOX_SCAN_FAILED") }
      do { return try InboxManifestValidator.read(inbox: inbox) }
      catch let error as InboxManifestValidationError { throw NativeError(error.stableCode) }
      catch { throw NativeError("INBOX_SCAN_FAILED") }
    }

    AsyncFunction("getPendingShareEvents") { () -> [[String: Any]] in [] }
    AsyncFunction("ackPendingShareEvent") { (_: String) -> Bool in true }
    AsyncFunction("ackEphemeralShareEvent") { (_: String) -> Bool in true }
    AsyncFunction("getPendingRecoveryEvent") { () throws -> [String: Any]? in
      guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier) else {
        throw NativeError("APP_GROUP_UNAVAILABLE")
      }
      do { return try RecoveryMetadataEventStore.read(container: container, folder: "RecoveryEvents").first }
      catch let error as RecoveryMetadataEventError { throw NativeError(error.stableCode) }
      catch { throw NativeError("NATIVE_EVENT_STORE_READ_FAILED") }
    }
    AsyncFunction("ackRecoveryEvent") { (id: String) throws -> Bool in
      guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier) else {
        throw NativeError("APP_GROUP_UNAVAILABLE")
      }
      do { return try RecoveryMetadataEventStore.ack(container: container, folder: "RecoveryEvents", id: id) }
      catch let error as RecoveryMetadataEventError { throw NativeError(error.stableCode) }
      catch { throw NativeError("NATIVE_RECOVERY_ACK_FAILED") }
    }

    AsyncFunction("handoffInbox") { (ingestionId: String, packId: String, requiredHeadroomBytes: Int64) throws -> [String: Any] in
      guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier) else {
        throw NativeError("APP_GROUP_UNAVAILABLE")
      }
      guard let applicationSupport = FileManager.default.urls(
        for: .applicationSupportDirectory,
        in: .userDomainMask
      ).first else {
        throw NativeError("STORAGE_WRITE_FAILED")
      }
      let ownedRoot = applicationSupport.appendingPathComponent("AIContextPack", isDirectory: true)
      do {
        return try InboxArtifactHandoff.handoff(
          container: container,
          applicationSupport: ownedRoot,
          ingestionId: ingestionId,
          packId: packId,
          requiredHeadroomBytes: requiredHeadroomBytes
        )
      } catch let error as InboxArtifactHandoffError {
        throw NativeError(error.stableCode)
      } catch let error as InboxManifestValidationError {
        throw NativeError(error.stableCode)
      } catch {
        throw NativeError("STORAGE_WRITE_FAILED")
      }
    }

    AsyncFunction("acknowledgeInbox") { (ingestionId: String) throws -> Bool in
      guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier) else {
        throw NativeError("APP_GROUP_UNAVAILABLE")
      }
      do { return try InboxArtifactHandoff.acknowledge(container: container, ingestionId: ingestionId) }
      catch let error as InboxArtifactHandoffError { throw NativeError(error.stableCode) }
      catch { throw NativeError("STORAGE_WRITE_FAILED") }
    }

    AsyncFunction("publishMainAppImport") { (
      ingestionId: String,
      source: String,
      inputs: [[String: Any]]
    ) throws -> [String: Any] in
      guard let container = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: appGroupIdentifier
      ), let cacheRoot = FileManager.default.urls(
        for: .cachesDirectory,
        in: .userDomainMask
      ).first else {
        throw NativeError("APP_GROUP_UNAVAILABLE")
      }
      do {
        return try MainAppImportPublisher.publish(
          container: container,
          cacheRoot: cacheRoot,
          ownedRoot: try ownedApplicationSupportRoot(),
          ingestionId: ingestionId,
          source: source,
          rawInputs: inputs
        )
      } catch let error as MainAppImportError {
        throw NativeError(error.stableCode)
      } catch let error as InboxManifestValidationError {
        throw NativeError(error.stableCode)
      } catch let error as ShareIngestionFatalError {
        switch error {
        case .invalidInput: throw NativeError("MAIN_APP_IMPORT_INPUT_INVALID")
        case .recoveryRequired, .interrupted:
          throw NativeError("PIPELINE_RECOVERY_REQUIRED")
        case .storageWriteFailed: throw NativeError("STORAGE_WRITE_FAILED")
        case .artifactIntegrityFailed: throw NativeError("ARTIFACT_INTEGRITY_FAILED")
        }
      } catch {
        throw NativeError("STORAGE_WRITE_FAILED")
      }
    }

    AsyncFunction("discardMainAppPickerFiles") { (fileUris: [String]) throws -> Bool in
      guard let cacheRoot = FileManager.default.urls(
        for: .cachesDirectory,
        in: .userDomainMask
      ).first else {
        throw NativeError("STORAGE_WRITE_FAILED")
      }
      do { return try MainAppImportPublisher.discard(cacheRoot: cacheRoot, fileUris: fileUris) }
      catch let error as MainAppImportError { throw NativeError(error.stableCode) }
      catch { throw NativeError("MAIN_APP_IMPORT_CLEANUP_FAILED") }
    }

    AsyncFunction("stageMainAppPickerFiles") { (fileUris: [String]) throws -> [String] in
      guard let cacheRoot = FileManager.default.urls(
        for: .cachesDirectory,
        in: .userDomainMask
      ).first else {
        throw NativeError("STORAGE_WRITE_FAILED")
      }
      do { return try MainAppImportPublisher.stagePickerFiles(cacheRoot: cacheRoot, fileUris: fileUris) }
      catch let error as MainAppImportError { throw NativeError(error.stableCode) }
      catch { throw NativeError("MAIN_APP_PICKER_STAGING_FAILED") }
    }

    AsyncFunction("cleanupMainAppPickerTransients") { () throws -> Bool in
      guard let cacheRoot = FileManager.default.urls(
        for: .cachesDirectory,
        in: .userDomainMask
      ).first else {
        throw NativeError("STORAGE_WRITE_FAILED")
      }
      do { return try MainAppImportPublisher.cleanupPickerTransients(cacheRoot: cacheRoot) }
      catch let error as MainAppImportError { throw NativeError(error.stableCode) }
      catch { throw NativeError("MAIN_APP_IMPORT_CLEANUP_FAILED") }
    }

    AsyncFunction("recoverMainAppPickerCache") { () throws -> Bool in
      guard let cacheRoot = FileManager.default.urls(
        for: .cachesDirectory,
        in: .userDomainMask
      ).first else {
        throw NativeError("STORAGE_WRITE_FAILED")
      }
      do { return try MainAppImportPublisher.recoverPickerCache(cacheRoot: cacheRoot) }
      catch let error as MainAppImportError { throw NativeError(error.stableCode) }
      catch { throw NativeError("MAIN_APP_IMPORT_CLEANUP_FAILED") }
    }

    AsyncFunction("publishArtifact") { (
      sourceFileUri: String,
      relativePath: String,
      expectedByteCount: Int64?,
      expectedSha256: String?
    ) throws -> [String: Any] in
      do {
        return try OwnedArtifactStore.publish(
          root: ownedApplicationSupportRoot(),
          source: try controlledArtifactSourceURL(sourceFileUri),
          relativePath: relativePath,
          expectedByteCount: expectedByteCount,
          expectedSha256: expectedSha256
        )
      } catch let error as OwnedArtifactStoreError {
        throw NativeError(error.stableCode)
      } catch let error as NativeError {
        throw error
      } catch {
        throw NativeError("STORAGE_WRITE_FAILED")
      }
    }

    AsyncFunction("verifyArtifact") { (
      relativePath: String,
      expectedByteCount: Int64,
      expectedSha256: String
    ) throws -> [String: Any] in
      do {
        return try OwnedArtifactStore.verify(
          root: ownedApplicationSupportRoot(),
          relativePath: relativePath,
          expectedByteCount: expectedByteCount,
          expectedSha256: expectedSha256
        )
      } catch let error as OwnedArtifactStoreError {
        throw NativeError(error.stableCode)
      } catch {
        throw NativeError("STORAGE_WRITE_FAILED")
      }
    }

    AsyncFunction("listOwnedArtifacts") { () throws -> [[String: Any]] in
      do { return try OwnedArtifactStore.list(root: ownedApplicationSupportRoot()) }
      catch let error as OwnedArtifactStoreError { throw NativeError(error.stableCode) }
      catch { throw NativeError("STORAGE_WRITE_FAILED") }
    }

    AsyncFunction("removeOwnedArtifact") { (relativePath: String) throws -> Bool in
      do {
        return try OwnedArtifactStore.remove(
          root: ownedApplicationSupportRoot(),
          relativePath: relativePath
        )
      } catch let error as OwnedArtifactStoreError { throw NativeError(error.stableCode) }
      catch { throw NativeError("STORAGE_WRITE_FAILED") }
    }

    AsyncFunction("quarantineOwnedArtifact") { (relativePath: String) throws -> [String: Any] in
      do {
        return try OwnedArtifactStore.quarantine(
          root: ownedApplicationSupportRoot(),
          relativePath: relativePath
        )
      } catch let error as OwnedArtifactStoreError { throw NativeError(error.stableCode) }
      catch { throw NativeError("STORAGE_WRITE_FAILED") }
    }

    AsyncFunction("purgeArtifactQuarantine") { (olderThanEpochMs: Int64) throws -> [String: Any] in
      do {
        return try OwnedArtifactStore.purgeQuarantine(
          root: ownedApplicationSupportRoot(),
          olderThanEpochMs: olderThanEpochMs
        )
      } catch let error as OwnedArtifactStoreError { throw NativeError(error.stableCode) }
      catch { throw NativeError("STORAGE_WRITE_FAILED") }
    }

    AsyncFunction("getArtifactStorageUsage") { () throws -> [String: Any] in
      do { return try OwnedArtifactStore.usage(root: ownedApplicationSupportRoot()) }
      catch let error as OwnedArtifactStoreError { throw NativeError(error.stableCode) }
      catch { throw NativeError("STORAGE_WRITE_FAILED") }
    }

    AsyncFunction("recognizeText") { (fileUri: String, script: String) async throws -> [String: Any] in
      let started = ContinuousClock.now
      let url = try controlledFileURL(fileUri)
      guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
            let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw NativeError("OCR_IMAGE_DECODE_FAILED")
      }
      let orientation = imageOrientation(source: source)
      let request = VNRecognizeTextRequest()
      request.recognitionLevel = .accurate
      request.usesLanguageCorrection = true
      request.recognitionLanguages = script == "chinese" ? ["zh-Hans", "en-US"] : ["en-US"]
      do {
        try VNImageRequestHandler(cgImage: image, orientation: orientation).perform([request])
      } catch {
        throw NativeError("OCR_RECOGNITION_FAILED")
      }
      let observations = request.results ?? []
      let blocks: [[String: Any]] = observations.compactMap { observation in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        let bounds = observation.boundingBox
        return ["text": candidate.string,
                "confidence": Double(candidate.confidence),
                "bounds": ["x": bounds.minX, "y": 1 - bounds.maxY, "width": bounds.width, "height": bounds.height]]
      }
      return ["schemaVersion": 1,
              "text": blocks.compactMap { $0["text"] as? String }.joined(separator: "\n"),
              "blocks": blocks,
              "durationMs": durationMilliseconds(since: started),
              "engine": "apple-vision",
              "revision": String(VNRecognizeTextRequestRevision3)]
    }

    AsyncFunction("probePdf") { (fileUri: String) throws -> [String: Any] in
      let url = try controlledFileURL(fileUri)
      let values: URLResourceValues
      do {
        values = try url.resourceValues(forKeys: [.fileSizeKey])
      } catch {
        throw NativeError("PDF_INVALID_OR_TOO_LARGE")
      }
      guard (values.fileSize ?? 0) <= 52_428_800 else { throw NativeError("PDF_TOO_LARGE") }
      guard let document = PDFDocument(url: url), document.pageCount <= 25 else { throw NativeError("PDF_INVALID_OR_TOO_MANY_PAGES") }
      var embedded = 0
      for index in 0..<document.pageCount where !(document.page(at: index)?.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { embedded += 1 }
      return ["pageCount": document.pageCount, "embeddedTextPages": embedded,
              "renderedFallbackPages": document.pageCount - embedded, "engine": "pdfkit",
              "limit": ["pages": 25, "bytes": 52_428_800]]
    }
  }
}

private func imageOrientation(source: CGImageSource) -> CGImagePropertyOrientation {
  guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
        let rawValue = properties[kCGImagePropertyOrientation] as? NSNumber else { return .up }
  return CGImagePropertyOrientation(rawValue: rawValue.uint32Value) ?? .up
}

private func controlledFileURL(_ value: String) throws -> URL {
  guard let url = URL(string: value), url.isFileURL else { throw NativeError("INVALID_LOCAL_FILE_URI") }
  return url.standardizedFileURL
}

private func controlledArtifactSourceURL(_ value: String) throws -> URL {
  let source = try controlledFileURL(value)
  let sourceValues: URLResourceValues
  do { sourceValues = try source.resourceValues(forKeys: [.isSymbolicLinkKey]) }
  catch { throw NativeError("INVALID_LOCAL_FILE_URI") }
  guard sourceValues.isSymbolicLink != true else {
    throw NativeError("INVALID_LOCAL_FILE_URI")
  }
  let candidate = source.resolvingSymlinksInPath().standardizedFileURL
  let sandbox = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
    .resolvingSymlinksInPath().standardizedFileURL
  guard candidate.path.hasPrefix(sandbox.path + "/") else {
    throw NativeError("INVALID_LOCAL_FILE_URI")
  }
  return candidate
}

private func ownedApplicationSupportRoot() throws -> URL {
  guard let applicationSupport = FileManager.default.urls(
    for: .applicationSupportDirectory,
    in: .userDomainMask
  ).first else {
    throw NativeError("STORAGE_WRITE_FAILED")
  }
  return applicationSupport.appendingPathComponent("AIContextPack", isDirectory: true)
}

private func durationMilliseconds(since start: ContinuousClock.Instant) -> Double {
  let duration = start.duration(to: .now)
  return Double(duration.components.seconds) * 1_000 + Double(duration.components.attoseconds) / 1_000_000_000_000_000
}

private final class NativeError: Exception, @unchecked Sendable {
  init(_ code: String) {
    super.init(name: "ContextNativeError", description: code, code: code)
  }
}
