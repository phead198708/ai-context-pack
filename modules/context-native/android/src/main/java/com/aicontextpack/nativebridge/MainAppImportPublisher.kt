package com.aicontextpack.nativebridge

import android.net.Uri
import android.system.Os
import android.system.OsConstants
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream
import java.nio.charset.StandardCharsets
import java.util.UUID

class MainAppImportException(
  val stableCode: String,
) : Exception(stableCode)

/**
 * Converts controlled picker-cache URIs and inline UTF-8 entries into the same atomic Inbox
 * writer used by Android system sharing. Provider paths and display filenames are never durable.
 */
object MainAppImportPublisher {
  fun publish(
    filesDir: File,
    cacheDir: File,
    ingestionId: String,
    source: String,
    rawInputs: List<Map<String, Any?>>,
    removeCacheFile: (File) -> Boolean = { it.delete() },
    operationHook: (ShareIngestionWriter.Point) -> Unit = {},
  ): Map<String, Any?> {
    requireCanonicalUuid(ingestionId)
    if (source !in setOf("main-app-picker", "main-app-text")) invalid()
    if (rawInputs.isEmpty() || rawInputs.size > ShareIngestionWriter.maximumItemCount) invalid()

    val cacheRoot = cacheDir.canonicalFile
    val pickerFiles = mutableListOf<File>()
    val seen = mutableSetOf<String>()
    val inputs = rawInputs.mapIndexed { index, raw ->
      val decoded = decodeInput(raw, index, cacheRoot)
      if (!seen.add(decoded.id)) invalid()
      decoded.file?.let(pickerFiles::add)
      decoded.input
    }
    val containsFile = pickerFiles.isNotEmpty()
    if ((source == "main-app-picker") != containsFile) invalid()

    val manifest = ShareIngestionWriter.publish(
      filesDir,
      ingestionId,
      inputs,
      source = source,
      operationHook = operationHook,
    ).manifest
    // Only a committed/replayed Inbox owns immutable bytes. A failed attempt keeps picker
    // cache files so the visible draft can retry or explicitly discard them.
    pickerFiles.distinctBy(File::getPath).forEach { file ->
      if (file.exists()) {
        val removed = try {
          removeCacheFile(file)
        } catch (_: Exception) {
          false
        }
        if (!removed) {
          throw MainAppImportException("MAIN_APP_IMPORT_CLEANUP_FAILED")
        }
      }
    }
    return manifest
  }

  fun discard(cacheDir: File, fileUris: List<String>): Boolean {
    val cacheRoot = cacheDir.canonicalFile
    fileUris.forEach { value ->
      val file = controlledCacheFile(value, cacheRoot)
      if (file.exists() && !file.delete()) {
        throw MainAppImportException("MAIN_APP_IMPORT_CLEANUP_FAILED")
      }
    }
    return true
  }

  private data class DecodedInput(
    val id: String,
    val input: ShareIngestionInput,
    val file: File? = null,
  )

  private fun decodeInput(
    raw: Map<String, Any?>,
    expectedOrder: Int,
    cacheRoot: File,
  ): DecodedInput {
    val kind = raw["kind"] as? String ?: invalid()
    val expectedKeys = if (kind == "file") fileKeys else textKeys
    if (raw.keys != expectedKeys) invalid()
    val id = raw["id"] as? String ?: invalid()
    requireCanonicalUuid(id)
    if (exactNonNegativeInt(raw["order"]) != expectedOrder) invalid()
    exactNonNegativeLong(raw["byteCount"])
    val declaredMediaType = raw["declaredMediaType"] as? String ?: invalid()
    if (!mediaType.matches(declaredMediaType) || declaredMediaType.length > 127) invalid()

    if (kind == "file") {
      val file = controlledCacheFile(raw["fileUri"] as? String ?: invalid(), cacheRoot)
      val input = if (file.isFile) {
        ShareIngestionInput(
          id = id,
          order = expectedOrder,
          declaredMediaType = declaredMediaType,
          openStream = { FileInputStream(file) },
        )
      } else {
        ShareIngestionInput(
          id = id,
          order = expectedOrder,
          declaredMediaType = declaredMediaType,
          preflightError = "IMPORT_PROVIDER_PERMISSION_EXPIRED",
        )
      }
      return DecodedInput(id, input, file)
    }

    if (kind !in setOf("text", "url")) invalid()
    val text = raw["text"] as? String ?: invalid()
    if (text.isEmpty()) invalid()
    val expectedType = if (kind == "url") "text/uri-list" else "text/plain"
    if (declaredMediaType != expectedType) invalid()
    val bytes = text.toByteArray(StandardCharsets.UTF_8)
    if (exactNonNegativeLong(raw["byteCount"]) != bytes.size.toLong()) invalid()
    if (kind == "url") {
      val uri = runCatching { Uri.parse(text) }.getOrNull() ?: invalid()
      if (uri.scheme?.lowercase() !in setOf("http", "https") || uri.host.isNullOrEmpty()) invalid()
    }
    return DecodedInput(
      id,
      ShareIngestionInput(
        id = id,
        order = expectedOrder,
        declaredMediaType = declaredMediaType,
        openStream = { ByteArrayInputStream(bytes) },
      ),
    )
  }

  private fun controlledCacheFile(value: String, cacheRoot: File): File {
    val uri = runCatching { Uri.parse(value) }.getOrNull() ?: invalid()
    if (uri.scheme != "file" || uri.path == null) invalid()
    val unresolved = File(uri.path!!)
    if (unresolved.exists()) {
      val mode = runCatching { Os.lstat(unresolved.path).st_mode }.getOrNull() ?: invalid()
      if (OsConstants.S_ISLNK(mode) || OsConstants.S_ISDIR(mode)) invalid()
    }
    val file = unresolved.canonicalFile
    if (!file.path.startsWith(cacheRoot.path + File.separator)) invalid()
    return file
  }

  private fun exactNonNegativeInt(value: Any?): Int {
    val number = value as? Number ?: invalid()
    val double = number.toDouble()
    if (!double.isFinite() || double < 0 || double % 1.0 != 0.0 || double > Int.MAX_VALUE) invalid()
    return double.toInt()
  }

  private fun exactNonNegativeLong(value: Any?): Long {
    val number = value as? Number ?: invalid()
    val double = number.toDouble()
    if (!double.isFinite() || double < 0 || double % 1.0 != 0.0 || double > 9_007_199_254_740_991.0) invalid()
    return double.toLong()
  }

  private fun requireCanonicalUuid(value: String) {
    val parsed = runCatching { UUID.fromString(value) }.getOrNull()
    if (parsed == null || parsed.toString() != value) invalid()
  }

  private fun invalid(): Nothing = throw MainAppImportException("MAIN_APP_IMPORT_INPUT_INVALID")

  private val mediaType = Regex(
    "^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$",
  )
  private val fileKeys = setOf(
    "id",
    "order",
    "kind",
    "declaredMediaType",
    "byteCount",
    "fileUri",
  )
  private val textKeys = setOf(
    "id",
    "order",
    "kind",
    "declaredMediaType",
    "byteCount",
    "text",
  )
}
