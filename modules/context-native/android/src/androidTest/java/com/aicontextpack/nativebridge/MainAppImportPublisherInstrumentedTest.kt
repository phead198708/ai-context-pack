package com.aicontextpack.nativebridge

import android.net.Uri
import android.system.Os
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class MainAppImportPublisherInstrumentedTest {
  private lateinit var root: File
  private lateinit var cache: File

  @Before fun setUp() {
    val contextCache = InstrumentationRegistry.getInstrumentation().targetContext.cacheDir
    root = File(contextCache, "main-app-root-${UUID.randomUUID()}")
    cache = File(contextCache, "main-app-cache-${UUID.randomUUID()}")
    assertTrue(root.mkdirs())
    assertTrue(cache.mkdirs())
  }

  @After fun tearDown() {
    root.deleteRecursively()
    cache.deleteRecursively()
  }

  @Test fun mixedPickerInputsReuseInboxWriterPreserveOrderAndRemoveCacheCopies() {
    val ingestionId = id()
    val imageId = id()
    val textId = id()
    val urlId = id()
    val unsupportedId = id()
    val image = cached(
      "selected-image.bin",
      byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    )
    val unsupported = cached("selected-archive.bin", byteArrayOf(0x50, 0x4b, 0x03, 0x04))
    val privateText = "English 中文 🧪\n    val indentation = true"
    val longUrl = "https://example.invalid/${"segment/".repeat(200)}"

    val manifest = MainAppImportPublisher.publish(
      root,
      cache,
      ingestionId,
      "main-app-picker",
      listOf(
        file(imageId, 0, "application/octet-stream", image),
        text(textId, 1, "text", privateText),
        text(urlId, 2, "url", longUrl),
        file(unsupportedId, 3, "application/zip", unsupported),
      ),
    )

    assertEquals("main-app-picker", manifest["source"])
    assertEquals("partial", manifest["status"])
    @Suppress("UNCHECKED_CAST")
    val items = manifest["items"] as List<Map<String, Any?>>
    assertEquals(listOf(imageId, textId, urlId, unsupportedId), items.map { it["id"] })
    assertEquals(listOf(0L, 1L, 2L, 3L), items.map { (it["order"] as Number).toLong() })
    assertEquals(listOf("copied", "copied", "copied", "failed"), items.map { it["status"] })
    assertEquals("IMPORT_TYPE_UNSUPPORTED", items.last()["errorCode"])
    assertEquals(privateText, File(root, "Inbox/$ingestionId/$textId.bin").readText())
    assertEquals(longUrl, File(root, "Inbox/$ingestionId/$urlId.bin").readText())
    assertFalse(image.exists())
    assertFalse(unsupported.exists())
    assertFalse(manifest.toString().contains("selected-image"))
  }

  @Test fun staleProviderIsVisibleWhileSuccessfulTextIsPreserved() {
    val ingestionId = id()
    val staleId = id()
    val textId = id()
    val stale = File(cache, "stale-provider.pdf")

    val manifest = MainAppImportPublisher.publish(
      root,
      cache,
      ingestionId,
      "main-app-picker",
      listOf(
        file(staleId, 0, "application/pdf", stale),
        text(textId, 1, "text", "preserved 中文"),
      ),
    )

    @Suppress("UNCHECKED_CAST")
    val items = manifest["items"] as List<Map<String, Any?>>
    assertEquals("IMPORT_PROVIDER_PERMISSION_EXPIRED", items[0]["errorCode"])
    assertEquals("copied", items[1]["status"])
    assertEquals("partial", manifest["status"])
  }

  @Test fun replayOfMultipleInlineItemsDoesNotDuplicateTheImport() {
    val ingestionId = id()
    val inputs = listOf(
      text(id(), 0, "text", "first"),
      text(id(), 1, "url", "https://example.invalid/replay"),
    )

    val initial = MainAppImportPublisher.publish(
      root,
      cache,
      ingestionId,
      "main-app-text",
      inputs,
    )
    val replay = MainAppImportPublisher.publish(
      root,
      cache,
      ingestionId,
      "main-app-text",
      inputs,
    )

    assertEquals(initial["ingestionId"], replay["ingestionId"])
    assertEquals(listOf(ingestionId), File(root, "Inbox").list()?.toList())
  }

  @Test fun failedPublishPreservesPickerCacheForRetry() {
    val ingestionId = id()
    val itemId = id()
    val image = cached(
      "retry-image.bin",
      byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    )
    val inputs = listOf(file(itemId, 0, "application/octet-stream", image))
    var interrupted = false

    assertThrows(ShareIngestionInterruptionException::class.java) {
      MainAppImportPublisher.publish(
        root,
        cache,
        ingestionId,
        "main-app-picker",
        inputs,
      ) { point ->
        if (!interrupted && point == ShareIngestionWriter.Point.AFTER_FIRST_CHUNK) {
          interrupted = true
          throw ShareIngestionInterruptionException()
        }
      }
    }
    assertTrue(interrupted)
    assertTrue(image.exists())

    val manifest = MainAppImportPublisher.publish(
      root,
      cache,
      ingestionId,
      "main-app-picker",
      inputs,
    )
    assertEquals("complete", manifest["status"])
    assertFalse(image.exists())
  }

  @Test fun committedImportSurfacesCacheCleanupFailureAndReplaysWithoutDuplication() {
    val ingestionId = id()
    val itemId = id()
    val image = cached(
      "cleanup-retry-image.bin",
      byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    )
    val inputs = listOf(file(itemId, 0, "application/octet-stream", image))

    val error = assertThrows(MainAppImportException::class.java) {
      MainAppImportPublisher.publish(
        root,
        cache,
        ingestionId,
        "main-app-picker",
        inputs,
        removeCacheFile = { false },
      )
    }
    assertEquals("MAIN_APP_IMPORT_COMMITTED_CLEANUP_REQUIRED", error.stableCode)
    assertTrue(image.exists())
    assertEquals(listOf(ingestionId), File(root, "Inbox").list()?.toList())

    val replay = MainAppImportPublisher.publish(
      root,
      cache,
      ingestionId,
      "main-app-picker",
      inputs,
    )
    assertEquals("complete", replay["status"])
    assertFalse(image.exists())
    assertEquals(listOf(ingestionId), File(root, "Inbox").list()?.toList())
  }

  @Test fun boundaryRejectsInvalidUrlByteCountAndPathsOutsideCache() {
    val outside = File(root, "outside.bin").apply { writeText("fixture") }
    val directory = File(cache, "selected-directory").apply { check(mkdirs()) }
    val invalidInputs = listOf(
      listOf(text(id(), 0, "url", "file:///private/value")),
      listOf(text(id(), 0, "url", "http:example.invalid")),
      listOf(
        mapOf(
          "id" to id(),
          "order" to 0,
          "kind" to "text",
          "declaredMediaType" to "text/plain",
          "byteCount" to 1,
          "text" to "中文",
        ),
      ),
      listOf(
        mapOf(
          "id" to id(),
          "order" to 0,
          "kind" to "text",
          "declaredMediaType" to "text/plain",
          "byteCount" to ShareIngestionWriter.maximumTextBytes + 1L,
          "text" to "x",
        ),
      ),
      listOf(file(id(), 0, "application/octet-stream", outside)),
      listOf(file(id(), 0, "application/octet-stream", directory)),
    )

    invalidInputs.forEach { inputs ->
      val source = if (inputs.single()["kind"] == "file") "main-app-picker" else "main-app-text"
      val error = assertThrows(MainAppImportException::class.java) {
        MainAppImportPublisher.publish(root, cache, id(), source, inputs)
      }
      assertEquals("MAIN_APP_IMPORT_INPUT_INVALID", error.stableCode)
    }
  }

  @Test fun discardRemovesOnlyControlledCacheFiles() {
    val selected = cached("cancelled.pdf", "fixture".toByteArray())
    assertTrue(MainAppImportPublisher.discard(cache, listOf(Uri.fromFile(selected).toString())))
    assertFalse(selected.exists())
    assertThrows(MainAppImportException::class.java) {
      MainAppImportPublisher.discard(
        cache,
        listOf(Uri.fromFile(File(root, "outside.pdf")).toString()),
      )
    }
  }

  @Test fun pickerStagingIsAnonymousAndRecoverySweepsOrphans() {
    val documentRoot = File(cache, "DocumentPicker").apply { assertTrue(mkdirs()) }
    val imageRoot = File(cache, "ImagePicker").apply { assertTrue(mkdirs()) }
    val document = File(documentRoot, "private-name.pdf").apply { writeText("pdf") }
    val image = File(imageRoot, "private-name.png").apply { writeText("png") }

    val staged = MainAppImportPublisher.stagePickerFiles(
      cache,
      listOf(Uri.fromFile(document).toString(), Uri.fromFile(image).toString()),
    )

    assertFalse(document.exists())
    assertFalse(image.exists())
    assertEquals(2, staged.size)
    assertTrue(staged.all { it.contains("/AIContextPackMainAppPicker/") && it.endsWith(".bin") })
    assertFalse(staged.joinToString().contains("private-name"))

    val orphan = File(documentRoot, "orphan.pdf").apply { writeText("orphan") }
    val partial = File(cache, "AIContextPackMainAppPicker/abandoned.partial").apply {
      assertTrue(mkdirs())
      File(this, "orphan.bin").writeText("partial")
    }
    assertTrue(MainAppImportPublisher.cleanupPickerTransients(cache))
    assertFalse(orphan.exists())
    assertFalse(partial.exists())
    assertTrue(staged.all { File(requireNotNull(Uri.parse(it).path)).exists() })

    assertTrue(MainAppImportPublisher.recoverPickerCache(cache))
    assertTrue(staged.all { !File(requireNotNull(Uri.parse(it).path)).exists() })

    val outside = File(root, "outside-stage").apply { assertTrue(mkdirs()) }
    val sentinel = File(outside, "sentinel.bin").apply { writeText("sentinel") }
    val invalidStageRoot = File(cache, "AIContextPackMainAppPicker")
    Os.symlink(outside.path, invalidStageRoot.path)
    assertTrue(MainAppImportPublisher.cleanupPickerTransients(cache))
    assertFalse(invalidStageRoot.exists())
    assertTrue(sentinel.exists())
  }

  private fun id(): String = UUID.randomUUID().toString()

  private fun cached(name: String, bytes: ByteArray): File =
    File(cache, name).apply { writeBytes(bytes) }

  private fun file(id: String, order: Int, mediaType: String, value: File): Map<String, Any?> =
    mapOf(
      "id" to id,
      "order" to order,
      "kind" to "file",
      "declaredMediaType" to mediaType,
      "byteCount" to if (value.exists()) value.length() else 0L,
      "fileUri" to Uri.fromFile(value).toString(),
    )

  private fun text(id: String, order: Int, kind: String, value: String): Map<String, Any?> =
    mapOf(
      "id" to id,
      "order" to order,
      "kind" to kind,
      "declaredMediaType" to if (kind == "url") "text/uri-list" else "text/plain",
      "byteCount" to value.toByteArray(Charsets.UTF_8).size,
      "text" to value,
    )
}
