package com.aicontextpack.nativebridge

import android.net.Uri
import android.os.Build
import android.system.Os
import android.system.OsConstants
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

internal class OwnedArtifactStoreException(val stableCode: String) : Exception(stableCode)

internal object OwnedArtifactStore {
  private val areas = setOf("originals", "derived", "exports", "previews")
  private val extensions = setOf(
    "bin", "heic", "jpeg", "jpg", "json", "md", "pdf", "png", "txt", "zip",
  )
  private class ProcessLockEntry {
    val lock = ReentrantLock()
    var users = 0
  }
  private val processLocks = ConcurrentHashMap<String, ProcessLockEntry>()
  private const val MAXIMUM_SAFE_INTEGER = 9_007_199_254_740_991L

  fun publish(
    root: File,
    source: File,
    relativePath: String,
    expectedByteCount: Long?,
    expectedSha256: String?,
  ): Map<String, Any> {
    val path = validate(root, relativePath)
    if (
      expectedByteCount?.let { it < 0 || it > MAXIMUM_SAFE_INTEGER } == true ||
      expectedSha256?.let(::validSha256) == false
    ) throw OwnedArtifactStoreException("SCHEMA_INVALID")
    requireRegularFile(source)
    val byteCount = source.length()
    if (byteCount > MAXIMUM_SAFE_INTEGER || expectedByteCount?.let { it != byteCount } == true) {
      throw OwnedArtifactStoreException("ARTIFACT_INTEGRITY_FAILED")
    }
    val sourceHash = sha256(source)
    if (expectedSha256 != null && expectedSha256 != sourceHash) {
      throw OwnedArtifactStoreException("ARTIFACT_INTEGRITY_FAILED")
    }
    return withArtifactLock(root, path.artifactId) {
      ensureDirectoryChain(path.file.parentFile
        ?: throw OwnedArtifactStoreException("STORAGE_WRITE_FAILED"))
      if (path.file.exists()) {
        requireRegularFile(path.file)
        if (path.file.length() != byteCount || sha256(path.file) != sourceHash) {
          throw OwnedArtifactStoreException("STORAGE_ARTIFACT_IMMUTABLE")
        }
        return@withArtifactLock mapOf(
          "relativePath" to relativePath,
          "byteCount" to byteCount,
          "sha256" to sourceHash,
          "created" to false,
        )
      }
      val partial = File(path.file.parentFile, "${path.file.name}.partial")
      if (partial.exists()) {
        if (!partial.delete()) throw OwnedArtifactStoreException("STORAGE_WRITE_FAILED")
        syncDirectory(requireNotNull(partial.parentFile))
      }
      try {
        source.inputStream().buffered().use { input ->
          FileOutputStream(partial).buffered().use { output ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
              val count = input.read(buffer)
              if (count < 0) break
              output.write(buffer, 0, count)
            }
            output.flush()
          }
        }
        FileOutputStream(partial, true).use { it.fd.sync() }
        requireRegularFile(partial)
        if (partial.length() != byteCount || sha256(partial) != sourceHash) {
          throw OwnedArtifactStoreException("ARTIFACT_INTEGRITY_FAILED")
        }
        atomicMove(partial, path.file)
        syncDirectory(requireNotNull(path.file.parentFile))
      } catch (error: OwnedArtifactStoreException) {
        throw error
      } catch (_: Exception) {
        throw OwnedArtifactStoreException("STORAGE_WRITE_FAILED")
      }
      mapOf(
        "relativePath" to relativePath,
        "byteCount" to byteCount,
        "sha256" to sourceHash,
        "created" to true,
      )
    }
  }

  fun verify(
    root: File,
    relativePath: String,
    expectedByteCount: Long,
    expectedSha256: String,
  ): Map<String, Any> {
    val path = validate(root, relativePath)
    if (expectedByteCount < 0 || expectedByteCount > MAXIMUM_SAFE_INTEGER || !validSha256(expectedSha256)) {
      throw OwnedArtifactStoreException("SCHEMA_INVALID")
    }
    if (!path.file.exists()) return mapOf("relativePath" to relativePath, "status" to "missing")
    requireAncestorDirectories(root, requireNotNull(path.file.parentFile))
    requireRegularFile(path.file)
    val byteCount = path.file.length()
    val hash = sha256(path.file)
    return mapOf(
      "relativePath" to relativePath,
      "status" to if (byteCount == expectedByteCount && hash == expectedSha256) "verified" else "mismatch",
      "byteCount" to byteCount,
      "sha256" to hash,
    )
  }

  fun resolveFileUri(root: File, relativePath: String): String {
    val path = validate(root, relativePath)
    requireAncestorDirectories(root, requireNotNull(path.file.parentFile))
    requireRegularFile(path.file)
    return Uri.fromFile(path.file).toString()
  }

  fun writeText(root: File, relativePath: String, text: String): Map<String, Any> {
    val path = validate(root, relativePath)
    val bytes = text.toByteArray(Charsets.UTF_8)
    if (!relativePath.endsWith(".txt") || bytes.size > 16 * 1024 * 1024) {
      throw OwnedArtifactStoreException("SCHEMA_INVALID")
    }
    return withArtifactLock(root, path.artifactId) {
      ensureDirectoryChain(path.file.parentFile
        ?: throw OwnedArtifactStoreException("STORAGE_WRITE_FAILED"))
      val expectedHash = MessageDigest.getInstance("SHA-256")
        .digest(bytes).joinToString("") { "%02x".format(it) }
      if (path.file.exists()) {
        requireRegularFile(path.file)
        if (path.file.length() != bytes.size.toLong() || sha256(path.file) != expectedHash) {
          throw OwnedArtifactStoreException("STORAGE_ARTIFACT_IMMUTABLE")
        }
        return@withArtifactLock mapOf(
          "relativePath" to relativePath,
          "byteCount" to bytes.size.toLong(),
          "sha256" to expectedHash,
          "created" to false,
        )
      }
      val partial = File(path.file.parentFile, "${path.file.name}.partial")
      try {
        if (partial.exists()) {
          if (!partial.delete()) throw OwnedArtifactStoreException("STORAGE_WRITE_FAILED")
          syncDirectory(requireNotNull(partial.parentFile))
        }
        FileOutputStream(partial).use { output ->
          output.write(bytes)
          output.fd.sync()
        }
        requireRegularFile(partial)
        if (partial.length() != bytes.size.toLong() || sha256(partial) != expectedHash) {
          throw OwnedArtifactStoreException("ARTIFACT_INTEGRITY_FAILED")
        }
        atomicMove(partial, path.file)
        syncDirectory(requireNotNull(path.file.parentFile))
      } catch (error: OwnedArtifactStoreException) {
        throw error
      } catch (_: Exception) {
        throw OwnedArtifactStoreException("STORAGE_WRITE_FAILED")
      }
      mapOf(
        "relativePath" to relativePath,
        "byteCount" to bytes.size.toLong(),
        "sha256" to expectedHash,
        "created" to true,
      )
    }
  }

  fun list(root: File): List<Map<String, Any>> {
    val packs = File(root, "Packs")
    if (!packs.exists()) return emptyList()
    requireDirectory(packs)
    val results = mutableListOf<Map<String, Any>>()
    directories(packs).forEach { pack ->
      if (!canonicalUuid(pack.name)) throw OwnedArtifactStoreException("ARTIFACT_INTEGRITY_FAILED")
      directories(pack).filter { areas.contains(it.name) }.forEach { area ->
        val children = area.listFiles()
          ?: throw OwnedArtifactStoreException("STORAGE_WRITE_FAILED")
        children.sortedBy { it.name }.forEach { file ->
          val relativePath = "Packs/${pack.name}/${area.name}/${file.name}"
          validate(root, relativePath, allowPartial = true)
          requireRegularFile(file)
          results += mapOf("relativePath" to relativePath, "byteCount" to file.length())
        }
      }
    }
    return results
  }

  fun remove(root: File, relativePath: String): Boolean {
    val path = validate(root, relativePath, allowPartial = true)
    return withArtifactLock(root, path.artifactId) {
      if (!path.file.exists()) return@withArtifactLock true
      requireAncestorDirectories(root, requireNotNull(path.file.parentFile))
      requireRegularFile(path.file)
      if (!path.file.delete()) throw OwnedArtifactStoreException("STORAGE_WRITE_FAILED")
      syncDirectory(requireNotNull(path.file.parentFile))
      true
    }
  }

  fun quarantine(root: File, relativePath: String): Map<String, Any> {
    val path = validate(root, relativePath, allowPartial = true)
    return withArtifactLock(root, path.artifactId) {
      if (!path.file.exists()) return@withArtifactLock mapOf("quarantined" to false)
      requireAncestorDirectories(root, requireNotNull(path.file.parentFile))
      requireRegularFile(path.file)
      val byteCount = path.file.length()
      withArtifactLock(root, "quarantine-retention") {
        val quarantine = File(root, "ArtifactQuarantine")
        ensureDirectoryChain(quarantine)
        val quarantineId = UUID.randomUUID().toString()
        val destination = File(quarantine, "${path.artifactId}-$quarantineId.quarantine")
        atomicMove(path.file, destination)
        if (!destination.setLastModified(System.currentTimeMillis())) {
          throw OwnedArtifactStoreException("STORAGE_WRITE_FAILED")
        }
        FileOutputStream(destination, true).use { it.fd.sync() }
        syncDirectory(requireNotNull(path.file.parentFile))
        syncDirectory(quarantine)
        mapOf(
          "quarantined" to true,
          "quarantineId" to quarantineId,
          "anonymousId" to path.artifactId,
          "byteCount" to byteCount,
        )
      }
    }
  }

  fun purgeQuarantine(root: File, olderThanEpochMs: Long): Map<String, Any> {
    if (olderThanEpochMs < 0 || olderThanEpochMs > MAXIMUM_SAFE_INTEGER) {
      throw OwnedArtifactStoreException("SCHEMA_INVALID")
    }
    return withArtifactLock(root, "quarantine-retention") {
      val quarantine = File(root, "ArtifactQuarantine")
      if (!quarantine.exists()) {
        return@withArtifactLock mapOf("purgedCount" to 0, "purgedBytes" to 0L)
      }
      requireDirectory(quarantine)
      val files = quarantine.listFiles()?.sortedBy { it.name }
        ?: throw OwnedArtifactStoreException("STORAGE_WRITE_FAILED")
      var purgedCount = 0
      var purgedBytes = 0L
      files.forEach { file ->
        validateQuarantineLeaf(file.name)
        requireRegularFile(file)
        if (file.lastModified() > olderThanEpochMs) return@forEach
        val byteCount = file.length()
        if (purgedBytes > MAXIMUM_SAFE_INTEGER - byteCount) {
          throw OwnedArtifactStoreException("ARTIFACT_INTEGRITY_FAILED")
        }
        if (!file.delete()) throw OwnedArtifactStoreException("STORAGE_WRITE_FAILED")
        purgedBytes += byteCount
        purgedCount += 1
      }
      if (purgedCount > 0) syncDirectory(quarantine)
      mapOf("purgedCount" to purgedCount, "purgedBytes" to purgedBytes)
    }
  }

  fun usage(root: File): Map<String, Any> {
    val artifacts = list(root)
    val artifactBytes = safeSum(artifacts.map { (it["byteCount"] as Number).toLong() })
    val quarantine = File(root, "ArtifactQuarantine")
    val quarantined = if (!quarantine.exists()) emptyList() else {
      requireDirectory(quarantine)
      quarantine.listFiles()?.sortedBy { it.name }
        ?: throw OwnedArtifactStoreException("STORAGE_WRITE_FAILED")
    }
    quarantined.forEach(::requireRegularFile)
    return mapOf(
      "artifactCount" to artifacts.size,
      "artifactBytes" to artifactBytes,
      "quarantineCount" to quarantined.size,
      "quarantineBytes" to safeSum(quarantined.map(File::length)),
    )
  }

  private data class ValidatedPath(val file: File, val artifactId: String)

  private fun validate(
    root: File,
    relativePath: String,
    allowPartial: Boolean = false,
  ): ValidatedPath {
    if (
      relativePath.isEmpty() || relativePath.startsWith('/') || relativePath.contains('\\') ||
      relativePath.contains('%') || relativePath.contains('\u0000')
    ) throw OwnedArtifactStoreException("SCHEMA_INVALID")
    val components = relativePath.split('/', ignoreCase = false, limit = 0)
    if (
      components.size != 4 || components[0] != "Packs" ||
      !canonicalUuid(components[1]) || !areas.contains(components[2])
    ) throw OwnedArtifactStoreException("SCHEMA_INVALID")
    val leaf = components[3]
    val partial = leaf.endsWith(".partial")
    if (partial && !allowPartial) throw OwnedArtifactStoreException("SCHEMA_INVALID")
    val publishedLeaf = if (partial) leaf.removeSuffix(".partial") else leaf
    val extension = publishedLeaf.substringAfterLast('.', "")
    val artifactId = publishedLeaf.removeSuffix(
      if (extension.isEmpty()) "" else ".$extension",
    )
    if (!canonicalUuid(artifactId) || !extensions.contains(extension)) {
      throw OwnedArtifactStoreException("SCHEMA_INVALID")
    }
    val file = File(root, relativePath)
    val rootPath = root.canonicalFile.path + File.separator
    if (!file.canonicalFile.path.startsWith(rootPath)) {
      throw OwnedArtifactStoreException("SCHEMA_INVALID")
    }
    return ValidatedPath(file, artifactId)
  }

  private fun <T> withArtifactLock(root: File, artifactId: String, operation: () -> T): T {
    val entry = requireNotNull(processLocks.compute(artifactId) { _, current ->
      (current ?: ProcessLockEntry()).also { it.users += 1 }
    })
    return try {
      entry.lock.withLock {
        val locks = File(root, "ArtifactStoreLocks")
        ensureDirectoryChain(locks)
        FileOutputStream(File(locks, "$artifactId.lock"), true).channel.use { channel ->
          channel.lock().use { operation() }
        }
      }
    } finally {
      processLocks.computeIfPresent(artifactId) { _, current ->
        if (current !== entry) current
        else {
          current.users -= 1
          current.takeIf { it.users > 0 }
        }
      }
    }
  }

  private fun ensureDirectoryChain(target: File) {
    val missing = mutableListOf<File>()
    var candidate = target
    while (!candidate.exists()) {
      missing += candidate
      candidate = candidate.parentFile
        ?: throw OwnedArtifactStoreException("STORAGE_WRITE_FAILED")
    }
    requireDirectory(candidate)
    missing.asReversed().forEach { directory ->
      if (!directory.mkdir()) throw OwnedArtifactStoreException("STORAGE_WRITE_FAILED")
      syncDirectory(directory)
      syncDirectory(requireNotNull(directory.parentFile))
    }
  }

  private fun directories(root: File): List<File> {
    requireDirectory(root)
    val children = root.listFiles()
      ?: throw OwnedArtifactStoreException("STORAGE_WRITE_FAILED")
    return children.filter {
      if (isSymbolicLink(it)) throw OwnedArtifactStoreException("ARTIFACT_INTEGRITY_FAILED")
      it.isDirectory
    }.sortedBy { it.name }
  }

  private fun requireDirectory(file: File) {
    if (!file.isDirectory || isSymbolicLink(file)) {
      throw OwnedArtifactStoreException("ARTIFACT_INTEGRITY_FAILED")
    }
  }

  private fun requireAncestorDirectories(root: File, target: File) {
    val ownedRoot = root.absoluteFile
    var candidate = target.absoluteFile
    val rootPath = ownedRoot.path
    if (candidate.path != rootPath && !candidate.path.startsWith(rootPath + File.separator)) {
      throw OwnedArtifactStoreException("SCHEMA_INVALID")
    }
    while (true) {
      requireDirectory(candidate)
      if (candidate.path == rootPath) return
      candidate = candidate.parentFile
        ?: throw OwnedArtifactStoreException("ARTIFACT_INTEGRITY_FAILED")
    }
  }

  private fun requireRegularFile(file: File) {
    if (!file.isFile || isSymbolicLink(file) || file.length() > MAXIMUM_SAFE_INTEGER) {
      throw OwnedArtifactStoreException("ARTIFACT_INTEGRITY_FAILED")
    }
  }

  private fun isSymbolicLink(file: File): Boolean = try {
    OsConstants.S_ISLNK(Os.lstat(file.path).st_mode)
  } catch (_: Exception) {
    throw OwnedArtifactStoreException("STORAGE_WRITE_FAILED")
  }

  private fun atomicMove(source: File, destination: File) {
    val moved = if (Build.VERSION.SDK_INT >= 26) {
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
    if (!moved) throw OwnedArtifactStoreException("STORAGE_WRITE_FAILED")
  }

  private fun syncDirectory(directory: File) {
    val descriptor = try { Os.open(directory.path, OsConstants.O_RDONLY, 0) }
    catch (_: Exception) { throw OwnedArtifactStoreException("STORAGE_WRITE_FAILED") }
    try { Os.fsync(descriptor) }
    catch (_: Exception) { throw OwnedArtifactStoreException("STORAGE_WRITE_FAILED") }
    finally { Os.close(descriptor) }
  }

  private fun sha256(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    try {
      file.inputStream().buffered().use { input ->
        val buffer = ByteArray(64 * 1024)
        while (true) {
          val count = input.read(buffer)
          if (count < 0) break
          digest.update(buffer, 0, count)
        }
      }
    } catch (_: Exception) {
      throw OwnedArtifactStoreException("ARTIFACT_INTEGRITY_FAILED")
    }
    return digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
  }

  private fun safeSum(values: List<Long>): Long = values.fold(0L) { total, value ->
    if (value < 0 || total > MAXIMUM_SAFE_INTEGER - value) {
      throw OwnedArtifactStoreException("ARTIFACT_INTEGRITY_FAILED")
    }
    total + value
  }

  private fun validSha256(value: String): Boolean =
    value.matches(Regex("^[0-9a-f]{64}$"))

  private fun validateQuarantineLeaf(value: String) {
    val match = Regex(
      "^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-" +
        "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\.quarantine$",
    ).matchEntire(value) ?: throw OwnedArtifactStoreException("ARTIFACT_INTEGRITY_FAILED")
    if (!canonicalUuid(match.groupValues[1]) || !canonicalUuid(match.groupValues[2])) {
      throw OwnedArtifactStoreException("ARTIFACT_INTEGRITY_FAILED")
    }
  }

  private fun canonicalUuid(value: String): Boolean = try {
    UUID.fromString(value).toString() == value
  } catch (_: IllegalArgumentException) {
    false
  }
}
