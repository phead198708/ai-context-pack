package com.aicontextpack.nativebridge

import android.system.Os
import android.system.OsConstants
import java.io.File
import java.io.FileOutputStream
import java.util.UUID

internal class InboxAcknowledgementStoreException(
  val stableCode: String,
) : Exception(stableCode)

/**
 * Durable, metadata-only evidence that an ingestion ID was already handed off and ACKed.
 *
 * The receipt is published before the scanner-visible Inbox directory is removed. It preserves
 * the already-validated manifest, but never provider URIs, display filenames, or artifact bytes.
 */
internal object InboxAcknowledgementStore {
  private const val directoryName = "InboxAcknowledgements"
  private const val tombstoneDirectoryName = "InboxAckTombstones"
  private const val maximumReceiptBytes = 262_144

  fun read(filesDir: File, ingestionId: String): Map<String, Any?>? {
    requireCanonicalUuid(ingestionId)
    val root = File(filesDir, directoryName)
    if (!root.exists()) return null
    requireSafeDirectory(root, filesDir)
    val receipt = File(root, "$ingestionId.json")
    if (!receipt.exists()) return null
    requireReceiptPath(receipt, root)
    return try {
      InboxManifestScanner.readAcknowledgementReceipt(receipt, ingestionId)
    } catch (error: NativeException) {
      throw InboxAcknowledgementStoreException(
        if (error.code == "SCHEMA_VERSION_UNSUPPORTED") error.code else "ARTIFACT_INTEGRITY_FAILED",
      )
    }
  }

  fun publish(
    filesDir: File,
    ingestionId: String,
    manifestBytes: ByteArray,
    directorySynchronizer: (File) -> Unit,
  ): Map<String, Any?> {
    requireCanonicalUuid(ingestionId)
    if (manifestBytes.isEmpty() || manifestBytes.size > maximumReceiptBytes) {
      throw InboxAcknowledgementStoreException("ARTIFACT_INTEGRITY_FAILED")
    }
    val root = File(filesDir, directoryName)
    ensureDurableDirectory(root, filesDir, directorySynchronizer)
    val receipt = File(root, "$ingestionId.json")
    if (receipt.exists()) {
      requireReceiptPath(receipt, root)
      val existing = try { receipt.readBytes() }
      catch (_: Exception) {
        throw InboxAcknowledgementStoreException("ARTIFACT_INTEGRITY_FAILED")
      }
      if (!existing.contentEquals(manifestBytes)) {
        throw InboxAcknowledgementStoreException("ARTIFACT_INTEGRITY_FAILED")
      }
      return read(filesDir, ingestionId)
        ?: throw InboxAcknowledgementStoreException("ARTIFACT_INTEGRITY_FAILED")
    }

    val partial = File(root, ".$ingestionId-${UUID.randomUUID()}.partial")
    try {
      FileOutputStream(partial).use { output ->
        output.write(manifestBytes)
        output.fd.sync()
      }
      Os.rename(partial.path, receipt.path)
      directorySynchronizer(root)
      return read(filesDir, ingestionId)
        ?: throw InboxAcknowledgementStoreException("ARTIFACT_INTEGRITY_FAILED")
    } catch (error: InboxAcknowledgementStoreException) {
      throw error
    } catch (_: Exception) {
      throw InboxAcknowledgementStoreException("STORAGE_WRITE_FAILED")
    } finally {
      runCatching { partial.delete() }
    }
  }

  fun matchingTombstones(filesDir: File, ingestionId: String): List<File> {
    requireCanonicalUuid(ingestionId)
    val root = File(filesDir, tombstoneDirectoryName)
    if (!root.exists()) return emptyList()
    requireSafeDirectory(root, filesDir)
    return try {
      (root.listFiles() ?: throw InboxAcknowledgementStoreException("STORAGE_WRITE_FAILED"))
        .filter { candidate ->
          tombstoneIngestionId(candidate, root) == ingestionId
        }
        .sortedBy { it.name }
    } catch (error: InboxAcknowledgementStoreException) {
      throw error
    } catch (_: Exception) {
      throw InboxAcknowledgementStoreException("STORAGE_WRITE_FAILED")
    }
  }

  fun tombstoneIngestionId(candidate: File, root: File): String? = runCatching {
    val name = candidate.name
    if (!name.endsWith(".ack")) return@runCatching null
    val stem = name.removeSuffix(".ack")
    if (stem.length != 73 || stem[36] != '-') return@runCatching null
    val ingestionId = stem.substring(0, 36)
    val nonce = stem.substring(37)
    if (!canonicalUuid(ingestionId) || !canonicalUuid(nonce)) return@runCatching null
    if (!candidate.isDirectory ||
      OsConstants.S_ISLNK(Os.lstat(candidate.path).st_mode) ||
      candidate.parentFile?.canonicalFile != root.canonicalFile
    ) return@runCatching null
    ingestionId
  }.getOrNull()

  private fun ensureDurableDirectory(
    root: File,
    filesDir: File,
    directorySynchronizer: (File) -> Unit,
  ) {
    try {
      if (root.exists()) {
        requireSafeDirectory(root, filesDir)
      } else {
        if (!root.mkdir()) throw InboxAcknowledgementStoreException("STORAGE_WRITE_FAILED")
        requireSafeDirectory(root, filesDir)
      }
      directorySynchronizer(root)
      directorySynchronizer(filesDir)
    } catch (error: InboxAcknowledgementStoreException) {
      throw error
    } catch (_: Exception) {
      throw InboxAcknowledgementStoreException("STORAGE_WRITE_FAILED")
    }
  }

  private fun requireSafeDirectory(directory: File, expectedParent: File) {
    try {
      if (!directory.isDirectory ||
        OsConstants.S_ISLNK(Os.lstat(directory.path).st_mode) ||
        directory.parentFile?.canonicalFile != expectedParent.canonicalFile
      ) {
        throw InboxAcknowledgementStoreException("STORAGE_WRITE_FAILED")
      }
    } catch (error: InboxAcknowledgementStoreException) {
      throw error
    } catch (_: Exception) {
      throw InboxAcknowledgementStoreException("STORAGE_WRITE_FAILED")
    }
  }

  private fun requireReceiptPath(receipt: File, root: File) {
    try {
      if (!receipt.isFile ||
        OsConstants.S_ISLNK(Os.lstat(receipt.path).st_mode) ||
        receipt.parentFile?.canonicalFile != root.canonicalFile
      ) {
        throw InboxAcknowledgementStoreException("ARTIFACT_INTEGRITY_FAILED")
      }
    } catch (error: InboxAcknowledgementStoreException) {
      throw error
    } catch (_: Exception) {
      throw InboxAcknowledgementStoreException("ARTIFACT_INTEGRITY_FAILED")
    }
  }

  private fun requireCanonicalUuid(value: String) {
    if (!canonicalUuid(value)) {
      throw InboxAcknowledgementStoreException("SCHEMA_INVALID")
    }
  }

  private fun canonicalUuid(value: String): Boolean = try {
    UUID.fromString(value).toString() == value
  } catch (_: IllegalArgumentException) {
    false
  }
}
