package com.aicontextpack.nativebridge

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import android.system.Os
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class InboxArtifactHandoffInstrumentedTest {
  private lateinit var root: File

  @Before fun setUp() {
    val context = ApplicationProvider.getApplicationContext<android.content.Context>()
    root = File(context.cacheDir, "handoff-${UUID.randomUUID()}")
    assertTrue(root.mkdirs())
  }

  @After fun tearDown() {
    root.deleteRecursively()
  }

  @Test fun publishesOwnedPathAndAcknowledgesOnlyAfterCommitBoundary() {
    val ingestionId = uuid()
    val packId = uuid()
    val itemId = uuid()
    writeManifest(ingestionId, listOf(Item(itemId, "image/png", ByteArray(3) { it.toByte() })))

    val result = InboxArtifactHandoff.handoff(
      root, ingestionId, packId, 0, availableBytes = { Long.MAX_VALUE },
    )

    @Suppress("UNCHECKED_CAST")
    val artifacts = result["artifacts"] as List<Map<String, Any>>
    assertEquals(1, artifacts.size)
    assertEquals(64, (result["manifestFingerprint"] as String).length)
    assertEquals(64, (artifacts.single()["sha256"] as String).length)
    assertEquals("Packs/$packId/originals/$itemId.bin", artifacts.single()["relativePath"])
    assertTrue(File(root, "Packs/$packId/originals/$itemId.bin").isFile)
    assertTrue(File(root, "Inbox/$ingestionId").isDirectory)
    assertTrue(InboxArtifactHandoff.acknowledge(root, ingestionId))
    assertFalse(File(root, "Inbox/$ingestionId").exists())
    assertTrue(InboxArtifactHandoff.acknowledge(root, ingestionId))
  }

  @Test fun everyHandoffInterruptionReplaysWithoutDuplicateArtifacts() {
    InboxArtifactHandoff.Point.entries.forEach { point ->
      val ingestionId = uuid()
      val packId = uuid()
      val itemId = uuid()
      writeManifest(
        ingestionId,
        listOf(Item(itemId, "image/png", ByteArray(128 * 1024) { 7 })),
      )
      var interrupted = false
      assertThrows(Exception::class.java) {
        InboxArtifactHandoff.handoff(
          root,
          ingestionId,
          packId,
          0,
          availableBytes = { Long.MAX_VALUE },
          operationHook = { observed ->
            if (!interrupted && observed == point) {
              interrupted = true
              throw IllegalStateException("SIMULATED_INTERRUPTION")
            }
          },
        )
      }
      assertTrue(interrupted)
      assertEquals(
        1,
        (InboxArtifactHandoff.handoff(
          root, ingestionId, packId, 0, availableBytes = { Long.MAX_VALUE },
        )["artifacts"] as List<*>).size,
      )
      assertEquals(
        listOf("$itemId.bin"),
        File(root, "Packs/$packId/originals").list()?.sorted(),
      )
    }
  }

  @Test fun lowDiskFailsBeforeCreatingPartialFiles() {
    val ingestionId = uuid()
    val packId = uuid()
    writeManifest(ingestionId, listOf(Item(uuid(), "image/png", byteArrayOf(1))))

    val error = assertThrows(InboxArtifactHandoffException::class.java) {
      InboxArtifactHandoff.handoff(
        root, ingestionId, packId, 1, availableBytes = { 1 },
      )
    }
    assertEquals("RESOURCE_LOW_DISK", error.stableCode)
    assertFalse(File(root, "Packs/$packId").exists())
  }

  @Test fun replayBudgetsOnlyHeadroomWhenArtifactIsAlreadyPublished() {
    val ingestionId = uuid()
    val packId = uuid()
    val itemId = uuid()
    writeManifest(
      ingestionId,
      listOf(Item(itemId, "image/png", ByteArray(4_096) { 1 })),
    )
    InboxArtifactHandoff.handoff(
      root, ingestionId, packId, 128, availableBytes = { Long.MAX_VALUE },
    )

    assertEquals(
      1,
      (InboxArtifactHandoff.handoff(
        root, ingestionId, packId, 128, availableBytes = { 128 },
      )["artifacts"] as List<*>).size,
    )
  }

  @Test fun newDestinationHierarchySynchronizesEveryDirectoryAndParent() {
    val ingestionId = uuid()
    val packId = uuid()
    val itemId = uuid()
    writeManifest(ingestionId, listOf(Item(itemId, "image/png", byteArrayOf(1))))
    val synchronized = mutableListOf<String>()

    InboxArtifactHandoff.handoff(
      root,
      ingestionId,
      packId,
      0,
      availableBytes = { Long.MAX_VALUE },
      directorySynchronizer = { synchronized += it.canonicalPath },
    )

    val packs = File(root, "Packs")
    val pack = File(packs, packId)
    val originals = File(pack, "originals")
    listOf(root, packs, pack, originals).forEach { directory ->
      assertTrue(synchronized.contains(directory.canonicalPath))
    }
  }

  @Test fun directorySynchronizationFailureFailsBeforePublishingArtifacts() {
    val ingestionId = uuid()
    val packId = uuid()
    val itemId = uuid()
    writeManifest(ingestionId, listOf(Item(itemId, "image/png", byteArrayOf(1))))

    val error = assertThrows(InboxArtifactHandoffException::class.java) {
      InboxArtifactHandoff.handoff(
        root,
        ingestionId,
        packId,
        0,
        availableBytes = { Long.MAX_VALUE },
        directorySynchronizer = { directory ->
          if (directory.name == packId) throw IllegalStateException("SIMULATED_SYNC_FAILURE")
        },
      )
    }
    assertEquals("STORAGE_WRITE_FAILED", error.stableCode)
    assertFalse(File(root, "Packs/$packId/originals/$itemId.bin").exists())
    var retriedExistingPackSync = false
    InboxArtifactHandoff.handoff(
      root,
      ingestionId,
      packId,
      0,
      availableBytes = { Long.MAX_VALUE },
      directorySynchronizer = { directory ->
        if (directory.name == packId) retriedExistingPackSync = true
      },
    )
    assertTrue(retriedExistingPackSync)
  }

  @Test fun acknowledgementCrashAfterRenameLeavesScannerInvisibleTombstone() {
    val ingestionId = uuid()
    writeManifest(ingestionId, listOf(Item(uuid(), "image/png", byteArrayOf(1))))
    var interrupted = false

    assertThrows(IllegalStateException::class.java) {
      InboxArtifactHandoff.acknowledge(
        root,
        ingestionId,
        operationHook = { point ->
          if (!interrupted &&
            point == InboxArtifactHandoff.AcknowledgementPoint.AFTER_TOMBSTONE_RENAME
          ) {
            interrupted = true
            throw IllegalStateException("SIMULATED_INTERRUPTION")
          }
        },
      )
    }
    assertTrue(interrupted)
    assertFalse(File(root, "Inbox/$ingestionId").exists())
    assertEquals(emptyList<Map<String, Any?>>(), InboxManifestScanner.scan(File(root, "Inbox")))
    val tombstones = File(root, "InboxAckTombstones")
    assertEquals(1, tombstones.listFiles()?.size)
    assertTrue(InboxArtifactHandoff.acknowledge(root, ingestionId))
    assertTrue(tombstones.listFiles()?.isEmpty() == true)
  }

  @Test fun acknowledgementCrashAfterReceiptCannotReopenAnAlreadyConsumedId() {
    val ingestionId = uuid()
    val itemId = uuid()
    writeManifest(ingestionId, listOf(Item(itemId, "image/png", byteArrayOf(1, 2, 3))))
    var interrupted = false

    assertThrows(IllegalStateException::class.java) {
      InboxArtifactHandoff.acknowledge(
        root,
        ingestionId,
        operationHook = { point ->
          if (!interrupted &&
            point == InboxArtifactHandoff.AcknowledgementPoint.AFTER_RECEIPT_PUBLISH
          ) {
            interrupted = true
            throw IllegalStateException("SIMULATED_INTERRUPTION")
          }
        },
      )
    }

    assertTrue(interrupted)
    assertTrue(File(root, "Inbox/$ingestionId").isDirectory)
    assertTrue(File(root, "InboxAcknowledgements/$ingestionId.json").isFile)
    val providerOpened = java.util.concurrent.atomic.AtomicBoolean(false)
    val replay = ShareIngestionWriter.publish(
      root,
      ingestionId,
      listOf(
        ShareIngestionInput(
          id = uuid(),
          order = 0,
          declaredMediaType = "image/png",
          openStream = {
            providerOpened.set(true)
            ByteArray(8).inputStream()
          },
        ),
      ),
    )

    assertTrue(replay.replayed)
    assertFalse(providerOpened.get())
    assertTrue(InboxArtifactHandoff.acknowledge(root, ingestionId))
    assertFalse(File(root, "Inbox/$ingestionId").exists())
    assertTrue(File(root, "InboxAcknowledgements/$ingestionId.json").isFile)
  }

  @Test fun acknowledgementTombstoneDeletionIsBestEffortAndRetryable() {
    val ingestionId = uuid()
    writeManifest(ingestionId, listOf(Item(uuid(), "image/png", byteArrayOf(1))))
    var deletionObserved = false
    var childrenBeforeInterruption = 0
    var childrenAfterInterruption = 0

    assertTrue(InboxArtifactHandoff.acknowledge(
      root,
      ingestionId,
      tombstoneRemover = { tombstone ->
        deletionObserved = true
        val children = requireNotNull(tombstone.listFiles())
        childrenBeforeInterruption = children.size
        assertTrue(requireNotNull(children.firstOrNull()).deleteRecursively())
        childrenAfterInterruption = requireNotNull(tombstone.listFiles()).size
        throw IllegalStateException("SIMULATED_INTERRUPTION")
      },
    ))
    assertTrue(deletionObserved)
    assertEquals(childrenBeforeInterruption - 1, childrenAfterInterruption)
    val tombstones = File(root, "InboxAckTombstones")
    assertEquals(1, tombstones.listFiles()?.size)
    assertTrue(InboxArtifactHandoff.acknowledge(root, ingestionId))
    assertTrue(tombstones.listFiles()?.isEmpty() == true)
  }

  @Test fun startupSweepResumesAfterInterruption() {
    leaveAcknowledgementTombstone()
    leaveAcknowledgementTombstone()
    val tombstones = File(root, "InboxAckTombstones")
    var removals = 0

    assertThrows(IllegalStateException::class.java) {
      InboxArtifactHandoff.sweepAcknowledgementTombstones(
        root,
        operationHook = { point ->
          if (point == InboxArtifactHandoff.TombstoneSweepPoint.AFTER_REMOVAL) {
            removals += 1
            if (removals == 1) throw IllegalStateException("SIMULATED_INTERRUPTION")
          }
        },
      )
    }
    assertEquals(1, removals)
    assertEquals(1, tombstones.listFiles()?.size)

    InboxArtifactHandoff.runStartupMaintenance(root)
    assertTrue(tombstones.listFiles()?.isEmpty() == true)
  }

  @Test fun startupSweepRetriesDeletionFailure() {
    leaveAcknowledgementTombstone()
    val tombstones = File(root, "InboxAckTombstones")

    assertEquals(
      InboxArtifactHandoff.TombstoneSweepResult(scanned = 1, removed = 0, failed = 1),
      InboxArtifactHandoff.sweepAcknowledgementTombstones(
        root,
        tombstoneRemover = { false },
      ),
    )
    assertEquals(1, tombstones.listFiles()?.size)

    InboxArtifactHandoff.runStartupMaintenance(root)
    assertTrue(tombstones.listFiles()?.isEmpty() == true)
  }

  @Test fun startupSweepContainsParentSynchronizationFailure() {
    leaveAcknowledgementTombstone()
    val tombstones = File(root, "InboxAckTombstones")

    assertEquals(
      InboxArtifactHandoff.TombstoneSweepResult(scanned = 1, removed = 0, failed = 1),
      InboxArtifactHandoff.sweepAcknowledgementTombstones(
        root,
        directorySynchronizer = { directory ->
          if (directory.canonicalFile == tombstones.canonicalFile) {
            throw IllegalStateException("SIMULATED_SYNC_FAILURE")
          }
        },
      ),
    )
    assertTrue(tombstones.listFiles()?.isEmpty() == true)
    InboxArtifactHandoff.runStartupMaintenance(root)
  }

  @Test fun requestedManifestSnapshotSerializesConcurrentAckOfOtherIngestion() {
    val requestedId = uuid()
    val acknowledgedId = uuid()
    writeManifest(requestedId, listOf(Item(uuid(), "image/png", byteArrayOf(1))))
    writeManifest(acknowledgedId, listOf(Item(uuid(), "image/png", byteArrayOf(2))))
    val snapshotEntered = CountDownLatch(1)
    val releaseSnapshot = CountDownLatch(1)
    val handoffFinished = CountDownLatch(1)
    val ackAttempted = CountDownLatch(1)
    val ackFinished = CountDownLatch(1)
    val handoffError = AtomicReference<Throwable?>()
    val acknowledgementError = AtomicReference<Throwable?>()

    Thread {
      try {
        InboxArtifactHandoff.handoff(
          root,
          requestedId,
          uuid(),
          0,
          availableBytes = { Long.MAX_VALUE },
          snapshotHook = {
            snapshotEntered.countDown()
            releaseSnapshot.await(5, TimeUnit.SECONDS)
          },
        )
      } catch (error: Throwable) {
        handoffError.set(error)
      } finally {
        handoffFinished.countDown()
      }
    }.start()
    assertTrue(snapshotEntered.await(5, TimeUnit.SECONDS))
    Thread {
      ackAttempted.countDown()
      try {
        InboxArtifactHandoff.acknowledge(root, acknowledgedId)
      } catch (error: Throwable) {
        acknowledgementError.set(error)
      } finally {
        ackFinished.countDown()
      }
    }.start()
    assertTrue(ackAttempted.await(5, TimeUnit.SECONDS))
    assertFalse(ackFinished.await(100, TimeUnit.MILLISECONDS))
    releaseSnapshot.countDown()
    assertTrue(handoffFinished.await(5, TimeUnit.SECONDS))
    assertTrue(ackFinished.await(5, TimeUnit.SECONDS))
    assertEquals(null, handoffError.get())
    assertEquals(null, acknowledgementError.get())
    assertTrue(File(root, "Inbox/$requestedId").isDirectory)
    assertFalse(File(root, "Inbox/$acknowledgedId").exists())
  }

  @Test fun manifestMutationDuringHandoffFailsExactByteBinding() {
    val ingestionId = uuid()
    val packId = uuid()
    val itemId = uuid()
    writeManifest(ingestionId, listOf(Item(itemId, "image/png", byteArrayOf(1, 2, 3))))
    val manifest = File(root, "Inbox/$ingestionId/manifest.json")
    var mutated = false

    val error = assertThrows(InboxArtifactHandoffException::class.java) {
      InboxArtifactHandoff.handoff(
        root,
        ingestionId,
        packId,
        0,
        availableBytes = { Long.MAX_VALUE },
        operationHook = { point ->
          if (!mutated && point == InboxArtifactHandoff.Point.AFTER_FILE_CLOSE) {
            mutated = true
            manifest.appendText(" ")
          }
        },
      )
    }
    assertEquals("ARTIFACT_INTEGRITY_FAILED", error.stableCode)
    assertTrue(mutated)
    assertTrue(File(root, "Inbox/$ingestionId").isDirectory)
  }

  @Test fun existingDestinationMustMatchSourceEvenWithoutManifestHash() {
    val ingestionId = uuid()
    val packId = uuid()
    val itemId = uuid()
    writeManifest(ingestionId, listOf(Item(itemId, "image/png", byteArrayOf(1, 2, 3))))
    val destination = File(root, "Packs/$packId/originals/$itemId.bin")
    assertTrue(requireNotNull(destination.parentFile).mkdirs())
    destination.writeBytes(byteArrayOf(3, 2, 1))

    val error = assertThrows(InboxArtifactHandoffException::class.java) {
      InboxArtifactHandoff.handoff(
        root, ingestionId, packId, 0, availableBytes = { Long.MAX_VALUE },
      )
    }
    assertEquals("ARTIFACT_INTEGRITY_FAILED", error.stableCode)
  }

  @Test fun destinationAncestorsRejectPreexistingSymlinks() {
    listOf("Packs", "pack", "originals").forEach { level ->
      val caseRoot = File(root, "case-$level").also { assertTrue(it.mkdirs()) }
      val outside = File(root, "outside-$level").also { assertTrue(it.mkdirs()) }
      val ingestionId = uuid()
      val packId = uuid()
      val itemId = uuid()
      writeManifest(
        ingestionId,
        listOf(Item(itemId, "image/png", byteArrayOf(1, 2, 3))),
        caseRoot,
      )
      val packs = File(caseRoot, "Packs")
      when (level) {
        "Packs" -> Os.symlink(outside.path, packs.path)
        "pack" -> {
          assertTrue(packs.mkdir())
          Os.symlink(outside.path, File(packs, packId).path)
        }
        else -> {
          val pack = File(packs, packId)
          assertTrue(pack.mkdirs())
          Os.symlink(outside.path, File(pack, "originals").path)
        }
      }

      val error = assertThrows(InboxArtifactHandoffException::class.java) {
        InboxArtifactHandoff.handoff(
          caseRoot, ingestionId, packId, 0, availableBytes = { Long.MAX_VALUE },
        )
      }
      assertEquals("ARTIFACT_INTEGRITY_FAILED", error.stableCode)
      assertFalse(File(outside, "$itemId.bin").exists())
    }
  }

  @Test fun destinationAncestorSwapBeforeCopyFailsClosed() {
    val ingestionId = uuid()
    val packId = uuid()
    val itemId = uuid()
    writeManifest(ingestionId, listOf(Item(itemId, "image/png", byteArrayOf(1, 2, 3))))
    val originals = File(root, "Packs/$packId/originals")
    val displaced = File(root, "Packs/$packId/originals-displaced")
    val outside = File(root, "outside-swap").also { assertTrue(it.mkdir()) }
    var swapped = false

    val error = assertThrows(InboxArtifactHandoffException::class.java) {
      InboxArtifactHandoff.handoff(
        root,
        ingestionId,
        packId,
        0,
        availableBytes = { Long.MAX_VALUE },
        operationHook = { point ->
          if (point == InboxArtifactHandoff.Point.BEFORE_COPY && !swapped) {
            swapped = true
            assertTrue(originals.renameTo(displaced))
            Os.symlink(outside.path, originals.path)
          }
        },
      )
    }
    assertEquals("ARTIFACT_INTEGRITY_FAILED", error.stableCode)
    assertTrue(swapped)
    assertFalse(File(outside, "$itemId.bin").exists())
    assertFalse(File(displaced, "$itemId.bin").exists())
  }

  @Test fun destinationPacksSwapBackToDisplacedTreeFailsClosed() {
    val ingestionId = uuid()
    val packId = uuid()
    val itemId = uuid()
    writeManifest(ingestionId, listOf(Item(itemId, "image/png", byteArrayOf(1, 2, 3))))
    val packs = File(root, "Packs")
    val displaced = File(root, "Packs-displaced")
    var swapped = false

    val error = assertThrows(InboxArtifactHandoffException::class.java) {
      InboxArtifactHandoff.handoff(
        root,
        ingestionId,
        packId,
        0,
        availableBytes = { Long.MAX_VALUE },
        operationHook = { point ->
          if (point == InboxArtifactHandoff.Point.BEFORE_COPY && !swapped) {
            swapped = true
            assertTrue(packs.renameTo(displaced))
            Os.symlink(displaced.path, packs.path)
          }
        },
      )
    }
    assertEquals("ARTIFACT_INTEGRITY_FAILED", error.stableCode)
    assertTrue(swapped)
    assertFalse(File(displaced, "$packId/originals/$itemId.bin").exists())
  }

  @Test fun twentyImageAndNearLimitPdfCopyBenchmarkDoesNotRunOcr() {
    val imageIngestion = uuid()
    val imagePack = uuid()
    val images = List(20) { Item(uuid(), "image/png", ByteArray(256 * 1024) { 1 }) }
    writeManifest(imageIngestion, images)
    val imageStarted = System.nanoTime()
    assertEquals(
      20,
      (InboxArtifactHandoff.handoff(
        root, imageIngestion, imagePack, 0, availableBytes = { Long.MAX_VALUE },
      )["artifacts"] as List<*>).size,
    )
    val imageDurationMs = (System.nanoTime() - imageStarted) / 1_000_000

    val pdfIngestion = uuid()
    val pdfPack = uuid()
    writeManifest(
      pdfIngestion,
      listOf(Item(uuid(), "application/pdf", ByteArray(49 * 1024 * 1024) { 2 })),
    )
    val pdfStarted = System.nanoTime()
    assertEquals(
      1,
      (InboxArtifactHandoff.handoff(
        root, pdfIngestion, pdfPack, 0, availableBytes = { Long.MAX_VALUE },
      )["artifacts"] as List<*>).size,
    )
    val pdfDurationMs = (System.nanoTime() - pdfStarted) / 1_000_000

    println(
      "PERSISTENCE_BENCHMARK platform=android images=20 imageBytes=5242880 " +
        "imageMs=$imageDurationMs pdfBytes=51380224 pdfMs=$pdfDurationMs ocrRuns=0",
    )
    assertTrue("20-image handoff took ${imageDurationMs}ms", imageDurationMs < 10_000)
    assertTrue("near-limit PDF handoff took ${pdfDurationMs}ms", pdfDurationMs < 10_000)
  }

  private fun writeManifest(
    ingestionId: String,
    items: List<Item>,
    filesRoot: File = root,
  ) {
    val directory = File(filesRoot, "Inbox/$ingestionId")
    assertTrue(directory.mkdirs())
    val payloadItems = JSONArray()
    items.forEachIndexed { index, item ->
      File(directory, "${item.id}.bin").writeBytes(item.bytes)
      payloadItems.put(
        JSONObject()
          .put("id", item.id)
          .put("order", index)
          .put("mediaType", item.mediaType)
          .put("status", "copied")
          .put("byteCount", item.bytes.size)
          .put("relativePath", "${item.id}.bin"),
      )
    }
    File(directory, "manifest.json").writeText(
      JSONObject()
        .put("schemaVersion", 1)
        .put("ingestionId", ingestionId)
        .put("createdAt", "2026-08-03T00:00:00Z")
        .put("source", "android-share-intent")
        .put("status", "complete")
        .put("items", payloadItems)
        .toString(),
    )
  }

  private fun leaveAcknowledgementTombstone(): String {
    val ingestionId = uuid()
    writeManifest(ingestionId, listOf(Item(uuid(), "image/png", byteArrayOf(1))))
    assertThrows(IllegalStateException::class.java) {
      InboxArtifactHandoff.acknowledge(
        root,
        ingestionId,
        operationHook = { point ->
          if (point == InboxArtifactHandoff.AcknowledgementPoint.AFTER_TOMBSTONE_RENAME) {
            throw IllegalStateException("SIMULATED_INTERRUPTION")
          }
        },
      )
    }
    return ingestionId
  }

  private fun uuid(): String = UUID.randomUUID().toString()

  private data class Item(val id: String, val mediaType: String, val bytes: ByteArray)
}
