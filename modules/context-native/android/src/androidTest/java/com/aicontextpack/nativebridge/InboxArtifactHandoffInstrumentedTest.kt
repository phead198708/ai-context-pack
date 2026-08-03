package com.aicontextpack.nativebridge

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.File
import java.util.UUID
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

  private fun writeManifest(ingestionId: String, items: List<Item>) {
    val directory = File(root, "Inbox/$ingestionId")
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

  private fun uuid(): String = UUID.randomUUID().toString()

  private data class Item(val id: String, val mediaType: String, val bytes: ByteArray)
}
