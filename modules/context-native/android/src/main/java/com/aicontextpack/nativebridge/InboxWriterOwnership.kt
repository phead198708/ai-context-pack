package com.aicontextpack.nativebridge

import java.io.File
import java.io.RandomAccessFile
import java.nio.channels.FileLock
import java.nio.channels.OverlappingFileLockException
import java.util.UUID
import java.util.concurrent.locks.ReentrantLock

/**
 * Publishes per-ingestion ownership while holding a stable registry lock.
 *
 * The registry file is never removed. A scanner must take the same lock before
 * observing per-ingestion lock files, so no unlocked per-ingestion file can be
 * mistaken for abandoned ownership while a writer is still registering it.
 */
class InboxWriterOwnership private constructor(
  private val filesDir: File,
  private val lockFile: File,
  private var handle: RandomAccessFile?,
  private var ownership: FileLock?,
) : AutoCloseable {
  override fun close() {
    val currentHandle = handle ?: return
    val currentOwnership = ownership
    handle = null
    ownership = null
    withRegistry(filesDir) {
      var failure: Throwable? = null
      try {
        if (lockFile.exists() && !lockFile.delete()) {
          failure = IllegalStateException("INBOX_WRITER_LOCK_REMOVE_FAILED")
        }
      } finally {
        runCatching { currentOwnership?.release() }
          .exceptionOrNull()
          ?.let { if (failure == null) failure = it }
        runCatching { currentHandle.close() }
          .exceptionOrNull()
          ?.let { if (failure == null) failure = it }
      }
      failure?.let { throw it }
    }
  }

  companion object {
    internal const val registryFileName = ".registry.lock"
    private val localRegistryLock = ReentrantLock()

    fun acquire(
      filesDir: File,
      ingestionId: String,
      publishedBeforeOwnership: () -> Unit = {},
    ): InboxWriterOwnership {
      requireCanonicalUuid(ingestionId)
      return withRegistry(filesDir) { lockDirectory ->
        val visibleLock = File(lockDirectory, "$ingestionId.lock")
        check(visibleLock.createNewFile()) { "INBOX_WRITER_LOCK_ALREADY_EXISTS" }
        val handle = RandomAccessFile(visibleLock, "rw")
        try {
          publishedBeforeOwnership()
          val ownership = handle.channel.lock()
          InboxWriterOwnership(filesDir, visibleLock, handle, ownership)
        } catch (error: Throwable) {
          runCatching { handle.close() }
          runCatching { visibleLock.delete() }
          throw error
        }
      }
    }

    internal fun <T> withRegistry(filesDir: File, action: (File) -> T): T {
      localRegistryLock.lock()
      try {
        val directory = File(filesDir, "InboxWriterLocks")
        check(directory.mkdirs() || directory.isDirectory) {
          "INBOX_WRITER_LOCK_DIRECTORY_INVALID"
        }
        val registry = RandomAccessFile(File(directory, registryFileName), "rw")
        try {
          registry.channel.lock().use { return action(directory) }
        } finally {
          registry.close()
        }
      } finally {
        localRegistryLock.unlock()
      }
    }

    internal fun acquireForRecovery(filesDir: File, directory: File): AutoCloseable? =
      withRegistry(filesDir) {
        val external = File(File(filesDir, "InboxWriterLocks"), "${directory.name}.lock")
        val legacy = File(directory, ".writer.lock")
        val candidate = when {
          external.exists() -> external
          legacy.exists() -> legacy
          else -> return@withRegistry AutoCloseable {}
        }
        val handle = RandomAccessFile(candidate, "rw")
        val lock = try {
          handle.channel.tryLock()
        } catch (_: OverlappingFileLockException) {
          null
        }
        if (lock == null) {
          handle.close()
          return@withRegistry null
        }
        RecoveryOwnership(filesDir, candidate, candidate == external, handle, lock)
      }

    internal fun removeAbandonedLockWhileCoordinated(lockFile: File): Boolean {
      val handle = RandomAccessFile(lockFile, "rw")
      val lock = try {
        handle.channel.tryLock()
      } catch (_: OverlappingFileLockException) {
        null
      }
      if (lock == null) {
        handle.close()
        return false
      }
      try {
        check(lockFile.delete() || !lockFile.exists())
      } finally {
        lock.release()
        handle.close()
      }
      return true
    }

    private fun requireCanonicalUuid(value: String) {
      require(UUID.fromString(value).toString() == value.lowercase())
    }
  }
}

private class RecoveryOwnership(
  private val filesDir: File,
  private val lockFile: File,
  private val removeVisibleLock: Boolean,
  private var handle: RandomAccessFile?,
  private var ownership: FileLock?,
) : AutoCloseable {
  override fun close() {
    val currentHandle = handle ?: return
    val currentOwnership = ownership
    handle = null
    ownership = null
    if (removeVisibleLock) {
      InboxWriterOwnership.withRegistry(filesDir) {
        try {
          check(lockFile.delete() || !lockFile.exists())
        } finally {
          currentOwnership?.release()
          currentHandle.close()
        }
      }
    } else {
      currentOwnership?.release()
      currentHandle.close()
    }
  }
}
