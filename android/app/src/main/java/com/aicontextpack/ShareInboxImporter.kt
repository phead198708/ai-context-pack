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

object ShareInboxImporter {
  @Suppress("DEPRECATION")
  fun importIfSupported(context: Context, intent: Intent?) {
    if (intent?.action != Intent.ACTION_SEND || intent.type?.startsWith("image/") != true) return
    val source = intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM) ?: return
    val ingestionId = UUID.randomUUID().toString()
    val itemId = UUID.randomUUID().toString()
    val directory = File(context.filesDir, "Inbox/$ingestionId").apply { mkdirs() }
    val partial = File(directory, "$itemId.partial")
    val destination = File(directory, "$itemId.bin")
    val manifest = File(directory, "manifest.json")
    val mediaType = intent.type ?: "application/octet-stream"
    val item = JSONObject().put("id", itemId).put("mediaType", mediaType)
    val status = try {
      context.contentResolver.openInputStream(source).use { input ->
        requireNotNull(input) { "SHARE_URI_UNREADABLE" }
        partial.outputStream().use { output -> input.copyTo(output) }
      }
      check(partial.renameTo(destination)) { "SHARE_ATOMIC_MOVE_FAILED" }
      item.put("byteCount", destination.length()).put("localUri", destination.toURI().toString()).put("status", "copied")
      "complete"
    } catch (_: Exception) {
      partial.delete()
      item.put("byteCount", 0).put("localUri", "file:///unavailable").put("status", "failed").put("errorCode", "SHARE_COPY_FAILED")
      "failed"
    }
    val payload = JSONObject()
      .put("schemaVersion", 1).put("ingestionId", ingestionId).put("createdAt", isoTimestamp())
      .put("source", "android-share-intent").put("status", status).put("items", JSONArray().put(item))
    val tempManifest = File(directory, "manifest.partial")
    tempManifest.writeText(payload.toString())
    check(tempManifest.renameTo(manifest)) { "MANIFEST_ATOMIC_MOVE_FAILED" }
  }

  private fun isoTimestamp(): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
    timeZone = TimeZone.getTimeZone("UTC")
  }.format(Date())
}
