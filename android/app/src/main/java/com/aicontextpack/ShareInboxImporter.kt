package com.aicontextpack

import android.content.Context
import android.content.Intent
import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
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
    val source = intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
    executor.execute {
      val result = try {
        requireNotNull(source) { "SHARE_STREAM_MISSING" }
        val mediaType = selectConcreteImageMediaType(intent.type, context.contentResolver.getType(source))
        if (mediaType == null) Result.FAILED else importImage(context, source, mediaType)
      } catch (_: Exception) {
        Result.FAILED
      }
      completion(result)
    }
  }

  internal fun importImage(context: Context, source: Uri, mediaType: String): Result {
    val ingestionId = UUID.randomUUID().toString()
    val itemId = UUID.randomUUID().toString()
    val directory = File(context.filesDir, "InboxStaging/$ingestionId")
    val lockDirectory = File(context.filesDir, "InboxWriterLocks")
    val publishedDirectory = File(context.filesDir, "Inbox/$ingestionId")
    val partial = File(directory, "$itemId.partial")
    val destination = File(directory, "$itemId.bin")
    val manifest = File(directory, "manifest.json")
    var lockFile: RandomAccessFile? = null
    var writerLock: java.nio.channels.FileLock? = null
    return try {
      require(selectConcreteImageMediaType(mediaType, null) != null) { "SHARE_MIME_INVALID" }
      check(lockDirectory.mkdirs() || lockDirectory.isDirectory) { "SHARE_LOCK_DIRECTORY_CREATE_FAILED" }
      lockFile = RandomAccessFile(File(lockDirectory, "$ingestionId.lock"), "rw")
      writerLock = lockFile.channel.lock()
      check(directory.mkdirs()) { "SHARE_DIRECTORY_CREATE_FAILED" }
      context.contentResolver.openInputStream(source).use { input ->
        requireNotNull(input) { "SHARE_URI_UNREADABLE" }
        partial.outputStream().use { output -> copyBounded(input, output, maxImageBytes) }
      }
      check(partial.renameTo(destination)) { "SHARE_ATOMIC_MOVE_FAILED" }
      val publishedDestination = File(publishedDirectory, destination.name)
      val item = JSONObject().put("id", itemId).put("mediaType", mediaType)
        .put("byteCount", destination.length()).put("localUri", publishedDestination.toURI().toString()).put("status", "copied")
      val payload = JSONObject()
        .put("schemaVersion", 1).put("ingestionId", ingestionId).put("createdAt", isoTimestamp())
        .put("source", "android-share-intent").put("status", "complete").put("items", JSONArray().put(item))
      val tempManifest = File(directory, "manifest.partial")
      tempManifest.writeText(payload.toString())
      check(tempManifest.renameTo(manifest)) { "MANIFEST_ATOMIC_MOVE_FAILED" }
      check(publishedDirectory.parentFile?.mkdirs() == true || publishedDirectory.parentFile?.isDirectory == true)
      check(directory.renameTo(publishedDirectory)) { "INGESTION_ATOMIC_PUBLISH_FAILED" }
      Result.COMPLETE
    } catch (_: Exception) {
      directory.deleteRecursively()
      Result.FAILED
    } finally {
      runCatching { writerLock?.release() }
      runCatching { lockFile?.close() }
      runCatching { File(lockDirectory, "$ingestionId.lock").delete() }
    }
  }

  internal fun selectConcreteImageMediaType(intentType: String?, resolvedType: String?): String? =
    sequenceOf(resolvedType, intentType).firstOrNull { type ->
      type != null && concreteImageMime.matches(type)
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

  private val concreteImageMime = Regex("^image/[a-z0-9][a-z0-9!#$&^_.+-]*$", RegexOption.IGNORE_CASE)
}
