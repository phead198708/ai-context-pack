import ExpoModulesCore
import Foundation
import PDFKit
import UIKit

private let appGroupIdentifier = "group.com.example.aicontextpack"

private enum AppleVisionOCRProcessScope {
  static let registry = OCRCancellationRegistry()
  static let imageHashRegistry = ImageHashTaskRegistry()
  static let imageHashScheduler = ImageHashScheduler()
  static let pdfFinishCoordinator = PDFProcessorFinishCoordinator()
  static let plainTextReadCoordinator = PlainTextReadCoordinator()
}

public final class ContextNativeModule: Module {
  private let ocrProcessor = AppleVisionOCRProcessor(
    registry: AppleVisionOCRProcessScope.registry
  )
  private let pdfProcessor = ApplePDFProcessor(
    registry: AppleVisionOCRProcessScope.registry
  )
  private lazy var pdfFinishOwner = PDFProcessorFinishOwner(
    finishProcessor: pdfProcessor.finish
  )
  private let pdfFinishCoordinator = AppleVisionOCRProcessScope.pdfFinishCoordinator
  private let plainTextReadCoordinator = AppleVisionOCRProcessScope.plainTextReadCoordinator
  private let ocrLifetime = OCRModuleLifetime()
  private let pdfLifetime = OCRModuleLifetime()
  private let imageHashOwnerId = UUID().uuidString.lowercased()
  private var memoryWarningObserver: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("ContextNative")

    OnCreate {
      memoryWarningObserver = NotificationCenter.default.addObserver(
        forName: UIApplication.didReceiveMemoryWarningNotification,
        object: nil,
        queue: nil
      ) { [weak self] _ in
        self?.ocrProcessor.setMemoryPressure(true)
      }
      let recoveryContainer = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: appGroupIdentifier
      )
      DispatchQueue.global(qos: .utility).async {
        ImageHashSnapshotStore.runStartupMaintenance()
        let failureCode = ImageCompressionTemporaryStore.runStartupMaintenance()
        if let recoveryContainer {
          try? ImageCompressionStartupRecoveryReporter.reconcile(
            container: recoveryContainer,
            failureCode: failureCode
          )
        }
      }
      guard let container = recoveryContainer else { return }
      DispatchQueue.global(qos: .utility).async {
        InboxArtifactHandoff.runStartupMaintenance(container: container)
      }
    }

    OnDestroy { [
      weak self,
      pdfFinishCoordinator = self.pdfFinishCoordinator,
      pdfFinishOwner = self.pdfFinishOwner,
      pdfLifetime = self.pdfLifetime,
      pdfProcessor = self.pdfProcessor
    ] in
      if let observer = self?.memoryWarningObserver {
        NotificationCenter.default.removeObserver(observer)
      }
      self?.memoryWarningObserver = nil
      if let taskId = self?.ocrLifetime.destroy() {
        _ = self?.ocrProcessor.cancel(taskId: taskId)
      }
      let activePDFTaskId = pdfLifetime.destroy()
      pdfFinishCoordinator.destroyOwner(pdfFinishOwner)
      pdfProcessor.destroy(activeTaskId: activePDFTaskId)
      if let ownerId = self?.imageHashOwnerId {
        AppleVisionOCRProcessScope.imageHashRegistry.destroyOwner(ownerId)
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
        case .committedRecoveryRequired:
          throw NativeError("MAIN_APP_IMPORT_COMMITTED_RECOVERY_REQUIRED")
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

    AsyncFunction("resolveOwnedArtifactFileUri") { (relativePath: String) throws -> String in
      do {
        return try OwnedArtifactStore.resolveFileUri(
          root: ownedApplicationSupportRoot(),
          relativePath: relativePath
        )
      } catch let error as OwnedArtifactStoreError {
        throw NativeError(error.stableCode)
      } catch {
        throw NativeError("STORAGE_WRITE_FAILED")
      }
    }

    AsyncFunction("writeTextArtifact") { (
      relativePath: String,
      text: String
    ) throws -> [String: Any] in
      do {
        return try OwnedArtifactStore.writeText(
          root: ownedApplicationSupportRoot(),
          relativePath: relativePath,
          text: text
        )
      } catch let error as OwnedArtifactStoreError {
        throw NativeError(error.stableCode)
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

    AsyncFunction("getOCRCapabilities") { [weak self] () throws -> [String: Any] in
      guard let self else { throw NativeError("OCR_ENGINE_UNAVAILABLE") }
      return self.ocrProcessor.capabilities()
    }

    AsyncFunction("hashImagePerceptually") { [weak self] (
      taskId: String,
      fileUri: String,
      expectedByteCount: Int64,
      expectedSha256: String
    ) async throws -> [String: Any] in
      guard let self else { throw NativeError("PIPELINE_STAGE_FAILED") }
      let url = try controlledArtifactSourceURL(fileUri)
      let registry = AppleVisionOCRProcessScope.imageHashRegistry
      guard let token = registry.reserve(ownerId: imageHashOwnerId, taskId: taskId) else {
        throw NativeError("PIPELINE_STAGE_FAILED")
      }
      do {
        return try await withCheckedThrowingContinuation { continuation in
          guard let work = AppleVisionOCRProcessScope.imageHashScheduler.submit(
            token: token,
            work: {
              try ImagePerceptualHasher.hash(
                fileURL: url,
                expectedByteCount: expectedByteCount,
                expectedSHA256: expectedSha256,
                cancellation: token
              )
            },
            completion: { result in
              registry.finish(ownerId: self.imageHashOwnerId, taskId: taskId, token: token)
              continuation.resume(with: result)
            }
          ) else {
            registry.finish(ownerId: self.imageHashOwnerId, taskId: taskId, token: token)
            continuation.resume(throwing: ImagePerceptualHashError.resourceLimit)
            return
          }
          registry.attach(
            ownerId: self.imageHashOwnerId,
            taskId: taskId,
            token: token,
            cancel: { work.cancel() },
            awaitCompletion: { work.cancelAndWait() }
          )
        }
      } catch let error as ImagePerceptualHashError {
        throw NativeError(error.stableCode)
      } catch {
        throw NativeError("PROCESSOR_OUTPUT_INVALID")
      }
    }

    AsyncFunction("cancelImagePerceptualHash") { [weak self] (taskId: String) -> Bool in
      guard let self else { return false }
      return AppleVisionOCRProcessScope.imageHashRegistry.cancel(
        ownerId: imageHashOwnerId,
        taskId: taskId
      )
    }

    AsyncFunction("inspectImageForCompression") { [weak self] (
      taskId: String,
      fileUri: String,
      expectedByteCount: Int64,
      expectedSha256: String
    ) async throws -> [String: Any] in
      guard let self else { throw NativeError("PIPELINE_STAGE_FAILED") }
      let url = try controlledArtifactSourceURL(fileUri)
      let registry = AppleVisionOCRProcessScope.imageHashRegistry
      guard let token = registry.reserve(ownerId: imageHashOwnerId, taskId: taskId) else {
        throw NativeError("PIPELINE_STAGE_FAILED")
      }
      do {
        return try await withCheckedThrowingContinuation { continuation in
          guard let work = AppleVisionOCRProcessScope.imageHashScheduler.submit(
            token: token,
            work: {
              try ImageCompressionProcessor.inspect(
                fileURL: url,
                expectedByteCount: expectedByteCount,
                expectedSHA256: expectedSha256,
                cancellation: token
              )
            },
            completion: { result in
              registry.finish(ownerId: self.imageHashOwnerId, taskId: taskId, token: token)
              continuation.resume(with: result)
            }
          ) else {
            registry.finish(ownerId: self.imageHashOwnerId, taskId: taskId, token: token)
            continuation.resume(throwing: ImagePerceptualHashError.resourceLimit)
            return
          }
          registry.attach(
            ownerId: self.imageHashOwnerId,
            taskId: taskId,
            token: token,
            cancel: { work.cancel() },
            awaitCompletion: { work.cancelAndWait() }
          )
        }
      } catch let error as ImagePerceptualHashError {
        throw NativeError(error.stableCode)
      } catch {
        throw NativeError("PROCESSOR_OUTPUT_INVALID")
      }
    }

    AsyncFunction("compressImage") { [weak self] (
      request: [String: Any]
    ) async throws -> [String: Any] in
      guard let self else { throw NativeError("PIPELINE_STAGE_FAILED") }
      let expectedKeys: Set<String> = [
        "schemaVersion", "taskId", "fileUri", "expectedByteCount",
        "expectedSha256", "targetWidth", "targetHeight", "quality",
        "outputMediaType", "preserveAlpha",
      ]
      guard Set(request.keys) == expectedKeys,
            (request["schemaVersion"] as? NSNumber)?.intValue == 1,
            let taskId = request["taskId"] as? String,
            let fileUri = request["fileUri"] as? String,
            let expectedByteCount = (request["expectedByteCount"] as? NSNumber)?.int64Value,
            let expectedSha256 = request["expectedSha256"] as? String,
            let targetWidth = (request["targetWidth"] as? NSNumber)?.intValue,
            let targetHeight = (request["targetHeight"] as? NSNumber)?.intValue,
            let quality = (request["quality"] as? NSNumber)?.doubleValue,
            let outputMediaType = request["outputMediaType"] as? String,
            let preserveAlpha = request["preserveAlpha"] as? Bool else {
        throw NativeError("PROCESSOR_OUTPUT_INVALID")
      }
      let url = try controlledArtifactSourceURL(fileUri)
      let registry = AppleVisionOCRProcessScope.imageHashRegistry
      guard let token = registry.reserve(ownerId: imageHashOwnerId, taskId: taskId) else {
        throw NativeError("PIPELINE_STAGE_FAILED")
      }
      do {
        return try await withCheckedThrowingContinuation { continuation in
          guard let work = AppleVisionOCRProcessScope.imageHashScheduler.submit(
            token: token,
            work: {
              try ImageCompressionProcessor.compress(
                taskId: taskId,
                fileURL: url,
                expectedByteCount: expectedByteCount,
                expectedSHA256: expectedSha256,
                targetWidth: targetWidth,
                targetHeight: targetHeight,
                quality: quality,
                outputMediaType: outputMediaType,
                preserveAlpha: preserveAlpha,
                cancellation: token
              )
            },
            completion: { result in
              registry.finish(ownerId: self.imageHashOwnerId, taskId: taskId, token: token)
              continuation.resume(with: result)
            }
          ) else {
            registry.finish(ownerId: self.imageHashOwnerId, taskId: taskId, token: token)
            continuation.resume(throwing: ImagePerceptualHashError.resourceLimit)
            return
          }
          registry.attach(
            ownerId: self.imageHashOwnerId,
            taskId: taskId,
            token: token,
            cancel: { work.cancel() },
            awaitCompletion: { work.cancelAndWait() }
          )
        }
      } catch let error as ImagePerceptualHashError {
        throw NativeError(error.stableCode)
      } catch {
        throw NativeError("PROCESSOR_OUTPUT_INVALID")
      }
    }

    AsyncFunction("cancelImageCompression") { [weak self] (taskId: String) -> Bool in
      guard let self else { return false }
      return AppleVisionOCRProcessScope.imageHashRegistry.cancel(
        ownerId: imageHashOwnerId,
        taskId: taskId
      )
    }

    AsyncFunction("finishImageCompression") { (taskId: String) -> Bool in
      ImageCompressionTemporaryStore.finish(taskId: taskId)
    }

    AsyncFunction("recognizeText") { [weak self] (
      taskId: String,
      fileUri: String,
      script: String,
      recognitionLevel: String
    ) async throws -> [String: Any] in
      guard let self else { throw NativeError("OCR_ENGINE_UNAVAILABLE") }
      let url = try controlledArtifactSourceURL(fileUri)
      let processor = self.ocrProcessor
      let lifetime = self.ocrLifetime
      do {
        try processor.reserve(taskId: taskId)
        do {
          try lifetime.begin(taskId: taskId)
        } catch {
          processor.finish(taskId: taskId)
          throw error
        }
        defer { lifetime.finish(taskId: taskId) }
        let result = try await Task.detached(priority: .userInitiated) {
          try processor.recognize(
            taskId: taskId,
            fileURL: url,
            script: script,
            recognitionLevel: recognitionLevel,
            reserved: true
          )
        }.value
        guard lifetime.claimDelivery(taskId: taskId) else {
          throw OCRProcessingError.cancelled
        }
        return result
      } catch let error as OCRProcessingError {
        throw NativeError(error.stableCode)
      } catch is CancellationError {
        throw NativeError("OCR_CANCELLED")
      } catch {
        throw NativeError("OCR_RECOGNITION_FAILED")
      }
    }

    AsyncFunction("cancelTextRecognition") { [weak self] (taskId: String) throws -> Bool in
      guard let self else { throw NativeError("OCR_ENGINE_UNAVAILABLE") }
      guard self.ocrProcessor.cancel(taskId: taskId) else {
        throw NativeError("OCR_RESULT_INVALID")
      }
      return true
    }

    AsyncFunction("inspectPdf") { [weak self] (
      taskId: String,
      fileUri: String,
      sourceSha256: String
    ) async throws -> [String: Any] in
      guard let self else { throw NativeError("PDF_PAGE_EXTRACTION_FAILED") }
      let url = try controlledArtifactSourceURL(fileUri)
      let processor = self.pdfProcessor
      let lifetime = self.pdfLifetime
      let operation: PDFOperationLifetimeLease
      do {
        operation = try beginPDFOperationLifetime(
          lifetime: lifetime,
          coordinator: self.pdfFinishCoordinator,
          owner: self.pdfFinishOwner,
          taskId: taskId
        ) {
          try processor.reserve(taskId: taskId)
        }
      } catch let error as PDFProcessingError {
        throw NativeError(error.stableCode)
      } catch let error as OCRProcessingError {
        throw NativeError(PDFProcessingError.fromOCR(error).stableCode)
      } catch {
        throw NativeError("PDF_PAGE_EXTRACTION_FAILED")
      }
      var keepSession = false
      defer { operation.finish(keepSession: keepSession) }
      do {
        let result = try await Task.detached(priority: .userInitiated) {
          try processor.inspect(
            taskId: taskId,
            fileURL: url,
            expectedSourceSHA256: sourceSha256,
            reserved: true
          )
        }.value
        keepSession = operation.claimDelivery()
        guard keepSession else {
          throw PDFProcessingError.cancelled
        }
        return result
      } catch let error as PDFProcessingError {
        throw NativeError(error.stableCode)
      } catch let error as OCRProcessingError {
        throw NativeError(PDFProcessingError.fromOCR(error).stableCode)
      } catch is CancellationError {
        throw NativeError("PDF_CANCELLED")
      } catch {
        throw NativeError("PDF_PAGE_EXTRACTION_FAILED")
      }
    }

    AsyncFunction("extractPdfPage") { [weak self] (
      taskId: String,
      fileUri: String,
      sourceSha256: String,
      pageIndex: Int,
      script: String
    ) async throws -> [String: Any] in
      guard let self else { throw NativeError("PDF_PAGE_EXTRACTION_FAILED") }
      let url = try controlledArtifactSourceURL(fileUri)
      let processor = self.pdfProcessor
      let lifetime = self.pdfLifetime
      let operation: PDFOperationLifetimeLease
      do {
        operation = try beginPDFOperationLifetime(
          lifetime: lifetime,
          coordinator: self.pdfFinishCoordinator,
          owner: self.pdfFinishOwner,
          taskId: taskId
        ) {
          try processor.validatePageRequest(
            taskId: taskId,
            fileURL: url,
            expectedSourceSHA256: sourceSha256
          )
        }
      } catch let error as PDFProcessingError {
        throw NativeError(error.stableCode)
      } catch let error as OCRProcessingError {
        throw NativeError(PDFProcessingError.fromOCR(error).stableCode)
      } catch {
        throw NativeError("PDF_PAGE_EXTRACTION_FAILED")
      }
      var keepSession = true
      defer { operation.finish(keepSession: keepSession) }
      do {
        let result = try await Task.detached(priority: .userInitiated) {
          try processor.extractPage(
            taskId: taskId,
            fileURL: url,
            expectedSourceSHA256: sourceSha256,
            pageIndex: pageIndex,
            script: script,
            reserved: true
          )
        }.value
        keepSession = operation.claimDelivery()
        guard keepSession else {
          throw NativeError("PDF_CANCELLED")
        }
        return result
      } catch let error as NativeError {
        throw error
      } catch let error as PDFProcessingError {
        keepSession = operation.claimDelivery()
        guard keepSession else {
          throw NativeError("PDF_CANCELLED")
        }
        throw NativeError(error.stableCode)
      } catch let error as OCRProcessingError {
        keepSession = operation.claimDelivery()
        guard keepSession else {
          throw NativeError("PDF_CANCELLED")
        }
        throw NativeError(PDFProcessingError.fromOCR(error).stableCode)
      } catch is CancellationError {
        keepSession = operation.claimDelivery()
        guard keepSession else {
          throw NativeError("PDF_CANCELLED")
        }
        throw NativeError("PDF_CANCELLED")
      } catch {
        keepSession = operation.claimDelivery()
        guard keepSession else {
          throw NativeError("PDF_CANCELLED")
        }
        throw NativeError("PDF_PAGE_EXTRACTION_FAILED")
      }
    }

    AsyncFunction("cancelPdfExtraction") { [weak self] (taskId: String) throws -> Bool in
      guard let self else { throw NativeError("PDF_PAGE_EXTRACTION_FAILED") }
      guard self.pdfProcessor.cancel(taskId: taskId) else {
        throw NativeError("PDF_RESULT_INVALID")
      }
      return true
    }

    AsyncFunction("finishPdfExtraction") { [weak self] (taskId: String) async throws -> Bool in
      guard let self else { throw NativeError("PDF_PAGE_EXTRACTION_FAILED") }
      return await withCheckedContinuation { continuation in
        self.pdfFinishCoordinator.requestFinish(
          fallbackOwner: self.pdfFinishOwner,
          taskId: taskId
        ) {
          continuation.resume(returning: true)
        }
      }
    }

    AsyncFunction("readPlainTextFile") {
      (
        fileUri: String,
        maximumBytes: Int,
        expectedByteCount: Int?,
        expectedSha256: String?
      ) async throws -> [String: Any] in
      let url = try controlledArtifactSourceURL(fileUri)
      do {
        return try await self.plainTextReadCoordinator.read(
          fileURL: url,
          maximumBytes: maximumBytes,
          expectedByteCount: expectedByteCount,
          expectedSHA256: expectedSha256
        )
      } catch let error as PlainTextFileReaderError {
        throw NativeError(error.stableCode)
      } catch {
        throw NativeError("TEXT_RESULT_INVALID")
      }
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
