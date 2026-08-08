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
  private const val stagedDirectoryName = "AIContextPackMainAppPicker"
  private val transientDirectoryNames = listOf("DocumentPicker", "ImagePicker")

  @Synchronized
  fun stagePickerFiles(cacheDir: File, fileUris: List<String>): List<String> {
    if (fileUris.isEmpty() || fileUris.size > ShareIngestionWriter.maximumItemCount || fileUris.toSet().size != fileUris.size) {
      invalid()
    }
    val cacheRoot = cacheDir.canonicalFile
    val sources = fileUris.map { controlledTransientFile(it, cacheRoot) }
    val stageRoot = File(cacheRoot, stagedDirectoryName)
    if (hasEntry(stageRoot)) {
      val mode = runCatching { Os.lstat(stageRoot.path).st_mode }.getOrNull()
      if (mode == null || OsConstants.S_ISLNK(mode) || !OsConstants.S_ISDIR(mode)) {
        throw MainAppImportException("MAIN_APP_IMPORT_CLEANUP_FAILED")
      }
    } else if (!stageRoot.mkdirs()) {
      throw MainAppImportException("MAIN_APP_PICKER_STAGING_FAILED")
    }
    val transactionId = UUID.randomUUID().toString()
    val partialRoot = File(stageRoot, "$transactionId.partial")
    val committedRoot = File(stageRoot, transactionId)
    if (!partialRoot.mkdir()) {
      throw MainAppImportException("MAIN_APP_PICKER_STAGING_FAILED")
    }
    val staged = mutableListOf<File>()
    try {
      sources.forEach { source ->
        val destination = File(partialRoot, "${UUID.randomUUID()}.bin")
        if (!source.renameTo(destination)) {
          throw MainAppImportException("MAIN_APP_PICKER_STAGING_FAILED")
        }
        staged += destination
      }
      if (!partialRoot.renameTo(committedRoot)) {
        throw MainAppImportException("MAIN_APP_PICKER_STAGING_FAILED")
      }
      return staged.map { Uri.fromFile(File(committedRoot, it.name)).toString() }
    } catch (error: Exception) {
      var cleanupFailed = false
      (listOf(partialRoot, committedRoot) + sources).distinctBy(File::getPath).forEach { file ->
        if (hasEntry(file) && !removeTree(file)) cleanupFailed = true
      }
      if (!cleanupPickerTransientsUnlocked(cacheRoot)) cleanupFailed = true
      if (cleanupFailed) throw MainAppImportException("MAIN_APP_IMPORT_CLEANUP_FAILED")
      if (error is MainAppImportException) throw error
      throw MainAppImportException("MAIN_APP_PICKER_STAGING_FAILED")
    }
  }

  @Synchronized
  fun cleanupPickerTransients(cacheDir: File): Boolean {
    if (!cleanupPickerTransientsUnlocked(cacheDir.canonicalFile)) {
      throw MainAppImportException("MAIN_APP_IMPORT_CLEANUP_FAILED")
    }
    return true
  }

  @Synchronized
  fun recoverPickerCache(cacheDir: File): Boolean {
    val cacheRoot = cacheDir.canonicalFile
    val names = transientDirectoryNames + stagedDirectoryName
    var cleanupFailed = false
    names.forEach { name ->
      val directory = File(cacheRoot, name)
      if (hasEntry(directory) && !removeTree(directory)) cleanupFailed = true
    }
    if (cleanupFailed) throw MainAppImportException("MAIN_APP_IMPORT_CLEANUP_FAILED")
    return true
  }

  @Synchronized
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
          // Publication is already durable. The UI must lock the draft and idempotently replay
          // this ingestion instead of offering cancellation for a Pack that now exists.
          throw MainAppImportException("MAIN_APP_IMPORT_COMMITTED_CLEANUP_REQUIRED")
        }
      }
    }
    return manifest
  }

  @Synchronized
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
    val declaredByteCount = exactNonNegativeLong(raw["byteCount"])
    if (declaredByteCount > ShareIngestionWriter.maximumTextBytes) invalid()
    val bytes = text.toByteArray(StandardCharsets.UTF_8)
    if (declaredByteCount != bytes.size.toLong()) invalid()
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

  private fun controlledTransientFile(value: String, cacheRoot: File): File {
    val file = controlledCacheFile(value, cacheRoot)
    if (!file.isFile || transientDirectoryNames.none { name ->
        file.path.startsWith(File(cacheRoot, name).canonicalPath + File.separator)
      }) invalid()
    return file
  }

  private fun cleanupPickerTransientsUnlocked(cacheRoot: File): Boolean {
    var cleanupSucceeded = true
    transientDirectoryNames.forEach { name ->
      val directory = File(cacheRoot, name)
      if (hasEntry(directory) && !removeTree(directory)) cleanupSucceeded = false
    }
    val stageRoot = File(cacheRoot, stagedDirectoryName)
    if (hasEntry(stageRoot)) {
      val mode = runCatching { Os.lstat(stageRoot.path).st_mode }.getOrNull()
      if (mode == null || OsConstants.S_ISLNK(mode) || !OsConstants.S_ISDIR(mode)) {
        if (!removeTree(stageRoot)) cleanupSucceeded = false
      } else {
        val children = stageRoot.listFiles()
        if (children == null) cleanupSucceeded = false
        else children.filter { it.name.endsWith(".partial") }.forEach { child ->
          if (!removeTree(child)) cleanupSucceeded = false
        }
      }
    }
    return cleanupSucceeded
  }

  private fun hasEntry(file: File): Boolean =
    runCatching { Os.lstat(file.path) }.isSuccess

  private fun removeTree(file: File): Boolean {
    val mode = runCatching { Os.lstat(file.path).st_mode }.getOrNull() ?: return true
    if (OsConstants.S_ISLNK(mode) || !OsConstants.S_ISDIR(mode)) return file.delete()
    val children = file.listFiles() ?: return false
    if (children.any { !removeTree(it) }) return false
    return file.delete()
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
