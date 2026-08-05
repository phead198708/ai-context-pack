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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread

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
  fun quarantinesMalformedManifestAndRetryCanContinue() {
    File(inbox, "$validIngestionId/manifest.json").apply {
      parentFile?.mkdirs()
      writeText("{truncated")
    }

    val error = assertThrows(NativeException::class.java) { InboxManifestScanner.scan(inbox) }

    assertEquals("SCHEMA_INVALID", error.code)
    assertEquals(emptyList<File>(), inbox.listFiles()?.toList())
    assertEquals(1, File(inbox.parentFile, "InboxQuarantine").listFiles()?.size)
    assertEquals(emptyList<Map<String, Any?>>(), InboxManifestScanner.scan(inbox))
  }

  @Test
  fun rejectsFullyShapedManifestUsingLenientNonJsonSyntax() {
    val item = File(inbox, "$validIngestionId/$validItemId.bin").apply {
      parentFile?.mkdirs()
      writeBytes(byteArrayOf(1, 2, 3))
    }
    val lenientPayload = """
      {
        schemaVersion: 1,
        ingestionId: '$validIngestionId',
        createdAt: '2026-01-01T00:00:00Z',
        source: 'android-share-intent',
        status: 'complete',
        items: [{
          id: '$validItemId',
          order: 0,
          mediaType: 'image/png',
          byteCount: 3,
          relativePath: '${item.name}',
          status: 'copied'
        }]
      }
    """.trimIndent()
    assertEquals(1, JSONObject(lenientPayload).getInt("schemaVersion"))
    File(requireNotNull(item.parentFile), "manifest.json").writeText(lenientPayload)

    val error = assertThrows(NativeException::class.java) { InboxManifestScanner.scan(inbox) }

    assertEquals("SCHEMA_INVALID", error.code)
  }

  @Test
  fun rejectsFileUriOutsideOwnedInbox() {
    writeManifest(File(inbox.parentFile, "outside.bin"))

    assertThrows(NativeException::class.java) { InboxManifestScanner.scan(inbox) }
  }

  @Test
  fun returnsValidOwnedManifest() {
    val item = File(inbox, "$validIngestionId/$validItemId.bin").apply {
      parentFile?.mkdirs()
      writeBytes(byteArrayOf(1, 2, 3))
    }
    writeManifest(item)

    assertEquals(1, InboxManifestScanner.scan(inbox).size)
  }

  @Test
  fun classifiesCopiedFileWithMismatchedByteCountAsArtifactIntegrityFailure() {
    val item = File(inbox, "$validIngestionId/$validItemId.bin").apply {
      parentFile?.mkdirs()
      writeBytes(byteArrayOf(1, 2, 3))
    }
    writeManifest(item, byteCount = 4)

    val error = assertThrows(NativeException::class.java) { InboxManifestScanner.scan(inbox) }

    assertEquals("ARTIFACT_INTEGRITY_FAILED", error.code)
  }

  @Test
  fun classifiesMissingCopiedFileAsArtifactIntegrityFailure() {
    val item = File(inbox, "$validIngestionId/$validItemId.bin").apply {
      parentFile?.mkdirs()
      writeBytes(byteArrayOf(1, 2, 3))
    }
    writeManifest(item)
    assertEquals(true, item.delete())

    val error = assertThrows(NativeException::class.java) { InboxManifestScanner.scan(inbox) }

    assertEquals("ARTIFACT_INTEGRITY_FAILED", error.code)
  }

  @Test
  fun classifiesEqualLengthDigestMismatchAsArtifactIntegrityFailure() {
    val item = File(inbox, "$validIngestionId/$validItemId.bin").apply {
      parentFile?.mkdirs()
      writeBytes(byteArrayOf(1, 2, 3))
    }
    writeManifest(item, sha256 = originalItemSha256)
    item.writeBytes(byteArrayOf(3, 2, 1))

    val error = assertThrows(NativeException::class.java) { InboxManifestScanner.scan(inbox) }

    assertEquals("ARTIFACT_INTEGRITY_FAILED", error.code)
  }

  @Test
  fun acceptsMatchingCopiedFileDigest() {
    val item = File(inbox, "$validIngestionId/$validItemId.bin").apply {
      parentFile?.mkdirs()
      writeBytes(byteArrayOf(1, 2, 3))
    }
    writeManifest(item, sha256 = originalItemSha256)

    assertEquals(1, InboxManifestScanner.scan(inbox).size)
  }

  @Test
  fun rejectsInvalidCurrentVersionTimestampAsSchemaInvalid() {
    listOf(
      "not-a-timestamp",
      "2026-02-29T00:00:00Z",
      "2026-01-01T24:00:00Z",
      "2026-04-31T00:00:00Z",
    ).forEach { timestamp ->
      val item = File(inbox, "$validIngestionId/$validItemId.bin").apply {
        parentFile?.mkdirs()
        writeBytes(byteArrayOf(1, 2, 3))
      }
      writeManifest(item, createdAt = timestamp)

      val error = assertThrows(NativeException::class.java) { InboxManifestScanner.scan(inbox) }

      assertEquals("SCHEMA_INVALID", error.code)
    }
  }

  @Test
  fun acceptsRealLeapDayWithNanosecondPrecision() {
    val item = File(inbox, "$validIngestionId/$validItemId.bin").apply {
      parentFile?.mkdirs()
      writeBytes(byteArrayOf(1, 2, 3))
    }
    writeManifest(item, createdAt = "2024-02-29T23:59:59.123456789Z")

    assertEquals(1, InboxManifestScanner.scan(inbox).size)
  }

  @Test
  fun rejectsInvalidCurrentVersionItemOrderAsSchemaInvalid() {
    val item = File(inbox, "$validIngestionId/$validItemId.bin").apply {
      parentFile?.mkdirs()
      writeBytes(byteArrayOf(1, 2, 3))
    }
    writeManifest(item, itemOrder = 1)

    val error = assertThrows(NativeException::class.java) { InboxManifestScanner.scan(inbox) }

    assertEquals("SCHEMA_INVALID", error.code)
  }

  @Test
  fun rejectsInvalidCurrentVersionAggregateStatusAsSchemaInvalid() {
    val item = File(inbox, "$validIngestionId/$validItemId.bin").apply {
      parentFile?.mkdirs()
      writeBytes(byteArrayOf(1, 2, 3))
    }
    writeManifest(item, manifestStatus = "failed")

    val error = assertThrows(NativeException::class.java) { InboxManifestScanner.scan(inbox) }

    assertEquals("SCHEMA_INVALID", error.code)
  }

  @Test
  fun rejectsManifestThatReferencesAnotherIngestion() {
    val other = File(inbox, "$otherIngestionId/$validItemId.bin").apply {
      parentFile?.mkdirs(); writeBytes(byteArrayOf(1, 2, 3))
    }
    writeManifest(other, manifestDirectory = File(inbox, validIngestionId))
    assertThrows(NativeException::class.java) { InboxManifestScanner.scan(inbox) }
  }

  @Test
  fun rejectsManifestWhoseIdDoesNotMatchItsDirectory() {
    val item = File(inbox, "$validIngestionId/$validItemId.bin").apply {
      parentFile?.mkdirs(); writeBytes(byteArrayOf(1, 2, 3))
    }
    writeManifest(item, ingestionId = otherIngestionId)

    assertThrows(NativeException::class.java) { InboxManifestScanner.scan(inbox) }
  }

  @Test
  fun rejectsUnknownManifestSchemaVersionWithStableCode() {
    val item = File(inbox, "$validIngestionId/$validItemId.bin").apply {
      parentFile?.mkdirs(); writeBytes(byteArrayOf(1, 2, 3))
    }
    writeManifest(item, schemaVersion = 2)

    val error = assertThrows(NativeException::class.java) { InboxManifestScanner.scan(inbox) }

    assertEquals("SCHEMA_VERSION_UNSUPPORTED", error.code)
  }

  @Test
  fun rejectsEveryNonCanonicalNumericSchemaVersionWithStableCode() {
    for (rawVersion in listOf(
      "-1",
      "1.5",
      "2",
      "1.0",
      "1e0",
      "1.0000000000000001",
      "1.000000000000000000000000000000000000001",
    )) {
      val item = File(inbox, "$validIngestionId/$validItemId.bin").apply {
        parentFile?.mkdirs(); writeBytes(byteArrayOf(1, 2, 3))
      }
      writeManifest(item)
      rewriteManifestSchemaVersion(rawVersion)

      val error = assertThrows(NativeException::class.java) { InboxManifestScanner.scan(inbox) }

      assertEquals("SCHEMA_VERSION_UNSUPPORTED", error.code)
    }
  }

  @Test
  fun rejectsEscapedDuplicateSchemaVersionKeyAsInvalid() {
    val item = File(inbox, "$validIngestionId/$validItemId.bin").apply {
      parentFile?.mkdirs(); writeBytes(byteArrayOf(1, 2, 3))
    }
    writeManifest(item)
    rewriteManifestSchemaVersion(
      "1,\"\\u0073chemaVersion\":1.000000000000000000000000000000000000001",
    )

    val error = assertThrows(NativeException::class.java) { InboxManifestScanner.scan(inbox) }

    assertEquals("SCHEMA_INVALID", error.code)
  }

  @Test
  fun rejectsNestedManifest() {
    val item = File(inbox, "$validIngestionId/$validItemId.bin").apply {
      parentFile?.mkdirs(); writeBytes(byteArrayOf(1, 2, 3))
    }
    writeManifest(item)
    File(inbox, "$validIngestionId/nested/manifest.json").apply {
      parentFile?.mkdirs(); writeText("{}")
    }

    assertThrows(NativeException::class.java) { InboxManifestScanner.scan(inbox) }
  }

  @Test
  fun rejectsInvalidIngestionDirectoryName() {
    val item = File(inbox, "not-a-uuid/$validItemId.bin").apply {
      parentFile?.mkdirs(); writeBytes(byteArrayOf(1, 2, 3))
    }
    writeManifest(item, manifestDirectory = requireNotNull(item.parentFile), ingestionId = "not-a-uuid")

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
  fun scannerCannotObserveUnlockedVisibleWriterOwnership() {
    val id = "423e4567-e89b-42d3-a456-426614174000"
    val published = CountDownLatch(1)
    val allowOwnership = CountDownLatch(1)
    val ownershipAcquired = CountDownLatch(1)
    val releaseWriter = CountDownLatch(1)
    val scannerAttempted = CountDownLatch(1)
    val scannerFinished = CountDownLatch(1)
    val failure = AtomicReference<Throwable?>()

    val writer = thread(name = "writer-registration-barrier") {
      try {
        InboxWriterOwnership.acquire(requireNotNull(inbox.parentFile), id) {
          published.countDown()
          check(allowOwnership.await(5, TimeUnit.SECONDS))
        }.use {
          ownershipAcquired.countDown()
          check(releaseWriter.await(5, TimeUnit.SECONDS))
        }
      } catch (error: Throwable) {
        failure.compareAndSet(null, error)
      }
    }

    assertEquals(true, published.await(5, TimeUnit.SECONDS))
    val lockFile = File(inbox.parentFile, "InboxWriterLocks/$id.lock")
    assertEquals(true, lockFile.isFile)
    val scanner = thread(name = "scanner-registration-barrier") {
      try {
        IncompleteTransactionRecovery.recover(inbox) { scannerAttempted.countDown() }
      } catch (error: Throwable) {
        failure.compareAndSet(null, error)
      } finally {
        scannerFinished.countDown()
      }
    }
    assertEquals(true, scannerAttempted.await(5, TimeUnit.SECONDS))
    assertEquals(true, lockFile.isFile)

    allowOwnership.countDown()
    assertEquals(true, ownershipAcquired.await(5, TimeUnit.SECONDS))
    assertEquals(true, scannerFinished.await(5, TimeUnit.SECONDS))
    assertEquals(true, lockFile.isFile)

    releaseWriter.countDown()
    writer.join(5_000)
    scanner.join(5_000)
    failure.get()?.let { throw it }
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
  fun quarantinesFilenameIdMismatchInBothEventStoresSoRetryCannotLoop() {
    val filesDir = requireNotNull(inbox.parentFile)
    val filenameId = "623e4567-e89b-42d3-a456-426614174000"
    val payloadId = "723e4567-e89b-42d3-a456-426614174000"
    val cases = listOf(
      "PendingShareEvents" to mapOf("result" to "complete"),
      "RecoveryEvents" to mapOf("code" to "INBOX_RECOVERY_REQUIRED"),
    )

    cases.forEach { (folder, fields) ->
      val directory = File(filesDir, folder).apply { mkdirs() }
      val event = File(directory, "$filenameId.json")
      val payload = JSONObject()
        .put("schemaVersion", 1)
        .put("id", payloadId)
        .put("createdAtMs", 1L)
      fields.forEach { (key, value) -> payload.put(key, value) }
      event.writeText(payload.toString())

      val error = assertThrows(MetadataEventException::class.java) {
        MetadataEventStore.read(filesDir, folder)
      }

      assertEquals("NATIVE_EVENT_SCHEMA_INVALID", error.stableCode)
      assertEquals(false, event.exists())
      assertEquals(1, directory.listFiles().orEmpty().count {
        it.name.startsWith("$filenameId.json.") && it.name.endsWith(".invalid")
      })
      assertEquals(emptyList<Map<String, Any>>(), MetadataEventStore.read(filesDir, folder))
    }
  }

  @Test
  fun quarantinesEqualNonRfcIdsAndRejectsAcknowledgementInBothEventStores() {
    val filesDir = requireNotNull(inbox.parentFile)
    val invalidIds = listOf(
      "00000000-0000-0000-0000-000000000000",
      "00000000-0000-0000-8000-000000000000",
      "00000000-0000-4000-0000-000000000000",
    )
    val cases = listOf(
      "PendingShareEvents" to mapOf("result" to "complete"),
      "RecoveryEvents" to mapOf("code" to "INBOX_RECOVERY_REQUIRED"),
    )

    cases.forEach { (folder, fields) ->
      val directory = File(filesDir, folder).apply { mkdirs() }
      invalidIds.forEach { id ->
        val event = File(directory, "$id.json")
        val payload = JSONObject()
          .put("schemaVersion", 1)
          .put("id", id)
          .put("createdAtMs", 1L)
        fields.forEach { (key, value) -> payload.put(key, value) }
        event.writeText(payload.toString())

        val readError = assertThrows(MetadataEventException::class.java) {
          MetadataEventStore.read(filesDir, folder)
        }

        assertEquals("NATIVE_EVENT_SCHEMA_INVALID", readError.stableCode)
        assertEquals(false, event.exists())
        assertEquals(true, directory.listFiles().orEmpty().any {
          it.name.startsWith("$id.json.") && it.name.endsWith(".invalid")
        })
        assertEquals(emptyList<Map<String, Any>>(), MetadataEventStore.read(filesDir, folder))
        val ackError = assertThrows(MetadataEventException::class.java) {
          MetadataEventStore.ack(filesDir, folder, id)
        }
        assertEquals("METADATA_EVENT_ID_INVALID", ackError.stableCode)
      }
    }

    val persistError = assertThrows(MetadataEventException::class.java) {
      MetadataEventStore.persistShareResult(
        filesDir,
        "complete",
        eventId = invalidIds.first(),
      )
    }
    assertEquals("METADATA_EVENT_ID_INVALID", persistError.stableCode)
  }

  @Test
  fun classifiesInvalidAndMissingRecoveryAcknowledgements() {
    val filesDir = requireNotNull(inbox.parentFile)
    val invalid = assertThrows(MetadataEventException::class.java) {
      MetadataEventStore.ack(filesDir, "RecoveryEvents", "not-a-uuid")
    }
    assertEquals("METADATA_EVENT_ID_INVALID", invalid.stableCode)
    assertEquals(true, MetadataEventStore.ack(filesDir, "RecoveryEvents", validIngestionId))
  }

  @Test
  fun classifiesRecoveryAcknowledgementDeleteFailure() {
    val filesDir = requireNotNull(inbox.parentFile)
    val event = File(filesDir, "RecoveryEvents/$validIngestionId.json").apply {
      mkdirs()
      File(this, "child").writeText("prevents File.delete")
    }

    val error = assertThrows(MetadataEventException::class.java) {
      MetadataEventStore.ack(filesDir, "RecoveryEvents", validIngestionId)
    }

    assertEquals("NATIVE_RECOVERY_ACK_FAILED", error.stableCode)
    assertEquals(true, event.exists())
  }

  @Test
  fun terminalEventPublicationIsIdempotentAndRejectsConflicts() {
    val filesDir = requireNotNull(inbox.parentFile)
    val id = "523e4567-e89b-42d3-a456-426614174000"
    val first = MetadataEventStore.persistShareResult(
      filesDir,
      "failed",
      id,
      id,
      "SHARE_IMPORT_FAILED",
    )
    val repeated = MetadataEventStore.persistShareResult(
      filesDir,
      "failed",
      id,
      id,
      "SHARE_IMPORT_FAILED",
    )

    assertEquals(first, repeated)
    assertThrows(MetadataEventException::class.java) {
      MetadataEventStore.persistShareResult(filesDir, "complete", id, id)
    }
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

    val error = assertThrows(NativeException::class.java) { InboxManifestScanner.scan(inbox) }

    assertEquals("INBOX_SCAN_FAILED", error.code)
  }

  @Test
  fun rejectsTraversalFailure() {
    val blocked = File(inbox, validIngestionId).apply { mkdirs() }
    val item = File(blocked, "$validItemId.bin").apply { writeBytes(byteArrayOf(1)) }
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
    manifestDirectory: File = File(inbox, validIngestionId),
    ingestionId: String = manifestDirectory.name,
    schemaVersion: Int = 1,
    createdAt: String = "2026-01-01T00:00:00Z",
    itemOrder: Int = 0,
    manifestStatus: String = "complete",
    sha256: String? = null,
  ) {
    val directory = manifestDirectory.apply { mkdirs() }
    val copiedItem = JSONObject()
      .put("id", validItemId)
      .put("order", itemOrder)
      .put("mediaType", "image/png")
      .put("byteCount", byteCount)
      .put("relativePath", item.name)
      .put("status", "copied")
    if (sha256 != null) copiedItem.put("sha256", sha256)
    val payload = JSONObject()
      .put("schemaVersion", schemaVersion)
      .put("ingestionId", ingestionId)
      .put("createdAt", createdAt)
      .put("source", "android-share-intent")
      .put("status", manifestStatus)
      .put(
        "items",
        JSONArray().put(copiedItem),
      )
    File(directory, "manifest.json").writeText(payload.toString())
  }

  private fun rewriteManifestSchemaVersion(rawToken: String) {
    val manifest = File(inbox, "$validIngestionId/manifest.json")
    val currentVersion = "\"schemaVersion\":1"
    val serialized = manifest.readText()
    check(currentVersion in serialized)
    manifest.writeText(serialized.replaceFirst(currentVersion, "\"schemaVersion\":$rawToken"))
  }

  companion object {
    private const val validIngestionId = "623e4567-e89b-42d3-a456-426614174000"
    private const val otherIngestionId = "723e4567-e89b-42d3-a456-426614174000"
    private const val validItemId = "823e4567-e89b-42d3-a456-426614174000"
    private const val originalItemSha256 =
      "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81"
  }
}
