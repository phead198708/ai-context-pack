package com.aicontextpack.nativebridge

import android.os.Build
import android.system.Os
import android.system.OsConstants
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.UUID

internal class InboxArtifactHandoffException(val stableCode: String) : Exception(stableCode)

internal object InboxArtifactHandoff {
  private data class SourceDescriptor(
    val name: String,
    val byteCount: Long,
    val sha256: String?,
  )
  enum class Point { BEFORE_COPY, DURING_COPY, AFTER_FILE_CLOSE, BEFORE_PUBLISH_RENAME }
  enum class AcknowledgementPoint {
    AFTER_RECEIPT_PUBLISH,
    AFTER_TOMBSTONE_RENAME,
    DURING_TOMBSTONE_DELETION,
  }
  enum class TombstoneSweepPoint { AFTER_REMOVAL }
  data class TombstoneSweepResult(val scanned: Int, val removed: Int, val failed: Int)

  fun handoff(
    filesDir: File,
    ingestionId: String,
    packId: String,
    requiredHeadroomBytes: Long,
    availableBytes: (File) -> Long = { it.usableSpace },
    operationHook: (Point) -> Unit = {},
    directorySynchronizer: (File) -> Unit = ::syncDirectory,
    snapshotHook: () -> Unit = {},
  ): Map<String, Any> {
    requireCanonicalUuid(ingestionId)
    requireCanonicalUuid(packId)
    if (requiredHeadroomBytes < 0) {
      throw InboxArtifactHandoffException("RESOURCE_LOW_DISK")
    }
    val inbox = File(filesDir, "Inbox")
    val sourceDirectory = File(inbox, ingestionId)
    val manifestFile = File(sourceDirectory, "manifest.json")
    val snapshot = try {
      InboxWriterOwnership.withRegistry(filesDir) {
        snapshotHook()
        val bytes = try { manifestFile.readBytes() }
        catch (_: Exception) { throw InboxArtifactHandoffException("SCHEMA_INVALID") }
        val manifest = try { InboxManifestScanner.readPublished(inbox, ingestionId) }
        catch (error: NativeException) {
          throw InboxArtifactHandoffException(error.code)
        }
        bytes to manifest
      }
    } catch (error: InboxArtifactHandoffException) {
      throw error
    } catch (_: Exception) {
      throw InboxArtifactHandoffException("STORAGE_WRITE_FAILED")
    }
    val originalManifestBytes = snapshot.first
    val manifestFingerprint = sha256(originalManifestBytes)
    val manifest = snapshot.second
    @Suppress("UNCHECKED_CAST")
    val items = manifest["items"] as? List<Map<String, Any?>>
      ?: throw InboxArtifactHandoffException("SCHEMA_INVALID")
    val destinationDirectory = File(filesDir, "Packs/$packId/originals")
    var requiredFreeBytes = requiredHeadroomBytes
    items.forEach { item ->
      val itemId = item["id"] as? String
        ?: throw InboxArtifactHandoffException("ARTIFACT_INTEGRITY_FAILED")
      requireCanonicalUuid(itemId)
      val descriptor = sourceDescriptor(sourceDirectory, item) ?: return@forEach
      if (File(destinationDirectory, "$itemId.bin").exists()) return@forEach
      if (requiredFreeBytes > Long.MAX_VALUE - descriptor.byteCount) {
        throw InboxArtifactHandoffException("ARTIFACT_INTEGRITY_FAILED")
      }
      requiredFreeBytes += descriptor.byteCount
    }
    if (availableBytes(filesDir) < requiredFreeBytes) {
      throw InboxArtifactHandoffException("RESOURCE_LOW_DISK")
    }
    ensureDestinationHierarchy(filesDir, packId, directorySynchronizer)
    val artifacts: List<Map<String, Any>> = items.mapNotNull { item ->
      val itemId = item["id"] as? String
        ?: throw InboxArtifactHandoffException("ARTIFACT_INTEGRITY_FAILED")
      val mediaType = item["mediaType"] as? String
        ?: throw InboxArtifactHandoffException("ARTIFACT_INTEGRITY_FAILED")
      val descriptor = sourceDescriptor(sourceDirectory, item) ?: return@mapNotNull null
      requireCanonicalUuid(itemId)
      val source = File(sourceDirectory, descriptor.name)
      val destination = File(destinationDirectory, "$itemId.bin")
      val partial = File(destinationDirectory, "$itemId.bin.partial")
      val actualHash = publish(
        source,
        partial,
        destination,
        descriptor.byteCount,
        descriptor.sha256,
        operationHook,
        directorySynchronizer,
      )
      val result = mutableMapOf<String, Any>(
        "id" to itemId,
        "itemId" to itemId,
        "relativePath" to "Packs/$packId/originals/$itemId.bin",
        "mediaType" to mediaType,
        "byteCount" to descriptor.byteCount,
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

  private fun sourceDescriptor(
    sourceDirectory: File,
    item: Map<String, Any?>,
  ): SourceDescriptor? {
    val itemId = item["id"] as? String
      ?: throw InboxArtifactHandoffException("ARTIFACT_INTEGRITY_FAILED")
    requireCanonicalUuid(itemId)
    if (item["status"] == "copied") {
      val sourceName = item["relativePath"] as? String
        ?: throw InboxArtifactHandoffException("ARTIFACT_INTEGRITY_FAILED")
      val byteCount = (item["byteCount"] as? Number)?.toLong()
        ?: throw InboxArtifactHandoffException("ARTIFACT_INTEGRITY_FAILED")
      if (sourceName != "$itemId.bin" || byteCount < 0) {
        throw InboxArtifactHandoffException("ARTIFACT_INTEGRITY_FAILED")
      }
      return SourceDescriptor(sourceName, byteCount, item["sha256"] as? String)
    }
    if (item["status"] != "failed") {
      throw InboxArtifactHandoffException("ARTIFACT_INTEGRITY_FAILED")
    }
    val source = File(sourceDirectory, "$itemId.retry")
    val mode = runCatching { Os.lstat(source.path).st_mode }.getOrNull()
    val retryByteCount = (item["retryByteCount"] as? Number)?.toLong()
    val retrySha256 = item["retrySha256"] as? String
    if (mode == null && retryByteCount == null && retrySha256 == null) return null
    if (
      mode == null ||
      !OsConstants.S_ISREG(mode) ||
      OsConstants.S_ISLNK(mode) ||
      retryByteCount == null ||
      retryByteCount !in 0..ShareIngestionWriter.maximumBinaryBytes ||
      source.length() != retryByteCount ||
      retrySha256 == null ||
      !Regex("^[0-9a-f]{64}$").matches(retrySha256)
    ) {
      throw InboxArtifactHandoffException("ARTIFACT_INTEGRITY_FAILED")
    }
    return SourceDescriptor(source.name, retryByteCount, retrySha256)
  }

  fun acknowledge(
    filesDir: File,
    ingestionId: String,
    operationHook: (AcknowledgementPoint) -> Unit = {},
    directorySynchronizer: (File) -> Unit = ::syncDirectory,
    tombstoneRemover: (File) -> Boolean = { it.deleteRecursively() },
  ): Boolean {
    requireCanonicalUuid(ingestionId)
    return InboxWriterOwnership.withRegistry(filesDir) { locks ->
      if (File(locks, "$ingestionId.lock").exists()) {
        throw InboxArtifactHandoffException("PIPELINE_RECOVERY_REQUIRED")
      }
      val inbox = File(filesDir, "Inbox")
      val directory = File(inbox, ingestionId)
      val tombstoneRoot = File(filesDir, "InboxAckTombstones")
      var receipt = try {
        InboxAcknowledgementStore.read(filesDir, ingestionId)
      } catch (error: InboxAcknowledgementStoreException) {
        throw InboxArtifactHandoffException(error.stableCode)
      }
      if (!directory.exists()) {
        if (receipt == null) {
          val tombstones = try {
            InboxAcknowledgementStore.matchingTombstones(filesDir, ingestionId)
          } catch (error: InboxAcknowledgementStoreException) {
            throw InboxArtifactHandoffException(error.stableCode)
          }
          tombstones.forEach { tombstone ->
            try {
              val manifestFile = File(tombstone, "manifest.json")
              val manifestBytes = manifestFile.readBytes()
              InboxManifestScanner.readOwnedDirectory(tombstone, ingestionId)
              if (!manifestFile.readBytes().contentEquals(manifestBytes)) {
                throw InboxArtifactHandoffException("ARTIFACT_INTEGRITY_FAILED")
              }
              receipt = InboxAcknowledgementStore.publish(
                filesDir,
                ingestionId,
                manifestBytes,
                directorySynchronizer,
              )
            } catch (error: InboxAcknowledgementStoreException) {
              throw InboxArtifactHandoffException(error.stableCode)
            } catch (error: NativeException) {
              throw InboxArtifactHandoffException(error.code)
            } catch (_: Exception) {
              throw InboxArtifactHandoffException("ARTIFACT_INTEGRITY_FAILED")
            }
          }
          if (receipt != null) operationHook(AcknowledgementPoint.AFTER_RECEIPT_PUBLISH)
        }
        // Acknowledging a never-published ID remains an idempotent no-op. A matching
        // tombstone, however, must first produce a durable receipt or fail closed.
        if (receipt == null) return@withRegistry true
        cleanupTombstones(
          tombstoneRoot,
          ingestionId,
          operationHook,
          directorySynchronizer,
          tombstoneRemover,
        )
        return@withRegistry true
      }
      val manifestBytes = try {
        val manifestFile = File(directory, "manifest.json")
        val snapshot = manifestFile.readBytes()
        InboxManifestScanner.readPublished(inbox, ingestionId)
        if (!manifestFile.readBytes().contentEquals(snapshot)) {
          throw InboxArtifactHandoffException("ARTIFACT_INTEGRITY_FAILED")
        }
        snapshot
      } catch (error: NativeException) {
        throw InboxArtifactHandoffException(error.code)
      } catch (_: Exception) {
        throw InboxArtifactHandoffException("ARTIFACT_INTEGRITY_FAILED")
      }
      try {
        receipt = InboxAcknowledgementStore.publish(
          filesDir,
          ingestionId,
          manifestBytes,
          directorySynchronizer,
        )
      } catch (error: InboxAcknowledgementStoreException) {
        throw InboxArtifactHandoffException(error.stableCode)
      }
      operationHook(AcknowledgementPoint.AFTER_RECEIPT_PUBLISH)
      ensureDurableDirectory(tombstoneRoot, directorySynchronizer)
      val tombstone = File(tombstoneRoot, "$ingestionId-${UUID.randomUUID()}.ack")
      atomicMove(directory, tombstone)
      directorySynchronizer(inbox)
      directorySynchronizer(tombstoneRoot)
      operationHook(AcknowledgementPoint.AFTER_TOMBSTONE_RENAME)
      cleanupTombstone(
        tombstone,
        operationHook,
        directorySynchronizer,
        tombstoneRemover,
      )
      true
    }
  }

  fun runStartupMaintenance(filesDir: File) {
    runCatching { sweepAcknowledgementTombstones(filesDir) }
  }

  fun sweepAcknowledgementTombstones(
    filesDir: File,
    operationHook: (TombstoneSweepPoint) -> Unit = {},
    directorySynchronizer: (File) -> Unit = ::syncDirectory,
    tombstoneRemover: (File) -> Boolean = { it.deleteRecursively() },
  ): TombstoneSweepResult = InboxWriterOwnership.withRegistry(filesDir) {
    val root = File(filesDir, "InboxAckTombstones")
    if (!root.exists()) return@withRegistry TombstoneSweepResult(0, 0, 0)
    if (!root.isDirectory) throw InboxArtifactHandoffException("STORAGE_WRITE_FAILED")
    val candidates = (root.listFiles()
      ?: throw InboxArtifactHandoffException("STORAGE_WRITE_FAILED"))
      .filter { validAcknowledgementTombstone(it, root) }
      .sortedBy { it.name }
    var removed = 0
    var failed = 0
    candidates.forEach { tombstone ->
      val failure = runCatching {
        val ingestionId = InboxAcknowledgementStore.tombstoneIngestionId(tombstone, root)
          ?: throw InboxArtifactHandoffException("ARTIFACT_INTEGRITY_FAILED")
        if (InboxAcknowledgementStore.read(filesDir, ingestionId) == null) {
          val manifestFile = File(tombstone, "manifest.json")
          val manifestBytes = manifestFile.readBytes()
          InboxManifestScanner.readOwnedDirectory(tombstone, ingestionId)
          if (!manifestFile.readBytes().contentEquals(manifestBytes)) {
            throw InboxArtifactHandoffException("ARTIFACT_INTEGRITY_FAILED")
          }
          InboxAcknowledgementStore.publish(
            filesDir,
            ingestionId,
            manifestBytes,
            directorySynchronizer,
          )
        }
        if (!tombstoneRemover(tombstone) || tombstone.exists()) {
          throw InboxArtifactHandoffException("STORAGE_WRITE_FAILED")
        }
        directorySynchronizer(root)
      }.exceptionOrNull()
      if (failure != null) {
        failed += 1
        return@forEach
      }
      removed += 1
      operationHook(TombstoneSweepPoint.AFTER_REMOVAL)
    }
    TombstoneSweepResult(candidates.size, removed, failed)
  }

  private fun publish(
    source: File,
    partial: File,
    destination: File,
    byteCount: Long,
    expectedHash: String?,
    operationHook: (Point) -> Unit,
    directorySynchronizer: (File) -> Unit,
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
      openRegularInput(source, byteCount).buffered().use { input ->
        FileOutputStream(partial).buffered().use { output ->
          val buffer = ByteArray(64 * 1024)
          var firstChunk = true
          var total = 0L
          while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            total += count
            if (total > byteCount) {
              throw InboxArtifactHandoffException("ARTIFACT_INTEGRITY_FAILED")
            }
            output.write(buffer, 0, count)
            if (firstChunk) {
              firstChunk = false
              operationHook(Point.DURING_COPY)
            }
          }
          if (total != byteCount) {
            throw InboxArtifactHandoffException("ARTIFACT_INTEGRITY_FAILED")
          }
          output.flush()
        }
      }
      FileOutputStream(partial, true).use { it.fd.sync() }
      operationHook(Point.AFTER_FILE_CLOSE)
      val actualHash = verify(partial, byteCount, expectedHash)
      operationHook(Point.BEFORE_PUBLISH_RENAME)
      atomicMove(partial, destination)
      directorySynchronizer(
        destination.parentFile ?: throw InboxArtifactHandoffException("STORAGE_WRITE_FAILED"),
      )
      return actualHash
    } catch (error: InboxArtifactHandoffException) {
      throw error
    } catch (_: Exception) {
      throw InboxArtifactHandoffException("STORAGE_WRITE_FAILED")
    }
  }

  private fun ensureDestinationHierarchy(
    filesDir: File,
    packId: String,
    directorySynchronizer: (File) -> Unit,
  ) {
    val packs = File(filesDir, "Packs")
    ensureDurableDirectory(packs, directorySynchronizer)
    val pack = File(packs, packId)
    ensureDurableDirectory(pack, directorySynchronizer)
    ensureDurableDirectory(File(pack, "originals"), directorySynchronizer)
  }

  private fun ensureDurableDirectory(
    directory: File,
    directorySynchronizer: (File) -> Unit,
  ) {
    val parent = directory.parentFile
      ?: throw InboxArtifactHandoffException("STORAGE_WRITE_FAILED")
    try {
      if (directory.exists()) {
        if (!directory.isDirectory) {
          throw InboxArtifactHandoffException("STORAGE_WRITE_FAILED")
        }
      } else {
        if (!directory.mkdir()) throw InboxArtifactHandoffException("STORAGE_WRITE_FAILED")
      }
      directorySynchronizer(directory)
      directorySynchronizer(parent)
    } catch (error: InboxArtifactHandoffException) {
      throw error
    } catch (_: Exception) {
      throw InboxArtifactHandoffException("STORAGE_WRITE_FAILED")
    }
  }

  private fun atomicMove(source: File, destination: File) {
    val published = if (Build.VERSION.SDK_INT >= 26) {
      runCatching {
        java.nio.file.Files.move(
          source.toPath(),
          destination.toPath(),
          java.nio.file.StandardCopyOption.ATOMIC_MOVE,
        )
      }.isSuccess
    } else {
      source.renameTo(destination)
    }
    if (!published) throw InboxArtifactHandoffException("STORAGE_WRITE_FAILED")
  }

  private fun cleanupTombstones(
    root: File,
    ingestionId: String,
    operationHook: (AcknowledgementPoint) -> Unit,
    directorySynchronizer: (File) -> Unit,
    tombstoneRemover: (File) -> Boolean,
  ) {
    val filesDir = root.parentFile ?: return
    runCatching { InboxAcknowledgementStore.matchingTombstones(filesDir, ingestionId) }
      .getOrDefault(emptyList())
      .forEach {
        cleanupTombstone(
          it,
          operationHook,
          directorySynchronizer,
          tombstoneRemover,
        )
      }
  }

  private fun validAcknowledgementTombstone(candidate: File, root: File): Boolean =
    InboxAcknowledgementStore.tombstoneIngestionId(candidate, root) != null

  private fun cleanupTombstone(
    tombstone: File,
    operationHook: (AcknowledgementPoint) -> Unit,
    directorySynchronizer: (File) -> Unit,
    tombstoneRemover: (File) -> Boolean,
  ) {
    runCatching {
      operationHook(AcknowledgementPoint.DURING_TOMBSTONE_DELETION)
      if (!tombstoneRemover(tombstone) || tombstone.exists()) {
        throw InboxArtifactHandoffException("STORAGE_WRITE_FAILED")
      }
      tombstone.parentFile?.let(directorySynchronizer)
    }
    // The atomic rename already removed the scanner-visible Inbox entry.
    // Tombstone removal is intentionally retryable best-effort cleanup.
  }

  private fun verify(file: File, byteCount: Long, expectedHash: String?): String {
    val digest = MessageDigest.getInstance("SHA-256")
    openRegularInput(file, byteCount).buffered().use { input ->
      val buffer = ByteArray(64 * 1024)
      var total = 0L
      while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        total += count
        if (total > byteCount) {
          throw InboxArtifactHandoffException("ARTIFACT_INTEGRITY_FAILED")
        }
        digest.update(buffer, 0, count)
      }
      if (total != byteCount) {
        throw InboxArtifactHandoffException("ARTIFACT_INTEGRITY_FAILED")
      }
    }
    val actualHash = digest.digest().joinToString("") {
      "%02x".format(it.toInt() and 0xff)
    }
    if (expectedHash != null && actualHash != expectedHash) {
      throw InboxArtifactHandoffException("ARTIFACT_INTEGRITY_FAILED")
    }
    return actualHash
  }

  private fun openRegularInput(file: File, byteCount: Long): FileInputStream {
    val descriptor = try {
      Os.open(
        file.path,
        OsConstants.O_RDONLY or OsConstants.O_NOFOLLOW,
        0,
      )
    } catch (_: Exception) {
      throw InboxArtifactHandoffException("ARTIFACT_INTEGRITY_FAILED")
    }
    try {
      val stat = Os.fstat(descriptor)
      if (!OsConstants.S_ISREG(stat.st_mode) || stat.st_size != byteCount) {
        throw InboxArtifactHandoffException("ARTIFACT_INTEGRITY_FAILED")
      }
      return FileInputStream(descriptor)
    } catch (error: Exception) {
      runCatching { Os.close(descriptor) }
      if (error is InboxArtifactHandoffException) throw error
      throw InboxArtifactHandoffException("ARTIFACT_INTEGRITY_FAILED")
    }
  }

  private fun sha256(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes)
      .joinToString("") { "%02x".format(it.toInt() and 0xff) }

  private fun syncDirectory(directory: File) {
    val descriptor = Os.open(directory.path, OsConstants.O_RDONLY, 0)
    try { Os.fsync(descriptor) } finally { Os.close(descriptor) }
  }

  private fun requireCanonicalUuid(value: String) {
    if (!canonicalUuid(value)) {
      throw InboxArtifactHandoffException("SCHEMA_INVALID")
    }
  }

  private fun canonicalUuid(value: String): Boolean = try {
    UUID.fromString(value).toString() == value
  } catch (_: IllegalArgumentException) {
    false
  }
}
