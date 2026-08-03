package com.aicontextpack.nativebridge

import android.os.Build
import android.system.Os
import android.system.OsConstants
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.UUID

internal class InboxArtifactHandoffException(val stableCode: String) : Exception(stableCode)

internal object InboxArtifactHandoff {
  enum class Point { BEFORE_COPY, DURING_COPY, AFTER_FILE_CLOSE, BEFORE_PUBLISH_RENAME }

  fun handoff(
    filesDir: File,
    ingestionId: String,
    packId: String,
    requiredHeadroomBytes: Long,
    availableBytes: (File) -> Long = { it.usableSpace },
    operationHook: (Point) -> Unit = {},
  ): Map<String, Any> {
    requireCanonicalUuid(ingestionId)
    requireCanonicalUuid(packId)
    if (requiredHeadroomBytes < 0) {
      throw InboxArtifactHandoffException("RESOURCE_LOW_DISK")
    }
    val inbox = File(filesDir, "Inbox")
    val sourceDirectory = File(inbox, ingestionId)
    val manifestFile = File(sourceDirectory, "manifest.json")
    val originalManifestBytes = try { manifestFile.readBytes() }
    catch (_: Exception) { throw InboxArtifactHandoffException("SCHEMA_INVALID") }
    val manifestFingerprint = sha256(originalManifestBytes)
    val manifest = InboxManifestScanner.scan(inbox)
      .firstOrNull { it["ingestionId"] == ingestionId }
      ?: throw InboxArtifactHandoffException("SCHEMA_INVALID")
    @Suppress("UNCHECKED_CAST")
    val items = manifest["items"] as? List<Map<String, Any?>>
      ?: throw InboxArtifactHandoffException("SCHEMA_INVALID")
    var requiredFreeBytes = requiredHeadroomBytes
    items.filter { it["status"] == "copied" }.forEach { item ->
      val byteCount = (item["byteCount"] as? Number)?.toLong()
        ?: throw InboxArtifactHandoffException("ARTIFACT_INTEGRITY_FAILED")
      if (byteCount < 0 || requiredFreeBytes > Long.MAX_VALUE - byteCount) {
        throw InboxArtifactHandoffException("ARTIFACT_INTEGRITY_FAILED")
      }
      requiredFreeBytes += byteCount
    }
    if (availableBytes(filesDir) < requiredFreeBytes) {
      throw InboxArtifactHandoffException("RESOURCE_LOW_DISK")
    }
    val destinationDirectory = File(filesDir, "Packs/$packId/originals")
    if (!destinationDirectory.mkdirs() && !destinationDirectory.isDirectory) {
      throw InboxArtifactHandoffException("STORAGE_WRITE_FAILED")
    }
    val artifacts: List<Map<String, Any>> = items.mapNotNull { item ->
      if (item["status"] != "copied") return@mapNotNull null
      val itemId = item["id"] as? String
        ?: throw InboxArtifactHandoffException("ARTIFACT_INTEGRITY_FAILED")
      val mediaType = item["mediaType"] as? String
        ?: throw InboxArtifactHandoffException("ARTIFACT_INTEGRITY_FAILED")
      val sourceName = item["relativePath"] as? String
        ?: throw InboxArtifactHandoffException("ARTIFACT_INTEGRITY_FAILED")
      val byteCount = (item["byteCount"] as? Number)?.toLong()
        ?: throw InboxArtifactHandoffException("ARTIFACT_INTEGRITY_FAILED")
      val expectedHash = item["sha256"] as? String
      requireCanonicalUuid(itemId)
      if (sourceName != "$itemId.bin" || byteCount < 0) {
        throw InboxArtifactHandoffException("ARTIFACT_INTEGRITY_FAILED")
      }
      val source = File(sourceDirectory, sourceName)
      val destination = File(destinationDirectory, "$itemId.bin")
      val partial = File(destinationDirectory, "$itemId.bin.partial")
      val actualHash = publish(
        source, partial, destination, byteCount, expectedHash, operationHook,
      )
      val result = mutableMapOf<String, Any>(
        "id" to itemId,
        "itemId" to itemId,
        "relativePath" to "Packs/$packId/originals/$itemId.bin",
        "mediaType" to mediaType,
        "byteCount" to byteCount,
      )
      result["sha256"] = actualHash
      result
    }
    val finalManifestBytes = try { manifestFile.readBytes() }
    catch (_: Exception) { throw InboxArtifactHandoffException("ARTIFACT_INTEGRITY_FAILED") }
    if (!finalManifestBytes.contentEquals(originalManifestBytes)) {
      throw InboxArtifactHandoffException("ARTIFACT_INTEGRITY_FAILED")
    }
    return mapOf(
      "manifest" to manifest,
      "manifestFingerprint" to manifestFingerprint,
      "artifacts" to artifacts,
    )
  }

  fun acknowledge(filesDir: File, ingestionId: String): Boolean {
    requireCanonicalUuid(ingestionId)
    return InboxWriterOwnership.withRegistry(filesDir) { locks ->
      if (File(locks, "$ingestionId.lock").exists()) {
        throw InboxArtifactHandoffException("PIPELINE_RECOVERY_REQUIRED")
      }
      val directory = File(filesDir, "Inbox/$ingestionId")
      if (!directory.exists()) return@withRegistry true
      if (!directory.deleteRecursively() || directory.exists()) {
        throw InboxArtifactHandoffException("STORAGE_WRITE_FAILED")
      }
      true
    }
  }

  private fun publish(
    source: File,
    partial: File,
    destination: File,
    byteCount: Long,
    expectedHash: String?,
    operationHook: (Point) -> Unit,
  ): String {
    if (destination.exists()) {
      val sourceHash = verify(source, byteCount, expectedHash)
      return verify(destination, byteCount, sourceHash)
    }
    if (partial.exists() && !partial.delete()) {
      throw InboxArtifactHandoffException("STORAGE_WRITE_FAILED")
    }
    operationHook(Point.BEFORE_COPY)
    try {
      source.inputStream().buffered().use { input ->
        FileOutputStream(partial).buffered().use { output ->
          val buffer = ByteArray(64 * 1024)
          var firstChunk = true
          while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            output.write(buffer, 0, count)
            if (firstChunk) {
              firstChunk = false
              operationHook(Point.DURING_COPY)
            }
          }
          output.flush()
        }
      }
      FileOutputStream(partial, true).use { it.fd.sync() }
      operationHook(Point.AFTER_FILE_CLOSE)
      val actualHash = verify(partial, byteCount, expectedHash)
      operationHook(Point.BEFORE_PUBLISH_RENAME)
      val published = if (Build.VERSION.SDK_INT >= 26) {
        runCatching {
          java.nio.file.Files.move(
            partial.toPath(),
            destination.toPath(),
            java.nio.file.StandardCopyOption.ATOMIC_MOVE,
          )
        }.isSuccess
      } else {
        partial.renameTo(destination)
      }
      if (!published) throw InboxArtifactHandoffException("STORAGE_WRITE_FAILED")
      syncDirectory(destination.parentFile ?: throw InboxArtifactHandoffException("STORAGE_WRITE_FAILED"))
      return actualHash
    } catch (error: InboxArtifactHandoffException) {
      throw error
    } catch (_: Exception) {
      throw InboxArtifactHandoffException("STORAGE_WRITE_FAILED")
    }
  }

  private fun verify(file: File, byteCount: Long, expectedHash: String?): String {
    if (!file.isFile || file.length() != byteCount) {
      throw InboxArtifactHandoffException("ARTIFACT_INTEGRITY_FAILED")
    }
    val actualHash = sha256(file)
    if (expectedHash != null && actualHash != expectedHash) {
      throw InboxArtifactHandoffException("ARTIFACT_INTEGRITY_FAILED")
    }
    return actualHash
  }

  private fun sha256(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().buffered().use { input ->
      val buffer = ByteArray(64 * 1024)
      while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        digest.update(buffer, 0, count)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
  }

  private fun sha256(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes)
      .joinToString("") { "%02x".format(it.toInt() and 0xff) }

  private fun syncDirectory(directory: File) {
    val descriptor = Os.open(directory.path, OsConstants.O_RDONLY, 0)
    try { Os.fsync(descriptor) } finally { Os.close(descriptor) }
  }

  private fun requireCanonicalUuid(value: String) {
    try {
      if (UUID.fromString(value).toString() != value) {
        throw InboxArtifactHandoffException("SCHEMA_INVALID")
      }
    } catch (_: IllegalArgumentException) {
      throw InboxArtifactHandoffException("SCHEMA_INVALID")
    }
  }
}
