package com.aicontextpack.nativebridge

import androidx.test.platform.app.InstrumentationRegistry
import android.system.Os
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Before
import org.junit.Test
import java.io.File
import java.io.RandomAccessFile

class InboxManifestScannerInstrumentedTest {
  private lateinit var inbox: File

  @Before
  fun setUp() {
    inbox = File(
      InstrumentationRegistry.getInstrumentation().targetContext.cacheDir,
      "scanner-test/Inbox",
    )
    inbox.deleteRecursively()
    check(inbox.mkdirs())
  }

  @After
  fun tearDown() {
    inbox.parentFile?.deleteRecursively()
  }

  @Test
  fun rejectsMalformedManifestInsteadOfDroppingIt() {
    File(inbox, "broken/manifest.json").apply {
      parentFile?.mkdirs()
      writeText("{truncated")
    }

    assertThrows(NativeException::class.java) { InboxManifestScanner.scan(inbox) }
  }

  @Test
  fun rejectsFileUriOutsideOwnedInbox() {
    writeManifest(File(inbox.parentFile, "outside.bin"))

    assertThrows(NativeException::class.java) { InboxManifestScanner.scan(inbox) }
  }

  @Test
  fun returnsValidOwnedManifest() {
    val item = File(inbox, "valid/item.bin").apply {
      parentFile?.mkdirs()
      writeBytes(byteArrayOf(1, 2, 3))
    }
    writeManifest(item)

    assertEquals(1, InboxManifestScanner.scan(inbox).size)
  }

  @Test
  fun rejectsCopiedFileWithMismatchedByteCount() {
    val item = File(inbox, "valid/item.bin").apply {
      parentFile?.mkdirs()
      writeBytes(byteArrayOf(1, 2, 3))
    }
    writeManifest(item, byteCount = 4)

    assertThrows(NativeException::class.java) { InboxManifestScanner.scan(inbox) }
  }

  @Test
  fun rejectsManifestThatReferencesAnotherIngestion() {
    val other = File(inbox, "other/item.bin").apply {
      parentFile?.mkdirs(); writeBytes(byteArrayOf(1, 2, 3))
    }
    writeManifest(other, manifestDirectory = File(inbox, "claimed"))
    assertThrows(NativeException::class.java) { InboxManifestScanner.scan(inbox) }
  }

  @Test
  fun leavesTransactionsWithLiveWriterLocksUntouched() {
    val partialId = "123e4567-e89b-42d3-a456-426614174000"
    val stagingId = "223e4567-e89b-42d3-a456-426614174000"
    val partial = File(inbox, partialId).apply { mkdirs() }
    File(partial, "item.partial").writeBytes(byteArrayOf(1, 2))
    val staging = File(inbox.parentFile, "InboxStaging/$stagingId").apply { mkdirs() }
    File(staging, "item.partial").writeBytes(byteArrayOf(3, 4))
    val lockDirectory = File(inbox.parentFile, "InboxWriterLocks").apply { mkdirs() }
    val firstFile = RandomAccessFile(File(lockDirectory, "$partialId.lock"), "rw")
    val secondFile = RandomAccessFile(File(lockDirectory, "$stagingId.lock"), "rw")
    val firstLock = firstFile.channel.lock()
    val secondLock = secondFile.channel.lock()
    try {
      assertEquals(emptyList<Map<String, Any?>>(), InboxManifestScanner.scan(inbox))
      assertEquals(true, partial.exists())
      assertEquals(true, staging.exists())
    } finally {
      firstLock.release(); secondLock.release(); firstFile.close(); secondFile.close()
    }
  }

  @Test
  fun preservesLivePreDirectoryLockAndRemovesItAfterAbandonment() {
    val id = "323e4567-e89b-42d3-a456-426614174000"
    val lockFile = File(inbox.parentFile, "InboxWriterLocks/$id.lock").apply {
      parentFile?.mkdirs(); createNewFile()
    }
    RandomAccessFile(lockFile, "rw").use { owner ->
      owner.channel.lock().use {
        assertEquals(emptyList<Map<String, Any?>>(), InboxManifestScanner.scan(inbox))
        assertEquals(true, lockFile.exists())
      }
    }
    assertEquals(emptyList<Map<String, Any?>>(), InboxManifestScanner.scan(inbox))
    assertEquals(false, lockFile.exists())
  }

  @Test
  fun failsClosedOnMalformedLockRegistryEntry() {
    File(inbox.parentFile, "InboxWriterLocks/provider-name.lock").apply {
      parentFile?.mkdirs(); createNewFile()
    }
    assertThrows(NativeException::class.java) { InboxManifestScanner.scan(inbox) }
  }

  @Test
  fun removesFreshlyAbandonedUnlockedTransactionsAndSurfacesDurableRecovery() {
    val copied = File(inbox, "copied").apply { mkdirs() }
    File(copied, "item.bin").writeBytes(byteArrayOf(3, 4))
    val staging = File(inbox.parentFile, "InboxStaging/stale").apply { mkdirs() }
    File(staging, "item.partial").writeBytes(byteArrayOf(1, 2))

    assertThrows(NativeException::class.java) { InboxManifestScanner.scan(inbox) }
    assertEquals(false, copied.exists())
    assertEquals(false, staging.exists())
    val events = MetadataEventStore.read(requireNotNull(inbox.parentFile), "RecoveryEvents")
    assertEquals(2, events.size)
    assertThrows(NativeException::class.java) { InboxManifestScanner.scan(inbox) }
    events.forEach { MetadataEventStore.ack(requireNotNull(inbox.parentFile), "RecoveryEvents", it.getValue("id") as String) }
    assertEquals(emptyList<Map<String, Any?>>(), InboxManifestScanner.scan(inbox))
  }

  @Test
  fun acknowledgesOnlyTheSpecifiedShareEventDuringInterleaving() {
    val filesDir = requireNotNull(inbox.parentFile)
    val first = MetadataEventStore.persistShareResult(filesDir, "complete")
    val second = MetadataEventStore.persistShareResult(filesDir, "failed")
    MetadataEventStore.ack(filesDir, "PendingShareEvents", first.getValue("id") as String)
    val remaining = MetadataEventStore.read(filesDir, "PendingShareEvents")
    assertEquals(listOf(second.getValue("id")), remaining.map { it["id"] })
  }

  @Test
  fun cleansPartialEventWhenAtomicRenameFails() {
    val id = "423e4567-e89b-42d3-a456-426614174000"
    val directory = File(inbox.parentFile, "PendingShareEvents").apply { mkdirs() }
    File(directory, "$id.json").mkdirs()
    assertThrows(Exception::class.java) {
      MetadataEventStore.persistShareResult(requireNotNull(inbox.parentFile), "failed", eventId = id)
    }
    assertEquals(false, File(directory, "$id.partial").exists())
  }

  @Test
  fun surfacesEventStoreWriteFailure() {
    File(inbox.parentFile, "PendingShareEvents").writeText("not a directory")
    assertThrows(Exception::class.java) {
      MetadataEventStore.persistShareResult(requireNotNull(inbox.parentFile), "failed")
    }
  }

  @Test
  fun rejectsInboxThatIsNotDirectory() {
    inbox.deleteRecursively()
    inbox.writeText("not a directory")

    assertThrows(NativeException::class.java) { InboxManifestScanner.scan(inbox) }
  }

  @Test
  fun rejectsTraversalFailure() {
    val blocked = File(inbox, "blocked").apply { mkdirs() }
    val item = File(blocked, "item.bin").apply { writeBytes(byteArrayOf(1)) }
    writeManifest(item, manifestDirectory = blocked)
    Os.chmod(blocked.path, 0)
    try {
      assertThrows(NativeException::class.java) { InboxManifestScanner.scan(inbox) }
    } finally {
      Os.chmod(blocked.path, 448)
    }
  }

  private fun writeManifest(
    item: File,
    byteCount: Long = item.length(),
    manifestDirectory: File = File(inbox, "valid"),
  ) {
    val directory = manifestDirectory.apply { mkdirs() }
    val payload = JSONObject()
      .put("schemaVersion", 1)
      .put("ingestionId", "valid")
      .put("createdAt", "2026-01-01T00:00:00Z")
      .put("source", "android-share-intent")
      .put("status", "complete")
      .put(
        "items",
        JSONArray().put(
          JSONObject()
            .put("id", "item")
            .put("mediaType", "image/png")
            .put("byteCount", byteCount)
            .put("localUri", item.toURI().toString())
            .put("status", "copied"),
        ),
      )
    File(directory, "manifest.json").writeText(payload.toString())
  }
}
