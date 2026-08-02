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
import java.io.RandomAccessFile
import java.nio.channels.OverlappingFileLockException
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
      MetadataEventStore.read(context.filesDir, "PendingShareEvents")
    }

    AsyncFunction("ackPendingShareEvent") { id: String ->
      val context = appContext.reactContext ?: throw NativeException("CONTEXT_UNAVAILABLE")
      MetadataEventStore.ack(context.filesDir, "PendingShareEvents", id)
    }

    AsyncFunction("getPendingRecoveryEvent") {
      val context = appContext.reactContext ?: throw NativeException("CONTEXT_UNAVAILABLE")
      MetadataEventStore.read(context.filesDir, "RecoveryEvents").firstOrNull()
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
        validateOwnedManifest(manifest, inbox)
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

  private fun validateOwnedManifest(manifest: JSONObject, inbox: File) {
    val inboxPath = inbox.canonicalPath + File.separator
    val items = manifest.getJSONArray("items")
    for (index in 0 until items.length()) {
      val item = items.getJSONObject(index)
      val uri = Uri.parse(item.getString("localUri"))
      check(uri.scheme == "file" && uri.authority.isNullOrEmpty())
      val path = File(requireNotNull(uri.path)).canonicalPath
      check(path.startsWith(inboxPath))
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
  fun recover(inbox: File): Boolean {
    val filesDir = requireNotNull(inbox.parentFile)
    val staging = File(filesDir, "InboxStaging")
    var recovered = recoverCandidates(staging, filesDir) { true }
    recovered = recoverCandidates(inbox, filesDir) { directory ->
      !File(directory, "manifest.json").isFile
    } || recovered
    return recovered
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
        acquireAbandonedWriterLock(directory, filesDir)?.use {
          MetadataEventStore.persistRecovery(requireNotNull(root.parentFile))
          check(directory.deleteRecursively() && !directory.exists())
          recovered = true
        }
      }
    return recovered
  }

  private fun acquireAbandonedWriterLock(directory: File, filesDir: File): AutoCloseable? {
    val external = File(File(filesDir, "InboxWriterLocks"), "${directory.name}.lock")
    val lockFile = if (external.exists()) external else File(directory, ".writer.lock")
    if (!lockFile.exists()) return AutoCloseable {}
    val file = RandomAccessFile(lockFile, "rw")
    val lock = try { file.channel.tryLock() }
    catch (_: OverlappingFileLockException) { null }
    if (lock == null) { file.close(); return null }
    return AutoCloseable {
      lock.release()
      file.close()
      if (lockFile == external) external.delete()
    }
  }
}

object MetadataEventStore {
  private val idPattern = Regex("^[0-9a-fA-F-]{36}$")

  fun persistShareResult(filesDir: File, result: String): Map<String, Any> =
    persist(filesDir, "PendingShareEvents", mapOf("result" to result))

  fun persistRecovery(filesDir: File): Map<String, Any> =
    persist(filesDir, "RecoveryEvents", mapOf("code" to "INBOX_RECOVERY_REQUIRED"))

  fun read(filesDir: File, folder: String): List<Map<String, Any>> {
    val directory = File(filesDir, folder)
    if (!directory.exists()) return emptyList()
    check(directory.isDirectory)
    return (directory.listFiles() ?: error("EVENT_STORE_READ_FAILED"))
      .filter { it.isFile && it.extension == "json" }
      .map { file ->
        val value = JSONObject(file.readText())
        mapOf(
          "schemaVersion" to value.getInt("schemaVersion"),
          "id" to value.getString("id"),
          "createdAtMs" to value.getLong("createdAtMs"),
          "result" to value.optString("result", ""),
          "code" to value.optString("code", ""),
        ).filterValues { it != "" }
      }.sortedBy { it["createdAtMs"] as Long }
  }

  fun ack(filesDir: File, folder: String, id: String): Boolean {
    require(idPattern.matches(id))
    val event = File(File(filesDir, folder), "$id.json")
    return !event.exists() || event.delete()
  }

  private fun persist(filesDir: File, folder: String, fields: Map<String, String>): Map<String, Any> {
    val id = UUID.randomUUID().toString()
    val directory = File(filesDir, folder)
    check(directory.mkdirs() || directory.isDirectory)
    val createdAtMs = System.currentTimeMillis()
    val payload = JSONObject().put("schemaVersion", 1).put("id", id).put("createdAtMs", createdAtMs)
    fields.forEach { (key, value) -> payload.put(key, value) }
    val partial = File(directory, "$id.partial")
    val published = File(directory, "$id.json")
    try {
      partial.writeText(payload.toString())
      check(partial.renameTo(published))
    } finally {
      if (!published.exists()) partial.delete()
    }
    return mapOf("schemaVersion" to 1, "id" to id, "createdAtMs" to createdAtMs) + fields
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
