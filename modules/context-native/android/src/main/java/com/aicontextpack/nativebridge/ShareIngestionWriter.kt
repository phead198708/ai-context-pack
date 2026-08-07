package com.aicontextpack.nativebridge

import android.system.Os
import android.system.OsConstants
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileNotFoundException
import java.io.FileOutputStream
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

/** A single provider value accepted by the Android system-share entry point. */
data class ShareIngestionInput(
  val id: String,
  val order: Int,
  val declaredMediaType: String?,
  val openStream: (() -> InputStream?)? = null,
  val preflightError: String? = null,
)

data class ShareIngestionSummary(
  val ingestionId: String,
  val status: String,
  val copied: Int,
  val rejected: Int,
  val failed: Int,
  val replayed: Boolean,
  val manifest: Map<String, Any?>,
)

class ShareIngestionInterruptionException : Exception("SHARE_INGESTION_INTERRUPTED")

class ShareInputCollectionException(
  val stableCode: String,
) : Exception(stableCode)

/**
 * Streams provider values into an app-owned staging directory and publishes exactly one
 * ImportManifestV1 by atomic rename. Detection is byte-based; provider MIME and filenames are
 * hints only and never become durable references.
 */
object ShareIngestionWriter {
  const val maximumItemCount = 20
  const val maximumReportedItemCount = 128
  const val maximumBinaryBytes = 52_428_800L
  const val maximumTextBytes = 1_048_576L
  const val maximumMediaTypeLength = 127

  enum class Point {
    AFTER_FIRST_CHUNK,
    BEFORE_ITEM_PUBLISH,
    BEFORE_MANIFEST_PUBLISH,
    BEFORE_DIRECTORY_PUBLISH,
    AFTER_DIRECTORY_PUBLISH,
  }

  fun publish(
    filesDir: File,
    ingestionId: String,
    inputs: List<ShareIngestionInput>,
    now: () -> Date = { Date() },
    operationHook: (Point) -> Unit = {},
  ): ShareIngestionSummary {
    requireCanonicalUuid(ingestionId)
    require(inputs.isNotEmpty())
    require(inputs.size <= maximumReportedItemCount)
    require(inputs.map { it.order } == inputs.indices.toList())
    require(inputs.map { it.id }.distinct().size == inputs.size)
    inputs.forEach { requireCanonicalUuid(it.id) }

    val inbox = File(filesDir, "Inbox")
    val publishedDirectory = File(inbox, ingestionId)
    if (File(publishedDirectory, "manifest.json").isFile) {
      return summary(InboxManifestScanner.readPublished(inbox, ingestionId), replayed = true)
    }

    val staging = File(filesDir, "InboxStaging/$ingestionId")
    var committed = false
    var ownershipAcquired = false
    try {
      acquireOwnership(filesDir, ingestionId).use {
        ownershipAcquired = true
        if (File(publishedDirectory, "manifest.json").isFile) {
          return summary(InboxManifestScanner.readPublished(inbox, ingestionId), replayed = true)
        }
        check(!publishedDirectory.exists()) { "INGESTION_DESTINATION_CONFLICT" }
        check(!staging.exists()) { "INGESTION_RECOVERY_REQUIRED" }
        val stagingRoot = requireNotNull(staging.parentFile)
        ensureDurableDirectory(stagingRoot)
        check(staging.mkdir()) { "INGESTION_STAGING_CREATE_FAILED" }
        synchronizeDirectory(stagingRoot)

        val items = inputs.map { input -> copyInput(staging, input, operationHook) }
        val copied = items.count { it.getString("status") == "copied" }
        val failed = items.size - copied
        val status = when {
          copied == items.size -> "complete"
          copied > 0 -> "partial"
          else -> "failed"
        }
        val manifest = JSONObject()
          .put("schemaVersion", 1)
          .put("ingestionId", ingestionId)
          .put("createdAt", isoTimestamp(now()))
          .put("source", "android-share-intent")
          .put("status", status)
          .put("items", JSONArray(items))
        val partialManifest = File(staging, "manifest.partial")
        val finalManifest = File(staging, "manifest.json")
        writeDurably(partialManifest, manifest.toString().toByteArray(StandardCharsets.UTF_8))
        operationHook(Point.BEFORE_MANIFEST_PUBLISH)
        atomicRename(partialManifest, finalManifest)
        synchronizeDirectory(staging)
        ensureDurableDirectory(inbox)
        operationHook(Point.BEFORE_DIRECTORY_PUBLISH)
        atomicRename(staging, publishedDirectory)
        committed = true
        // The directory rename is the visibility commit point. A later parent-directory
        // fsync failure cannot safely be reported as a failed import while the complete
        // manifest is already visible; retain and return that committed import instead.
        try {
          operationHook(Point.AFTER_DIRECTORY_PUBLISH)
        } catch (_: Exception) {
          // Fault injection models a failure in the post-rename durability window.
        }
        try {
          synchronizeDirectory(inbox)
        } catch (_: Exception) {
          // The validated published import remains the authoritative result.
        }
      }
      return summary(
        InboxManifestScanner.readPublished(inbox, ingestionId),
        replayed = false,
      )
    } finally {
      if (!committed && ownershipAcquired) runCatching { staging.deleteRecursively() }
    }
  }

  private fun copyInput(
    staging: File,
    input: ShareIngestionInput,
    operationHook: (Point) -> Unit,
  ): JSONObject {
    input.preflightError?.let { code ->
      require(code in failedItemCodes)
      return failedItem(input, code)
    }
    val partial = File(staging, "${input.id}.partial")
    val destination = File(staging, "${input.id}.bin")
    return try {
      val source = input.openStream?.invoke()
        ?: throw ShareInputException("IMPORT_PROVIDER_PERMISSION_EXPIRED")
      val digest = MessageDigest.getInstance("SHA-256")
      val byteCount = source.use { stream ->
        FileOutputStream(partial).use { output ->
          val buffer = ByteArray(64 * 1024)
          var total = 0L
          var firstChunk = true
          while (true) {
            val count = stream.read(buffer)
            if (count < 0) break
            if (count == 0) {
              val byte = stream.read()
              if (byte < 0) break
              total += 1
              if (total > maximumBinaryBytes) {
                throw ShareInputException("IMPORT_SIZE_LIMIT_EXCEEDED")
              }
              output.write(byte)
              digest.update(byte.toByte())
              if (firstChunk) {
                firstChunk = false
                operationHook(Point.AFTER_FIRST_CHUNK)
              }
              continue
            }
            total += count
            if (total > maximumBinaryBytes) {
              throw ShareInputException("IMPORT_SIZE_LIMIT_EXCEEDED")
            }
            output.write(buffer, 0, count)
            digest.update(buffer, 0, count)
            if (firstChunk) {
              firstChunk = false
              operationHook(Point.AFTER_FIRST_CHUNK)
            }
          }
          output.fd.sync()
          total
        }
      }
      val detectedMediaType = detectMediaType(partial)
      if (!declaredTypeAllows(input.declaredMediaType, detectedMediaType)) {
        throw ShareInputException("IMPORT_TYPE_UNSUPPORTED", detectedMediaType)
      }
      operationHook(Point.BEFORE_ITEM_PUBLISH)
      atomicRename(partial, destination)
      synchronizeDirectory(staging)
      JSONObject()
        .put("id", input.id)
        .put("order", input.order)
        .put("mediaType", detectedMediaType)
        .put("status", "copied")
        .put("byteCount", byteCount)
        .put("relativePath", destination.name)
        .put("sha256", digest.digest().toHex())
    } catch (error: ShareIngestionInterruptionException) {
      throw error
    } catch (error: ShareIngestionStorageException) {
      throw error
    } catch (error: ShareInputException) {
      partial.delete()
      failedItem(input, error.stableCode, error.detectedMediaType)
    } catch (_: SecurityException) {
      partial.delete()
      failedItem(input, "IMPORT_PROVIDER_PERMISSION_EXPIRED")
    } catch (_: FileNotFoundException) {
      partial.delete()
      failedItem(input, "IMPORT_PROVIDER_PERMISSION_EXPIRED")
    } catch (_: Exception) {
      partial.delete()
      failedItem(input, "IMPORT_COPY_FAILED")
    }
  }

  private fun acquireOwnership(filesDir: File, ingestionId: String): InboxWriterOwnership {
    val deadline = System.nanoTime() + 5_000_000_000L
    while (true) {
      try {
        return InboxWriterOwnership.acquire(filesDir, ingestionId)
      } catch (error: IllegalStateException) {
        if (error.message != "INBOX_WRITER_LOCK_ALREADY_EXISTS" || System.nanoTime() >= deadline) {
          throw error
        }
        Thread.sleep(10)
      }
    }
  }

  private fun failedItem(
    input: ShareIngestionInput,
    code: String,
    detectedMediaType: String? = null,
  ): JSONObject = JSONObject()
    .put("id", input.id)
    .put("order", input.order)
    .put(
      "mediaType",
      detectedMediaType ?: concreteOrFallbackMediaType(input.declaredMediaType),
    )
    .put("status", "failed")
    .put("byteCount", 0)
    .put("errorCode", code)

  private fun summary(manifest: Map<String, Any?>, replayed: Boolean): ShareIngestionSummary {
    @Suppress("UNCHECKED_CAST")
    val items = manifest["items"] as? List<Map<String, Any?>>
      ?: throw IllegalStateException("SCHEMA_INVALID")
    val failedCodes = items.mapNotNull { item ->
      if (item["status"] == "failed") item["errorCode"] as? String else null
    }
    return ShareIngestionSummary(
      ingestionId = manifest["ingestionId"] as? String
        ?: throw IllegalStateException("SCHEMA_INVALID"),
      status = manifest["status"] as? String ?: throw IllegalStateException("SCHEMA_INVALID"),
      copied = items.count { it["status"] == "copied" },
      rejected = failedCodes.count { it == "IMPORT_TYPE_UNSUPPORTED" || it == "IMPORT_SIZE_LIMIT_EXCEEDED" },
      failed = failedCodes.count { it != "IMPORT_TYPE_UNSUPPORTED" && it != "IMPORT_SIZE_LIMIT_EXCEEDED" },
      replayed = replayed,
      manifest = manifest,
    )
  }

  private fun detectMediaType(file: File): String {
    val prefix = file.inputStream().buffered().use { input ->
      val bytes = ByteArray(4_096)
      val count = input.read(bytes)
      if (count < 0) ByteArray(0) else bytes.copyOf(count)
    }
    if (prefix.startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png"
    if (prefix.startsWith(0xff, 0xd8, 0xff)) return "image/jpeg"
    if (prefix.asciiStartsWith("GIF87a") || prefix.asciiStartsWith("GIF89a")) return "image/gif"
    if (prefix.asciiStartsWith("BM")) return "image/bmp"
    if (prefix.startsWith(0x49, 0x49, 0x2a, 0x00) || prefix.startsWith(0x4d, 0x4d, 0x00, 0x2a)) return "image/tiff"
    if (prefix.size >= 12 && prefix.ascii(0, 4) == "RIFF" && prefix.ascii(8, 12) == "WEBP") return "image/webp"
    isoBaseMediaType(prefix)?.let { return it }
    if (prefix.indexOfSubsequence("%PDF-".toByteArray(StandardCharsets.US_ASCII), 1_024) >= 0) {
      return "application/pdf"
    }
    if (file.length() > maximumTextBytes) {
      throw ShareInputException("IMPORT_SIZE_LIMIT_EXCEEDED")
    }
    val text = decodeUtf8(file.readBytes())
      ?: throw ShareInputException("IMPORT_TYPE_UNSUPPORTED")
    if (text.any(::isDisallowedTextControl)) {
      throw ShareInputException("IMPORT_TYPE_UNSUPPORTED")
    }
    return if (validWebURL(text.trim())) "text/uri-list" else "text/plain"
  }

  private fun isoBaseMediaType(bytes: ByteArray): String? {
    if (bytes.size < 12 || bytes.ascii(4, 8) != "ftyp") return null
    val brand = bytes.ascii(8, 12)
    return when (brand) {
      "heic", "heix", "hevc", "hevx", "mif1", "msf1" -> "image/heic"
      "avif", "avis" -> "image/avif"
      else -> null
    }
  }

  private fun declaredTypeAllows(declared: String?, detected: String): Boolean {
    val normalized = declared?.substringBefore(';')?.trim()?.lowercase()
    if (
      normalized.isNullOrEmpty() ||
      normalized == "*/*" ||
      normalized.length > maximumMediaTypeLength ||
      !concreteMediaType.matches(normalized) ||
      normalized == "application/octet-stream"
    ) return true
    if (normalized == detected) return true
    if (normalized == "image/*" && detected.startsWith("image/")) return true
    if (normalized == "text/*" && detected.startsWith("text/")) return true
    if (normalized == "text/plain" && detected == "text/uri-list") return true
    return false
  }

  private fun concreteOrFallbackMediaType(value: String?): String {
    val normalized = value?.substringBefore(';')?.trim()?.lowercase()
    return if (
      normalized != null &&
      normalized.length <= maximumMediaTypeLength &&
      concreteMediaType.matches(normalized)
    ) normalized
    else "application/octet-stream"
  }

  private fun validWebURL(value: String): Boolean = try {
    val uri = java.net.URI(value)
    (uri.scheme == "http" || uri.scheme == "https") && !uri.host.isNullOrBlank()
  } catch (_: Exception) {
    false
  }

  private fun isDisallowedTextControl(value: Char): Boolean =
    (value.code < 0x20 && value != '\t' && value != '\n' && value != '\r') || value.code == 0x7f

  private fun decodeUtf8(bytes: ByteArray): String? = try {
    StandardCharsets.UTF_8.newDecoder()
      .onMalformedInput(CodingErrorAction.REPORT)
      .onUnmappableCharacter(CodingErrorAction.REPORT)
      .decode(ByteBuffer.wrap(bytes))
      .toString()
  } catch (_: Exception) {
    null
  }

  private fun writeDurably(destination: File, bytes: ByteArray) {
    FileOutputStream(destination).use { output ->
      output.write(bytes)
      output.fd.sync()
    }
  }

  private fun atomicRename(source: File, destination: File) {
    try {
      Os.rename(source.path, destination.path)
    } catch (_: Exception) {
      throw ShareIngestionStorageException()
    }
  }

  private fun synchronizeDirectory(directory: File) {
    val descriptor = try {
      Os.open(directory.path, OsConstants.O_RDONLY, 0)
    } catch (_: Exception) {
      throw ShareIngestionStorageException()
    }
    try {
      Os.fsync(descriptor)
    } catch (_: Exception) {
      throw ShareIngestionStorageException()
    } finally {
      runCatching { Os.close(descriptor) }
    }
  }

  private fun ensureDurableDirectory(directory: File) {
    if (directory.exists()) {
      check(
        directory.isDirectory &&
          !OsConstants.S_ISLNK(Os.lstat(directory.path).st_mode),
      ) { "INGESTION_DIRECTORY_INVALID" }
      return
    }
    check(directory.mkdir()) { "INGESTION_DIRECTORY_CREATE_FAILED" }
    synchronizeDirectory(requireNotNull(directory.parentFile))
  }

  private fun isoTimestamp(date: Date): String = SimpleDateFormat(
    "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
    Locale.US,
  ).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(date)

  private fun requireCanonicalUuid(value: String) {
    require(UUID.fromString(value).toString() == value)
  }

  private fun ByteArray.startsWith(vararg expected: Int): Boolean =
    size >= expected.size && expected.indices.all { index ->
      (this[index].toInt() and 0xff) == expected[index]
    }

  private fun ByteArray.asciiStartsWith(value: String): Boolean =
    startsWith(*value.toByteArray(StandardCharsets.US_ASCII).map { it.toInt() and 0xff }.toIntArray())

  private fun ByteArray.ascii(start: Int, end: Int): String =
    String(copyOfRange(start, end), StandardCharsets.US_ASCII)

  private fun ByteArray.indexOfSubsequence(needle: ByteArray, maximumStart: Int): Int {
    val lastStart = minOf(size - needle.size, maximumStart)
    if (lastStart < 0) return -1
    for (start in 0..lastStart) {
      if (needle.indices.all { offset -> this[start + offset] == needle[offset] }) return start
    }
    return -1
  }

  private fun ByteArray.toHex(): String = joinToString("") { byte -> "%02x".format(byte) }

  private val concreteMediaType = Regex(
    "^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$",
  )
  private val failedItemCodes = setOf(
    "IMPORT_PROVIDER_PERMISSION_EXPIRED",
    "IMPORT_TYPE_UNSUPPORTED",
    "IMPORT_COPY_FAILED",
    "IMPORT_SIZE_LIMIT_EXCEEDED",
  )
}

private class ShareInputException(
  val stableCode: String,
  val detectedMediaType: String? = null,
) : Exception(stableCode)

private class ShareIngestionStorageException : Exception("SHARE_INGESTION_STORAGE_FAILED")
