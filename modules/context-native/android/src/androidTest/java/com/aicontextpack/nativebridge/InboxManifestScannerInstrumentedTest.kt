package com.aicontextpack.nativebridge

import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Before
import org.junit.Test
import java.io.File

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

  private fun writeManifest(item: File, byteCount: Long = item.length()) {
    val directory = File(inbox, "valid").apply { mkdirs() }
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
