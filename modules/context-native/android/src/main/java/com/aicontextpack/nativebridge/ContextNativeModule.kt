package com.aicontextpack.nativebridge

import android.content.ComponentCallbacks2
import android.content.Context
import android.content.res.Configuration
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.Build
import android.os.ParcelFileDescriptor
import android.system.Os
import android.system.OsConstants
import android.util.JsonReader
import android.util.JsonToken
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.StringReader
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

internal object AndroidOCRProcessScope {
  val registry = OcrTaskRegistry()
  val resultExecutor = ThreadPoolExecutor(
    1,
    1,
    0L,
    TimeUnit.MILLISECONDS,
    ArrayBlockingQueue(4),
    { action ->
      Thread(action, "ai-context-pack-ocr-result").apply { isDaemon = true }
    },
    ThreadPoolExecutor.AbortPolicy(),
  )
}

internal object AndroidPDFProcessScope {
  val executor = ThreadPoolExecutor(
    1,
    1,
    0L,
    TimeUnit.MILLISECONDS,
    ArrayBlockingQueue(2),
    { action ->
      Thread(action, "ai-context-pack-pdf-text").apply { isDaemon = true }
    },
    ThreadPoolExecutor.AbortPolicy(),
  )
}

internal data class OcrLifecycleRegistration(
  val taskId: String,
  val close: () -> Unit,
  val rejectOnDestroy: () -> Unit,
)

internal data class OcrLifecycleDestruction(
  val taskId: String,
  val close: () -> Unit,
  val reject: (() -> Unit)?,
)

internal class OcrModuleLifecycle {
  private data class Active(
    val registration: OcrLifecycleRegistration,
    var settled: Boolean = false,
    var destructionIssued: Boolean = false,
  )

  private var destroyed = false
  private var active: Active? = null

  @Synchronized
  fun register(registration: OcrLifecycleRegistration): Boolean {
    if (destroyed || active != null) return false
    active = Active(registration)
    return true
  }

  @Synchronized
  fun deliver(taskId: String, action: () -> Unit): Boolean {
    val current = active
    if (destroyed || current?.registration?.taskId != taskId || current.settled) return false
    current.settled = true
    action()
    return true
  }

  @Synchronized
  fun finish(taskId: String) {
    if (active?.registration?.taskId == taskId) active = null
  }

  @Synchronized
  fun destroy(): OcrLifecycleDestruction? {
    destroyed = true
    val current = active ?: return null
    if (current.destructionIssued) return null
    current.destructionIssued = true
    val reject = if (current.settled) {
      null
    } else {
      current.settled = true
      current.registration.rejectOnDestroy
    }
    return OcrLifecycleDestruction(
      taskId = current.registration.taskId,
      close = current.registration.close,
      reject = reject,
    )
  }
}

class ContextNativeModule : Module(), ComponentCallbacks2 {
  private val ocrProcessor = AndroidOCRProcessor(AndroidOCRProcessScope.registry)
  private val pdfProcessor = AndroidPDFProcessor(AndroidOCRProcessScope.registry)
  private val ocrLifecycle = OcrModuleLifecycle()
  private val pdfLifecycle = OcrModuleLifecycle()
  private var callbackContext: Context? = null

  override fun definition() = ModuleDefinition {
    Name("ContextNative")

    OnCreate {
      appContext.reactContext?.let { context ->
        context.registerComponentCallbacks(this@ContextNativeModule)
        callbackContext = context
        Thread(
          { InboxArtifactHandoff.runStartupMaintenance(context.filesDir) },
          "ai-context-pack-tombstone-sweep",
        ).start()
      }
    }

    OnDestroy {
      callbackContext?.unregisterComponentCallbacks(this@ContextNativeModule)
      callbackContext = null
      ocrLifecycle.destroy()?.let { active ->
        ocrProcessor.cancel(active.taskId)
        active.close()
        active.reject?.invoke()
      }
      pdfLifecycle.destroy()?.let { active ->
        pdfProcessor.cancel(active.taskId)
        active.close()
        active.reject?.invoke()
      }
    }

    AsyncFunction("scanInbox") {
      val context = appContext.reactContext ?: throw NativeException("CONTEXT_UNAVAILABLE")
      val inbox = File(context.filesDir, "Inbox")
      InboxManifestScanner.scan(inbox)
    }

    AsyncFunction("getPendingShareEvents") {
      val context = appContext.reactContext ?: throw NativeException("CONTEXT_UNAVAILABLE")
      try { MetadataEventStore.read(context.filesDir, "PendingShareEvents") + EphemeralShareEventStore.read() }
      catch (error: MetadataEventException) { throw NativeException(error.stableCode) }
    }

    AsyncFunction("ackPendingShareEvent") { id: String ->
      val context = appContext.reactContext ?: throw NativeException("CONTEXT_UNAVAILABLE")
      try { MetadataEventStore.ack(context.filesDir, "PendingShareEvents", id) }
      catch (error: MetadataEventException) { throw NativeException(error.stableCode) }
    }

    AsyncFunction("ackEphemeralShareEvent") { id: String ->
      EphemeralShareEventStore.ack(id)
    }

    AsyncFunction("getPendingRecoveryEvent") {
      val context = appContext.reactContext ?: throw NativeException("CONTEXT_UNAVAILABLE")
      try { MetadataEventStore.read(context.filesDir, "RecoveryEvents").firstOrNull() }
      catch (error: MetadataEventException) { throw NativeException(error.stableCode) }
    }

    AsyncFunction("ackRecoveryEvent") { id: String ->
      val context = appContext.reactContext ?: throw NativeException("CONTEXT_UNAVAILABLE")
      try { MetadataEventStore.ack(context.filesDir, "RecoveryEvents", id) }
      catch (error: MetadataEventException) { throw NativeException(error.stableCode) }
    }

    AsyncFunction("handoffInbox") { ingestionId: String, packId: String, requiredHeadroomBytes: Double ->
      val context = appContext.reactContext ?: throw NativeException("CONTEXT_UNAVAILABLE")
      try {
        InboxArtifactHandoff.handoff(
          context.filesDir,
          ingestionId,
          packId,
          requiredHeadroomBytes.toLong(),
        )
      } catch (error: InboxArtifactHandoffException) {
        throw NativeException(error.stableCode)
      }
    }

    AsyncFunction("acknowledgeInbox") { ingestionId: String ->
      val context = appContext.reactContext ?: throw NativeException("CONTEXT_UNAVAILABLE")
      try { InboxArtifactHandoff.acknowledge(context.filesDir, ingestionId) }
      catch (error: InboxArtifactHandoffException) { throw NativeException(error.stableCode) }
    }

    AsyncFunction("publishMainAppImport") {
      ingestionId: String,
      source: String,
      inputs: List<Map<String, Any?>> ->
      val context = appContext.reactContext ?: throw NativeException("CONTEXT_UNAVAILABLE")
      try {
        MainAppImportPublisher.publish(
          context.filesDir,
          context.cacheDir,
          ingestionId,
          source,
          inputs,
        )
      } catch (error: MainAppImportException) {
        throw NativeException(error.stableCode)
      } catch (_: ShareIngestionInterruptionException) {
        throw NativeException("PIPELINE_RECOVERY_REQUIRED")
      } catch (_: ShareIngestionCommittedRecoveryException) {
        throw NativeException("MAIN_APP_IMPORT_COMMITTED_RECOVERY_REQUIRED")
      } catch (_: ShareIngestionIntegrityException) {
        throw NativeException("ARTIFACT_INTEGRITY_FAILED")
      } catch (error: IllegalStateException) {
        if (error.message?.contains("RECOVERY_REQUIRED") == true) {
          throw NativeException("PIPELINE_RECOVERY_REQUIRED")
        }
        throw NativeException("STORAGE_WRITE_FAILED")
      } catch (_: Exception) {
        throw NativeException("STORAGE_WRITE_FAILED")
      }
    }

    AsyncFunction("discardMainAppPickerFiles") { fileUris: List<String> ->
      val context = appContext.reactContext ?: throw NativeException("CONTEXT_UNAVAILABLE")
      try { MainAppImportPublisher.discard(context.cacheDir, fileUris) }
      catch (error: MainAppImportException) { throw NativeException(error.stableCode) }
      catch (_: Exception) { throw NativeException("MAIN_APP_IMPORT_CLEANUP_FAILED") }
    }

    AsyncFunction("stageMainAppPickerFiles") { fileUris: List<String> ->
      val context = appContext.reactContext ?: throw NativeException("CONTEXT_UNAVAILABLE")
      try { MainAppImportPublisher.stagePickerFiles(context.cacheDir, fileUris) }
      catch (error: MainAppImportException) { throw NativeException(error.stableCode) }
      catch (_: Exception) { throw NativeException("MAIN_APP_PICKER_STAGING_FAILED") }
    }

    AsyncFunction("cleanupMainAppPickerTransients") {
      val context = appContext.reactContext ?: throw NativeException("CONTEXT_UNAVAILABLE")
      try { MainAppImportPublisher.cleanupPickerTransients(context.cacheDir) }
      catch (error: MainAppImportException) { throw NativeException(error.stableCode) }
      catch (_: Exception) { throw NativeException("MAIN_APP_IMPORT_CLEANUP_FAILED") }
    }

    AsyncFunction("recoverMainAppPickerCache") {
      val context = appContext.reactContext ?: throw NativeException("CONTEXT_UNAVAILABLE")
      try { MainAppImportPublisher.recoverPickerCache(context.cacheDir) }
      catch (error: MainAppImportException) { throw NativeException(error.stableCode) }
      catch (_: Exception) { throw NativeException("MAIN_APP_IMPORT_CLEANUP_FAILED") }
    }

    AsyncFunction("publishArtifact") {
      sourceFileUri: String,
      relativePath: String,
      expectedByteCount: Double?,
      expectedSha256: String? ->
      val context = appContext.reactContext ?: throw NativeException("CONTEXT_UNAVAILABLE")
      try {
        val unresolvedSource = File(controlledFileUri(sourceFileUri).path
          ?: throw NativeException("INVALID_LOCAL_FILE_URI"))
        val sourceMode = try { Os.lstat(unresolvedSource.path).st_mode }
        catch (_: Exception) { throw NativeException("INVALID_LOCAL_FILE_URI") }
        if (OsConstants.S_ISLNK(sourceMode)) {
          throw NativeException("INVALID_LOCAL_FILE_URI")
        }
        val source = unresolvedSource.canonicalFile
        val allowedRoots = listOf(context.filesDir, context.cacheDir).map(File::getCanonicalFile)
        if (allowedRoots.none { root ->
            source.path.startsWith(root.path + File.separator)
          }) throw NativeException("INVALID_LOCAL_FILE_URI")
        OwnedArtifactStore.publish(
          context.filesDir,
          source,
          relativePath,
          expectedByteCount?.let(::safeIntegerLong),
          expectedSha256,
        )
      } catch (error: OwnedArtifactStoreException) {
        throw NativeException(error.stableCode)
      } catch (error: NativeException) {
        throw error
      } catch (_: Exception) {
        throw NativeException("STORAGE_WRITE_FAILED")
      }
    }

    AsyncFunction("verifyArtifact") {
      relativePath: String,
      expectedByteCount: Double,
      expectedSha256: String ->
      val context = appContext.reactContext ?: throw NativeException("CONTEXT_UNAVAILABLE")
      try {
        OwnedArtifactStore.verify(
          context.filesDir,
          relativePath,
          safeIntegerLong(expectedByteCount),
          expectedSha256,
        )
      } catch (error: OwnedArtifactStoreException) {
        throw NativeException(error.stableCode)
      } catch (error: NativeException) {
        throw error
      } catch (_: Exception) {
        throw NativeException("STORAGE_WRITE_FAILED")
      }
    }

    AsyncFunction("listOwnedArtifacts") {
      val context = appContext.reactContext ?: throw NativeException("CONTEXT_UNAVAILABLE")
      try { OwnedArtifactStore.list(context.filesDir) }
      catch (error: OwnedArtifactStoreException) { throw NativeException(error.stableCode) }
      catch (_: Exception) { throw NativeException("STORAGE_WRITE_FAILED") }
    }

    AsyncFunction("removeOwnedArtifact") { relativePath: String ->
      val context = appContext.reactContext ?: throw NativeException("CONTEXT_UNAVAILABLE")
      try { OwnedArtifactStore.remove(context.filesDir, relativePath) }
      catch (error: OwnedArtifactStoreException) { throw NativeException(error.stableCode) }
      catch (_: Exception) { throw NativeException("STORAGE_WRITE_FAILED") }
    }

    AsyncFunction("quarantineOwnedArtifact") { relativePath: String ->
      val context = appContext.reactContext ?: throw NativeException("CONTEXT_UNAVAILABLE")
      try { OwnedArtifactStore.quarantine(context.filesDir, relativePath) }
      catch (error: OwnedArtifactStoreException) { throw NativeException(error.stableCode) }
      catch (_: Exception) { throw NativeException("STORAGE_WRITE_FAILED") }
    }

    AsyncFunction("purgeArtifactQuarantine") { olderThanEpochMs: Double ->
      val context = appContext.reactContext ?: throw NativeException("CONTEXT_UNAVAILABLE")
      try {
        OwnedArtifactStore.purgeQuarantine(
          context.filesDir,
          safeIntegerLong(olderThanEpochMs),
        )
      } catch (error: OwnedArtifactStoreException) {
        throw NativeException(error.stableCode)
      } catch (error: NativeException) {
        throw error
      } catch (_: Exception) {
        throw NativeException("STORAGE_WRITE_FAILED")
      }
    }

    AsyncFunction("getArtifactStorageUsage") {
      val context = appContext.reactContext ?: throw NativeException("CONTEXT_UNAVAILABLE")
      try { OwnedArtifactStore.usage(context.filesDir) }
      catch (error: OwnedArtifactStoreException) { throw NativeException(error.stableCode) }
      catch (_: Exception) { throw NativeException("STORAGE_WRITE_FAILED") }
    }

    AsyncFunction("getOCRCapabilities") {
      val context = appContext.reactContext ?: throw NativeException("CONTEXT_UNAVAILABLE")
      ocrProcessor.capabilities(context)
    }

    AsyncFunction("recognizeText") {
      taskId: String,
      fileUri: String,
      script: String,
      recognitionLevel: String,
      promise: Promise ->
      val context = appContext.reactContext ?: return@AsyncFunction promise.reject(NativeException("CONTEXT_UNAVAILABLE"))
      val task = try {
        ocrProcessor.prepare(context, taskId, fileUri, script, recognitionLevel)
      } catch (error: NativeException) {
        return@AsyncFunction promise.reject(error)
      }
      val processor = ocrProcessor
      val lifecycle = ocrLifecycle
      val closed = AtomicBoolean(false)
      val closeRecognizer = {
        if (closed.compareAndSet(false, true)) task.recognizer.close()
      }
      val registered = lifecycle.register(
        OcrLifecycleRegistration(
          taskId = taskId,
          close = closeRecognizer,
          rejectOnDestroy = { promise.reject(NativeException("OCR_CANCELLED")) },
        ),
      )
      if (!registered) {
        processor.cancel(taskId)
        closeRecognizer()
        processor.finish(taskId)
        return@AsyncFunction promise.reject(NativeException("OCR_CANCELLED"))
      }
      val recognition = try {
        task.recognizer.process(task.image)
      } catch (error: OutOfMemoryError) {
        settleOCRRecognitionStartFailure(
          error,
          taskId,
          closeRecognizer,
          lifecycle,
          processor::finish,
        ) { promise.reject(it) }
        return@AsyncFunction
      } catch (error: Exception) {
        settleOCRRecognitionStartFailure(
          error,
          taskId,
          closeRecognizer,
          lifecycle,
          processor::finish,
        ) { promise.reject(it) }
        return@AsyncFunction
      }
      recognition
        .addOnSuccessListener(AndroidOCRProcessScope.resultExecutor) { result ->
          val outcome = try {
            processor.result(task, result) to null
          } catch (error: NativeException) {
            null to error
          } catch (_: OutOfMemoryError) {
            null to NativeException("RESOURCE_MEMORY_PRESSURE")
          } catch (_: Exception) {
            null to NativeException("OCR_RESULT_INVALID")
          }
          lifecycle.deliver(taskId) {
            val error = outcome.second
            if (error == null) promise.resolve(outcome.first) else promise.reject(error)
          }
        }
        .addOnFailureListener(AndroidOCRProcessScope.resultExecutor) {
          lifecycle.deliver(taskId) {
            promise.reject(
              NativeException(
                processor.failureCode(taskId) ?: "OCR_RECOGNITION_FAILED",
              ),
            )
          }
        }
        .addOnCompleteListener(AndroidOCRProcessScope.resultExecutor) {
          closeRecognizer()
          lifecycle.finish(taskId)
          processor.finish(taskId)
        }
    }

    AsyncFunction("cancelTextRecognition") { taskId: String ->
      ocrProcessor.cancel(taskId)
    }

    AsyncFunction("inspectPdf") { fileUri: String, promise: Promise ->
      val context = appContext.reactContext
        ?: return@AsyncFunction promise.reject(NativeException("CONTEXT_UNAVAILABLE"))
      try {
        AndroidPDFProcessScope.executor.execute {
          try { promise.resolve(pdfProcessor.inspect(context, fileUri)) }
          catch (error: NativeException) { promise.reject(error) }
          catch (_: OutOfMemoryError) { promise.reject(NativeException("RESOURCE_MEMORY_PRESSURE")) }
          catch (_: Throwable) { promise.reject(NativeException("PDF_PAGE_EXTRACTION_FAILED")) }
        }
      } catch (_: RejectedExecutionException) {
        promise.reject(NativeException("PDF_RESOURCE_BUSY"))
      }
    }

    AsyncFunction("extractPdfPage") {
      taskId: String,
      fileUri: String,
      pageIndex: Int,
      script: String,
      promise: Promise ->
      val context = appContext.reactContext
        ?: return@AsyncFunction promise.reject(NativeException("CONTEXT_UNAVAILABLE"))
      try {
        pdfProcessor.reserve(taskId)
      } catch (error: NativeException) {
        return@AsyncFunction promise.reject(error)
      }
      val processor = pdfProcessor
      val lifecycle = pdfLifecycle
      if (!lifecycle.register(OcrLifecycleRegistration(
          taskId = taskId,
          close = {},
          rejectOnDestroy = { promise.reject(NativeException("PDF_CANCELLED")) },
        ))) {
        processor.cancel(taskId)
        processor.finish(taskId)
        return@AsyncFunction promise.reject(NativeException("PDF_CANCELLED"))
      }
      try {
        AndroidPDFProcessScope.executor.execute {
          try {
            val result = processor.extractPage(
              context = context,
              taskId = taskId,
              fileUri = fileUri,
              pageIndex = pageIndex,
              script = script,
              reserved = true,
            )
            lifecycle.deliver(taskId) { promise.resolve(result) }
          } catch (error: NativeException) {
            lifecycle.deliver(taskId) { promise.reject(error) }
          } catch (_: OutOfMemoryError) {
            lifecycle.deliver(taskId) {
              promise.reject(NativeException("RESOURCE_MEMORY_PRESSURE"))
            }
          } catch (_: Throwable) {
            lifecycle.deliver(taskId) {
              promise.reject(NativeException("PDF_PAGE_EXTRACTION_FAILED"))
            }
          } finally {
            lifecycle.finish(taskId)
            processor.finish(taskId)
          }
        }
      } catch (_: RejectedExecutionException) {
        lifecycle.deliver(taskId) { promise.reject(NativeException("PDF_RESOURCE_BUSY")) }
        lifecycle.finish(taskId)
        processor.finish(taskId)
      }
    }

    AsyncFunction("cancelPdfExtraction") { taskId: String ->
      pdfProcessor.cancel(taskId)
    }

    AsyncFunction("readPlainTextFile") { fileUri: String, promise: Promise ->
      val context = appContext.reactContext
        ?: return@AsyncFunction promise.reject(NativeException("CONTEXT_UNAVAILABLE"))
      try {
        AndroidPDFProcessScope.executor.execute {
          try { promise.resolve(AndroidPlainTextFileReader.read(context, fileUri)) }
          catch (error: NativeException) { promise.reject(error) }
          catch (_: OutOfMemoryError) { promise.reject(NativeException("RESOURCE_MEMORY_PRESSURE")) }
          catch (_: Throwable) { promise.reject(NativeException("TEXT_RESULT_INVALID")) }
        }
      } catch (_: RejectedExecutionException) {
        promise.reject(NativeException("TEXT_RESOURCE_BUSY"))
      }
    }

    AsyncFunction("probePdf") { fileUri: String ->
      val context = appContext.reactContext ?: throw NativeException("CONTEXT_UNAVAILABLE")
      val file = controlledSandboxFile(context, fileUri)
      if (!file.isFile || file.length() > 52_428_800) throw NativeException("PDF_INVALID_OR_TOO_LARGE")
      val descriptor = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
      PdfProbe.probe(descriptor)
    }
  }

  private fun controlledFileUri(value: String): Uri {
    val uri = Uri.parse(value)
    if (uri.scheme != "file") throw NativeException("INVALID_LOCAL_FILE_URI")
    return uri
  }

  private fun safeIntegerLong(value: Double): Long {
    if (!value.isFinite() || value < 0 || value > 9_007_199_254_740_991.0 || value % 1.0 != 0.0) {
      throw NativeException("SCHEMA_INVALID")
    }
    return value.toLong()
  }

  override fun onTrimMemory(level: Int) {
    if (isMemoryPressureTrimLevel(level)) {
      ocrProcessor.setMemoryPressure(true)
    }
  }

  override fun onLowMemory() {
    ocrProcessor.setMemoryPressure(true)
  }

  override fun onConfigurationChanged(newConfig: Configuration) = Unit
}

internal fun settleOCRRecognitionStartFailure(
  error: Throwable,
  taskId: String,
  closeRecognizer: () -> Unit,
  lifecycle: OcrModuleLifecycle,
  finishProcessor: (String) -> Unit,
  reject: (NativeException) -> Unit,
) {
  try {
    closeRecognizer()
    lifecycle.deliver(taskId) {
      reject(
        NativeException(
          if (error is OutOfMemoryError) "RESOURCE_MEMORY_PRESSURE"
          else "OCR_RECOGNITION_FAILED",
        ),
      )
    }
  } finally {
    try {
      lifecycle.finish(taskId)
    } finally {
      finishProcessor(taskId)
    }
  }
}

internal fun isMemoryPressureTrimLevel(level: Int): Boolean =
  level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW ||
    level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL ||
    level >= ComponentCallbacks2.TRIM_MEMORY_MODERATE

internal object InboxManifestScanner {
  private const val maximumReceiptBytes = 262_144L
  private enum class ExactSchemaVersionResult {
    SUPPORTED,
    UNSUPPORTED,
    INVALID,
  }

  private val ingestionIdPattern =
    Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
  private val mediaTypePattern =
    Regex("^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$")
  private val isoDateTimePattern =
    Regex("^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d{1,9})?Z$")
  private val sha256Pattern = Regex("^[0-9a-f]{64}$")
  private val manifestKeys = setOf(
    "schemaVersion", "ingestionId", "createdAt", "source", "status", "items",
  )
  private val copiedItemKeys = setOf(
    "id", "order", "mediaType", "status", "byteCount", "relativePath", "sha256",
  )
  private val failedItemKeys = setOf(
    "id", "order", "mediaType", "status", "byteCount", "errorCode",
  )
  private val failedRetryItemKeys = setOf("retryByteCount", "retrySha256")
  private val stableErrorCodes = setOf(
    "DOMAIN_INVALID_TRANSITION",
    "SCHEMA_INVALID",
    "SCHEMA_VERSION_UNSUPPORTED",
    "ARTIFACT_INTEGRITY_FAILED",
    "IMPORT_PROVIDER_PERMISSION_EXPIRED",
    "IMPORT_TYPE_UNSUPPORTED",
    "IMPORT_COPY_FAILED",
    "IMPORT_SIZE_LIMIT_EXCEEDED",
    "IMPORT_ITEM_LIMIT_EXCEEDED",
    "IMPORT_PARTIAL_FAILURE",
    "PDF_CANCELLED",
    "PDF_CORRUPT",
    "PDF_ENCRYPTED",
    "PDF_EMPTY",
    "PDF_TOO_LARGE",
    "PDF_TOO_MANY_PAGES",
    "PDF_PAGE_OUT_OF_RANGE",
    "PDF_PAGE_EXTRACTION_FAILED",
    "PDF_RESOURCE_BUSY",
    "PDF_RESULT_INVALID",
    "TEXT_INVALID_UTF8",
    "TEXT_TOO_LARGE",
    "TEXT_RESOURCE_BUSY",
    "TEXT_RESULT_INVALID",
    "URL_INVALID",
    "URL_TOO_LONG",
    "PIPELINE_STAGE_FAILED",
    "PROCESSOR_OUTPUT_INVALID",
    "PIPELINE_RECOVERY_REQUIRED",
    "PRIVACY_REVIEW_REQUIRED",
    "PRIVACY_EXPORT_BLOCKED",
    "RESOURCE_LOW_DISK",
    "RESOURCE_MEMORY_PRESSURE",
    "STORAGE_WRITE_FAILED",
    "STORAGE_DIVERGENCE_DETECTED",
    "STORAGE_ARTIFACT_IMMUTABLE",
    "PERSISTENCE_CONFLICT",
    "DEVELOPMENT_RESET_FORBIDDEN",
  )

  fun scan(inbox: File): List<Map<String, Any?>> {
    if (MetadataEventStore.read(requireNotNull(inbox.parentFile), "RecoveryEvents").isNotEmpty()) {
      throw NativeException("INBOX_RECOVERY_REQUIRED")
    }
    val recovery = try {
      IncompleteTransactionRecovery.recover(inbox)
    } catch (_: Exception) {
      throw NativeException("INBOX_SCAN_FAILED")
    }
    if (recovery) throw NativeException("INBOX_RECOVERY_REQUIRED")
    if (!inbox.exists()) return emptyList()
    if (!inbox.isDirectory || !inbox.canRead()) throw NativeException("INBOX_SCAN_FAILED")
    val rootPath = try { inbox.canonicalPath + File.separator }
    catch (_: Exception) { throw NativeException("INBOX_SCAN_FAILED") }
    val ids = mutableSetOf<String>()
    val ingestions = inbox.listFiles()?.sortedBy { it.name }
      ?: throw NativeException("INBOX_SCAN_FAILED")
    val manifests = mutableListOf<Map<String, Any?>>()
    for (ingestion in ingestions) {
      val file = try {
        check(!isSymbolicLink(ingestion))
        check(ingestion.isDirectory && ingestion.parentFile?.canonicalFile == inbox.canonicalFile)
        check(ingestion.canonicalPath.startsWith(rootPath))
        val id = ingestion.name
        check(ingestionIdPattern.matches(id) && UUID.fromString(id).toString() == id && ids.add(id))
        val children = ingestion.listFiles() ?: error("INBOX_SCAN_FAILED")
        check(children.none { it.isDirectory || isSymbolicLink(it) })
        File(ingestion, "manifest.json").takeIf { it.isFile }
      } catch (_: Exception) {
        quarantineMalformed(inbox, ingestion)
        throw NativeException("SCHEMA_INVALID")
      } ?: continue
      try {
        val rawManifest = file.readText()
        val manifest = strictJsonObject(rawManifest)
        validateManifest(
          manifest,
          rawManifest,
          ingestion.name,
          requireNotNull(file.parentFile),
        )
        manifests += jsonObjectToMap(manifest)
      } catch (error: InboxManifestValidationException) {
        quarantineMalformed(inbox, ingestion)
        throw NativeException(error.stableCode)
      } catch (_: IOException) {
        throw NativeException("INBOX_SCAN_FAILED")
      } catch (_: SecurityException) {
        throw NativeException("INBOX_SCAN_FAILED")
      } catch (_: Exception) {
        quarantineMalformed(inbox, ingestion)
        throw NativeException("SCHEMA_INVALID")
      }
    }
    return manifests
  }

  fun readPublished(inbox: File, ingestionId: String): Map<String, Any?> {
    if (!ingestionIdPattern.matches(ingestionId) ||
      UUID.fromString(ingestionId).toString() != ingestionId
    ) {
      throw NativeException("SCHEMA_INVALID")
    }
    if (!inbox.isDirectory || !inbox.canRead()) throw NativeException("INBOX_SCAN_FAILED")
    val ingestion = File(inbox, ingestionId)
    try {
      check(ingestion.isDirectory && ingestion.parentFile?.canonicalFile == inbox.canonicalFile)
      check(ingestion.canonicalPath.startsWith(inbox.canonicalPath + File.separator))
      val children = ingestion.listFiles() ?: error("INBOX_SCAN_FAILED")
      check(children.none { it.isDirectory })
      check(File(ingestion, "manifest.json").isFile)
    } catch (_: Exception) {
      throw NativeException("INBOX_SCAN_FAILED")
    }
    return readOwnedDirectory(ingestion, ingestionId)
  }

  /** Validates a scanner-hidden acknowledgement tombstone against its original ID. */
  fun readOwnedDirectory(ingestion: File, ingestionId: String): Map<String, Any?> {
    if (!ingestionIdPattern.matches(ingestionId) ||
      UUID.fromString(ingestionId).toString() != ingestionId
    ) {
      throw NativeException("SCHEMA_INVALID")
    }
    return try {
      check(ingestion.isDirectory && !isSymbolicLink(ingestion))
      val children = ingestion.listFiles() ?: error("INBOX_SCAN_FAILED")
      check(children.none { it.isDirectory || isSymbolicLink(it) })
      val manifestFile = File(ingestion, "manifest.json").also { check(it.isFile) }
      val rawManifest = manifestFile.readText()
      val manifest = strictJsonObject(rawManifest)
      validateManifest(manifest, rawManifest, ingestionId, ingestion)
      jsonObjectToMap(manifest)
    } catch (error: InboxManifestValidationException) {
      throw NativeException(error.stableCode)
    } catch (error: NativeException) {
      throw error
    } catch (_: IOException) {
      throw NativeException("INBOX_SCAN_FAILED")
    } catch (_: SecurityException) {
      throw NativeException("INBOX_SCAN_FAILED")
    } catch (_: Exception) {
      throw NativeException("SCHEMA_INVALID")
    }
  }

  /** Reads a compact durable ACK receipt without requiring deleted Inbox artifacts. */
  fun readAcknowledgementReceipt(receipt: File, ingestionId: String): Map<String, Any?> {
    if (!ingestionIdPattern.matches(ingestionId) ||
      UUID.fromString(ingestionId).toString() != ingestionId
    ) {
      throw NativeException("SCHEMA_INVALID")
    }
    return try {
      check(
        receipt.isFile &&
          receipt.length() in 1..maximumReceiptBytes &&
          !isSymbolicLink(receipt),
      )
      val rawManifest = receipt.readText()
      val manifest = strictJsonObject(rawManifest)
      validateManifest(manifest, rawManifest, ingestionId, ownedDirectory = null)
      jsonObjectToMap(manifest)
    } catch (error: InboxManifestValidationException) {
      throw NativeException(error.stableCode)
    } catch (error: NativeException) {
      throw error
    } catch (_: IOException) {
      throw NativeException("INBOX_SCAN_FAILED")
    } catch (_: SecurityException) {
      throw NativeException("INBOX_SCAN_FAILED")
    } catch (_: Exception) {
      throw NativeException("SCHEMA_INVALID")
    }
  }

  private fun quarantineMalformed(inbox: File, ingestion: File) {
    try {
      val container = requireNotNull(inbox.parentFile)
      val quarantine = File(container, "InboxQuarantine")
      if (quarantine.exists()) {
        check(quarantine.isDirectory && !isSymbolicLink(quarantine))
      } else {
        check(quarantine.mkdir())
        synchronizeDirectory(container)
      }
      val target = File(quarantine, "${UUID.randomUUID()}.quarantine")
      check(ingestion.renameTo(target))
      synchronizeDirectory(inbox)
      synchronizeDirectory(quarantine)
    } catch (_: Exception) {
      throw NativeException("STORAGE_WRITE_FAILED")
    }
  }

  private fun isSymbolicLink(file: File): Boolean =
    OsConstants.S_ISLNK(Os.lstat(file.path).st_mode)

  private fun synchronizeDirectory(directory: File) {
    val descriptor = Os.open(directory.path, OsConstants.O_RDONLY, 0)
    try { Os.fsync(descriptor) } finally { Os.close(descriptor) }
  }

  private fun validateManifest(
    manifest: JSONObject,
    rawManifest: String,
    expectedIngestionId: String,
    ownedDirectory: File?,
  ) {
    val schemaVersion = manifest.opt("schemaVersion")
    check(schemaVersion is Number)
    when (exactSchemaVersion(rawManifest)) {
      ExactSchemaVersionResult.SUPPORTED -> Unit
      ExactSchemaVersionResult.UNSUPPORTED ->
        throw InboxManifestValidationException("SCHEMA_VERSION_UNSUPPORTED")
      ExactSchemaVersionResult.INVALID ->
        throw InboxManifestValidationException("SCHEMA_INVALID")
    }
    check(manifest.keys().asSequence().toSet() == manifestKeys)
    val ingestionId = manifest.getString("ingestionId")
    check(ingestionIdPattern.matches(ingestionId) && UUID.fromString(ingestionId).toString() == ingestionId)
    check(ingestionId == expectedIngestionId)
    check(isIsoDateTime(manifest.getString("createdAt")))
    check(
      manifest.getString("source") in setOf(
        "ios-share-extension",
        "android-share-intent",
        "main-app-picker",
        "main-app-text",
      ),
    )
    val manifestStatus = manifest.getString("status")
    check(manifestStatus in setOf("complete", "partial", "failed"))
    val canonicalOwnedDirectory = ownedDirectory?.canonicalFile
    val items = manifest.getJSONArray("items")
    check(items.length() in 1..ShareIngestionWriter.maximumReportedItemCount)
    val ids = mutableSetOf<String>()
    var copied = 0
    var failed = 0
    for (index in 0 until items.length()) {
      val item = items.getJSONObject(index)
      val itemId = item.getString("id")
      check(ingestionIdPattern.matches(itemId) && UUID.fromString(itemId).toString() == itemId)
      check(ids.add(itemId) && nonNegativeInteger(item.opt("order")) == index.toLong())
      val mediaType = item.getString("mediaType")
      check(
        mediaType.length <= ShareIngestionWriter.maximumMediaTypeLength &&
          mediaTypePattern.matches(mediaType),
      )
      when (item.getString("status")) {
        "copied" -> {
          val keys = item.keys().asSequence().toSet()
          check(keys.all(copiedItemKeys::contains))
          check(keys.containsAll(copiedItemKeys - "sha256"))
          val relativePath = item.getString("relativePath")
          check(relativePath == "$itemId.bin" && '/' !in relativePath && '\\' !in relativePath)
          check(!item.has("localUri") && !item.has("providerUri"))
          if (item.has("sha256")) check(sha256Pattern.matches(item.getString("sha256")))
          val byteCount = requireNotNull(nonNegativeInteger(item.opt("byteCount")))
          if (canonicalOwnedDirectory != null) {
            val copiedFile = File(canonicalOwnedDirectory, relativePath).canonicalFile
            check(copiedFile.parentFile == canonicalOwnedDirectory)
            if (!copiedFile.isFile || copiedFile.length() != byteCount) {
              throw InboxManifestValidationException("ARTIFACT_INTEGRITY_FAILED")
            }
            if (item.has("sha256") && sha256(copiedFile) != item.getString("sha256")) {
              throw InboxManifestValidationException("ARTIFACT_INTEGRITY_FAILED")
            }
          }
          copied += 1
        }
        "failed" -> {
          val itemKeys = item.keys().asSequence().toSet()
          val retryByteCount = nonNegativeInteger(item.opt("retryByteCount"))
          val retrySha256 = item.opt("retrySha256") as? String
          val hasRetryMetadata = retryByteCount != null || retrySha256 != null
          check(
            itemKeys == failedItemKeys ||
              itemKeys == failedItemKeys + failedRetryItemKeys,
          )
          check(nonNegativeInteger(item.opt("byteCount")) == 0L)
          check(item.getString("errorCode") in stableErrorCodes)
          check(
            !hasRetryMetadata ||
              (
                retryByteCount != null &&
                  retryByteCount <= ShareIngestionWriter.maximumBinaryBytes &&
                  retrySha256 != null &&
                  sha256Pattern.matches(retrySha256)
              ),
          )
          if (ownedDirectory != null) {
            val retry = File(ownedDirectory, "$itemId.retry")
            val stat = runCatching { Os.lstat(retry.path) }.getOrNull()
            if (retryByteCount != null && retrySha256 != null) {
              if (
                stat == null ||
                !OsConstants.S_ISREG(stat.st_mode) ||
                OsConstants.S_ISLNK(stat.st_mode) ||
                stat.st_size != retryByteCount ||
                sha256(retry) != retrySha256
              ) {
                throw InboxManifestValidationException("ARTIFACT_INTEGRITY_FAILED")
              }
            } else if (stat != null) {
              throw InboxManifestValidationException("ARTIFACT_INTEGRITY_FAILED")
            }
          }
          failed += 1
        }
        else -> throw InboxManifestValidationException("SCHEMA_INVALID")
      }
    }
    check(
      (manifestStatus == "complete" && copied > 0 && failed == 0) ||
        (manifestStatus == "partial" && copied > 0 && failed > 0) ||
        (manifestStatus == "failed" && copied == 0 && failed > 0)
    )
  }

  private fun exactSchemaVersion(rawManifest: String): ExactSchemaVersionResult = try {
    JsonReader(StringReader(rawManifest)).use { reader ->
      reader.isLenient = false
      reader.beginObject()
      var foundVersion = false
      var supportedVersion = false
      while (reader.hasNext()) {
        val key = reader.nextName()
        if (key == "schemaVersion") {
          if (foundVersion || reader.peek() != JsonToken.NUMBER) {
            return ExactSchemaVersionResult.INVALID
          }
          foundVersion = true
          supportedVersion = reader.nextString() == "1"
        } else {
          consumeJsonValue(reader)
        }
      }
      reader.endObject()
      if (reader.peek() != JsonToken.END_DOCUMENT || !foundVersion) {
        ExactSchemaVersionResult.INVALID
      } else if (supportedVersion) {
        ExactSchemaVersionResult.SUPPORTED
      } else {
        ExactSchemaVersionResult.UNSUPPORTED
      }
    }
  } catch (_: Exception) {
    ExactSchemaVersionResult.INVALID
  }

  private fun nonNegativeInteger(value: Any?): Long? {
    val number = (value as? Number)?.toDouble() ?: return null
    if (!number.isFinite() || number < 0 || number % 1.0 != 0.0 || number > 9_007_199_254_740_991.0) {
      return null
    }
    return number.toLong()
  }

  private fun isIsoDateTime(value: String): Boolean {
    if (!isoDateTimePattern.matches(value)) return false
    val year = value.substring(0, 4).toInt()
    val month = value.substring(5, 7).toInt()
    val day = value.substring(8, 10).toInt()
    val maximumDay = when (month) {
      2 -> if (year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)) 29 else 28
      4, 6, 9, 11 -> 30
      else -> 31
    }
    return day <= maximumDay
  }

  private fun strictJsonObject(text: String): JSONObject {
    try {
      JsonReader(StringReader(text)).use { reader ->
        reader.isLenient = false
        check(reader.peek() == JsonToken.BEGIN_OBJECT)
        consumeJsonValue(reader)
        check(reader.peek() == JsonToken.END_DOCUMENT)
      }
      return JSONObject(text)
    } catch (error: InboxManifestValidationException) {
      throw error
    } catch (_: Exception) {
      throw InboxManifestValidationException("SCHEMA_INVALID")
    }
  }

  private fun consumeJsonValue(reader: JsonReader) {
    when (reader.peek()) {
      JsonToken.BEGIN_OBJECT -> {
        reader.beginObject()
        while (reader.hasNext()) {
          reader.nextName()
          consumeJsonValue(reader)
        }
        reader.endObject()
      }
      JsonToken.BEGIN_ARRAY -> {
        reader.beginArray()
        while (reader.hasNext()) consumeJsonValue(reader)
        reader.endArray()
      }
      JsonToken.STRING, JsonToken.NUMBER -> reader.nextString()
      JsonToken.BOOLEAN -> reader.nextBoolean()
      JsonToken.NULL -> reader.nextNull()
      else -> error("SCHEMA_INVALID")
    }
  }

  private fun sha256(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    try {
      file.inputStream().buffered().use { input ->
        val buffer = ByteArray(64 * 1024)
        while (true) {
          val count = input.read(buffer)
          if (count < 0) break
          digest.update(buffer, 0, count)
        }
      }
    } catch (_: IOException) {
      throw InboxManifestValidationException("ARTIFACT_INTEGRITY_FAILED")
    } catch (_: SecurityException) {
      throw InboxManifestValidationException("ARTIFACT_INTEGRITY_FAILED")
    }
    val hexadecimal = "0123456789abcdef"
    return buildString(64) {
      digest.digest().forEach { byte ->
        val value = byte.toInt() and 0xff
        append(hexadecimal[value ushr 4])
        append(hexadecimal[value and 0x0f])
      }
    }
  }

  private fun jsonObjectToMap(value: JSONObject): Map<String, Any?> = value.keys().asSequence().associateWith { key ->
    when (val item = value.get(key)) { is JSONObject -> jsonObjectToMap(item); is org.json.JSONArray -> (0 until item.length()).map { index -> val child = item.get(index); if (child is JSONObject) jsonObjectToMap(child) else child }; JSONObject.NULL -> null; else -> item }
  }
}

internal object IncompleteTransactionRecovery {
  fun recover(inbox: File, beforeLockRegistryScan: () -> Unit = {}): Boolean {
    val filesDir = requireNotNull(inbox.parentFile)
    recoverOrphanLocks(filesDir, beforeLockRegistryScan)
    val staging = File(filesDir, "InboxStaging")
    var recovered = recoverCandidates(staging, filesDir) { true }
    recovered = recoverCandidates(inbox, filesDir) { directory ->
      !File(directory, "manifest.json").isFile
    } || recovered
    return recovered
  }

  private fun recoverOrphanLocks(filesDir: File, beforeLockRegistryScan: () -> Unit) {
    val lockDirectory = File(filesDir, "InboxWriterLocks")
    if (!lockDirectory.exists()) return
    beforeLockRegistryScan()
    InboxWriterOwnership.withRegistry(filesDir) {
      check(lockDirectory.isDirectory && lockDirectory.canRead())
      val lockName = Regex("^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\\.lock$", RegexOption.IGNORE_CASE)
      (lockDirectory.listFiles() ?: error("INBOX_LOCK_SCAN_FAILED")).forEach { lockFile ->
        if (lockFile.name == InboxWriterOwnership.registryFileName) return@forEach
        val match = lockName.matchEntire(lockFile.name)
        check(lockFile.isFile && match != null)
        val id = requireNotNull(match).groupValues[1]
        val staging = File(filesDir, "InboxStaging/$id")
        val published = File(filesDir, "Inbox/$id")
        val incompletePublished = published.exists() && !File(published, "manifest.json").isFile
        if (staging.exists() || incompletePublished) return@forEach
        InboxWriterOwnership.removeAbandonedLockWhileCoordinated(lockFile)
      }
    }
  }

  private fun recoverCandidates(
    root: File,
    filesDir: File,
    isIncomplete: (File) -> Boolean,
  ): Boolean {
    if (!root.exists()) return false
    check(root.isDirectory && root.canRead())
    val rootPath = root.canonicalPath + File.separator
    var recovered = false
    (root.listFiles() ?: error("INBOX_SCAN_FAILED"))
      .filter { directory -> directory.isDirectory && isIncomplete(directory) }
      .forEach { directory ->
        check(directory.canonicalPath.startsWith(rootPath))
        InboxWriterOwnership.acquireForRecovery(filesDir, directory)?.use {
          MetadataEventStore.persistRecovery(requireNotNull(root.parentFile))
          check(directory.deleteRecursively() && !directory.exists())
          recovered = true
        }
      }
    return recovered
  }

}

object MetadataEventStore {
  private val canonicalIdPattern = Regex(
    "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
  )

  fun persistShareResult(
    filesDir: File,
    result: String,
    transactionId: String? = null,
    eventId: String = UUID.randomUUID().toString(),
    code: String? = null,
  ): Map<String, Any> =
    persist(filesDir, "PendingShareEvents", mapOf("result" to result) +
      (transactionId?.let { mapOf("transactionId" to it) } ?: emptyMap()) +
      (code?.let { mapOf("code" to it) } ?: emptyMap()), eventId)

  fun persistRecovery(filesDir: File): Map<String, Any> =
    persist(filesDir, "RecoveryEvents", mapOf("code" to "INBOX_RECOVERY_REQUIRED"), UUID.randomUUID().toString())

  fun read(filesDir: File, folder: String): List<Map<String, Any>> {
    val directory = File(filesDir, folder)
    if (!directory.exists()) return emptyList()
    if (!directory.isDirectory) throw MetadataEventException("NATIVE_EVENT_STORE_READ_FAILED")
    return (directory.listFiles() ?: throw MetadataEventException("NATIVE_EVENT_STORE_READ_FAILED"))
      .filter { it.isFile && it.extension == "json" }
      .map { file ->
        try {
          val filenameId = file.name.removeSuffix(".json")
          check(isCanonicalId(filenameId))
          val value = JSONObject(file.readText())
          val id = value.getString("id")
          check(value.getInt("schemaVersion") == 1 && isCanonicalId(id) && id == filenameId)
          if (folder == "PendingShareEvents")
            check(value.getString("result") == "complete" || value.getString("result") == "failed")
          if (folder == "RecoveryEvents")
            check(value.getString("code") == "INBOX_RECOVERY_REQUIRED")
          mapOf(
            "schemaVersion" to 1,
            "id" to id,
            "createdAtMs" to value.getLong("createdAtMs"),
            "result" to value.optString("result", ""),
            "code" to value.optString("code", ""),
          ).filterValues { it != "" }
        } catch (_: java.io.IOException) {
          throw MetadataEventException("NATIVE_EVENT_STORE_READ_FAILED")
        } catch (_: Exception) {
          val quarantined = File(directory, "${file.name}.${UUID.randomUUID()}.invalid")
          if (!file.renameTo(quarantined))
            throw MetadataEventException("NATIVE_EVENT_STORE_READ_FAILED")
          throw MetadataEventException("NATIVE_EVENT_SCHEMA_INVALID")
        }
      }.sortedBy { it["createdAtMs"] as Long }
  }

  fun ack(filesDir: File, folder: String, id: String): Boolean {
    if (!isCanonicalId(id))
      throw MetadataEventException("METADATA_EVENT_ID_INVALID")
    val event = File(File(filesDir, folder), "$id.json")
    if (!event.exists()) return true
    if (!event.delete()) {
      val code = if (folder == "RecoveryEvents") "NATIVE_RECOVERY_ACK_FAILED" else "NATIVE_SHARE_ACK_FAILED"
      throw MetadataEventException(code)
    }
    return true
  }

  private fun persist(filesDir: File, folder: String, fields: Map<String, String>, id: String): Map<String, Any> {
    if (!isCanonicalId(id)) throw MetadataEventException("METADATA_EVENT_ID_INVALID")
    val directory = File(filesDir, folder)
    check(directory.mkdirs() || directory.isDirectory)
    val createdAtMs = System.currentTimeMillis()
    val payload = JSONObject().put("schemaVersion", 1).put("id", id).put("createdAtMs", createdAtMs)
    fields.forEach { (key, value) -> payload.put(key, value) }
    val partial = File(directory, "$id.partial")
    val published = File(directory, "$id.json")
    if (published.exists()) {
      val existing = try { JSONObject(published.readText()) }
      catch (_: Exception) { throw MetadataEventException("NATIVE_EVENT_CONFLICT") }
      try {
        check(existing.getInt("schemaVersion") == 1 && existing.getString("id") == id)
        fields.forEach { (key, value) -> check(existing.getString(key) == value) }
        val existingCreatedAt = existing.getLong("createdAtMs")
        return mapOf("schemaVersion" to 1, "id" to id, "createdAtMs" to existingCreatedAt) + fields
      } catch (_: Exception) {
        throw MetadataEventException("NATIVE_EVENT_CONFLICT")
      }
    }
    try {
      partial.writeText(payload.toString())
      check(partial.renameTo(published))
    } finally {
      partial.delete()
    }
    return mapOf("schemaVersion" to 1, "id" to id, "createdAtMs" to createdAtMs) + fields
  }

  private fun isCanonicalId(id: String): Boolean =
    canonicalIdPattern.matches(id) && runCatching { UUID.fromString(id).toString() }.getOrNull() == id
}

class MetadataEventException(val stableCode: String) : Exception(stableCode)

object EphemeralShareEventStore {
  private const val capacity = 16
  private const val overflowId = "00000000-0000-4000-8000-000000000001"
  private val events = LinkedHashMap<String, Map<String, Any>>()
  private var overflowed = false

  @Synchronized
  fun publishIfEphemeral(event: Map<String, Any>) {
    if (event["durable"] != false) return
    val id = event["id"] as? String ?: return
    if (events.size >= capacity && !events.containsKey(id)) {
      overflowed = true
      return
    }
    events[id] = event
  }

  @Synchronized fun read(): List<Map<String, Any>> = events.values.toList() +
    if (overflowed) listOf(mapOf(
      "schemaVersion" to 1,
      "id" to overflowId,
      "result" to "failed",
      "durable" to false,
      "code" to "SHARE_EPHEMERAL_QUEUE_OVERFLOW",
    )) else emptyList()

  @Synchronized fun ack(id: String): Boolean {
    if (id == overflowId && overflowed) { overflowed = false; return true }
    return events.remove(id) != null
  }
}

internal object OcrBoundsNormalizer {
  fun normalize(left: Int, top: Int, boxWidth: Int, boxHeight: Int, sourceWidth: Int, sourceHeight: Int): Map<String, Double> {
    val width = sourceWidth.coerceAtLeast(1).toDouble()
    val height = sourceHeight.coerceAtLeast(1).toDouble()
    val clippedLeft = left.toDouble().coerceIn(0.0, width)
    val clippedTop = top.toDouble().coerceIn(0.0, height)
    val clippedRight = (left.toLong() + boxWidth).toDouble().coerceIn(clippedLeft, width)
    val clippedBottom = (top.toLong() + boxHeight).toDouble().coerceIn(clippedTop, height)
    return mapOf(
      "x" to clippedLeft / width,
      "y" to clippedTop / height,
      "width" to (clippedRight - clippedLeft) / width,
      "height" to (clippedBottom - clippedTop) / height,
    )
  }
}

internal object PdfProbe {
  fun probe(descriptor: ParcelFileDescriptor): Map<String, Any> = PdfRenderer(descriptor).use { renderer ->
    if (renderer.pageCount > 25) throw NativeException("PDF_TOO_MANY_PAGES")
    var embeddedTextPages = 0
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) {
      for (index in 0 until renderer.pageCount) {
        renderer.openPage(index).use { page ->
          if (page.textContents.any { content -> content.text.isNotBlank() }) embeddedTextPages += 1
        }
      }
    }
    mapOf(
      "pageCount" to renderer.pageCount,
      "embeddedTextPages" to embeddedTextPages,
      "renderedFallbackPages" to renderer.pageCount - embeddedTextPages,
      "engine" to "pdf-renderer",
      "limit" to mapOf("pages" to 25, "bytes" to 52_428_800),
    )
  }
}

internal class NativeException(code: String) : CodedException(code, code, null)

private class InboxManifestValidationException(val stableCode: String) : Exception(stableCode)
