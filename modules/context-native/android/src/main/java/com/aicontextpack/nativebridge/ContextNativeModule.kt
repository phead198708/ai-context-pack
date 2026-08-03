package com.aicontextpack.nativebridge

import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.Build
import android.os.ParcelFileDescriptor
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.Text
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject
import java.io.File
import java.util.UUID

class ContextNativeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ContextNative")

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
      MetadataEventStore.ack(context.filesDir, "PendingShareEvents", id)
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
      MetadataEventStore.ack(context.filesDir, "RecoveryEvents", id)
    }

    AsyncFunction("recognizeText") { fileUri: String, script: String, promise: Promise ->
      val context = appContext.reactContext ?: return@AsyncFunction promise.reject(NativeException("CONTEXT_UNAVAILABLE"))
      val uri = controlledFileUri(fileUri)
      val started = System.nanoTime()
      val image = try { InputImage.fromFilePath(context, uri) } catch (_: Exception) { return@AsyncFunction promise.reject(NativeException("OCR_IMAGE_DECODE_FAILED")) }
      val recognizer = if (script == "chinese") TextRecognition.getClient(ChineseTextRecognizerOptions.Builder().build()) else TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
      recognizer.process(image)
        .addOnSuccessListener { result -> promise.resolve(ocrResult(result, image.width, image.height, script, started)) }
        .addOnFailureListener { promise.reject(NativeException("OCR_RECOGNITION_FAILED")) }
        .addOnCompleteListener { recognizer.close() }
    }

    AsyncFunction("probePdf") { fileUri: String ->
      val file = File(controlledFileUri(fileUri).path ?: throw NativeException("INVALID_LOCAL_FILE_URI"))
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

  private fun ocrResult(result: Text, sourceWidth: Int, sourceHeight: Int, script: String, started: Long): Map<String, Any> {
    val width = sourceWidth.coerceAtLeast(1)
    val height = sourceHeight.coerceAtLeast(1)
    val blocks = result.textBlocks.mapNotNull { block -> block.boundingBox?.let { box -> mapOf("text" to block.text, "bounds" to OcrBoundsNormalizer.normalize(box.left, box.top, box.width(), box.height(), width, height)) } }
    return mapOf("schemaVersion" to 1, "text" to result.text, "blocks" to blocks,
      "durationMs" to (System.nanoTime() - started) / 1_000_000.0,
      "engine" to if (script == "chinese") "ml-kit-chinese" else "ml-kit-latin", "revision" to "16.0.1")
  }

}

internal object InboxManifestScanner {
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
    val files = try { manifestFiles(inbox) }
    catch (_: Exception) { throw NativeException("INBOX_SCAN_FAILED") }
    return files.map { file ->
      try {
        val manifest = JSONObject(file.readText())
        validateOwnedManifest(manifest, requireNotNull(file.parentFile))
        jsonObjectToMap(manifest)
      } catch (_: Exception) {
        throw NativeException("INBOX_MANIFEST_INVALID")
      }
    }
  }

  private fun manifestFiles(root: File): List<File> {
    val rootPath = root.canonicalPath + File.separator
    val manifests = mutableListOf<File>()
    fun visit(directory: File) {
      val children = directory.listFiles() ?: error("INBOX_SCAN_FAILED")
      children.forEach { child ->
        check(child.canonicalPath.startsWith(rootPath))
        when {
          child.isDirectory -> visit(child)
          child.isFile && child.name == "manifest.json" -> manifests += child
        }
      }
    }
    visit(root)
    return manifests
  }

  private fun validateOwnedManifest(manifest: JSONObject, ingestion: File) {
    val ingestionPath = ingestion.canonicalPath + File.separator
    val items = manifest.getJSONArray("items")
    for (index in 0 until items.length()) {
      val item = items.getJSONObject(index)
      val uri = Uri.parse(item.getString("localUri"))
      check(uri.scheme == "file" && uri.authority.isNullOrEmpty())
      val path = File(requireNotNull(uri.path)).canonicalPath
      check(path.startsWith(ingestionPath))
      if (item.getString("status") == "copied") {
        val copiedFile = File(path)
        check(copiedFile.isFile && copiedFile.length() == item.getLong("byteCount"))
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
  private val idPattern = Regex("^[0-9a-fA-F-]{36}$")

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
          val value = JSONObject(file.readText())
          val id = value.getString("id")
          check(value.getInt("schemaVersion") == 1 && idPattern.matches(id))
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
          val quarantined = File(directory, "${file.nameWithoutExtension}.invalid")
          if (!file.renameTo(quarantined))
            throw MetadataEventException("NATIVE_EVENT_STORE_READ_FAILED")
          throw MetadataEventException("NATIVE_EVENT_SCHEMA_INVALID")
        }
      }.sortedBy { it["createdAtMs"] as Long }
  }

  fun ack(filesDir: File, folder: String, id: String): Boolean {
    require(idPattern.matches(id))
    val event = File(File(filesDir, folder), "$id.json")
    return !event.exists() || event.delete()
  }

  private fun persist(filesDir: File, folder: String, fields: Map<String, String>, id: String): Map<String, Any> {
    require(idPattern.matches(id))
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

internal class NativeException(code: String) : CodedException(code)
