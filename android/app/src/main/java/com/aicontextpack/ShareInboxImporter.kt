package com.aicontextpack

import android.content.Context
import android.content.Intent
import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import java.util.concurrent.Executors

object ShareInboxImporter {
  private const val maxImageBytes = 52_428_800L
  private val executor = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "share-inbox-import").apply { isDaemon = true }
  }

  enum class Result(val wireValue: String) { COMPLETE("complete"), FAILED("failed") }

  @Suppress("DEPRECATION")
  fun importIfSupportedAsync(context: Context, intent: Intent?, completion: (Result) -> Unit) {
    if (intent?.action != Intent.ACTION_SEND || intent.type?.startsWith("image/") != true) return
    val source = intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM) ?: return
    val mediaType = intent.type ?: "application/octet-stream"
    executor.execute { completion(importImage(context, source, mediaType)) }
  }

  internal fun importImage(context: Context, source: Uri, mediaType: String): Result {
    val ingestionId = UUID.randomUUID().toString()
    val itemId = UUID.randomUUID().toString()
    val directory = File(context.filesDir, "Inbox/$ingestionId")
    val partial = File(directory, "$itemId.partial")
    val destination = File(directory, "$itemId.bin")
    val manifest = File(directory, "manifest.json")
    return try {
      check(directory.mkdirs()) { "SHARE_DIRECTORY_CREATE_FAILED" }
      context.contentResolver.openInputStream(source).use { input ->
        requireNotNull(input) { "SHARE_URI_UNREADABLE" }
        partial.outputStream().use { output -> copyBounded(input, output, maxImageBytes) }
      }
      check(partial.renameTo(destination)) { "SHARE_ATOMIC_MOVE_FAILED" }
      val item = JSONObject().put("id", itemId).put("mediaType", mediaType)
        .put("byteCount", destination.length()).put("localUri", destination.toURI().toString()).put("status", "copied")
      val payload = JSONObject()
        .put("schemaVersion", 1).put("ingestionId", ingestionId).put("createdAt", isoTimestamp())
        .put("source", "android-share-intent").put("status", "complete").put("items", JSONArray().put(item))
      val tempManifest = File(directory, "manifest.partial")
      tempManifest.writeText(payload.toString())
      check(tempManifest.renameTo(manifest)) { "MANIFEST_ATOMIC_MOVE_FAILED" }
      Result.COMPLETE
    } catch (_: Exception) {
      directory.deleteRecursively()
      Result.FAILED
    }
  }

  internal fun copyBounded(input: java.io.InputStream, output: java.io.OutputStream, limit: Long): Long {
    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
    var total = 0L
    while (true) {
      val read = input.read(buffer)
      if (read < 0) return total
      total += read
      check(total <= limit) { "SHARE_IMAGE_TOO_LARGE" }
      output.write(buffer, 0, read)
    }
  }

  private fun isoTimestamp(): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
    timeZone = TimeZone.getTimeZone("UTC")
  }.format(Date())
}
